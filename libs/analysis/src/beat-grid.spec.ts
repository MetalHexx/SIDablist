import { describe, it, expect } from 'vitest';
import { SID_REGISTER_COUNT, VOICE_CONTROL_REGISTERS } from '@sidablist/core';
import type { RegisterRecord } from '@sidablist/core';
import { detectBeatGrid, fitBeatGrid, noteStarts } from './beat-grid.js';
import type { NoteStarts } from './beat-grid.js';

const PAL_CALLS_PER_SECOND = 50;
const GATE_ON = 0x41;
const GATE_OFF = 0x40;

interface Retrigger {
  readonly entry: number;
  readonly voice: number;
  /** The first byte written in that call. */
  readonly first: number;
}

/** A record of `frames` entries whose voice control columns come from `controls[voice][entry]`
 *  (gate off where absent), plus the given in-call double writes. */
function recordOf(
  frames: number,
  controls: readonly (readonly number[])[],
  retriggers: readonly Retrigger[] = [],
): RegisterRecord {
  const values = new Uint8Array(frames * SID_REGISTER_COUNT);
  controls.forEach((column, voice) => {
    column.forEach((byte, entry) => {
      values[entry * SID_REGISTER_COUNT + VOICE_CONTROL_REGISTERS[voice]] = byte;
    });
  });
  return {
    frames,
    values,
    retriggerEntries: Uint32Array.from(retriggers.map((r) => r.entry)),
    retriggerRegisters: Uint8Array.from(retriggers.map((r) => VOICE_CONTROL_REGISTERS[r.voice])),
    retriggerValues: Uint8Array.from(retriggers.map((r) => r.first)),
  };
}

/** A control column that holds `GATE_ON` over each `[from, to)` range and `GATE_OFF` elsewhere. */
function gated(frames: number, ...ranges: readonly (readonly [number, number])[]): number[] {
  const column = new Array<number>(frames).fill(GATE_OFF);
  for (const [from, to] of ranges) {
    column.fill(GATE_ON, from, to);
  }
  return column;
}

function startsAt(frames: readonly number[], voices: (frame: number) => number): NoteStarts {
  return {
    frames: Uint32Array.from(frames),
    voices: Uint8Array.from(frames.map(voices)),
  };
}

interface Pattern {
  /** Frames between steps. */
  readonly stepFrames: number;
  /** Frames between beats, which the loudest starts (three voices) fall on. */
  readonly beatFrames: number;
  readonly fromFrame?: number;
  readonly toFrame: number;
}

/** A lone voice on each step, all three voices on each beat. */
function accentedStarts({ stepFrames, beatFrames, fromFrame = 0, toFrame }: Pattern): number[][] {
  const out: number[][] = [];
  for (let frame = fromFrame; frame < toFrame; frame += stepFrames) {
    out.push([frame, (frame - fromFrame) % beatFrames === 0 ? 3 : 1]);
  }
  return out;
}

function asNoteStarts(parts: readonly (readonly number[])[]): NoteStarts {
  return {
    frames: Uint32Array.from(parts.map(([frame]) => frame)),
    voices: Uint8Array.from(parts.map(([, voices]) => voices)),
  };
}

/** Deterministic pseudo-random numbers in [0, 1). */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('noteStarts', () => {
  it('starts a note where a voice raises its gate, and not while the gate is held', () => {
    const record = recordOf(12, [gated(12, [3, 9])]);

    const starts = noteStarts(record);

    expect(Array.from(starts.frames)).toEqual([3]);
    expect(Array.from(starts.voices)).toEqual([1]);
  });

  it('starts a note on entry 0 when the gate is already raised there', () => {
    const record = recordOf(4, [gated(4, [0, 2])]);

    expect(Array.from(noteStarts(record).frames)).toEqual([0]);
  });

  it('starts a note again when the gate is dropped and raised between two entries', () => {
    const record = recordOf(10, [gated(10, [1, 4], [5, 8])]);

    expect(Array.from(noteStarts(record).frames)).toEqual([1, 5]);
  });

  it('starts a note where a play call drops the gate and raises it again', () => {
    // The chip holds the gate from entry 2 on, but entry 6 wrote it clear first and then set again.
    const record = recordOf(10, [gated(10, [2, 10])], [{ entry: 6, voice: 0, first: GATE_OFF }]);

    expect(Array.from(noteStarts(record).frames)).toEqual([2, 6]);
  });

  it('does not start a note when a doubled write held the gate throughout', () => {
    const record = recordOf(10, [gated(10, [2, 10])], [{ entry: 6, voice: 0, first: GATE_ON }]);

    expect(Array.from(noteStarts(record).frames)).toEqual([2]);
  });

  it('counts a gate raised and a retrigger on the same entry as one voice starting', () => {
    const record = recordOf(6, [gated(6, [3, 6])], [{ entry: 3, voice: 0, first: GATE_OFF }]);

    const starts = noteStarts(record);

    expect(Array.from(starts.frames)).toEqual([3]);
    expect(Array.from(starts.voices)).toEqual([1]);
  });

  it('counts every voice that starts on a frame, and reads each voice from its own register', () => {
    const record = recordOf(
      12,
      [gated(12, [2, 4], [8, 10]), gated(12, [2, 4]), gated(12, [2, 4], [6, 8])],
      [{ entry: 10, voice: 1, first: GATE_OFF }],
    );

    const starts = noteStarts(record);

    expect(Array.from(starts.frames)).toEqual([2, 6, 8]);
    expect(Array.from(starts.voices)).toEqual([3, 1, 1]);
  });

  it('counts a noise voice and a voice whose waveform changes with its gate', () => {
    const record = recordOf(6, [[0x80, 0x80, 0x81, 0x80, 0x00, 0x21]]);

    expect(Array.from(noteStarts(record).frames)).toEqual([2, 5]);
  });
});

describe('detectBeatGrid', () => {
  it('finds straight 24-frame beats under 6-frame steps', () => {
    const starts = asNoteStarts(accentedStarts({ stepFrames: 6, beatFrames: 24, toFrame: 4800 }));

    const detection = detectBeatGrid(starts, 4800, PAL_CALLS_PER_SECOND);

    expect(detection.grid).toEqual({
      beatFrames: 24,
      beatOneFrame: 0,
      startFrame: 0,
      endFrame: null,
    });
    expect(detection.confidence).toBe('strong');
  });

  it('puts beat one on the first note start that sits on the grid', () => {
    const starts = asNoteStarts(
      accentedStarts({ stepFrames: 6, beatFrames: 24, fromFrame: 10, toFrame: 4800 }),
    );

    const detection = detectBeatGrid(starts, 4800, PAL_CALLS_PER_SECOND);

    expect(detection.grid?.beatFrames).toBe(24);
    expect(detection.grid?.beatOneFrame).toBe(10);
  });

  it('adds a swing of 6 and 5 frames up to a whole 11-frame beat', () => {
    const swung: number[][] = [];
    for (let beat = 0; beat < 400; beat++) {
      swung.push([beat * 11, 3], [beat * 11 + 6, 1]);
    }

    // 11 frames is a usual beat only at a slow play rate: at 50 calls per second it is 270 BPM.
    const detection = detectBeatGrid(asNoteStarts(swung), 4400, PAL_CALLS_PER_SECOND / 2);

    expect(detection.grid?.beatFrames).toBe(11);
    expect(detection.grid?.beatOneFrame).toBe(0);
    expect(detection.confidence).not.toBe('none');
  });

  it('searches a multispeed stream in its own frames, giving the doubled frame count', () => {
    const starts = asNoteStarts(accentedStarts({ stepFrames: 12, beatFrames: 48, toFrame: 9600 }));

    const detection = detectBeatGrid(starts, 9600, PAL_CALLS_PER_SECOND * 2);

    expect(detection.grid?.beatFrames).toBe(48);
    expect(detection.confidence).toBe('strong');
  });

  it('takes the beat rather than the bar that aligns just as well', () => {
    const starts = asNoteStarts(accentedStarts({ stepFrames: 5, beatFrames: 30, toFrame: 6000 }));

    const detection = detectBeatGrid(starts, 6000, PAL_CALLS_PER_SECOND);

    expect(detection.grid?.beatFrames).toBe(30);
  });

  it('settles equally aligned lengths on the one nearest the usual tempo, and says it is unsure', () => {
    // Steps alone: every whole number of steps aligns exactly as well as any other.
    const starts = asNoteStarts(accentedStarts({ stepFrames: 6, beatFrames: 6, toFrame: 4800 }));

    const detection = detectBeatGrid(starts, 4800, PAL_CALLS_PER_SECOND);

    expect(detection.grid?.beatFrames).toBe(24);
    expect(detection.confidence).toBe('weak');
  });

  it('holds the grid across a quiet stretch', () => {
    const music = accentedStarts({ stepFrames: 6, beatFrames: 24, toFrame: 4800 }).filter(
      ([frame]) => frame < 1920 || frame >= 2880,
    );

    const detection = detectBeatGrid(asNoteStarts(music), 4800, PAL_CALLS_PER_SECOND);

    expect(detection.grid).toMatchObject({ beatFrames: 24, startFrame: 0, endFrame: null });
  });

  it('gives a tune that changes tempo the later part’s grid and span', () => {
    const changeFrame = 1200;
    const before = accentedStarts({
      stepFrames: 7,
      beatFrames: 28,
      fromFrame: 3,
      toFrame: changeFrame,
    });
    const after = accentedStarts({
      stepFrames: 6,
      beatFrames: 24,
      fromFrame: changeFrame,
      toFrame: 6000,
    });

    const detection = detectBeatGrid(
      asNoteStarts([...before, ...after]),
      6000,
      PAL_CALLS_PER_SECOND,
    );

    expect(detection.grid?.beatFrames).toBe(24);
    expect(detection.grid?.startFrame).toBeGreaterThanOrEqual(changeFrame);
    expect(detection.grid?.startFrame).toBeLessThan(changeFrame + 24);
    expect(detection.grid?.beatOneFrame).toBe(changeFrame);
    expect(detection.grid?.endFrame).toBeNull();
  });

  it('ends the span where the starts stop agreeing with the grid', () => {
    const endOfMusic = 4800;
    const music = accentedStarts({ stepFrames: 6, beatFrames: 24, toFrame: endOfMusic });
    const random = seeded(7);
    const freeTime: number[][] = [];
    for (let frame = endOfMusic + 7; frame < 7200; frame += 4 + Math.floor(random() * 13)) {
      freeTime.push([frame, 1]);
    }

    const detection = detectBeatGrid(
      asNoteStarts([...music, ...freeTime]),
      7200,
      PAL_CALLS_PER_SECOND,
    );

    expect(detection.grid?.beatFrames).toBe(24);
    expect(detection.grid?.startFrame).toBe(0);
    expect(detection.grid?.endFrame).toBeGreaterThan(endOfMusic - 24);
    expect(detection.grid?.endFrame).toBeLessThanOrEqual(endOfMusic);
  });

  it('declines note starts that fall at random', () => {
    const random = seeded(42);
    const taken = new Set<number>();
    while (taken.size < 600) {
      taken.add(Math.floor(random() * 6000));
    }
    const frames = [...taken].sort((a, b) => a - b);
    const starts = startsAt(frames, () => 1 + Math.floor(random() * 3));

    const detection = detectBeatGrid(starts, 6000, PAL_CALLS_PER_SECOND);

    expect(detection).toEqual({ grid: null, confidence: 'none' });
  });

  it('declines a 30-frame stream', () => {
    const starts = asNoteStarts(accentedStarts({ stepFrames: 1, beatFrames: 4, toFrame: 30 }));

    const detection = detectBeatGrid(starts, 30, PAL_CALLS_PER_SECOND);

    expect(detection).toEqual({ grid: null, confidence: 'none' });
  });

  it('declines a stream that covers fewer than a handful of beats, however regular its starts', () => {
    const starts = asNoteStarts(accentedStarts({ stepFrames: 3, beatFrames: 12, toFrame: 105 }));

    const detection = detectBeatGrid(starts, 105, PAL_CALLS_PER_SECOND);

    expect(starts.frames.length).toBeGreaterThanOrEqual(32);
    expect(detection).toEqual({ grid: null, confidence: 'none' });
  });

  it('declines when too few voices ever start a note', () => {
    const starts = asNoteStarts(accentedStarts({ stepFrames: 24, beatFrames: 24, toFrame: 480 }));

    expect(detectBeatGrid(starts, 4800, PAL_CALLS_PER_SECOND)).toEqual({
      grid: null,
      confidence: 'none',
    });
  });

  it('gives the same answer every time it is asked', () => {
    const starts = asNoteStarts(accentedStarts({ stepFrames: 6, beatFrames: 24, toFrame: 4800 }));

    const first = detectBeatGrid(starts, 4800, PAL_CALLS_PER_SECOND);
    const second = detectBeatGrid(starts, 4800, PAL_CALLS_PER_SECOND);

    expect(second).toEqual(first);
    expect(first.grid).not.toBeNull();
  });
});

describe('fitBeatGrid', () => {
  const GRID_OFFSET = 10;
  const starts = asNoteStarts(
    accentedStarts({ stepFrames: 6, beatFrames: 24, fromFrame: GRID_OFFSET, toFrame: 2400 }),
  );

  it('fits an exact 24-frame grid to approximate beat frames jittered by up to 2', () => {
    const jitter = [2, -2, 1, -1, 0, 2, -2, 1, -1, 2];
    const approx = jitter.map((offset, beat) => GRID_OFFSET + 24 * (beat + 3) + offset);

    const grid = fitBeatGrid(approx, starts);

    expect(grid).toEqual({ beatFrames: 24, beatOneFrame: GRID_OFFSET + 24 * 3 });
  });

  it('lands the length on the note starts rather than on the approximate gaps', () => {
    const approx = [0, 1, 2, 3, 4, 5].map((beat) => GRID_OFFSET + 25 * beat);

    const grid = fitBeatGrid(approx, starts);

    expect(grid?.beatFrames).toBe(24);
    expect(grid?.beatOneFrame).toBe(GRID_OFFSET);
  });

  it('anchors on a later approximate frame, then steps back to the first', () => {
    const lateStarts = asNoteStarts(
      accentedStarts({ stepFrames: 6, beatFrames: 24, fromFrame: 100, toFrame: 2400 }),
    );

    const grid = fitBeatGrid([28, 52, 76, 100, 124, 148], lateStarts);

    expect(grid).toEqual({ beatFrames: 24, beatOneFrame: 28 });
  });

  it('keeps beat one at or above frame 0', () => {
    const lateStarts = asNoteStarts(
      accentedStarts({ stepFrames: 6, beatFrames: 24, fromFrame: 22, toFrame: 2400 }),
    );

    const grid = fitBeatGrid([0, 24, 48, 72], lateStarts);

    expect(grid).toEqual({ beatFrames: 24, beatOneFrame: 22 });
  });

  it('is null with fewer than two approximate frames', () => {
    expect(fitBeatGrid([], starts)).toBeNull();
    expect(fitBeatGrid([GRID_OFFSET], starts)).toBeNull();
  });

  it('is null when the median gap is not positive', () => {
    expect(fitBeatGrid([34, 34, 34, 58], starts)).toBeNull();
  });

  it('is null when no approximate frame is near a note start', () => {
    const sparse = asNoteStarts([[1000, 3]]);

    expect(fitBeatGrid([100, 124, 148, 172], sparse)).toBeNull();
  });
});
