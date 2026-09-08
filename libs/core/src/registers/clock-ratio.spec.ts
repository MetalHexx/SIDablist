import { describe, it, expect } from 'vitest';
import { NTSC_PHI2_HZ, PAL_PHI2_HZ, clockRatio } from './clock-ratio.js';

describe('clockRatio', () => {
  it('is exactly 1 for a machine clocked the way the tune was written for', () => {
    expect(clockRatio(PAL_PHI2_HZ, PAL_PHI2_HZ)).toBe(1);
    expect(clockRatio(NTSC_PHI2_HZ, NTSC_PHI2_HZ)).toBe(1);
  });

  it('undoes the 3.804% NTSC clock rise, in whichever direction the correction runs', () => {
    const palOnNtsc = clockRatio(PAL_PHI2_HZ, NTSC_PHI2_HZ) as number;
    const ntscOnPal = clockRatio(NTSC_PHI2_HZ, PAL_PHI2_HZ) as number;

    // A faster machine needs smaller register values to sound the same note, and a slower one
    // larger — the correction is the inverse of the clock's own move.
    expect(palOnNtsc).toBeLessThan(1);
    expect(ntscOnPal).toBeGreaterThan(1);
    expect(1 / palOnNtsc).toBeCloseTo(1.03804, 5);
    expect(palOnNtsc * ntscOnPal).toBeCloseTo(1, 12);
  });

  it('scales linearly with either clock, so a doubled target halves the correction', () => {
    expect(clockRatio(1000, 2000)).toBe(0.5);
    expect(clockRatio(2000, 1000)).toBe(2);
  });

  it.each([
    ['a zero source', 0, NTSC_PHI2_HZ],
    ['a zero target', PAL_PHI2_HZ, 0],
    ['a negative source', -PAL_PHI2_HZ, NTSC_PHI2_HZ],
    ['a negative target', PAL_PHI2_HZ, -NTSC_PHI2_HZ],
    ['a NaN source', Number.NaN, NTSC_PHI2_HZ],
    ['an infinite target', PAL_PHI2_HZ, Number.POSITIVE_INFINITY],
  ])('rejects %s rather than deriving a coefficient from it', (_case, sourceHz, targetHz) => {
    expect(clockRatio(sourceHz, targetHz)).toBeNull();
  });
});
