import { describe, expect, it } from 'vitest';
import { framesToSeconds, MICROSECONDS_PER_SECOND } from './math.js';

describe('framesToSeconds', () => {
  it('converts frames to seconds using nominal interval and calls per frame', () => {
    const frames = 100;
    const nominalIntervalUs = 20000;
    const callsPerFrame = 1;
    const expected = (frames * (nominalIntervalUs / callsPerFrame)) / MICROSECONDS_PER_SECOND;
    expect(framesToSeconds(frames, nominalIntervalUs, callsPerFrame)).toBe(expected);
  });

  it('handles multispeed by adjusting calls per frame', () => {
    const frames = 100;
    const nominalIntervalUs = 20000;
    const callsPerFrame = 2;
    const expected = (frames * (nominalIntervalUs / callsPerFrame)) / MICROSECONDS_PER_SECOND;
    expect(framesToSeconds(frames, nominalIntervalUs, callsPerFrame)).toBe(expected);
  });

  it('produces identical values to original analysis implementation', () => {
    const frames = 150;
    const nominalIntervalUs = 20000;
    const callsPerFrame = 1;
    const result = framesToSeconds(frames, nominalIntervalUs, callsPerFrame);
    const expected = (frames * (nominalIntervalUs / callsPerFrame)) / 1_000_000;
    expect(result).toBe(expected);
  });

  it('MICROSECONDS_PER_SECOND is correctly defined', () => {
    expect(MICROSECONDS_PER_SECOND).toBe(1_000_000);
  });
});
