import { isUsableLoopLength, reduceLapPhase } from '@sidablist/core';
import { inGridSpan, nearestBeat, nextBeat, onBeat, type HeldGrid } from './beats.js';
import { lapPhaseAt, lengthLadder, type LadderSize } from './grid-lines.js';

/** A loop's bounds in frames; `endFrame` null is a cue. An end need not be a whole frame. */
export interface LoopBounds {
  readonly startFrame: number;
  readonly endFrame: number | null;
}

/**
 * Why an edit was refused: no grid to measure by, the start outside the grid's span, no ladder
 * rung to take, a cue where a length is needed, no beat to land on, an edge before frame 0 or past
 * the tune's end, or a length the engine cannot lap.
 */
export type LoopEditRefusal =
  | 'no-grid'
  | 'outside-span'
  | 'no-size'
  | 'no-end'
  | 'no-beat'
  | 'before-start'
  | 'past-end'
  | 'too-short';

/** An edit's outcome: the new bounds, or the code of the refusal. */
export type LoopEdit =
  | { readonly ok: true; readonly bounds: LoopBounds }
  | { readonly ok: false; readonly refusal: LoopEditRefusal };

/** The length a cue gains when it is halved or doubled. */
export const CUE_LENGTH_BEATS = 4;

/** A tolerance on a beat count: a tapped grid carries float noise. */
const BEAT_COUNT_TOLERANCE = 1e-9;

function refuse(refusal: LoopEditRefusal): LoopEdit {
  return { ok: false, refusal };
}

/**
 * The grid to edit by, read at the loop's start: the refusal when there is none or the start is
 * outside its span.
 */
function gridAtStart(loop: LoopBounds, grid: HeldGrid | null): HeldGrid | LoopEditRefusal {
  if (grid === null) {
    return 'no-grid';
  }
  return inGridSpan(grid, loop.startFrame) ? grid : 'outside-span';
}

function isRefusal(read: HeldGrid | LoopEditRefusal): read is LoopEditRefusal {
  return typeof read === 'string';
}

/**
 * Accepts `startFrame` and `endFrame` as the loop's new bounds, or names what is wrong, checked in
 * this order: an edge below 0, an edge past `lengthFrames` (when known), an end that makes a length
 * the engine cannot lap (`isUsableLoopLength`: not whole and under 2 frames). A result equal to its
 * input is still accepted: whether anything changed is the host's to decide.
 */
function place(startFrame: number, endFrame: number | null, lengthFrames: number | null): LoopEdit {
  if (startFrame < 0 || (endFrame !== null && endFrame < 0)) {
    return refuse('before-start');
  }
  if (
    lengthFrames !== null &&
    (startFrame > lengthFrames || (endFrame !== null && endFrame > lengthFrames))
  ) {
    return refuse('past-end');
  }
  if (endFrame !== null && !isUsableLoopLength(startFrame, endFrame)) {
    return refuse('too-short');
  }
  return { ok: true, bounds: { startFrame, endFrame } };
}

/** The loop at its own start, ending `rung.frames` on. */
function withRung(loop: LoopBounds, rung: LadderSize, lengthFrames: number | null): LoopEdit {
  return place(loop.startFrame, loop.startFrame + rung.frames, lengthFrames);
}

/**
 * Halves or doubles a loop's length along `lengthLadder`, keeping its start. A cue takes the
 * `CUE_LENGTH_BEATS` rung either way. A loop halving takes the largest rung strictly shorter than
 * its length and doubling the smallest strictly longer, so a length off the ladder lands on it in
 * that direction. `no-size` when there is no such rung (doubling at 128 beats, halving at the
 * shortest rung). The end is `startFrame + rung.frames`, which may be fractional. `lengthFrames` is
 * the tune's length, or null while unknown, when nothing is checked against its end.
 */
export function resizeLoop(
  loop: LoopBounds,
  direction: 'halve' | 'double',
  grid: HeldGrid | null,
  lengthFrames: number | null,
): LoopEdit {
  const read = gridAtStart(loop, grid);
  if (isRefusal(read)) {
    return refuse(read);
  }
  const ladder = lengthLadder(read.beatFrames);
  let rung: LadderSize | undefined;
  if (loop.endFrame === null) {
    rung = ladder.find((size) => size.beats === CUE_LENGTH_BEATS);
  } else {
    const length = loop.endFrame - loop.startFrame;
    rung =
      direction === 'halve'
        ? ladder.filter((size) => size.frames < length).at(-1)
        : ladder.find((size) => size.frames > length);
  }
  return rung === undefined ? refuse('no-size') : withRung(loop, rung, lengthFrames);
}

/**
 * Sets a loop's length to `beats` beats, keeping its start; a cue gains an end the same way.
 * `no-size` when `lengthLadder` has no rung of that many beats, for example one under 2 frames.
 */
export function setLoopLength(
  loop: LoopBounds,
  beats: number,
  grid: HeldGrid | null,
  lengthFrames: number | null,
): LoopEdit {
  const read = gridAtStart(loop, grid);
  if (isRefusal(read)) {
    return refuse(read);
  }
  const rung = lengthLadder(read.beatFrames).find((size) => size.beats === beats);
  return rung === undefined ? refuse('no-size') : withRung(loop, rung, lengthFrames);
}

/**
 * Adds (`direction` 1) or takes away (-1) one beat of a loop's length, landing on a whole number of
 * beats: 25 beats goes to 24 or 26, and 1/4 of a beat goes up to 1. `no-size` when the result is
 * under one beat. A cue is `no-end`, refused before the grid is read. The end is
 * `startFrame + n × beatFrames`.
 */
export function stepLoopLength(
  loop: LoopBounds,
  direction: -1 | 1,
  grid: HeldGrid | null,
  lengthFrames: number | null,
): LoopEdit {
  if (loop.endFrame === null) {
    return refuse('no-end');
  }
  const read = gridAtStart(loop, grid);
  if (isRefusal(read)) {
    return refuse(read);
  }
  const length = (loop.endFrame - loop.startFrame) / read.beatFrames;
  const beats =
    direction === 1
      ? Math.floor(length + BEAT_COUNT_TOLERANCE) + 1
      : Math.ceil(length - BEAT_COUNT_TOLERANCE) - 1;
  if (beats < 1) {
    return refuse('no-size');
  }
  return place(loop.startFrame, loop.startFrame + beats * read.beatFrames, lengthFrames);
}

/**
 * Moves a loop by `beats` beats (the host's step, a positive whole number) either way. A start on a
 * beat moves to the nearest beat plus or minus `beats × beatFrames`; any other start lands first on
 * the next beat that way. The new start is rounded to a whole frame, and `no-beat` when there is
 * none or it is outside the grid's span. The end follows at the same length; a cue moves alone.
 */
export function moveLoop(
  loop: LoopBounds,
  beats: number,
  direction: -1 | 1,
  grid: HeldGrid | null,
  lengthFrames: number | null,
): LoopEdit {
  const read = gridAtStart(loop, grid);
  if (isRefusal(read)) {
    return refuse(read);
  }
  const from = loop.startFrame;
  let target: number | null;
  if (onBeat(read, from)) {
    const beat = nearestBeat(read, from);
    target = beat === null ? null : beat + direction * beats * read.beatFrames;
  } else {
    target = nextBeat(read, from, direction);
  }
  if (target === null) {
    return refuse('no-beat');
  }
  const to = Math.round(target);
  if (!inGridSpan(read, to)) {
    return refuse('no-beat');
  }
  return place(to, loop.endFrame === null ? null : loop.endFrame + to - from, lengthFrames);
}

/**
 * Moves both edges of a loop by one frame either way, with a grid or without. The host keeps its
 * own limit on how far a saved edge may sit off the beat it was set on; that is its bookkeeping,
 * not checked here.
 */
export function shiftLoop(
  loop: LoopBounds,
  direction: -1 | 1,
  lengthFrames: number | null,
): LoopEdit {
  return place(
    loop.startFrame + direction,
    loop.endFrame === null ? null : loop.endFrame + direction,
    lengthFrames,
  );
}

/**
 * The lap phase to hand the engine for a loop of `lengthFrames` starting at `startFrame` on the
 * grid: `lapPhaseAt` over the beat when the loop is a beat or more and over its own length below
 * one, reduced to a fraction of a frame (core's `reduceLapPhase`). Undefined with no grid, and when
 * the phase is 0, so a loop on a whole-frame line is handed over as it always was. A host passes it
 * as `JumpTarget.lapPhase` or `loop-bounds.lapPhase`.
 */
export function loopLapPhase(
  grid: HeldGrid | null,
  startFrame: number,
  lengthFrames: number,
): number | undefined {
  if (grid === null) {
    return undefined;
  }
  const period = lengthFrames >= grid.beatFrames ? grid.beatFrames : lengthFrames;
  const phase = reduceLapPhase(lapPhaseAt(grid, period, startFrame));
  return phase === 0 ? undefined : phase;
}
