import type {
  SidSink,
  SinkCapabilities,
  FarEndConsumption,
  SidFrame,
  Frames,
  SidModel,
  TimeSource,
  EngineLog,
} from '@sidablist/core';
import type { Microseconds, Milliseconds } from '@sidablist/core';
import { milliseconds, MICROSECONDS_PER_SECOND } from '@sidablist/core';
import {
  buildDisplayCharsPacket,
  buildSidDataPacket,
  buildSidTypePacket,
  buildStartPacket,
  buildStopPacket,
  SID_DATA_PACKET_MAX_LENGTH,
  SID_DATA_PACKET_MIN_LENGTH,
  writeSidDataPacket,
} from '../wire/encoder.js';
import type { DeliveryStats } from './delivery-stats.js';
import type { MidiOutputPort } from './midi-output-port.js';

/**
 * `AsidSink` is core's `SidSink` plus the protocol-specific members core has no concept of: a far
 * end with a screen, and a live schedule-ahead window whose meaning is this sink's to define.
 */
export interface AsidSink extends SidSink {
  /** Sends text to the cartridge's display. ASID-specific: core's sink contract has no notion of a
   *  far end with a screen. Keeps the ownership line true — without it the application would have
   *  to import the display-chars encoder directly, and "the application never sees a SysEx byte"
   *  would be false. */
  showText(text: string): void;
  /** The live schedule-ahead control. The application sets it, this sink implements it, and
   *  another sink may ignore it or mean something different by it — which is why it lives here and
   *  not on core's contract. Reads back, clamped, via `capabilities.scheduleAheadMs`. */
  setScheduleAhead(ms: Milliseconds): void;
  /** The delivery counters this sink owns: packets sent, bytes sent, cancel support, last cancel
   *  latency and in-flight depth. Core's `SidSink` contract has no notion of them, so they are
   *  reachable only through this wider interface. */
  readonly stats: DeliveryStats;
}

/**
 * The `scheduleAheadMs` ceiling enforced whenever the selected MIDI port cannot cancel a pending
 * send — two PAL frames. Ear-derived: settled by listening on real hardware, not a value a test can
 * re-derive. Stale-tempo frames a tempo change can no longer catch still play out, so the window
 * they can be stale for has to stay short enough to be inaudible. A port that *can* cancel has no
 * need of this — `retime()` re-times whatever is still outstanding instead of merely bounding it.
 *
 * Enforced live, at every send, via `effectiveScheduleAheadMs()` — not only at the moment
 * `setScheduleAhead()` runs — because `supportsCancel` is something the injected `MidiOutputPort`
 * can flip on its own (a port swap, a same-device reconnect) with no call back into this sink.
 */
export const UNCANCELLABLE_SCHEDULE_AHEAD_CEILING_MS: Milliseconds = milliseconds(40);

/** ASID addresses a single chip on the wire today; a multi-chip cartridge is a future protocol
 *  extension this sink does not yet speak. */
const CHIP_INDEX = 0;

/** How far past the previous send an unscheduled one is stamped on a port that cannot cancel, so
 *  the port's ordering of two near-equal timestamps never decides which of them lands first. */
const UNSCHEDULED_SEND_SPACING_MS = 1;

/** The shortest frame interval the ring is first sized for, in ms — a quadruple-speed PAL tune. A
 *  tempo command that asks for a shorter one grows the ring through `retime()`. */
const DEFAULT_SHORTEST_FRAME_INTERVAL_MS = 5;
/** The fewest slots the ring ever has, whatever the schedule-ahead. */
const MIN_RING_SLOTS = 8;
/** The most slots the ring grows to. Sizing follows a schedule-ahead and a tempo the host chooses, so
 *  it needs a bound of its own; past it, the overflow rule applies. */
const MAX_RING_SLOTS = 256;

/** One packet already handed to the port with a future delivery time — pruned as its delivery time
 *  passes. What a tempo change can still catch: `retime()` cancels the port's queue and re-sends
 *  exactly these, at the new spacing, rather than losing whatever they were carrying.
 *
 *  Each slot owns its `buffer` until it is pruned, because `retime()` re-sends those very bytes.
 *  `views[n - SID_DATA_PACKET_MIN_LENGTH]` is `buffer.subarray(0, n)`: `MidiOutputPort.send` takes no
 *  length, and a `subarray` made per send would be garbage on the frame path, so every length a data
 *  packet can have gets its view when the slot is made. */
interface CommittedSlot {
  readonly buffer: Uint8Array;
  readonly views: readonly Uint8Array[];
  length: number;
  scheduledAtMs: number;
}

function createSlot(): CommittedSlot {
  const buffer = new Uint8Array(SID_DATA_PACKET_MAX_LENGTH);
  const views: Uint8Array[] = [];
  for (let length = SID_DATA_PACKET_MIN_LENGTH; length <= SID_DATA_PACKET_MAX_LENGTH; length++) {
    views.push(buffer.subarray(0, length));
  }
  return { buffer, views, length: 0, scheduledAtMs: 0 };
}

class AsidSinkImpl implements AsidSink {
  private scheduleAheadMsValue: Milliseconds;
  private packetsSent = 0;
  private bytesSent = 0;
  private lastCancelLatencyMs = -1;
  /** The ring of committed sends: `slots[0..committedCount)` are live, oldest first, and the rest are
   *  free. Grown only off the tick (`setScheduleAhead`, `retime`), pruned in place on the tick. When
   *  a send finds it full, the oldest live slot is recycled for it — that send is no longer tracked, so
   *  a later `retime()` does not re-send it. Nothing allocates on the tick. */
  private readonly slots: CommittedSlot[] = [];
  private committedCount = 0;
  /** Where an untracked send — one already due when it arrives — is packed. */
  private readonly stagingSlot = createSlot();
  private shortestFrameIntervalMs = DEFAULT_SHORTEST_FRAME_INTERVAL_MS;
  /** `deliver` calls since the last `begin` or `reset`. This sink sends each at once, so all have passed. */
  private deliveredCount = 0;
  private readonly liveCapabilities: SinkCapabilities;
  /** The latest delivery time handed to the port. Unlike the committed ring it survives `reset()`
   *  and `end()`: a port that cannot cancel still delivers everything up to here, whatever this
   *  sink has stopped counting. See `sendUnscheduled`. */
  private lastStampedAtMs = 0;

  constructor(
    private readonly port: MidiOutputPort,
    private readonly time: TimeSource,
    private readonly log: EngineLog | undefined,
    scheduleAheadMs: Milliseconds,
  ) {
    this.scheduleAheadMsValue = scheduleAheadMs;
    this.growRing();
    // One object for the sink's life, read live through accessors: a fresh object per read would be
    // garbage for a caller that reads it on the tick.
    const scheduleAhead = () => this.effectiveScheduleAheadMs();
    this.liveCapabilities = {
      perWriteOffsets: false, // ASID has no per-write time offset on the wire
      get cancellation() {
        return port.supportsCancel; // can flip on a port swap or reconnect
      },
      get scheduleAheadMs() {
        return scheduleAhead(); // the clamped value, not the requested one
      },
      // One SID_DATA packet carries a whole frame's present/value slots in the firmware's fixed
      // slot order (`ASID_SLOT_TO_REGISTER`) — the far end applies them in that order regardless
      // of the order the writes arrived in, so cross-register arrival order never reaches the wire.
      preservesWriteOrder: false,
    };
  }

  get capabilities(): SinkCapabilities {
    return this.liveCapabilities;
  }

  get stats(): DeliveryStats {
    const cancelSupported = this.port.supportsCancel;
    return {
      packetsSent: this.packetsSent,
      bytesSent: this.bytesSent,
      cancelSupported,
      // Derived rather than read straight off the field: `lastCancelLatencyMs` is sticky across a
      // mid-session port swap, so a swap to a non-cancelling port must force this back to -1 rather
      // than surface a stale reading from the port it replaced.
      lastCancelLatencyMs: cancelSupported ? this.lastCancelLatencyMs : -1,
      inFlight: this.inFlightCount(this.time.now()),
    };
  }

  begin(tune: { readonly chipModel: SidModel }): void {
    // The header already told us the model; this sink forwards it as its own packet, immediately
    // before the start packet — the order the engine used pre-extraction.
    this.deliveredCount = 0;
    this.sendControl(buildSidTypePacket(CHIP_INDEX, tune.chipModel === 'mos8580'));
    this.sendControl(buildStartPacket());
  }

  end(): void {
    // Stopping supersedes anything still outstanding — nothing is coming to land it.
    this.committedCount = 0;
    this.sendControl(buildStopPacket());
  }

  /** `frameNumber` and `catchUpClamped` are core's to know for delivery-against-due-time
   *  measurement (P05-T05, at the `deliver()` call site). Scheduling has no use for either, but
   *  the interface requires them: `frameNumber` identifies what was consumed if read back from a
   *  port that can report it, and `catchUpClamped` flags a frame that was stalled and is reporting
   *  a due time later than truth. ASID is one-way, so we acknowledge them without using them. */
  deliver(
    frame: SidFrame,
    frameNumber: Frames,
    dueAtMs: Milliseconds,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    catchUpClamped: boolean,
  ): void {
    const nowMs = this.time.now();
    const scheduledAtMs = milliseconds(dueAtMs + this.effectiveScheduleAheadMs());
    this.pruneCommittedHostSends(nowMs);
    // A send whose delivery time has already passed, because the host stalled between the frame
    // falling due and reaching this sink, has been handed over for immediate release: there is
    // nothing left to cancel or re-time, so it is not tracked.
    const tracked = scheduledAtMs > nowMs;
    const slot = tracked ? this.acquireSlot() : this.stagingSlot;
    const length = writeSidDataPacket(frame, slot.buffer);
    slot.length = length;
    slot.scheduledAtMs = scheduledAtMs;
    this.port.send(slot.views[length - SID_DATA_PACKET_MIN_LENGTH], scheduledAtMs);
    if (tracked) {
      this.committedCount++;
    }
    if (scheduledAtMs > this.lastStampedAtMs) {
      this.lastStampedAtMs = scheduledAtMs;
    }
    this.packetsSent++;
    this.bytesSent += length;
    this.deliveredCount++;
  }

  /** Packs and sends unscheduled — the pause gate-off's contract, and why this never touches
   *  the committed ring. Ahead of anything scheduled on a port that can cancel; just behind what
   *  is already committed on one that cannot (`sendUnscheduled`). */
  deliverNow(frame: SidFrame): void {
    this.sendControl(buildSidDataPacket(frame));
  }

  /**
   * The cancellation half of a tempo change.
   *
   * With a port that can cancel, whatever is still sitting in its queue was scheduled against the
   * old interval and would land at the wrong spacing; wiping it and re-sending the same packets at
   * the new one is what "re-time" means here — the content is unchanged, only the delivery times
   * move. Without cancellation, or when `cancelPending()` reports it did not actually cancel
   * anything, this is a no-op: resending on top of sends the port still holds would duplicate them,
   * so `setScheduleAhead()`'s live clamp is what keeps that window inaudible instead.
   */
  retime(intervalUs: Microseconds): void {
    const nowMs = this.time.now();
    const newIntervalMs = intervalUs / (MICROSECONDS_PER_SECOND / 1000);
    if (newIntervalMs > 0 && newIntervalMs < this.shortestFrameIntervalMs) {
      this.shortestFrameIntervalMs = newIntervalMs;
      this.growRing();
    }
    this.pruneCommittedHostSends(nowMs);
    if (this.committedCount === 0 || !this.port.supportsCancel) {
      return;
    }
    if (!this.port.cancelPending()) {
      return;
    }

    // The furthest-out entry is the one that would have kept arriving longest without the cancel —
    // how far past this request it was still committed to land is the cancel's measured reach.
    let furthestMs = this.slots[0].scheduledAtMs;
    for (let index = 1; index < this.committedCount; index++) {
      furthestMs = Math.max(furthestMs, this.slots[index].scheduledAtMs);
    }
    this.lastCancelLatencyMs = furthestMs - nowMs;
    // `supportsCancel` is already confirmed true above, so this equals `scheduleAheadMsValue` —
    // read via the same helper `deliver` uses purely so both call sites agree on one source of
    // truth for "the window actually in effect right now."
    const aheadMs = this.effectiveScheduleAheadMs();
    // The same `nowMs` the latency above was measured against: a second reading would put the
    // measurement and the first re-sent packet on two different anchors.
    let scheduledAtMs = nowMs + aheadMs;
    for (let index = 0; index < this.committedCount; index++) {
      const slot = this.slots[index];
      slot.scheduledAtMs = scheduledAtMs;
      this.port.send(slot.views[slot.length - SID_DATA_PACKET_MIN_LENGTH], scheduledAtMs);
      this.lastStampedAtMs = scheduledAtMs;
      this.packetsSent++;
      this.bytesSent += slot.length;
      scheduledAtMs += newIntervalMs;
    }
  }

  /**
   * Drops what is outstanding without sending a stop packet. Stopping the far end is `end()`, and
   * the two are separate because a seek resets without stopping.
   *
   * Withdraws from the port itself, not only from local bookkeeping — otherwise a stale frame the
   * port already holds still lands after the reset, while `stats.inFlight` reports 0 the whole time.
   * A port that cannot cancel has no way to satisfy "drops everything outstanding": the packet is
   * already irrevocably in the port's hands, so the best this can do is stop counting it as
   * in-flight rather than claim a withdrawal that did not happen.
   */
  reset(): void {
    if (this.port.supportsCancel) {
      this.port.cancelPending();
    }
    this.committedCount = 0;
    this.deliveredCount = 0;
  }

  /** Every frame went to the port as it arrived, stamped ahead, so all of them have passed. */
  passedCount(): number {
    return this.deliveredCount;
  }

  /** Holds nothing to drop: a frame already handed to the port cannot be taken back, so replacements
   *  begin after the last delivery. */
  replaceFrom(): number {
    return this.deliveredCount;
  }

  readAt(): FarEndConsumption {
    // ASID cannot know what the far end has consumed, but it does know its own in-flight depth.
    return { kind: 'unknown', inFlight: this.inFlightCount(this.time.now()) };
  }

  showText(text: string): void {
    this.port.send(buildDisplayCharsPacket(text));
  }

  setScheduleAhead(ms: Milliseconds): void {
    if (!Number.isFinite(ms) || ms < 0) {
      this.log?.warn(`ASID sink: ignoring a schedule-ahead of ${ms} ms.`);
      return;
    }
    const clamped = this.port.supportsCancel
      ? ms
      : milliseconds(Math.min(ms, UNCANCELLABLE_SCHEDULE_AHEAD_CEILING_MS));
    if (clamped !== ms) {
      this.log?.warn(
        `ASID sink: clamped schedule-ahead from ${ms} ms to ${clamped} ms — the selected MIDI ` +
          `port cannot cancel a pending send, so a deeper window would risk stale-tempo frames ` +
          `playing out audibly.`,
      );
    }
    this.scheduleAheadMsValue = clamped;
    this.growRing();
  }

  /**
   * The schedule-ahead window actually honoured for the next send, re-derived fresh against the
   * live `port.supportsCancel` rather than trusted from whatever `setScheduleAhead()` last stored —
   * capability can flip on its own (a port swap, a same-device reconnect) with no matching call
   * back into `setScheduleAhead()`.
   */
  private effectiveScheduleAheadMs(): Milliseconds {
    return this.port.supportsCancel
      ? this.scheduleAheadMsValue
      : milliseconds(Math.min(this.scheduleAheadMsValue, UNCANCELLABLE_SCHEDULE_AHEAD_CEILING_MS));
  }

  private sendControl(packet: Uint8Array): void {
    this.sendUnscheduled(packet);
    this.packetsSent++;
    this.bytesSent += packet.length;
  }

  /**
   * Sends a packet that has no due time — start, stop, a pause's gate-off — as early as it can
   * without overtaking a frame the port will still deliver.
   *
   * A port that can cancel takes it at once: whatever it still holds is either withdrawn by the
   * `reset()` core makes first, or meant to land after it. A port that cannot cancel will play every
   * frame stamped up to `lastStampedAtMs` regardless, so a packet sent ahead of them is undone by
   * them — a gate-off followed by frames that re-open the gates leaves the voices ringing through
   * the pause. It is stamped just behind them instead, each such send a step behind the last so two
   * of them keep their order. The wait is bounded by the schedule-ahead window, which
   * `UNCANCELLABLE_SCHEDULE_AHEAD_CEILING_MS` caps for exactly this kind of port.
   */
  private sendUnscheduled(packet: Uint8Array): void {
    if (this.port.supportsCancel || this.lastStampedAtMs <= this.time.now()) {
      this.port.send(packet);
      return;
    }
    this.lastStampedAtMs += UNSCHEDULED_SEND_SPACING_MS;
    this.port.send(packet, this.lastStampedAtMs);
  }

  /** Drops whatever has already reached its scheduled delivery time, so the ring never holds more
   *  than a tempo change could actually still catch. Compacts in place, keeping the order of what
   *  stays; the slots that leave the live range are swapped, not discarded, so each is reused. */
  private pruneCommittedHostSends(nowMs: number): void {
    let kept = 0;
    for (let index = 0; index < this.committedCount; index++) {
      const slot = this.slots[index];
      if (slot.scheduledAtMs > nowMs) {
        this.slots[index] = this.slots[kept];
        this.slots[kept] = slot;
        kept++;
      }
    }
    this.committedCount = kept;
  }

  /** The slot the next tracked send is packed into, once the ring has been pruned. A full ring gives
   *  up its oldest live slot: that send stops being tracked, so a later `retime()` does not re-send
   *  it. It is the soonest due, so it is the one least worth keeping. The caller counts the slot in
   *  with `committedCount++` after the send. */
  private acquireSlot(): CommittedSlot {
    if (this.committedCount === this.slots.length) {
      const oldest = this.slots[0];
      this.slots.copyWithin(0, 1);
      this.slots[this.slots.length - 1] = oldest;
      this.committedCount--;
    }
    return this.slots[this.committedCount];
  }

  /** Adds slots until the ring can hold every send that can be outstanding: the schedule-ahead over
   *  the shortest frame interval seen, plus a little. Never shrinks, and never runs on the tick. */
  private growRing(): void {
    const outstanding = Math.ceil(this.scheduleAheadMsValue / this.shortestFrameIntervalMs) + 2;
    const wanted = Math.min(MAX_RING_SLOTS, Math.max(MIN_RING_SLOTS, outstanding));
    while (this.slots.length < wanted) {
      this.slots.push(createSlot());
    }
  }

  private inFlightCount(nowMs: number): number {
    let count = 0;
    for (let index = 0; index < this.committedCount; index++) {
      if (this.slots[index].scheduledAtMs > nowMs) {
        count++;
      }
    }
    return count;
  }
}

/** Builds an ASID sink over an injected `MidiOutputPort`, reading time from the host's
 *  `TimeSource` and reporting rejected input to `log` (silent when absent). The class itself is not
 *  exported — `AsidSink` is the contract a consumer builds against. */
export function createAsidSink(
  port: MidiOutputPort,
  options: {
    readonly time: TimeSource;
    readonly scheduleAheadMs?: Milliseconds;
    readonly log?: EngineLog;
  },
): AsidSink {
  return new AsidSinkImpl(
    port,
    options.time,
    options.log,
    options.scheduleAheadMs ?? milliseconds(0),
  );
}
