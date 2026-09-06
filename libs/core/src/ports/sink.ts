import type { Frames, Microseconds, Milliseconds } from '../units.js';
import type { SidFrame } from '../registers/sid-frame.js';
import type { SidModel } from '../sid/sid-file.model.js';

/** What a sink can and cannot do, so core adapts instead of finding out at run time. A sink that
 *  cannot honour a capability reports it and ignores the request — it does not throw, and core
 *  does not check before calling. */
export interface SinkCapabilities {
  /** Whether the sink can honour a per-write time offset. ASID cannot; DMA can. */
  readonly perWriteOffsets: boolean;
  /** Whether a pending, not-yet-sent frame can be withdrawn. */
  readonly cancellation: boolean;
  /** How far ahead the sink will accept frames, if it has an opinion. */
  readonly scheduleAheadMs: Milliseconds | null;
}

/** What the far end has consumed. `'unknown'` is a legitimate answer, not a failure —
 *  but a sink that knows its own in-flight depth must report it. */
export type FarEndConsumption =
  | { readonly kind: 'unknown'; readonly inFlight: number }
  | { readonly kind: 'known'; readonly consumedThroughFrame: Frames; readonly inFlight: number };

/**
 * A far end that consumes SID register writes: ASID over MIDI today, a DMA cartridge later.
 * Shaped from the richer transport's side even though only one sink exists to satisfy it —
 * widening a one-way contract later means rewriting both ends.
 *
 * `begin`/`end`/`deliverNow` exist because the engine has a control path today, unscheduled and
 * unmeasured by design: a stop packet on load-while-playing, on a clock-start failure, on stop, on
 * end-of-track and on dispose; a chip-model packet followed by a start packet on play; and a
 * voice-gate-off frame on pause. A contract with only `deliver` cannot express them, and without
 * them the far end is never told to enter or leave play mode.
 *
 * The three are named for what they mean to the *timeline*, not for what a sink puts on the wire.
 * A DMA sink arms and disarms its C64-side player in `begin`/`end`; ASID sends packets. Neither
 * name mentions a packet.
 */
export interface SidSink {
  /** A getter, not a frozen object. `cancellation` tracks a port that can be swapped or
   *  reconnected under the sink with no call back in, and `scheduleAheadMs` reports the
   *  value actually in force after clamping — both are live. */
  readonly capabilities: SinkCapabilities;

  /** The far end should prepare to receive frames. Called once before the first frame of
   *  a run. `chipModel` comes from the tune's own header, which is why core supplies it and
   *  the sink does not go looking: ASID forwards it as its own packet, a DMA sink may ignore
   *  it entirely. */
  begin(tune: { readonly chipModel: SidModel }): void;
  /** The far end should stop. Called on pause, stop, end-of-track and dispose. */
  end(): void;

  /** Hands one frame over with the host time it is due, on the same timeline the clock
   *  reports (`performance.now()` milliseconds). `frameNumber` is the timeline position this
   *  frame represents — it is what lets a sink that can read its far end say *what* was
   *  consumed rather than only how much is outstanding. `catchUpClamped` marks a frame whose
   *  due time is later than the truth because its clock advance hit the catch-up ceiling —
   *  a sink measuring lag under-reports for those and needs to know. The frame's buffers
   *  are reused: a sink that outlives the call must copy. */
  deliver(
    frame: SidFrame,
    frameNumber: Frames,
    dueAtMs: Milliseconds,
    catchUpClamped: boolean,
  ): void;

  /** Sends one frame immediately — outside the schedule, outside lag measurement, ahead of
   *  anything already queued. This is the gate-off a pause needs: it has no due time, and
   *  queueing it behind scheduled frames would let the voices ring on until they drained. */
  deliverNow(frame: SidFrame): void;

  /** Re-times or withdraws whatever is still outstanding after a tempo change.
   *  A sink with no scheduling of its own implements this as a no-op. */
  retime(intervalUs: Microseconds): void;
  /** Drops everything outstanding without playing it. Does not itself stop the far end —
   *  that is `end()`, and the two are separate because a seek resets without stopping. */
  reset(): void;
  readAt(): FarEndConsumption;
}
