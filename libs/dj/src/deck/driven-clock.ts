import { microseconds, milliseconds } from '@sidablist/core';
import type {
  FrameClock,
  FrameClockStats,
  Microseconds,
  Milliseconds,
  TimeSource,
} from '@sidablist/core';
import { CLOCK_DUE_MS, CLOCK_INTERVAL_US, CLOCK_TICKS } from './deck-state.js';

type OnFrame = (dueAtMs: Milliseconds, catchUpClamped: boolean) => void;

/**
 * The `FrameClock` a deck's engine is given, ticked only by the deck: it fires nothing of its own,
 * so the deck decides how far ahead of the sink's time it renders and a rewind can re-render a
 * frame at the due time the original had.
 *
 * Its due time, interval and tick count live in `cells`, the deck state's own array, so saving the
 * state saves the clock and a restore puts it back. `started` is the engine's to change (it starts
 * the clock on `play()` and stops it on a halt) and is not part of the saved state.
 */
export class DrivenClock implements FrameClock {
  private onFrame: OnFrame | null = null;
  private running = false;
  /** The interval the last tick advanced by: a double kept in a typed array, which never boxes. */
  private readonly lastStep = new Float64Array(1);

  constructor(
    private readonly time: TimeSource,
    private readonly cells: Float64Array,
  ) {}

  /** Whether the engine has started the clock and not stopped it since. */
  get started(): boolean {
    return this.running;
  }

  /** When the next frame is due, on the `TimeSource` timeline. */
  get nextDueMs(): number {
    return this.cells[CLOCK_DUE_MS];
  }

  /** The interval the last `tick` was paced at, in microseconds. */
  get lastStepUs(): number {
    return this.lastStep[0];
  }

  /** Keeps `onFrame` and the interval, and makes the first frame due now. */
  start(intervalUs: Microseconds, onFrame: OnFrame): Promise<void> {
    this.onFrame = onFrame;
    this.running = true;
    this.cells[CLOCK_INTERVAL_US] = intervalUs;
    this.cells[CLOCK_DUE_MS] = this.time.now();
    return Promise.resolve();
  }

  /** Changes the step from the next tick on, without moving the due time. */
  setIntervalUs(intervalUs: Microseconds): void {
    this.cells[CLOCK_INTERVAL_US] = intervalUs;
  }

  stop(): void {
    this.running = false;
    this.onFrame = null;
  }

  /** Moves the next due time to `ms`, for a deck that fell too far behind to render the frames it missed. */
  skipTo(ms: number): void {
    this.cells[CLOCK_DUE_MS] = ms;
  }

  /**
   * Fires one frame: `onFrame` with the due time, then the due time moves on by the interval the
   * tick started with. A change the engine makes to the interval during the tick takes effect from
   * the next one. Does nothing when the clock is not started.
   */
  tick(catchUpClamped: boolean): void {
    const onFrame = this.onFrame;
    if (onFrame === null) return;
    const cells = this.cells;
    const dueMs = cells[CLOCK_DUE_MS];
    const stepUs = cells[CLOCK_INTERVAL_US];
    this.lastStep[0] = stepUs;
    cells[CLOCK_TICKS]++;
    onFrame(milliseconds(dueMs), catchUpClamped);
    cells[CLOCK_DUE_MS] = dueMs + stepUs / 1000;
  }

  get stats(): FrameClockStats {
    const intervalUs = microseconds(this.cells[CLOCK_INTERVAL_US]);
    return {
      framesEmitted: this.cells[CLOCK_TICKS],
      measuredMeanIntervalUs: intervalUs,
      nominalIntervalUs: intervalUs,
      driftMs: milliseconds(0),
      jitterMs: milliseconds(0),
      worstGapMs: milliseconds(0),
      lateCallbacks: 0,
    };
  }
}
