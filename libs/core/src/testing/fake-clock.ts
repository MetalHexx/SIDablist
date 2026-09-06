import type { FrameClock, FrameClockStats } from '../ports/clock.js';
import { microseconds, milliseconds, type Microseconds, type Milliseconds } from '../units.js';

type OnFrame = (dueAtMs: Milliseconds, catchUpClamped: boolean) => void;

/**
 * Drives a `FrameClock` consumer without a real timer: a test calls `tick` to fire exactly one
 * frame-due callback, at whatever `dueAtMs`/`catchUpClamped` it chooses.
 */
export class FakeClock implements FrameClock {
  private intervalUs: Microseconds = microseconds(0);
  private onFrame: OnFrame | null = null;
  private framesEmitted = 0;

  start(intervalUs: Microseconds, onFrame: OnFrame): Promise<void> {
    this.intervalUs = intervalUs;
    this.onFrame = onFrame;
    return Promise.resolve();
  }

  setIntervalUs(intervalUs: Microseconds): void {
    this.intervalUs = intervalUs;
  }

  stop(): void {
    this.onFrame = null;
  }

  /** Fires one frame-due callback as if it arrived at `dueAtMs`. Throws if `start` has not been
   *  called — mirrors a real clock having nothing to release before it starts. */
  tick(dueAtMs: Milliseconds, catchUpClamped = false): void {
    if (this.onFrame === null) throw new Error('FakeClock.tick called before start()');
    this.framesEmitted++;
    this.onFrame(dueAtMs, catchUpClamped);
  }

  get stats(): FrameClockStats {
    return {
      framesEmitted: this.framesEmitted,
      measuredMeanIntervalUs: this.intervalUs,
      nominalIntervalUs: this.intervalUs,
      driftMs: milliseconds(0),
      jitterMs: milliseconds(0),
      worstGapMs: milliseconds(0),
      lateCallbacks: 0,
    };
  }
}
