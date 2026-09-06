import { describe, it, expect } from 'vitest';
import { FrameAccumulator, MAX_CATCH_UP_US } from './frame-accumulator.js';
import { microseconds } from '../units.js';

describe('FrameAccumulator', () => {
  it('emits nothing until a whole interval has accumulated', () => {
    const accumulator = new FrameAccumulator(microseconds(20000));
    let frames = 0;

    accumulator.advance(microseconds(19999), () => frames++);

    expect(frames).toBe(0);
    expect(accumulator.framesEmitted).toBe(0);
  });

  it('emits every frame that falls inside one span when the interval is the shorter of the two', () => {
    const accumulator = new FrameAccumulator(microseconds(1000));
    let frames = 0;

    accumulator.advance(microseconds(5333), () => frames++);

    expect(frames).toBe(5);
    expect(accumulator.framesEmitted).toBe(5);
  });

  it('carries the remainder across advances rather than resetting it', () => {
    const accumulator = new FrameAccumulator(microseconds(20000));
    let frames = 0;
    const tick = () => frames++;

    // Three spans of 5333 µs is 15999 µs — one short — and the fourth crosses the interval.
    accumulator.advance(microseconds(5333), tick);
    accumulator.advance(microseconds(5333), tick);
    accumulator.advance(microseconds(5333), tick);
    expect(frames).toBe(0);

    accumulator.advance(microseconds(5333), tick);

    expect(frames).toBe(1);
  });

  it('applies a new interval on the next advance without dropping the accumulator', () => {
    const accumulator = new FrameAccumulator(microseconds(1000));
    let frames = 0;
    const tick = () => frames++;

    accumulator.advance(microseconds(900), tick);
    expect(frames).toBe(0);

    accumulator.setIntervalUs(microseconds(500));
    accumulator.advance(microseconds(200), tick);

    // The 900 µs already banked plus 200 µs is two 500 µs frames — the accumulator survived.
    expect(frames).toBe(2);
    expect(accumulator.nominalIntervalUs).toBe(500);
  });

  it('accounts nominal elapsed time at the interval in force for each frame', () => {
    const accumulator = new FrameAccumulator(microseconds(1000));
    const tick = () => undefined;

    accumulator.advance(microseconds(2000), tick);
    accumulator.setIntervalUs(microseconds(500));
    accumulator.advance(microseconds(1000), tick);

    expect(accumulator.framesEmitted).toBe(4);
    expect(accumulator.nominalElapsedUs).toBe(2000 + 1000);
  });

  it('reports a frame that lands on the end of the credited span as due right then', () => {
    const accumulator = new FrameAccumulator(microseconds(20000));
    const lags: number[] = [];

    accumulator.advance(microseconds(20000), (lagUs) => lags.push(lagUs));

    expect(lags).toEqual([0]);
  });

  it('reports how late a frame already was when the advance that released it ran', () => {
    const accumulator = new FrameAccumulator(microseconds(20000));
    const lags: number[] = [];

    accumulator.advance(microseconds(25000), (lagUs) => lags.push(lagUs));

    expect(lags).toEqual([5000]);
  });

  it('spaces two frames released by one advance an interval apart, both in the past', () => {
    const accumulator = new FrameAccumulator(microseconds(20000));
    const lags: number[] = [];

    // 45 ms banked at a 20 ms interval: the first frame fell due 25 ms before this advance ran, the
    // second 5 ms before it. They burst out together, but they describe two instants 20 ms apart.
    accumulator.advance(microseconds(45000), (lagUs) => lags.push(lagUs));

    expect(lags).toEqual([25000, 5000]);
    expect(lags[0] - lags[1]).toBe(20000);
  });

  it('measures lag against the interval in force when each frame fell due', () => {
    const accumulator = new FrameAccumulator(microseconds(1000));
    const lags: number[] = [];
    const record = (lagUs: number) => lags.push(lagUs);

    accumulator.advance(microseconds(900), record);
    accumulator.setIntervalUs(microseconds(500));
    accumulator.advance(microseconds(200), record);

    // The 1100 µs banked releases two 500 µs frames, so they sit 500 µs apart rather than 1000.
    expect(lags).toEqual([600, 100]);
  });

  it('spreads the catch-up a stall owes across the gap instead of stacking it at the end', () => {
    const accumulator = new FrameAccumulator(microseconds(10000));
    const lags: number[] = [];

    // The shape a long callback gap hands over: four frames owed, oldest first, evenly spaced and
    // every one of them already due.
    accumulator.advance(microseconds(45000), (lagUs) => lags.push(lagUs));

    expect(lags).toEqual([35000, 25000, 15000, 5000]);
  });

  it('rejects an interval that would never elapse', () => {
    expect(() => new FrameAccumulator(microseconds(0))).toThrow(RangeError);
    expect(() =>
      new FrameAccumulator(microseconds(1000)).setIntervalUs(microseconds(Number.NaN)),
    ).toThrow(RangeError);
  });

  describe('catch-up clamp', () => {
    it('does not clamp elapsed time within the ceiling', () => {
      const accumulator = new FrameAccumulator(microseconds(10000));

      const clamped = accumulator.advance(microseconds(45000), () => undefined);

      expect(clamped).toBe(false);
    });

    it('caps a very long stall to the ceiling rather than flooding the burst with frames', () => {
      const accumulator = new FrameAccumulator(microseconds(10000));
      let frames = 0;

      // Five seconds of elapsed time: only MAX_CATCH_UP_US of it may be credited.
      const clamped = accumulator.advance(microseconds(5_000_000), () => frames++);

      expect(clamped).toBe(true);
      expect(frames).toBe(MAX_CATCH_UP_US / 10000);
    });

    it('is trustworthy again on the next advance once the stall has passed', () => {
      const accumulator = new FrameAccumulator(microseconds(10000));

      const stalled = accumulator.advance(microseconds(5_000_000), () => undefined);
      const healthy = accumulator.advance(microseconds(10000), () => undefined);

      expect(stalled).toBe(true);
      expect(healthy).toBe(false);
    });
  });
});
