import { describe, expect, it } from 'vitest';
import type { BeatGrid } from './beat-grid.js';
import { lapLength } from '@sidablist/core';
import {
  foldIntoLoop,
  gridLine,
  lapPhaseAt,
  lapPhaseOfFold,
  lengthLadder,
  loopStartAtOrBefore,
  shrinkLanding,
} from './grid-lines.js';

const grid = (beatFrames: number, beatOneFrame: number): BeatGrid => ({ beatFrames, beatOneFrame });

describe('lengthLadder', () => {
  const framesOf = (beatFrames: number): number[] =>
    lengthLadder(beatFrames).map((size) => size.frames);

  it('lists the powers of two of a beat from 1/16 to 128 beats that are two frames or more', () => {
    const ladder = lengthLadder(24);

    expect(ladder.map((size) => size.frames)).toEqual([
      3, 6, 12, 24, 48, 96, 192, 384, 768, 1536, 3072,
    ]);
    expect(ladder.map((size) => size.beats)).toEqual([
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

  it.each([
    [28, [3.5, 7, 14, 28, 56]],
    [24, [3, 6, 12, 24, 48]],
    [22, [2.75, 5.5, 11, 22, 44]],
    [40, [2.5, 5, 10, 20, 40]],
    [25, [3.125, 6.25, 12.5, 25, 50]],
    [30, [3.75, 7.5, 15, 30, 60]],
    [26, [3.25, 6.5, 13, 26, 52]],
    [32, [2, 4, 8, 16, 32]],
  ])(
    'keeps the lengths of a %s-frame beat that are not whole, and no odd division',
    (beat, start) => {
      const ladder = lengthLadder(beat);
      expect(ladder.map((size) => size.frames).slice(0, 5)).toEqual(start);
      expect(ladder.map((size) => size.frames)).toEqual(ladder.map((size) => size.beats * beat));
      expect(ladder.at(-1)).toEqual({ beats: 128, frames: 128 * beat });
    },
  );

  it('never goes below 1/16 of a beat, however long the beat', () => {
    expect(lengthLadder(64)[0]).toEqual({ beats: 1 / 16, frames: 4 });
    expect(lengthLadder(48)[0]).toEqual({ beats: 1 / 16, frames: 3 });
  });

  it('keeps a length below two frames off the ladder', () => {
    expect(framesOf(1)).toEqual([2, 4, 8, 16, 32, 64, 128]);
    expect(framesOf(3)).toEqual([3, 6, 12, 24, 48, 96, 192, 384]);
    expect(framesOf(12)[0]).toBe(3);
    expect(framesOf(12.5)[0]).toBe(3.125);
  });

  it('reads a tapped grid with float noise as the whole grid it is', () => {
    expect(framesOf(24 + 1e-12)).toEqual(framesOf(24));
    expect(framesOf(32 - 1e-12)).toEqual(framesOf(32));
    expect(lengthLadder(28 + 1e-12)[1].frames).toBe(7);
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

  describe('with a lap phase', () => {
    // An eighth of a 28-frame beat from frame 100: laps of 4, 3, 4, 3 at phase 0, ending at 104,
    // 107, 111, 114; at phase 0.5 they run 3, 4, 3, 4, ending at 103, 107, 110, 114.
    it.each([
      { phase: 0, frame: 100, landing: 104 },
      { phase: 0, frame: 103, landing: 104 },
      { phase: 0, frame: 104, landing: 107 },
      { phase: 0, frame: 108, landing: 111 },
      { phase: 0, frame: 90, landing: 104 },
      { phase: 0.5, frame: 100, landing: 103 },
      { phase: 0.5, frame: 103, landing: 107 },
      { phase: 0.5, frame: 107, landing: 110 },
      { phase: 99.5, frame: 107, landing: 110 },
    ])('lands at phase $phase from $frame on $landing', ({ phase, frame, landing }) => {
      expect(shrinkLanding(100, 3.5, frame, 200, phase)).toBe(landing);
    });

    it('lands on the boundaries a stepped lap count reaches, from any phase', () => {
      for (const length of [2.5, 2.75, 3.125, 3.5, 6.25]) {
        for (const phase of [0, 0.25, 0.5, 0.75]) {
          const ends: number[] = [];
          let at = 100;
          for (let lap = 0; lap < 40; lap++) {
            at += lapLength(phase, length, lap);
            ends.push(at);
          }
          for (let frame = 95; frame < ends[ends.length - 2]; frame++) {
            const expected = ends.find((end) => end > frame);
            expect(shrinkLanding(100, length, frame, 1000, phase)).toBe(expected);
          }
        }
      }
    });

    it('is capped at the end rounded up, so the landing is always a whole frame', () => {
      expect(shrinkLanding(100, 3.5, 105, 107, 0)).toBe(107);
      // Laps of 2.75 end at 103, 106, 108: the one after 106 is past the end, 105.5 rounded up.
      expect(shrinkLanding(100, 2.75, 106, 105.5, 0)).toBe(106);
      expect(shrinkLanding(100, 2.75, 100, 105.5, 0)).toBe(103);
    });

    it('lands as it does with none for a whole length', () => {
      for (const frame of [90, 100, 123, 124, 170, 177]) {
        expect(shrinkLanding(100, 24, frame, 180, 0.5)).toBe(shrinkLanding(100, 24, frame, 180));
      }
    });
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

  describe('with a lap phase', () => {
    it.each([
      // 3.5 frames from 10 at phase 0: laps of 4, 3, 4, 3 over 10-14, 14-17, 17-21, 21-24.
      { phase: 0, frame: 13, folded: 13 },
      { phase: 0, frame: 14, folded: 10 },
      { phase: 0, frame: 16, folded: 12 },
      { phase: 0, frame: 17, folded: 10 },
      { phase: 0, frame: 20, folded: 13 },
      { phase: 0, frame: 5, folded: 5 },
      // At phase 0.5: 3, 4, 3, 4 over 10-13, 13-17, 17-20, 20-24.
      { phase: 0.5, frame: 13, folded: 10 },
      { phase: 0.5, frame: 16, folded: 13 },
      { phase: 0.5, frame: 20, folded: 10 },
      { phase: 0.5, frame: 39, folded: 11 },
    ])('folds $frame at phase $phase to $folded', ({ phase, frame, folded }) => {
      expect(foldIntoLoop(frame, 10, 13.5, phase)).toBe(folded);
    });

    it('folds by the whole laps a stepped lap count takes, from any phase', () => {
      for (const length of [2.5, 2.75, 3.125, 3.5, 6.25]) {
        for (const phase of [0, 0.25, 0.5, 0.75, 31.5]) {
          let lapStart = 10;
          for (let lap = 0; lap < 60; lap++) {
            const lapFrames = lapLength(phase, length, lap);
            for (let offset = 0; offset < lapFrames; offset++) {
              const frame = lapStart + offset;
              expect(foldIntoLoop(frame, 10, 10 + length, phase)).toBe(10 + offset);
              expect(lapPhaseOfFold(frame, 10, 10 + length, phase)).toBeCloseTo(
                phase + lap * length,
                9,
              );
            }
            lapStart += lapFrames;
          }
        }
      }
    });

    it('folds a whole length as it does with none', () => {
      for (const frame of [5, 10, 50, 59, 60, 65, 110, 137]) {
        expect(foldIntoLoop(frame, 10, 60, 0.5)).toBe(foldIntoLoop(frame, 10, 60));
      }
    });
  });
});

describe('lapPhaseAt', () => {
  it.each([
    { name: 'a beat line', beat: 28, beatOne: 3, period: 28, start: 59, phase: 59 },
    {
      name: 'an eighth line on the half frame',
      beat: 28,
      beatOne: 0,
      period: 3.5,
      start: 102,
      phase: 101.5,
    },
    {
      name: 'an eighth line on a whole frame',
      beat: 28,
      beatOne: 0,
      period: 3.5,
      start: 98,
      phase: 98,
    },
    { name: 'a sixteenth of 40', beat: 40, beatOne: 1, period: 2.5, start: 104, phase: 103.5 },
    { name: 'an eighth of 22', beat: 22, beatOne: 3, period: 2.75, start: 105, phase: 104.75 },
    { name: 'a line before beat one', beat: 28, beatOne: 10, period: 3.5, start: 3, phase: 3 },
    { name: 'a quarter of 25', beat: 25, beatOne: 2, period: 6.25, start: 21, phase: 20.75 },
  ])('is the unrounded line for $name', ({ beat, beatOne, period, start, phase }) => {
    const beatGrid = grid(beat, beatOne);
    expect(lapPhaseAt(beatGrid, period, start)).toBe(phase);
    expect(gridLine(beatGrid, period, Math.round((phase - beatOne) / period))).toBe(start);
  });

  it('is the start itself off the lines, or for a period that is not a positive number', () => {
    expect(lapPhaseAt(grid(28, 0), 3.5, 103)).toBe(103);
    expect(lapPhaseAt(grid(28, 0), 0, 102)).toBe(102);
    expect(lapPhaseAt(grid(28, 0), Number.NaN, 102)).toBe(102);
  });

  it('names the phase that laps a loop from its start onto the grid’s own lines', () => {
    const beatGrid = grid(22, 3);
    const period = 2.75;
    for (let index = 0; index < 40; index++) {
      const start = gridLine(beatGrid, period, index);
      const phase = lapPhaseAt(beatGrid, period, start);
      let at = start;
      for (let lap = 0; lap < 20; lap++) {
        at += lapLength(phase, period, lap);
        expect(at).toBe(gridLine(beatGrid, period, index + lap + 1));
      }
    }
  });
});
