import { frames, type Frames } from '../units.js';

/**
 * What loop detection found for a tune, as the three fields a stored index record holds them in.
 *
 * Stated as one type rather than three positional arguments: a period, a start and an end are read
 * and set together, and three interchangeable nullable frame numbers in a row is exactly the
 * transposition hazard branded types exist to catch — but only if the caller cannot pass them in
 * the wrong order to begin with, which a single named-field argument guarantees and a run of
 * positional ones does not.
 */
export interface DetectedLoopFrames {
  readonly loopStartFrame: Frames | null;
  readonly loopPeriodFrames: Frames | null;
  readonly endedAtFrame: Frames | null;
}

/**
 * What core knows about a track beyond whatever loop it is presently enforcing: where the track's
 * own loop sits, where the track ends, and whether reaching that end should replay the track or
 * stop it.
 *
 * Holds one `DetectedLoopFrames | null` rather than the three fields separately, since they are
 * always read and written together — a stray write to one alone would desynchronise it from the
 * other two with nothing to catch the mistake.
 */
export interface TrackStructure {
  /**
   * Adopts a new detection, replacing whatever was held before.
   *
   * A loop period that is not a finite number greater than zero describes no lap, so the loop start
   * is dropped alongside it — a start with no period to pair it with is meaningless, not a
   * zero-length loop. An ended point that is not a finite number greater than zero is likewise
   * treated as no answer. A loop start of exactly 0 — a tune that repeats from its very first frame
   * — is valid and survives validation.
   *
   * Passing `null` clears every field, the same as a detection that found nothing.
   */
  setTrackStructure(detected: DetectedLoopFrames | null): void;
  /** Where the track's own loop begins, sanitised; null with no usable loop. Left undefaulted here
   *  — a caller that needs "0 when absent" (arming the loop, or `trackEndFrame` below) applies that
   *  default itself, since an absent start and an explicit 0 mean different things everywhere else. */
  loopStartFrame(): Frames | null;
  /** One lap of the track's own loop, sanitised; null with no usable loop. */
  loopPeriodFrames(): Frames | null;
  /** Where the track ends: loop start (defaulting to 0 when absent) plus period for a looping
   *  track, the end point for one that stopped instead, or null when detection answered neither. */
  trackEndFrame(): Frames | null;
  /** Whether reaching the track's end should replay the track (true) or stop it (false).
   *
   *  Player state, not tune state: untouched by `setTrackStructure`, and never read from storage —
   *  core holds only the value the application hands it, which it does at load time and whenever
   *  the operator changes the setting. Defaults to false, so a track new to this state stops at its
   *  end rather than looping without having been asked to. */
  repeatEnabled(): boolean;
  setRepeatEnabled(enabled: boolean): void;
}

/** A usable frame span: a finite number greater than zero, else null. */
function sanitizePositiveFrame(value: Frames | null): Frames | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** A usable loop start: a finite frame at or after the start of the tune, else null. Distinct from
 *  `sanitizePositiveFrame` because 0 — a tune that repeats from the very top — is a valid start. */
function sanitizeStartFrame(value: Frames | null): Frames | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function createTrackStructure(): TrackStructure {
  let loopStart: Frames | null = null;
  let loopPeriod: Frames | null = null;
  let endedAt: Frames | null = null;
  let repeat = false;

  return {
    setTrackStructure(detected: DetectedLoopFrames | null): void {
      const period = sanitizePositiveFrame(detected?.loopPeriodFrames ?? null);
      loopStart = period === null ? null : sanitizeStartFrame(detected?.loopStartFrame ?? null);
      loopPeriod = period;
      endedAt = sanitizePositiveFrame(detected?.endedAtFrame ?? null);
    },

    loopStartFrame: (): Frames | null => loopStart,
    loopPeriodFrames: (): Frames | null => loopPeriod,

    trackEndFrame(): Frames | null {
      if (loopPeriod === null) return endedAt;
      return frames((loopStart ?? 0) + loopPeriod);
    },

    repeatEnabled: (): boolean => repeat,
    setRepeatEnabled(enabled: boolean): void {
      repeat = enabled;
    },
  };
}
