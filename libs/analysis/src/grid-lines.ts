import type { BeatGrid } from './beat-grid.js';

/** One length a loop can take: a power of two of beats (or the shortest exact division), and its whole frames. */
export interface LadderSize {
  readonly beats: number;
  readonly frames: number;
}

/** A frame count within this of a whole number is a whole number: a tapped grid carries float noise. */
const WHOLE_FRAME_TOLERANCE = 1e-9;
/** The shortest ladder length is 2^-5 of a beat. */
const SHORTEST_POWER = -5;
/** The longest ladder length is 2^7 of a beat. */
const LONGEST_POWER = 7;
/** One play call plus the re-entry gate-off; the engine stretches a 1-call loop to 2. */
const MIN_LOOP_FRAMES = 2;

/**
 * Ascending: powers of two from 1/32 to 128 beats whose length is a whole number of frames, at
 * least 2 frames; below the shortest of them, the shortest whole-frame length that divides the
 * beat, when shorter.
 */
export function lengthLadder(beatFrames: number): readonly LadderSize[] {
  const sizes: LadderSize[] = [];
  for (let power = SHORTEST_POWER; power <= LONGEST_POWER; power++) {
    const beats = 2 ** power;
    const frames = beats * beatFrames;
    const whole = Math.round(frames);
    if (whole >= MIN_LOOP_FRAMES && Math.abs(frames - whole) < WHOLE_FRAME_TOLERANCE) {
      sizes.push({ beats, frames: whole });
    }
  }
  const division = shortestDivision(beatFrames);
  if (division !== null && (sizes.length === 0 || division < sizes[0].frames)) {
    sizes.unshift({ beats: division / beatFrames, frames: division });
  }
  return sizes;
}

/** The shortest whole-frame length, at least `MIN_LOOP_FRAMES`, that divides a whole-frame beat. */
function shortestDivision(beatFrames: number): number | null {
  const beat = Math.round(beatFrames);
  if (Math.abs(beatFrames - beat) >= WHOLE_FRAME_TOLERANCE) {
    return null;
  }
  for (let frames = MIN_LOOP_FRAMES; frames < beat; frames++) {
    if (beat % frames === 0) {
      return frames;
    }
  }
  return null;
}

/**
 * Line `index` of lines `periodFrames` apart through the grid's beat one:
 * `Math.round(beatOneFrame + index × periodFrames)`.
 *
 * Every line rounds to a whole frame, so a grid whose `beatFrames` carries float noise still lands
 * its lines on frames. Core's crossing lines round the same way: changing this means changing its
 * `CrossingLines` check with it.
 */
export function gridLine(grid: BeatGrid, periodFrames: number, index: number): number {
  // `+ 0` turns the -0 that rounding a small negative gives into 0.
  return Math.round(grid.beatOneFrame + index * periodFrames) + 0;
}

/**
 * Where a loop of `lengthFrames` starts if it starts at or behind `frame`: the last beat line at or
 * behind `frame` when the length is a beat or more, otherwise the last line of its own length. Null
 * when no line ≥ 0 is at or behind `frame`.
 */
export function loopStartAtOrBefore(
  grid: BeatGrid,
  lengthFrames: number,
  frame: number,
): number | null {
  const period = lengthFrames >= grid.beatFrames ? grid.beatFrames : lengthFrames;
  if (!(period > 0) || !Number.isFinite(period)) {
    return null;
  }

  // The floor of the unrounded index can sit one line off once the lines are rounded, so step to
  // the true last line at or behind `frame` from either side.
  let index = Math.floor((frame - grid.beatOneFrame) / period);
  while (gridLine(grid, period, index + 1) <= frame) {
    index++;
  }
  while (gridLine(grid, period, index) > frame) {
    index--;
  }

  const line = gridLine(grid, period, index);
  return line >= 0 ? line : null;
}

/**
 * The first frame a whole number (≥ 1) of `lengthFrames` after `startFrame` that lies after
 * `frame`, capped at `endFrame`. Where shrinking a loop that starts at `startFrame` and ends at
 * `endFrame` takes effect.
 */
export function shrinkLanding(
  startFrame: number,
  lengthFrames: number,
  frame: number,
  endFrame: number,
): number {
  if (!(lengthFrames > 0)) {
    return endFrame;
  }
  const laps = Math.max(1, Math.floor((frame - startFrame) / lengthFrames) + 1);
  return Math.min(startFrame + laps * lengthFrames, endFrame);
}

/**
 * `frame` itself when it is before `endFrame`; otherwise `frame` folded back into
 * [`startFrame`, `endFrame`) by whole laps.
 */
export function foldIntoLoop(frame: number, startFrame: number, endFrame: number): number {
  if (frame < endFrame) {
    return frame;
  }
  const length = endFrame - startFrame;
  if (!(length > 0)) {
    return startFrame;
  }
  return startFrame + ((frame - startFrame) % length);
}
