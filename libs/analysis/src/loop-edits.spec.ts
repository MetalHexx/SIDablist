import { describe, expect, it } from 'vitest';
import type { BeatGrid, DetectedBeatGrid } from './beat-grid.js';
import {
  CUE_LENGTH_BEATS,
  loopLapPhase,
  moveLoop,
  resizeLoop,
  setLoopLength,
  shiftLoop,
  stepLoopLength,
  type LoopBounds,
  type LoopEdit,
} from './loop-edits.js';

const grid24: BeatGrid = { beatFrames: 24, beatOneFrame: 0 };
const grid28: BeatGrid = { beatFrames: 28, beatOneFrame: 0 };
const offset: BeatGrid = { beatFrames: 24, beatOneFrame: 10 };
const scan: DetectedBeatGrid = { beatFrames: 24, beatOneFrame: 10, startFrame: 100, endFrame: 200 };

const loop = (startFrame: number, endFrame: number | null): LoopBounds => ({
  startFrame,
  endFrame,
});
const accepted = (startFrame: number, endFrame: number | null): LoopEdit => ({
  ok: true,
  bounds: { startFrame, endFrame },
});
const refused = (refusal: Extract<LoopEdit, { ok: false }>['refusal']): LoopEdit => ({
  ok: false,
  refusal,
});

describe('resizeLoop', () => {
  it('halves and doubles along the ladder from a rung', () => {
    expect(resizeLoop(loop(48, 72), 'halve', grid24, null)).toEqual(accepted(48, 60));
    expect(resizeLoop(loop(48, 72), 'double', grid24, null)).toEqual(accepted(48, 96));
  });

  it('lands a length off the ladder on the rung in the direction taken', () => {
    expect(resizeLoop(loop(0, 30), 'halve', grid24, null)).toEqual(accepted(0, 24));
    expect(resizeLoop(loop(0, 30), 'double', grid24, null)).toEqual(accepted(0, 48));
  });

  it('refuses to double at 128 beats and to halve at the shortest rung', () => {
    expect(resizeLoop(loop(0, 3072), 'double', grid24, null)).toEqual(refused('no-size'));
    expect(resizeLoop(loop(0, 3), 'halve', grid24, null)).toEqual(refused('no-size'));
  });

  it('gives a cue the cue length either way', () => {
    const end = 48 + CUE_LENGTH_BEATS * 24;
    expect(resizeLoop(loop(48, null), 'halve', grid24, null)).toEqual(accepted(48, end));
    expect(resizeLoop(loop(48, null), 'double', grid24, null)).toEqual(accepted(48, end));
  });

  it('may end a fractional frame on', () => {
    expect(resizeLoop(loop(100, 107), 'halve', grid28, null)).toEqual(accepted(100, 103.5));
  });
});

describe('setLoopLength', () => {
  it('sets a rung of beats, a cue gaining an end the same way', () => {
    expect(setLoopLength(loop(24, 48), 4, grid24, null)).toEqual(accepted(24, 120));
    expect(setLoopLength(loop(24, null), 2, grid24, null)).toEqual(accepted(24, 72));
  });

  it('ends a fractional rung on a fractional frame', () => {
    expect(setLoopLength(loop(100, null), 1 / 8, grid28, null)).toEqual(accepted(100, 103.5));
  });

  it('refuses a size the ladder lacks', () => {
    expect(setLoopLength(loop(0, 24), 1 / 16, grid28, null)).toEqual(refused('no-size'));
    expect(setLoopLength(loop(0, 24), 3, grid24, null)).toEqual(refused('no-size'));
  });
});

describe('stepLoopLength', () => {
  it('steps a whole beat up or down from a whole count of beats', () => {
    expect(stepLoopLength(loop(0, 600), 1, grid24, null)).toEqual(accepted(0, 624));
    expect(stepLoopLength(loop(0, 600), -1, grid24, null)).toEqual(accepted(0, 576));
  });

  it('takes a part of a beat up to one beat and refuses to go below it', () => {
    expect(stepLoopLength(loop(0, 6), 1, grid24, null)).toEqual(accepted(0, 24));
    expect(stepLoopLength(loop(0, 24), -1, grid24, null)).toEqual(refused('no-size'));
    expect(stepLoopLength(loop(0, 6), -1, grid24, null)).toEqual(refused('no-size'));
  });

  it('refuses a cue before it reads the grid', () => {
    expect(stepLoopLength(loop(0, null), 1, null, null)).toEqual(refused('no-end'));
  });

  it('checks the result against the tune length', () => {
    expect(stepLoopLength(loop(0, 600), 1, grid24, 610)).toEqual(refused('past-end'));
  });
});

describe('moveLoop', () => {
  it('moves a loop on a beat by the step, its end following', () => {
    expect(moveLoop(loop(34, 82), 1, 1, offset, null)).toEqual(accepted(58, 106));
    expect(moveLoop(loop(34, 82), 1, -1, offset, null)).toEqual(accepted(10, 58));
    expect(moveLoop(loop(34, 82), 2, 1, offset, null)).toEqual(accepted(82, 130));
  });

  it('lands a start off a beat on the next beat that way, whatever the step', () => {
    expect(moveLoop(loop(40, 88), 4, 1, offset, null)).toEqual(accepted(58, 106));
    expect(moveLoop(loop(40, 88), 4, -1, offset, null)).toEqual(accepted(34, 82));
  });

  it('moves a cue alone and rounds the new start to a whole frame', () => {
    expect(moveLoop(loop(0, null), 1, 1, { beatFrames: 24.5, beatOneFrame: 0 }, null)).toEqual(
      accepted(25, null),
    );
  });

  it('refuses a move to a beat below frame 0 or outside the span', () => {
    expect(moveLoop(loop(34, 82), 2, -1, offset, null)).toEqual(refused('no-beat'));
    expect(moveLoop(loop(178, 190), 1, 1, scan, null)).toEqual(refused('no-beat'));
    expect(moveLoop(loop(106, 118), 1, -1, scan, null)).toEqual(refused('no-beat'));
  });

  it('checks the result against the tune length', () => {
    expect(moveLoop(loop(34, 82), 1, 1, offset, 100)).toEqual(refused('past-end'));
  });
});

describe('shiftLoop', () => {
  it('moves both edges a frame, with no grid', () => {
    expect(shiftLoop(loop(10, 50), 1, null)).toEqual(accepted(11, 51));
    expect(shiftLoop(loop(10, null), -1, null)).toEqual(accepted(9, null));
  });

  it('refuses an edge below 0 and one past the tune length, accepting the length itself', () => {
    expect(shiftLoop(loop(0, 10), -1, null)).toEqual(refused('before-start'));
    expect(shiftLoop(loop(90, 100), 1, 100)).toEqual(refused('past-end'));
    expect(shiftLoop(loop(89, 99), 1, 100)).toEqual(accepted(90, 100));
  });

  it('refuses a length that is not whole and under 2 frames', () => {
    expect(shiftLoop(loop(10, 11.5), 1, null)).toEqual(refused('too-short'));
  });
});

describe('a grid edit reads the grid at the loop start first', () => {
  const edits: [string, (g: BeatGrid | DetectedBeatGrid | null, start: number) => LoopEdit][] = [
    ['resizeLoop', (g, s) => resizeLoop(loop(s, s + 24), 'double', g, null)],
    ['setLoopLength', (g, s) => setLoopLength(loop(s, s + 24), 2, g, null)],
    ['stepLoopLength', (g, s) => stepLoopLength(loop(s, s + 24), 1, g, null)],
    ['moveLoop', (g, s) => moveLoop(loop(s, s + 24), 1, 1, g, null)],
  ];

  it.each(edits)('%s refuses no grid and a start outside the span', (_name, edit) => {
    expect(edit(null, 106)).toEqual(refused('no-grid'));
    expect(edit(scan, 50)).toEqual(refused('outside-span'));
    expect(edit(scan, 200)).toEqual(refused('outside-span'));
  });
});

describe('loopLapPhase', () => {
  const fractional: BeatGrid = { beatFrames: 24.5, beatOneFrame: 0 };

  it('is undefined with no grid', () => {
    expect(loopLapPhase(null, 74, 24.5)).toBeUndefined();
  });

  it('is undefined on a whole-frame line', () => {
    expect(loopLapPhase(grid24, 48, 24)).toBeUndefined();
    expect(loopLapPhase(fractional, 49, 24.5)).toBeUndefined();
  });

  it('is the fraction of the line a start rounds from, over the beat at a beat or more', () => {
    expect(loopLapPhase(fractional, 74, 24.5)).toBe(0.5);
    expect(loopLapPhase(fractional, 74, 49)).toBe(0.5);
  });

  it('measures over the loop length below a beat', () => {
    expect(loopLapPhase(fractional, 74, 12.25)).toBe(0.5);
  });

  it('is undefined when no line rounds to the start', () => {
    expect(loopLapPhase(fractional, 75, 24.5)).toBeUndefined();
  });
});
