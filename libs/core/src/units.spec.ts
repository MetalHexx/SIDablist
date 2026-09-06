import { describe, expect, it } from 'vitest';
import { cycles, frames, milliseconds, microseconds } from './units.js';

describe('branded unit types', () => {
  it('frames constructor creates a Frames value', () => {
    const value = frames(100);
    expect(value).toBe(100);
  });

  it('milliseconds constructor creates a Milliseconds value', () => {
    const value = milliseconds(50);
    expect(value).toBe(50);
  });

  it('microseconds constructor creates a Microseconds value', () => {
    const value = microseconds(50000);
    expect(value).toBe(50000);
  });

  it('cycles constructor creates a Cycles value', () => {
    const value = cycles(1000000);
    expect(value).toBe(1000000);
  });

  it('brand types provide type-level safety (nominal typing at compile time)', () => {
    const f = frames(100);
    const ms = milliseconds(100);
    const us = microseconds(100);

    expect(f).toBe(ms);
    expect(ms).toBe(us);
  });
});
