import type {
  SidSink,
  SinkCapabilities,
  FarEndConsumption,
  SidFrame,
  Frames,
  SidModel,
} from '@sidablist/core';
import type { Microseconds, Milliseconds } from '@sidablist/core';
import { milliseconds, MICROSECONDS_PER_SECOND } from '@sidablist/core';
import {
  buildDisplayCharsPacket,
  buildSidDataPacket,
  buildSidTypePacket,
  buildStartPacket,
  buildStopPacket,
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

/** One packet already handed to the port with a future delivery time — pruned as its delivery time
 *  passes. What a tempo change can still catch: `retime()` cancels the port's queue and re-sends
 *  exactly these, at the new spacing, rather than losing whatever they were carrying. */
interface CommittedHostSend {
  readonly packet: Uint8Array;
  readonly scheduledAtMs: Milliseconds;
}

class AsidSinkImpl implements AsidSink {
  private scheduleAheadMsValue: Milliseconds;
  private packetsSent = 0;
  private bytesSent = 0;
  private lastCancelLatencyMs = -1;
  private committedHostSends: CommittedHostSend[] = [];

  constructor(
    private readonly port: MidiOutputPort,
    scheduleAheadMs: Milliseconds,
  ) {
    this.scheduleAheadMsValue = scheduleAheadMs;
  }

  get capabilities(): SinkCapabilities {
    return {
      perWriteOffsets: false, // ASID has no per-write time offset on the wire
      cancellation: this.port.supportsCancel, // can flip on a port swap or reconnect
      scheduleAheadMs: this.effectiveScheduleAheadMs(), // the clamped value, not the requested one
      // One SID_DATA packet carries a whole frame's present/value slots in the firmware's fixed
      // slot order (`ASID_SLOT_TO_REGISTER`) — the far end applies them in that order regardless
      // of the order the writes arrived in, so cross-register arrival order never reaches the wire.
      preservesWriteOrder: false,
    };
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
      inFlight: this.inFlightCount(performance.now()),
    };
  }

  begin(tune: { readonly chipModel: SidModel }): void {
    // The header already told us the model; this sink forwards it as its own packet, immediately
    // before the start packet — the order the engine used pre-extraction.
    this.sendControl(buildSidTypePacket(CHIP_INDEX, tune.chipModel === 'mos8580'));
    this.sendControl(buildStartPacket());
  }

  end(): void {
    // Stopping supersedes anything still outstanding — nothing is coming to land it.
    this.committedHostSends = [];
    this.sendControl(buildStopPacket());
  }

  /** `frameNumber` and the contract's `catchUpClamped` are core's to know for delivery-against-
   *  due-time measurement (P05-T05, at the `deliver()` call site) — scheduling has no use for
   *  either, so `catchUpClamped` is not declared here at all. */
  deliver(frame: SidFrame, frameNumber: Frames, dueAtMs: Milliseconds): void {
    const packet = buildSidDataPacket(frame);
    const scheduledAtMs = milliseconds(dueAtMs + this.effectiveScheduleAheadMs());
    this.port.send(packet, scheduledAtMs);
    this.recordCommittedHostSend(packet, scheduledAtMs);
    this.packetsSent++;
    this.bytesSent += packet.length;
  }

  /** Packs and sends immediately, with no timestamp, ahead of anything scheduled — the pause
   *  gate-off's contract, and why this never touches `committedHostSends`. */
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
    const nowMs = performance.now();
    this.pruneCommittedHostSends(nowMs);
    if (this.committedHostSends.length === 0 || !this.port.supportsCancel) {
      return;
    }
    if (!this.port.cancelPending()) {
      return;
    }

    const outstanding = this.committedHostSends;
    // The furthest-out entry is the one that would have kept arriving longest without the cancel —
    // how far past this request it was still committed to land is the cancel's measured reach.
    this.lastCancelLatencyMs = Math.max(...outstanding.map((entry) => entry.scheduledAtMs)) - nowMs;
    this.committedHostSends = [];
    // `supportsCancel` is already confirmed true above, so this equals `scheduleAheadMsValue` —
    // read via the same helper `deliver` uses purely so both call sites agree on one source of
    // truth for "the window actually in effect right now."
    const aheadMs = this.effectiveScheduleAheadMs();
    const newIntervalMs = intervalUs / (MICROSECONDS_PER_SECOND / 1000);
    // The same `nowMs` the latency above was measured against: a second reading would put the
    // measurement and the first re-sent packet on two different anchors.
    let scheduledAtMs = nowMs + aheadMs;
    for (const { packet } of outstanding) {
      this.port.send(packet, scheduledAtMs);
      this.committedHostSends.push({ packet, scheduledAtMs: milliseconds(scheduledAtMs) });
      scheduledAtMs += newIntervalMs;
    }
  }

  /** Drops what is outstanding without sending a stop packet. Stopping the far end is `end()`, and
   *  the two are separate because a seek resets without stopping. */
  reset(): void {
    this.committedHostSends = [];
  }

  readAt(): FarEndConsumption {
    // ASID cannot know what the far end has consumed, but it does know its own in-flight depth.
    return { kind: 'unknown', inFlight: this.inFlightCount(performance.now()) };
  }

  showText(text: string): void {
    this.port.send(buildDisplayCharsPacket(text));
  }

  setScheduleAhead(ms: Milliseconds): void {
    if (!Number.isFinite(ms) || ms < 0) {
      console.warn(`ASID sink: ignoring a schedule-ahead of ${ms} ms.`);
      return;
    }
    const clamped = this.port.supportsCancel
      ? ms
      : milliseconds(Math.min(ms, UNCANCELLABLE_SCHEDULE_AHEAD_CEILING_MS));
    if (clamped !== ms) {
      console.warn(
        `ASID sink: clamped schedule-ahead from ${ms} ms to ${clamped} ms — the selected MIDI ` +
          `port cannot cancel a pending send, so a deeper window would risk stale-tempo frames ` +
          `playing out audibly.`,
      );
    }
    this.scheduleAheadMsValue = clamped;
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
    this.port.send(packet);
    this.packetsSent++;
    this.bytesSent += packet.length;
  }

  /** Drops whatever has already reached its scheduled delivery time, so `committedHostSends` never
   *  holds more than a tempo change could actually still catch. */
  private pruneCommittedHostSends(nowMs: number): void {
    this.committedHostSends = this.committedHostSends.filter(
      (entry) => entry.scheduledAtMs > nowMs,
    );
  }

  /** Records a send a tempo change could still catch — and only such a send. One whose delivery
   *  time has already passed, because the host stalled between the frame falling due and reaching
   *  this sink, has been handed over for immediate release: there is nothing left to cancel or
   *  re-time, so it never belonged in this collection. */
  private recordCommittedHostSend(packet: Uint8Array, scheduledAtMs: Milliseconds): void {
    const nowMs = performance.now();
    this.pruneCommittedHostSends(nowMs);
    if (scheduledAtMs > nowMs) {
      this.committedHostSends.push({ packet, scheduledAtMs });
    }
  }

  private inFlightCount(nowMs: number): number {
    return this.committedHostSends.reduce(
      (count, entry) => (entry.scheduledAtMs > nowMs ? count + 1 : count),
      0,
    );
  }
}

/** Builds an ASID sink over an injected `MidiOutputPort`. The class itself is not exported —
 *  `AsidSink` is the contract a consumer builds against. */
export function createAsidSink(
  port: MidiOutputPort,
  options?: { readonly scheduleAheadMs?: Milliseconds },
): AsidSink {
  return new AsidSinkImpl(port, options?.scheduleAheadMs ?? milliseconds(0));
}
