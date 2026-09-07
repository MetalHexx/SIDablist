import type { FrameClockStats } from '../ports/clock.js';
import { microseconds, milliseconds, type Microseconds, type Milliseconds } from '../units.js';
import type { FrameAccumulator } from './frame-accumulator.js';

const MICROSECONDS_PER_MILLISECOND = 1000;

/** A callback gap beyond this multiple of the nominal buffer duration counts as late. */
export const LATE_CALLBACK_FACTOR = 2;

/**
 * The running callback-gap bookkeeping behind `FrameClock.stats`.
 *
 * A concrete clock feeds it the gaps between its own callbacks and the elapsed time it has
 * measured; it alone knows its own timing source. This is only the arithmetic those measurements
 * turn into — jitter as the gap's population standard deviation, the worst single gap, how many
 * gaps ran later than `lateThresholdMs`, the measured mean interval, and drift against the nominal
 * grid — split out so it exercises without a timing source in the way.
 */
export interface ClockStats {
  /** Records one callback-to-callback gap, in milliseconds. */
  recordGap(gapMs: Milliseconds): void;

  /**
   * Standard deviation of the recorded gaps.
   *
   * The mean interval and the drift can both look healthy while individual callbacks scatter, and
   * it is the scatter that empties a downstream queue: no callback means no packet, and a queue
   * that runs dry re-buffers. Measured on the callback rather than on emitted frames so the figure
   * means the same thing whatever multispeed the tune carries.
   *
   * Population standard deviation from the running sums, floored at 0 against float cancellation.
   */
  readonly jitterMs: Milliseconds;

  /**
   * The longest single recorded gap.
   *
   * The number that actually catches a rare dropout: one stall barely moves the standard
   * deviation but empties any buffer outright.
   */
  readonly worstGapMs: Milliseconds;

  /**
   * How many gaps ran later than `lateThresholdMs`.
   *
   * `worstGapMs` is a running maximum that never decays, so a single spike sets it for the session
   * and cannot be told apart from a constant problem. This is the frequency alongside it.
   */
  readonly lateCallbacks: number;

  /**
   * Assembles the full `FrameClockStats` snapshot: the gap-based figures above, plus the measured
   * mean interval and drift, which come from `accumulator`'s own bookkeeping compared against
   * `measuredElapsedUs` — the real time a concrete clock has measured since it started.
   *
   * Now that a clock advances on measured time, drift is the check on that: frames fall due
   * against the wall clock, so a healthy stream holds it near zero. A figure that climbs steadily
   * means the engine is emitting at a different rate from the one it advertises downstream.
   */
  toFrameClockStats(
    accumulator: FrameAccumulator,
    measuredElapsedUs: Microseconds,
  ): FrameClockStats;
}

/** Builds a `ClockStats` that counts a gap later than `lateThresholdMs` as late. */
export function createClockStats(lateThresholdMs: Milliseconds): ClockStats {
  return new ClockStatsImpl(lateThresholdMs);
}

class ClockStatsImpl implements ClockStats {
  // Running sums rather than a kept list of samples: a concrete clock updates this on its own
  // callback, where allocating per tick is exactly the jitter it is trying to measure.
  private gapCount = 0;
  private gapSumMs = 0;
  private gapSumSqMs = 0;
  private worstGapMsValue = 0;
  private lateCallbacksCount = 0;

  constructor(private readonly lateThresholdMs: Milliseconds) {}

  recordGap(gapMs: Milliseconds): void {
    this.gapCount++;
    this.gapSumMs += gapMs;
    this.gapSumSqMs += gapMs * gapMs;
    if (gapMs > this.worstGapMsValue) this.worstGapMsValue = gapMs;
    if (gapMs > this.lateThresholdMs) this.lateCallbacksCount++;
  }

  get jitterMs(): Milliseconds {
    if (this.gapCount < 2) return milliseconds(0);
    const mean = this.gapSumMs / this.gapCount;
    return milliseconds(Math.sqrt(Math.max(0, this.gapSumSqMs / this.gapCount - mean * mean)));
  }

  get worstGapMs(): Milliseconds {
    return milliseconds(this.worstGapMsValue);
  }

  get lateCallbacks(): number {
    return this.lateCallbacksCount;
  }

  toFrameClockStats(
    accumulator: FrameAccumulator,
    measuredElapsedUs: Microseconds,
  ): FrameClockStats {
    const framesEmitted = accumulator.framesEmitted;
    const measuredMeanIntervalUs =
      framesEmitted === 0 ? microseconds(0) : microseconds(measuredElapsedUs / framesEmitted);
    const driftMs = milliseconds(
      (measuredElapsedUs - accumulator.nominalElapsedUs) / MICROSECONDS_PER_MILLISECOND,
    );

    return {
      framesEmitted,
      measuredMeanIntervalUs,
      nominalIntervalUs: accumulator.nominalIntervalUs,
      driftMs,
      jitterMs: this.jitterMs,
      worstGapMs: this.worstGapMs,
      lateCallbacks: this.lateCallbacks,
    };
  }
}
