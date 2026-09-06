import { describe, expect, it } from 'vitest';
import {
  positionBasisFor,
  sanitizePositiveFrame,
  sanitizeStartFrame,
  timelineBasisFor,
} from './length.js';

describe('positionBasisFor', () => {
  it('returns null for null input', () => {
    expect(positionBasisFor(null)).toBeNull();
  });

  it('returns intro + period for a looping tune', () => {
    const loop = {
      loopStartFrame: 1000,
      loopPeriodFrames: 2000,
      endedAtFrame: null,
    };
    expect(positionBasisFor(loop)).toBe(3000);
  });

  it('handles looping tune with zero loop start', () => {
    const loop = {
      loopStartFrame: 0,
      loopPeriodFrames: 5000,
      endedAtFrame: 100000,
    };
    expect(positionBasisFor(loop)).toBe(5000);
  });

  it('returns end point for ended tune (no loop period)', () => {
    const loop = {
      loopStartFrame: 1000,
      loopPeriodFrames: null,
      endedAtFrame: 8000,
    };
    expect(positionBasisFor(loop)).toBe(8000);
  });

  it('returns null for tune detection could not answer for', () => {
    const loop = {
      loopStartFrame: null,
      loopPeriodFrames: null,
      endedAtFrame: null,
    };
    expect(positionBasisFor(loop)).toBeNull();
  });

  it('sanitizes period and ignores invalid end point', () => {
    const loop = {
      loopStartFrame: 1000,
      loopPeriodFrames: -100,
      endedAtFrame: Infinity,
    };
    expect(positionBasisFor(loop)).toBeNull();
  });
});

describe('timelineBasisFor', () => {
  it('returns null for null input', () => {
    expect(timelineBasisFor(null)).toBeNull();
  });

  it('returns intro + period for a looping tune', () => {
    const loop = {
      loopStartFrame: 1000,
      loopPeriodFrames: 2000,
      endedAtFrame: null,
    };
    expect(timelineBasisFor(loop)).toBe(3000);
  });

  it('handles looping tune with zero loop start', () => {
    const loop = {
      loopStartFrame: 0,
      loopPeriodFrames: 5000,
      endedAtFrame: 100000,
    };
    expect(timelineBasisFor(loop)).toBe(5000);
  });

  it('scales ended tune end point by ENDED_MUSIC_FRACTION', () => {
    const loop = {
      loopStartFrame: 1000,
      loopPeriodFrames: null,
      endedAtFrame: 80000,
    };
    const expected = Math.round(80000 / 0.8);
    expect(timelineBasisFor(loop)).toBe(expected);
  });

  it('returns null for tune detection could not answer for', () => {
    const loop = {
      loopStartFrame: null,
      loopPeriodFrames: null,
      endedAtFrame: null,
    };
    expect(timelineBasisFor(loop)).toBeNull();
  });

  it('sanitizes period and handles invalid end point', () => {
    const loop = {
      loopStartFrame: 1000,
      loopPeriodFrames: -100,
      endedAtFrame: Infinity,
    };
    expect(timelineBasisFor(loop)).toBeNull();
  });
});

describe('sanitizePositiveFrame', () => {
  it('accepts finite positive numbers', () => {
    expect(sanitizePositiveFrame(1)).toBe(1);
    expect(sanitizePositiveFrame(100.5)).toBe(100.5);
  });

  it('rejects zero', () => {
    expect(sanitizePositiveFrame(0)).toBeNull();
  });

  it('rejects negative numbers', () => {
    expect(sanitizePositiveFrame(-1)).toBeNull();
  });

  it('rejects non-finite numbers', () => {
    expect(sanitizePositiveFrame(Infinity)).toBeNull();
    expect(sanitizePositiveFrame(-Infinity)).toBeNull();
    expect(sanitizePositiveFrame(NaN)).toBeNull();
  });

  it('rejects null and non-numbers', () => {
    expect(sanitizePositiveFrame(null)).toBeNull();
  });
});

describe('sanitizeStartFrame', () => {
  it('accepts zero', () => {
    expect(sanitizeStartFrame(0)).toBe(0);
  });

  it('accepts finite positive numbers', () => {
    expect(sanitizeStartFrame(1)).toBe(1);
    expect(sanitizeStartFrame(100.5)).toBe(100.5);
  });

  it('rejects negative numbers', () => {
    expect(sanitizeStartFrame(-1)).toBeNull();
  });

  it('rejects non-finite numbers', () => {
    expect(sanitizeStartFrame(Infinity)).toBeNull();
    expect(sanitizeStartFrame(-Infinity)).toBeNull();
    expect(sanitizeStartFrame(NaN)).toBeNull();
  });

  it('rejects null and non-numbers', () => {
    expect(sanitizeStartFrame(null)).toBeNull();
  });
});
