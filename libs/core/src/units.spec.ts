import { describe, expect, it } from 'vitest';
import { cycles, frames, milliseconds, microseconds, type Frames } from './units.js';

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
    // Compile-time assertion: assigning Milliseconds where Frames is expected fails typechecking
    const expectFrames = (f: Frames) => f;
    // @ts-expect-error Milliseconds is not assignable to Frames
    expectFrames(milliseconds(100));
  });
});
