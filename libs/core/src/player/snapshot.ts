import type { Cycles, Frames, Microseconds, Milliseconds } from '../units.js';
import type { PlayRate, TimingMode } from '../clock/play-rate.js';
import type { FrameClockStats } from '../ports/clock.js';
import type { FarEndConsumption, SinkCapabilities } from '../ports/sink.js';
import type { SidField } from '../registers/sid-fields.js';
import type { ActiveLoop, VarispeedLoopStart } from '../timeline/active-loop.js';

/** A jump the host queued for the end of the running loop's current lap: a loop when
 *  `endFrame` is set, a cue (play on from `startFrame`, no loop) when it is null. */
export interface QueuedJump {
  readonly startFrame: Frames;
  readonly endFrame: Frames | null;
  /** How varispeed holds the queued loop once it is running — see `ActiveLoop`. Means something
   *  only when `endFrame` is set. */
  readonly varispeedStart?: VarispeedLoopStart;
}

/** Output-stage settings a jump applies as it lands, in the engine's own terms. It applies
 *  exactly what it lists and leaves every other setting as it is. Tempo and the momentary voice
 *  holds are never part of it. */
export interface JumpSettings {
  /** Voice 0…2's pitch coefficient, by index — see `setVoicePitch`. A voice past the end of a
   *  shorter array keeps its own. */
  readonly voicePitch?: readonly number[];
  /** Fields offset by a signed amount in their raw units — see `setFieldOffset`; 0 hands one back. */
  readonly fieldOffsets?: readonly { readonly field: SidField; readonly amount: number }[];
  /** Fields held at a raw value, `amount` 0…1 (default 1) — see `holdField` — or released when
   *  `value` is null. */
  readonly fieldHolds?: readonly {
    readonly field: SidField;
    readonly value: number | null;
    readonly amount?: number;
  }[];
  /** Voice 0…2's latched mute, by index — see `setVoiceMuted`. A voice past the end of a
   *  shorter array keeps its own. */
  readonly voiceMutes?: readonly boolean[];
}

/**
 * The read side of `SidPlayer`: everything a consumer's change detection should wake up for,
 * grouped into named objects rather than a flat property bag so a field added later lands inside
 * its group instead of forcing every existing field to shift.
 *
 * `positionPercent` is deliberately absent — it derives from `getPosition()`, which is a pulled
 * read the consumer makes on its own schedule, so the consumer computes the percentage itself from
 * that read and `basis` rather than have it ride the subscription.
 */
export interface PlayerSnapshot {
  readonly transport: 'stopped' | 'playing' | 'paused' | 'ended' | 'error';
  readonly tune: {
    readonly subtune: number;
    readonly subtuneCount: number;
    readonly lengthFrames: Frames | null;
    /** Declared jump frames whose snapshot is ready, ascending. */
    readonly preparedFrames: readonly Frames[];
    /** The jump queued for the end of the running loop's lap, or null. */
    readonly queuedJump: QueuedJump | null;
    /** How many queued jumps the engine has handed off to since this tune and subtune loaded. It
     *  increments once per hand-off and never on a cancel, a replace or a clear, so a host can tell
     *  a landing from a dropped queue. */
    readonly handOffs: number;
    /** The register record's length in play calls, or null without a record. */
    readonly recordedFrames: Frames | null;
  } | null;
  readonly tempo: {
    readonly multiplier: number;
    readonly effectiveIntervalUs: Microseconds;
    readonly nominalIntervalUs: Microseconds;
    readonly callsPerFrame: number;
    readonly rate: PlayRate;
    readonly timingMode: TimingMode;
    /** True from `enterVarispeed` until live playback or the paused landing takes over. The rate
     *  that drives it is never published: it moves every tick. */
    readonly varispeed: boolean;
  };
  readonly loop: ActiveLoop;
  readonly voices: readonly { readonly muted: boolean; readonly held: boolean }[];
  /** What the playhead is measured against, and where the track ends — both derived from the
   *  track structure the application supplied. */
  readonly basis: {
    readonly positionBasisFrames: Frames;
    readonly ceilingFrames: Frames;
    readonly trackEndFrame: Frames | null;
  };
  readonly repeatTrack: boolean;
  readonly error: string | null;
}

/**
 * Counters and measurements pulled by `getStats()`, never pushed through `subscribe` — the same
 * split as `getPosition()`, and for the same reason: they move every frame, and forcing that
 * through change detection would wake every consumer to tell it something it can already ask for.
 *
 * Grouped by name rather than flattened, so a field a later change adds lands inside its own group
 * instead of shifting every one already here — never repurpose an existing field for a new meaning.
 * Packets and bytes sent, cancel support and last-cancel latency are the sink's own counters, not
 * this one — a consumer that wants them asks the sink it constructed.
 */
export interface PlayerStats {
  readonly framesRendered: Frames;
  readonly clock: FrameClockStats;
  /** What the clock is actually pacing at, which differs from what the tempo asked for only while
   *  nothing is playing. */
  readonly effectiveIntervalUs: Microseconds;
  /** Measured by core at the `deliver()` call site — see the measurement/scheduling split. */
  readonly delivery: {
    readonly scheduledFrames: number;
    readonly lateFrames: number;
    readonly meanLagMs: Milliseconds;
    readonly worstLagMs: Milliseconds;
    readonly reorderedFrames: number;
    readonly clampedFrames: number;
  };
  /** Read through from the sink, which is the only thing that knows them. */
  readonly sink: {
    readonly farEnd: FarEndConsumption;
    readonly capabilities: SinkCapabilities;
  };
  readonly suppressedWrites: number;
  readonly illegalOpcodeCount: number;
  /** How much of the frame's cycle budget the play routine actually spent, and the unused fraction
   *  of it, 0..1 — see `C64Machine.frameCycleBudget`. */
  readonly cpu: { readonly cyclesUsed: Cycles; readonly headroom: number };
  /** Voice 0/1/2's gate, waveform, frequency and envelope, decoded from the register shadow on read
   *  — see `RegisterFrame.voiceState`. */
  readonly voices: readonly {
    readonly gate: boolean;
    readonly waveform: number;
    readonly frequency: number;
    readonly envelope: number;
  }[];
  /** Every register as the tune wrote it versus as scaling would emit it this instant — see
   *  `RegisterFrame.emittedValues`. */
  readonly emitted: { readonly written: Uint8Array; readonly sent: Uint8Array };
  /** Whether a resync's gate-off step is still owed to the stream — 1 while `queueResync` is
   *  waiting for the next tick to release it, 0 once it has gone out. */
  readonly resync: { readonly inFlightDepth: number };
  /** The tune's multispeed exactly as its CIA timer latch describes it, alongside the integer form
   *  already published in `tempo.callsPerFrame` — see `C64Machine.exactCallsPerFrame`'s own doc for
   *  the rounding discrepancy this makes visible. */
  readonly rate: { readonly exactCallsPerFrame: number; readonly roundedCallsPerFrame: number };
}
