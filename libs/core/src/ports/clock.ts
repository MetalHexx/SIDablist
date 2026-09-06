import type { Microseconds, Milliseconds } from '../units.js';

/**
 * Emits frame-due callbacks at a settable cadence. Pinned to what the shipped implementation
 * already provides, because a concrete adapter has to satisfy it unchanged. It must not assume
 * the strictest case: it states *this frame is due at T* and leaves precision to the
 * implementation, because ASID needs host-clock precision while a DMA far end keeps its own time
 * and needs only a correct average rate.
 */
export interface FrameClock {
  /** `dueAtMs` is when the frame fell due on the `performance.now()` timeline, which is
   *  *before* the tick that releases it — a callback releases every frame that fell inside
   *  the span it credits, so frames arrive in bursts carrying due times one interval apart.
   *  `catchUpClamped` marks a frame released from a span crediting less than the time really
   *  elapsed, whose due time is therefore later than the truth. */
  start(
    intervalUs: Microseconds,
    onFrame: (dueAtMs: Milliseconds, catchUpClamped: boolean) => void,
  ): Promise<void>;
  /** Takes effect on the next tick, without a restart and without dropping the accumulator. */
  setIntervalUs(intervalUs: Microseconds): void;
  stop(): void;
  readonly stats: FrameClockStats;
}

/** Cadence measurements a clock accumulates as it runs frames — a verbatim move of the shipped
 *  shape, comments included. */
export interface FrameClockStats {
  readonly framesEmitted: number;
  readonly measuredMeanIntervalUs: Microseconds;
  readonly nominalIntervalUs: Microseconds;
  /** Accumulated difference between where the clock thinks it is and real elapsed time. */
  readonly driftMs: Milliseconds;
  /** Standard deviation of the callback gap — how far the clock's cadence scatters around
   *  the interval it was asked for. */
  readonly jitterMs: Milliseconds;
  readonly worstGapMs: Milliseconds;
  /** Callbacks that arrived more than 2x the nominal buffer duration late. */
  readonly lateCallbacks: number;
}
