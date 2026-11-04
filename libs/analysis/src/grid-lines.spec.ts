import { describe, expect, it } from 'vitest';
import type { BeatGrid } from './beat-grid.js';
import {
  foldIntoLoop,
  gridLine,
  lengthLadder,
  loopStartAtOrBefore,
  shrinkLanding,
} from './grid-lines.js';

const grid = (beatFrames: number, beatOneFrame: number): BeatGrid => ({ beatFrames, beatOneFrame });

describe('lengthLadder', () => {
  const framesOf = (beatFrames: number): number[] =>
    lengthLadder(beatFrames).map((size) => size.frames);

  it('lists the whole-frame powers of two of a beat, with the shortest exact division ahead of them', () => {
    const ladder = lengthLadder(24);

    expect(ladder.map((size) => size.frames)).toEqual([
      2, 3, 6, 12, 24, 48, 96, 192, 384, 768, 1536, 3072,
    ]);
    expect(ladder[0].beats).toBeCloseTo(2 / 24, 12);
    expect(ladder.slice(1).map((size) => size.beats)).toEqual([
      1 / 8,
      1 / 4,
      1 / 2,
      1,
      2,
      4,
      8,
      16,
      32,
      64,
      128,
    ]);
  });

  it('puts the division first only when it is shorter than the shortest power', () => {
    // 25 frames: no power below a beat is whole, so the 5-frame division leads the beat itself.
    expect(framesOf(25)).toEqual([5, 25, 50, 100, 200, 400, 800, 1600, 3200]);
    // 3 frames: nothing divides it, and a half beat is not whole.
    expect(framesOf(3)).toEqual([3, 6, 12, 24, 48, 96, 192, 384]);
  });

  it('starts at the first whole power for a fractional beat, and offers no division', () => {
    expect(framesOf(12.5)).toEqual([25, 50, 100, 200, 400, 800, 1600]);
  });

  it('reads a tapped grid with float noise as the whole grid it is', () => {
    expect(framesOf(24 + 1e-12)).toEqual(framesOf(24));
  });

  it('keeps a length below two frames off the ladder', () => {
    expect(framesOf(1)).toEqual([2, 4, 8, 16, 32, 64, 128]);
  });
});

describe('gridLine', () => {
  it.each([
    { name: 'beat one itself', beatFrames: 24, beatOne: 10, period: 24, index: 0, line: 10 },
    { name: 'a later beat', beatFrames: 24, beatOne: 10, period: 24, index: 3, line: 82 },
    {
      name: 'a line before beat one',
      beatFrames: 24,
      beatOne: 10,
      period: 24,
      index: -1,
      line: -14,
    },
    {
      name: 'a half-frame line rounds up',
      beatFrames: 25,
      beatOne: 10,
      period: 12.5,
      index: 1,
      line: 23,
    },
    {
      name: 'a negative half-frame rounds toward zero',
      beatFrames: 25,
      beatOne: 10,
      period: 12.5,
      index: -3,
      line: -27,
    },
    { name: 'a fractional period', beatFrames: 12.4, beatOne: 0, period: 12.4, index: 5, line: 62 },
  ])('$name', ({ beatFrames, beatOne, period, index, line }) => {
    expect(gridLine(grid(beatFrames, beatOne), period, index)).toBe(line);
  });

  it('never returns a negative zero', () => {
    expect(Object.is(gridLine(grid(24, 0), 0.4, -1), 0)).toBe(true);
  });
});

describe('loopStartAtOrBefore', () => {
  const beatGrid = grid(24, 10);

  it.each([
    { name: 'on a beat line', length: 24, frame: 10, start: 10 },
    { name: 'a frame short of the next beat line', length: 24, frame: 33, start: 10 },
    { name: 'on the next beat line', length: 24, frame: 34, start: 34 },
    { name: 'deep into the grid', length: 24, frame: 100, start: 82 },
    { name: 'a length of more than a beat takes the beat line', length: 48, frame: 100, start: 82 },
    { name: 'a length of exactly a beat', length: 24, frame: 59, start: 58 },
    {
      name: 'a length below a beat takes a line of its own length',
      length: 6,
      frame: 99,
      start: 94,
    },
    { name: 'on a line of its own length', length: 6, frame: 100, start: 100 },
    { name: 'a line of its own length before beat one', length: 6, frame: 5, start: 4 },
  ])('$name', ({ length, frame, start }) => {
    expect(loopStartAtOrBefore(beatGrid, length, frame)).toBe(start);
  });

  it.each([
    { name: 'a beat length behind the first beat line', length: 24, frame: 5 },
    { name: 'a short length behind its first line at or after 0', length: 6, frame: 3 },
    { name: 'frame 0 before beat one', length: 24, frame: 0 },
  ])('is null for $name', ({ length, frame }) => {
    expect(loopStartAtOrBefore(beatGrid, length, frame)).toBeNull();
  });

  it('checks the neighbouring line when rounding moves a line behind the floor of the unrounded index', () => {
    // Line 1 is 12.4 unrounded, past frame 12, but rounds to 12 itself.
    expect(loopStartAtOrBefore(grid(12.4, 0), 12.4, 12)).toBe(12);
    expect(loopStartAtOrBefore(grid(12.4, 0), 12.4, 11)).toBe(0);
    // And the line that rounds up past a frame is not taken.
    expect(loopStartAtOrBefore(grid(12.6, 0), 12.6, 12)).toBe(0);
    expect(loopStartAtOrBefore(grid(12.6, 0), 12.6, 13)).toBe(13);
  });

  it('agrees with a scan of gridLine across a tapped grid, for a beat length and a shorter one', () => {
    const tapped = grid(23.7, 3);
    for (const length of [23.7, 47.4, 5.925]) {
      const period = length >= tapped.beatFrames ? tapped.beatFrames : length;
      for (let frame = 0; frame < 400; frame++) {
        let expected: number | null = null;
        for (let index = -8; index < 80; index++) {
          const line = gridLine(tapped, period, index);
          if (line >= 0 && line <= frame) expected = line;
        }
        expect(loopStartAtOrBefore(tapped, length, frame)).toBe(expected);
      }
    }
  });

  it('declines a length that is not a positive number', () => {
    expect(loopStartAtOrBefore(beatGrid, 0, 100)).toBeNull();
    expect(loopStartAtOrBefore(grid(24, 10), Number.NaN, 100)).toBeNull();
  });
});

describe('shrinkLanding', () => {
  it.each([
    { name: 'on the start', frame: 100, landing: 124 },
    { name: 'inside the first lap', frame: 123, landing: 124 },
    { name: 'on a lap boundary it takes the next one', frame: 124, landing: 148 },
    { name: 'behind the start', frame: 90, landing: 124 },
    { name: 'several laps in', frame: 170, landing: 172 },
  ])('$name', ({ frame, landing }) => {
    expect(shrinkLanding(100, 24, frame, 400)).toBe(landing);
  });

  it('is capped at the end', () => {
    expect(shrinkLanding(100, 24, 177, 180)).toBe(180);
    expect(shrinkLanding(100, 24, 100, 110)).toBe(110);
  });
});

describe('foldIntoLoop', () => {
  it.each([
    { name: 'a frame inside the loop', frame: 50, folded: 50 },
    { name: 'a frame before the loop', frame: 5, folded: 5 },
    { name: 'the end itself folds to the start', frame: 60, folded: 10 },
    { name: 'a frame past the end', frame: 65, folded: 15 },
    { name: 'whole laps past the end', frame: 110, folded: 10 },
    { name: 'a lap and a bit', frame: 137, folded: 37 },
  ])('$name', ({ frame, folded }) => {
    expect(foldIntoLoop(frame, 10, 60)).toBe(folded);
  });
});
