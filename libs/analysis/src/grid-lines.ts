import { lapLength, lapSpan, lapsWithin } from '@sidablist/core';
import type { BeatGrid } from './beat-grid.js';

/**
 * One length a loop can take: a power of two of beats, and its frames. The frames need not be a
 * whole number: core laps such a length in alternating whole-frame lengths that add up exactly
 * (see core's `ActiveLoop`).
 */
export interface LadderSize {
  readonly beats: number;
  readonly frames: number;
}

/** A frame count within this of a whole number is a whole number: a tapped grid carries float noise. */
const WHOLE_FRAME_TOLERANCE = 1e-9;
/** The shortest ladder length is 2^-4 of a beat. */
const SHORTEST_POWER = -4;
/** The longest ladder length is 2^7 of a beat. */
const LONGEST_POWER = 7;
/** One play call plus the re-entry gate-off, which every lap of a loop must hold: core's
 *  `MIN_FRACTIONAL_LOOP_FRAMES`. */
const MIN_LOOP_FRAMES = 2;

/**
 * Ascending: powers of two from 1/16 to 128 beats at least 2 frames long. A length that is not a
 * whole number of frames is kept as it is — its laps alternate — and one within float noise of a
 * whole number is that whole number.
 */
export function lengthLadder(beatFrames: number): readonly LadderSize[] {
  const sizes: LadderSize[] = [];
  for (let power = SHORTEST_POWER; power <= LONGEST_POWER; power++) {
    const beats = 2 ** power;
    const exact = beats * beatFrames;
    const whole = Math.round(exact);
    const frames = Math.abs(exact - whole) < WHOLE_FRAME_TOLERANCE ? whole : exact;
    if (frames >= MIN_LOOP_FRAMES) {
      sizes.push({ beats, frames });
    }
  }
  return sizes;
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
 * The lap phase of a loop that starts at `startFrame` on lines `periodFrames` apart: the unrounded
 * position of the line that rounds to it, `beatOneFrame + i × period`, which says how the laps of a
 * length that is not whole alternate (core's `ActiveLoop.lapPhase`). `startFrame` itself when no
 * line rounds to it, or the period is not a positive number — the phase of a whole frame.
 *
 * The period is the loop's length below a beat and the beat at a beat or more, as
 * `loopStartAtOrBefore` chooses it.
 */
export function lapPhaseAt(grid: BeatGrid, periodFrames: number, startFrame: number): number {
  if (!(periodFrames > 0) || !Number.isFinite(periodFrames)) {
    return startFrame;
  }
  const index = Math.round((startFrame - grid.beatOneFrame) / periodFrames);
  return gridLine(grid, periodFrames, index) === startFrame
    ? grid.beatOneFrame + index * periodFrames
    : startFrame;
}

/**
 * Where shrinking a loop that starts at `startFrame` and ends at `endFrame` to `lengthFrames`
 * takes effect: the first lap boundary of the new length that lies after `frame`, capped at the
 * end.
 *
 * With no `lapPhase`: the first frame a whole number (≥ 1) of `lengthFrames` after `startFrame`,
 * capped at `endFrame`.
 *
 * With one — the lap phase at `startFrame` of the laps the boundaries count (see `lapPhaseAt`) — the
 * boundaries are the whole-frame ends of the alternating laps of `lengthFrames` from there, and the
 * cap is `endFrame` rounded up, so the answer is always a whole frame: a running loop whose length
 * is not whole ends its lap in progress at most there, and core lands a change named past that
 * lap's end at its end. `lapPhaseOfFold(landing, startFrame, startFrame + lengthFrames, lapPhase)`
 * is the phase the new loop starts its laps at there.
 */
export function shrinkLanding(
  startFrame: number,
  lengthFrames: number,
  frame: number,
  endFrame: number,
  lapPhase?: number,
): number {
  if (lapPhase === undefined) {
    if (!(lengthFrames > 0)) {
      return endFrame;
    }
    const laps = Math.max(1, Math.floor((frame - startFrame) / lengthFrames) + 1);
    return Math.min(startFrame + laps * lengthFrames, endFrame);
  }
  const cap = Math.ceil(endFrame);
  if (!(lengthFrames > 0)) {
    return cap;
  }
  const laps = Math.max(1, lapsWithin(lapPhase, lengthFrames, frame - startFrame) + 1);
  return Math.min(startFrame + lapSpan(lapPhase, lengthFrames, laps), cap);
}

/**
 * `frame` itself when it is before the loop's first lap ends; otherwise `frame` folded back into
 * the loop by whole laps.
 *
 * With no `lapPhase`, every lap is `endFrame - startFrame` long and the first ends at `endFrame`.
 * With one — the lap phase at `startFrame` (see `lapPhaseAt`) — the laps alternate in whole-frame
 * lengths from there, as core laps the loop, and `frame` lands at the same place in the lap it
 * falls in; `lapPhaseOfFold` is that lap's phase. A whole length folds the same either way.
 */
export function foldIntoLoop(
  frame: number,
  startFrame: number,
  endFrame: number,
  lapPhase?: number,
): number {
  const length = endFrame - startFrame;
  if (lapPhase === undefined) {
    if (frame < endFrame) {
      return frame;
    }
    if (!(length > 0)) {
      return startFrame;
    }
    return startFrame + ((frame - startFrame) % length);
  }
  if (!(length > 0)) {
    return frame < endFrame ? frame : startFrame;
  }
  if (frame < startFrame + lapLength(lapPhase, length)) {
    return frame;
  }
  const laps = lapsWithin(lapPhase, length, frame - startFrame);
  return frame - lapSpan(lapPhase, length, laps);
}

/**
 * The lap phase of the lap `foldIntoLoop(frame, startFrame, endFrame, lapPhase)` folds `frame`
 * into: `lapPhase` plus the whole laps folded away, times the length — the unrounded position of
 * that lap's start. A frame on a lap boundary is in the lap it starts, so for a boundary
 * `shrinkLanding` returns this is the phase the shrunk loop's laps start at. `lapPhase` itself
 * before the first lap ends, and for a length that is not a positive number.
 */
export function lapPhaseOfFold(
  frame: number,
  startFrame: number,
  endFrame: number,
  lapPhase: number,
): number {
  const length = endFrame - startFrame;
  if (!(length > 0)) {
    return lapPhase;
  }
  return lapPhase + lapsWithin(lapPhase, length, frame - startFrame) * length;
}
