import { beforeEach, describe, expect, it } from 'vitest';
import { frames } from '../units.js';
import { createTrackStructure, type TrackStructure } from './track-structure.js';

describe('createTrackStructure', () => {
  let track: TrackStructure;

  beforeEach(() => {
    track = createTrackStructure();
  });

  it('has no structure and does not repeat before anything is set', () => {
    expect(track.loopStartFrame()).toBeNull();
    expect(track.loopPeriodFrames()).toBeNull();
    expect(track.trackEndFrame()).toBeNull();
    expect(track.repeatEnabled()).toBe(false);
  });

  it('derives the end from an explicit start plus the period', () => {
    track.setTrackStructure({
      loopStartFrame: frames(1000),
      loopPeriodFrames: frames(500),
      endedAtFrame: null,
    });

    expect(track.loopStartFrame()).toBe(1000);
    expect(track.loopPeriodFrames()).toBe(500);
    expect(track.trackEndFrame()).toBe(1500);
  });

  it('keeps an explicit start of 0 rather than treating it as absent', () => {
    track.setTrackStructure({
      loopStartFrame: frames(0),
      loopPeriodFrames: frames(500),
      endedAtFrame: null,
    });

    expect(track.loopStartFrame()).toBe(0);
    expect(track.trackEndFrame()).toBe(500);
  });

  it('defaults an absent start to 0 when a usable period is armed', () => {
    track.setTrackStructure({
      loopStartFrame: null,
      loopPeriodFrames: frames(750),
      endedAtFrame: null,
    });

    expect(track.loopStartFrame()).toBeNull();
    expect(track.trackEndFrame()).toBe(750);
  });

  it('disarms the loop rather than producing a zero-length one when the period is unusable', () => {
    track.setTrackStructure({
      loopStartFrame: frames(200),
      loopPeriodFrames: frames(0),
      endedAtFrame: null,
    });

    expect(track.loopStartFrame()).toBeNull();
    expect(track.loopPeriodFrames()).toBeNull();
    expect(track.trackEndFrame()).toBeNull();
  });

  it('treats a negative or non-finite period as no answer, not a fault', () => {
    track.setTrackStructure({
      loopStartFrame: frames(50),
      loopPeriodFrames: frames(-10),
      endedAtFrame: null,
    });
    expect(track.loopPeriodFrames()).toBeNull();

    track.setTrackStructure({
      loopStartFrame: frames(50),
      loopPeriodFrames: frames(NaN),
      endedAtFrame: null,
    });
    expect(track.loopPeriodFrames()).toBeNull();
  });

  it('falls back to the ended point when there is no usable period', () => {
    track.setTrackStructure({
      loopStartFrame: null,
      loopPeriodFrames: null,
      endedAtFrame: frames(9000),
    });

    expect(track.trackEndFrame()).toBe(9000);
  });

  it('treats an unusable ended point as no answer at all', () => {
    track.setTrackStructure({
      loopStartFrame: null,
      loopPeriodFrames: null,
      endedAtFrame: frames(-1),
    });

    expect(track.trackEndFrame()).toBeNull();
  });

  it('clears every field on a null detection, same as one that found nothing', () => {
    track.setTrackStructure({
      loopStartFrame: frames(10),
      loopPeriodFrames: frames(100),
      endedAtFrame: null,
    });

    track.setTrackStructure(null);

    expect(track.loopStartFrame()).toBeNull();
    expect(track.loopPeriodFrames()).toBeNull();
    expect(track.trackEndFrame()).toBeNull();
  });

  it('holds repeat as a plain value the caller sets, independent of the detection', () => {
    track.setRepeatEnabled(true);
    expect(track.repeatEnabled()).toBe(true);

    track.setTrackStructure({
      loopStartFrame: frames(10),
      loopPeriodFrames: frames(100),
      endedAtFrame: null,
    });
    expect(track.repeatEnabled()).toBe(true);

    track.setRepeatEnabled(false);
    expect(track.repeatEnabled()).toBe(false);
  });
});

describe('saving and restoring a track structure', () => {
  const read = (track: TrackStructure) => ({
    start: track.loopStartFrame(),
    period: track.loopPeriodFrames(),
    end: track.trackEndFrame(),
    repeat: track.repeatEnabled(),
  });

  it('puts back a loop and the repeat setting that a later detection replaced', () => {
    const track = createTrackStructure();
    track.setTrackStructure({
      loopStartFrame: frames(40),
      loopPeriodFrames: frames(200),
      endedAtFrame: null,
    });
    track.setRepeatEnabled(true);
    const state = track.createState();
    track.saveInto(state);
    const saved = read(track);

    track.setTrackStructure({
      loopStartFrame: null,
      loopPeriodFrames: null,
      endedAtFrame: frames(70),
    });
    track.setRepeatEnabled(false);
    track.restoreFrom(state);

    expect(read(track)).toEqual(saved);
    expect(saved.end).toBe(240);
  });

  it('puts back a track that only ended, and back to holding nothing', () => {
    const track = createTrackStructure();
    track.setTrackStructure({
      loopStartFrame: null,
      loopPeriodFrames: null,
      endedAtFrame: frames(70),
    });
    const ended = track.createState();
    track.saveInto(ended);
    const nothing = track.createState();
    track.setTrackStructure(null);
    track.saveInto(nothing);

    track.setTrackStructure({
      loopStartFrame: frames(0),
      loopPeriodFrames: frames(30),
      endedAtFrame: null,
    });
    track.restoreFrom(ended);
    expect(read(track)).toEqual({ start: null, period: null, end: 70, repeat: false });

    track.restoreFrom(nothing);
    expect(read(track)).toEqual({ start: null, period: null, end: null, repeat: false });
  });

  it('keeps a loop that starts at frame 0', () => {
    const track = createTrackStructure();
    track.setTrackStructure({
      loopStartFrame: frames(0),
      loopPeriodFrames: frames(64),
      endedAtFrame: null,
    });
    const state = track.createState();
    track.saveInto(state);
    track.setTrackStructure(null);

    track.restoreFrom(state);

    expect(read(track)).toMatchObject({ start: 0, period: 64, end: 64 });
  });
});
