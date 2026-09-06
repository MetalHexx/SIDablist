import type { Frames, Microseconds, Milliseconds } from '../units.js';
import type { PlayRate, TimingMode } from '../clock/play-rate.js';
import type { FrameClockStats } from '../ports/clock.js';
import type { FarEndConsumption, SinkCapabilities } from '../ports/sink.js';

/**
 * The read side of `SidPlayer`: everything a consumer's change detection should wake up for,
 * grouped into named objects rather than a flat property bag so a field P07-T02 adds lands inside
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
  } | null;
  readonly tempo: {
    readonly multiplier: number;
    readonly effectiveIntervalUs: Microseconds;
    readonly nominalIntervalUs: Microseconds;
    readonly callsPerFrame: number;
    readonly rate: PlayRate;
    readonly timingMode: TimingMode;
  };
  readonly loop: { readonly startFrame: Frames; readonly endFrame: Frames } | null;
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
 * This is the base shape; P07-T02 adds further groups additively and must not repurpose any of the
 * ones already here. Packets and bytes sent, cancel support and last-cancel latency are the sink's
 * own counters, not this one — a consumer that wants them asks the sink it constructed.
 */
export interface PlayerStats {
  readonly framesRendered: Frames;
  readonly clock: FrameClockStats;
  /** What the clock is actually pacing at, which differs from what the fader asked for only while
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
}
