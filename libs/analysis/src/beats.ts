import type { BeatGrid, DetectedBeatGrid } from './beat-grid.js';

/**
 * A grid a host keeps: a scan's, which holds over its span, or a bare one (a tapped grid), which holds
 * over the whole tune from frame 0.
 */
export type HeldGrid = BeatGrid | DetectedBeatGrid;

/** A frame count within this of a whole number is a whole number: a tapped grid carries float noise. */
const INDEX_TOLERANCE = 1e-9;
/** A frame is on a beat when the nearest beat is closer than this many frames. */
const ON_BEAT_FRAMES = 0.5;

/**
 * Whether `frame` is inside the span the grid holds over: `startFrame <= frame < endFrame` for a
 * scan's grid (no upper bound while its `endFrame` is null), `frame >= 0` for a bare one.
 */
export function inGridSpan(grid: HeldGrid, frame: number): boolean {
  if ('startFrame' in grid) {
    return frame >= grid.startFrame && frame < (grid.endFrame ?? Infinity);
  }
  return frame >= 0;
}

/**
 * The beat nearest `frame`, unrounded: among the beats either side of the one `frame` rounds to, the
 * nearest that is at or after frame 0 and inside the grid's span, the earlier on a tie. Null when
 * `frame` is outside the span, or no such beat exists.
 */
export function nearestBeat(grid: HeldGrid, frame: number): number | null {
  if (!inGridSpan(grid, frame)) {
    return null;
  }
  const index = Math.round((frame - grid.beatOneFrame) / grid.beatFrames);
  let best: number | null = null;
  for (let candidate = index - 1; candidate <= index + 1; candidate++) {
    const beat = grid.beatOneFrame + candidate * grid.beatFrames;
    if (beat < 0 || !inGridSpan(grid, beat)) {
      continue;
    }
    if (best === null || Math.abs(beat - frame) < Math.abs(best - frame)) {
      best = beat;
    }
  }
  return best;
}

/** Whether `frame` is on a beat: the nearest beat is less than half a frame away. */
export function onBeat(grid: HeldGrid, frame: number): boolean {
  const beat = nearestBeat(grid, frame);
  return beat !== null && Math.abs(beat - frame) < ON_BEAT_FRAMES;
}

/**
 * The first beat strictly after (`direction` 1) or before (-1) `frame`, unrounded. Null when that
 * beat is below frame 0 or outside the grid's span.
 */
export function nextBeat(grid: HeldGrid, frame: number, direction: -1 | 1): number | null {
  const index = (frame - grid.beatOneFrame) / grid.beatFrames;
  const target =
    direction === 1
      ? Math.floor(index + INDEX_TOLERANCE) + 1
      : Math.ceil(index - INDEX_TOLERANCE) - 1;
  const beat = grid.beatOneFrame + target * grid.beatFrames;
  return beat >= 0 && inGridSpan(grid, beat) ? beat : null;
}

/**
 * `frame` rounded to a whole frame, then moved to the nearest beat to it, rounded, when the grid
 * has one there. The rounded frame itself with no grid, or no beat there.
 */
export function snapToBeat(frame: number, grid: HeldGrid | null): number {
  const rounded = Math.round(frame);
  if (grid === null) {
    return rounded;
  }
  const beat = nearestBeat(grid, rounded);
  return beat === null ? rounded : Math.round(beat);
}

/**
 * Beats per minute of a grid whose beat is `beatFrames` long: `60e6 / (beatFrames × playCallIntervalUs) × tempo`.
 *
 * `playCallIntervalUs` is the tune's play-call interval at tempo 1: core's
 * `playCallIntervalUs(nominalIntervalUs, rate)`, or `nominalIntervalUs / exactCallsPerFrame` from a DJ
 * deck's picture `rate`. `tempo` is the deck's effective tempo. Whether to show a readout outside a
 * scan grid's span is the host's call.
 */
export function beatsPerMinute(
  beatFrames: number,
  playCallIntervalUs: number,
  tempo: number,
): number {
  return (60e6 / (beatFrames * playCallIntervalUs)) * tempo;
}
