import { describe, it, expect } from 'vitest';
import { ClockStats } from './clock-stats.js';
import { FrameAccumulator } from './frame-accumulator.js';
import { microseconds, milliseconds } from '../units.js';

describe('ClockStats', () => {
  describe('jitterMs', () => {
    it('reports zero rather than dividing by zero before two gaps have landed', () => {
      const stats = new ClockStats(milliseconds(100));

      expect(stats.jitterMs).toBe(0);
      expect(stats.worstGapMs).toBe(0);

      stats.recordGap(milliseconds(5));

      expect(stats.jitterMs).toBe(0);
    });

    it('reports no scatter when every gap is the same width', () => {
      const stats = new ClockStats(milliseconds(100));

      for (let i = 0; i < 10; i++) stats.recordGap(milliseconds(5));

      expect(stats.jitterMs).toBeCloseTo(0);
      expect(stats.worstGapMs).toBeCloseTo(5);
    });

    it('rises when a stall widens the scatter, without the worst gap losing the spike to the average', () => {
      const evenOnly = new ClockStats(milliseconds(1000));
      for (let i = 0; i < 100; i++) evenOnly.recordGap(milliseconds(5));
      const evenJitter = evenOnly.jitterMs;

      const withStall = new ClockStats(milliseconds(1000));
      for (let i = 0; i < 50; i++) withStall.recordGap(milliseconds(5));
      withStall.recordGap(milliseconds(200));
      for (let i = 0; i < 50; i++) withStall.recordGap(milliseconds(5));

      // The point of carrying both figures — σ rises but stays modest, while the gap that would
      // empty any downstream buffer is plainly visible in the running maximum.
      expect(withStall.jitterMs).toBeGreaterThan(evenJitter);
      expect(withStall.worstGapMs).toBeCloseTo(200);
    });

    it('never decays once the worst gap has been set, unlike jitter which is an average', () => {
      const stats = new ClockStats(milliseconds(1000));
      for (let i = 0; i < 20; i++) stats.recordGap(milliseconds(5));
      stats.recordGap(milliseconds(300));
      const worstAfterSpike = stats.worstGapMs;

      for (let i = 0; i < 100; i++) stats.recordGap(milliseconds(5));

      expect(stats.worstGapMs).toBe(worstAfterSpike);
    });
  });

  describe('lateCallbacks', () => {
    it('counts only gaps past the threshold, separating a spike from a recurring one', () => {
      const stats = new ClockStats(milliseconds(10));

      stats.recordGap(milliseconds(5));
      expect(stats.lateCallbacks).toBe(0);

      stats.recordGap(milliseconds(40));
      stats.recordGap(milliseconds(40));

      expect(stats.lateCallbacks).toBe(2);
    });
  });

  describe('toFrameClockStats', () => {
    it('reports drift near zero when measured time tracks the nominal grid', () => {
      const accumulator = new FrameAccumulator(microseconds(20000));
      accumulator.advance(microseconds(60000), () => undefined);
      const stats = new ClockStats(milliseconds(1000));

      const snapshot = stats.toFrameClockStats(accumulator, microseconds(60000));

      expect(snapshot.framesEmitted).toBe(3);
      expect(snapshot.driftMs).toBeCloseTo(0);
      expect(snapshot.nominalIntervalUs).toBe(20000);
    });

    it('holds drift bounded rather than letting it accumulate with runtime', () => {
      const accumulator = new FrameAccumulator(microseconds(20000));
      const stats = new ClockStats(milliseconds(1000));
      const gapUs = 7000; // does not divide the interval evenly, so a remainder is always in flight
      let measuredElapsedUs = 0;

      for (let i = 0; i < 50; i++) {
        accumulator.advance(microseconds(gapUs), () => undefined);
        measuredElapsedUs += gapUs;
      }
      const early = Math.abs(
        stats.toFrameClockStats(accumulator, microseconds(measuredElapsedUs)).driftMs,
      );

      for (let i = 0; i < 450; i++) {
        accumulator.advance(microseconds(gapUs), () => undefined);
        measuredElapsedUs += gapUs;
      }
      const late = Math.abs(
        stats.toFrameClockStats(accumulator, microseconds(measuredElapsedUs)).driftMs,
      );

      // Bounded by the frame still accumulating — one interval's worth — and no larger after nine
      // times the runtime, unlike a clock that drifts by a fixed fraction of elapsed time.
      expect(early).toBeLessThan(20);
      expect(late).toBeLessThan(20);
    });

    it('reports the measured mean interval as measured elapsed time over frames emitted', () => {
      const accumulator = new FrameAccumulator(microseconds(20000));
      accumulator.advance(microseconds(100000), () => undefined);
      const stats = new ClockStats(milliseconds(1000));

      const snapshot = stats.toFrameClockStats(accumulator, microseconds(100000));

      expect(snapshot.measuredMeanIntervalUs).toBeCloseTo(20000, 5);
    });

    it('reports a zero mean interval rather than dividing by zero before any frame has fallen due', () => {
      const accumulator = new FrameAccumulator(microseconds(20000));
      const stats = new ClockStats(milliseconds(1000));

      const snapshot = stats.toFrameClockStats(accumulator, microseconds(500));

      expect(snapshot.measuredMeanIntervalUs).toBe(0);
    });
  });
});
