import { describe, expect, it } from 'vitest';
import type { BeatGrid, DetectedBeatGrid } from './beat-grid.js';
import { beatsPerMinute, inGridSpan, nearestBeat, nextBeat, onBeat, snapToBeat } from './beats.js';

/** A bare grid: beats at 10, 34, 58, ... and -14 before the tune starts. */
const bare: BeatGrid = { beatFrames: 24, beatOneFrame: 10 };
/** A scan's grid: beats at 106, 130, 154, 178 inside [100, 200). */
const scan: DetectedBeatGrid = { beatFrames: 24, beatOneFrame: 10, startFrame: 100, endFrame: 200 };
const openScan: DetectedBeatGrid = { ...scan, endFrame: null };

describe('inGridSpan', () => {
  it('holds from startFrame inclusive to endFrame exclusive', () => {
    expect(inGridSpan(scan, 99)).toBe(false);
    expect(inGridSpan(scan, 100)).toBe(true);
    expect(inGridSpan(scan, 199)).toBe(true);
    expect(inGridSpan(scan, 200)).toBe(false);
  });

  it('holds to the end of the tune while endFrame is null', () => {
    expect(inGridSpan(openScan, 1e9)).toBe(true);
  });

  it('holds a bare grid over the whole tune from frame 0', () => {
    expect(inGridSpan(bare, -1)).toBe(false);
    expect(inGridSpan(bare, 0)).toBe(true);
    expect(inGridSpan(bare, 1e9)).toBe(true);
  });
});

describe('nearestBeat', () => {
  it('is null outside the span', () => {
    expect(nearestBeat(scan, 99)).toBeNull();
    expect(nearestBeat(scan, 200)).toBeNull();
  });

  it('skips a beat below frame 0', () => {
    expect(nearestBeat(bare, 0)).toBe(10);
    expect(nearestBeat(bare, 5)).toBe(10);
  });

  it('skips a beat outside the span, taking the nearest inside it', () => {
    expect(nearestBeat(scan, 100)).toBe(106);
    expect(nearestBeat(scan, 199)).toBe(178);
  });

  it('keeps the earlier beat on a tie', () => {
    expect(nearestBeat(scan, 118)).toBe(106);
  });

  it('returns a beat unrounded', () => {
    expect(nearestBeat({ beatFrames: 24.5, beatOneFrame: 0 }, 72)).toBe(73.5);
  });
});

describe('onBeat', () => {
  it('is true under half a frame off and false at half a frame', () => {
    expect(onBeat(bare, 34.49)).toBe(true);
    expect(onBeat(bare, 34.5)).toBe(false);
    expect(onBeat(bare, 33.51)).toBe(true);
  });

  it('is false outside the span', () => {
    expect(onBeat(scan, 99.9)).toBe(false);
  });
});

describe('nextBeat', () => {
  it('goes strictly past a beat it starts on', () => {
    expect(nextBeat(bare, 34, 1)).toBe(58);
    expect(nextBeat(bare, 34, -1)).toBe(10);
  });

  it('goes to the neighbouring beat from between beats', () => {
    expect(nextBeat(bare, 40, 1)).toBe(58);
    expect(nextBeat(bare, 40, -1)).toBe(34);
  });

  it('is null below frame 0 or outside the span', () => {
    expect(nextBeat(bare, 10, -1)).toBeNull();
    expect(nextBeat(scan, 178, 1)).toBeNull();
    expect(nextBeat(scan, 106, -1)).toBeNull();
  });
});

describe('snapToBeat', () => {
  it('rounds the frame and then moves it to the nearest beat, rounded', () => {
    expect(snapToBeat(36.4, bare)).toBe(34);
    expect(snapToBeat(72, { beatFrames: 24.5, beatOneFrame: 0 })).toBe(74);
  });

  it('is the rounded frame outside the span or with no grid', () => {
    expect(snapToBeat(50.6, scan)).toBe(51);
    expect(snapToBeat(3.5, null)).toBe(4);
  });
});

describe('beatsPerMinute', () => {
  it('is the beats a minute of a beat of beatFrames play calls', () => {
    expect(beatsPerMinute(24, 20_000, 1)).toBe(125);
  });

  it('scales with the tempo', () => {
    expect(beatsPerMinute(24, 20_000, 0.5)).toBe(62.5);
  });
});
