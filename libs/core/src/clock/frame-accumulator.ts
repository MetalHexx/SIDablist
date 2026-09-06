import { frames, microseconds, type Frames, type Microseconds } from '../units.js';

/**
 * The most catch-up a single `advance` may credit after a stall.
 *
 * Catching up is normally self-correcting: the far end drained frames while the clock was
 * stalled, so crediting exactly what elapsed puts its queue back where it was. That stops holding
 * past the point where the far end would have underflowed and re-buffered on its own — beyond
 * there the queue has already refilled itself, and a burst on top of it overflows rather than
 * restores. 250 ms is comfortably past every buffer size a sink offers at frame rates this engine
 * runs.
 *
 * It also bounds how far a frame's `lagUs` can be trusted. A gap longer than this credits less
 * time than really passed, so the frames it releases are anchored up to `(gap − 250 ms)` later
 * than they truly fell due. Playback is unharmed — every one of them is in the past and goes out
 * at once — but a lag measured against those due times under-reports by that much, which is why
 * `advance` reports whether it clamped rather than leaving it to be averaged into a timing figure.
 */
export const MAX_CATCH_UP_US: Microseconds = microseconds(250_000);

/**
 * Turns elapsed time into frame ticks.
 *
 * Split out from any concrete clock because this is the arithmetic that decides how many frames
 * an elapsed span owes, and it is worth exercising without a timing source in the way.
 */
export class FrameAccumulator {
  private intervalUs: Microseconds;
  private accumulatorUs = 0;
  private frameCount = 0;
  private nominalUsEmitted = 0;

  constructor(intervalUs: Microseconds) {
    assertPositiveInterval(intervalUs);
    this.intervalUs = intervalUs;
  }

  get nominalIntervalUs(): Microseconds {
    return this.intervalUs;
  }

  get framesEmitted(): Frames {
    return frames(this.frameCount);
  }

  /** The time the emitted frames were supposed to take, summed at the interval in force for each. */
  get nominalElapsedUs(): Microseconds {
    return microseconds(this.nominalUsEmitted);
  }

  /** @throws {RangeError} when `intervalUs` is not a positive finite number. */
  setIntervalUs(intervalUs: Microseconds): void {
    assertPositiveInterval(intervalUs);
    this.intervalUs = intervalUs;
  }

  /**
   * Adds `elapsedUs` of time, clamped to `MAX_CATCH_UP_US`, and fires every frame that now falls
   * due.
   *
   * More than one frame can fall inside a single advance at short intervals, or after a caller
   * hands over a long measured gap, and they must all fire — so this bursts several ticks back to
   * back. Absorbing bursts is exactly what a downstream queue is for.
   *
   * Each frame reports `lagUs`: how long before the end of the credited span it fell due. That is
   * exactly what remains in the accumulator once the frame's interval has come out of it, so a
   * caller holding the time the span ended can place every frame in the burst — one interval apart
   * rather than all at the instant the advance happened to run.
   *
   * Returns whether this call's elapsed time was clamped by `MAX_CATCH_UP_US`. The flag describes
   * the whole advance rather than any one frame in it, since every frame it releases came from the
   * same clamped span.
   */
  advance(elapsedUs: Microseconds, onFrame: (lagUs: Microseconds) => void): boolean {
    const catchUpClamped = elapsedUs > MAX_CATCH_UP_US;
    this.accumulatorUs += Math.min(elapsedUs, MAX_CATCH_UP_US);
    while (this.accumulatorUs >= this.intervalUs) {
      this.accumulatorUs -= this.intervalUs;
      this.frameCount++;
      this.nominalUsEmitted += this.intervalUs;
      onFrame(microseconds(this.accumulatorUs));
    }
    return catchUpClamped;
  }
}

function assertPositiveInterval(intervalUs: number): void {
  if (!Number.isFinite(intervalUs) || intervalUs <= 0) {
    throw new RangeError(`frame interval ${intervalUs} µs must be a positive finite number`);
  }
}
