import { describe, expect, it } from 'vitest';
import { frames } from '../units.js';
import { countAfter, ShadowPosition, type ShadowCount } from './shadow-position.js';
import { createTrackStructure } from './track-structure.js';

const loop = (
  start: number,
  end: number,
): { startFrame: ReturnType<typeof frames>; endFrame: ReturnType<typeof frames> } => ({
  startFrame: frames(start),
  endFrame: frames(end),
});

const at = (frame: number, held = false): ShadowCount => ({ frame: frames(frame), held });

/** What the shadow reads after each of `ticks` ticks. */
function readings(shadow: ShadowPosition, ticks: number): number[] {
  const track = createTrackStructure();
  const read: number[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    shadow.tick(track);
    read.push(shadow.position() ?? -1);
  }
  return read;
}

describe('ShadowPosition', () => {
  it('reads nothing until it starts and after it stops', () => {
    const shadow = new ShadowPosition();
    expect(shadow.position()).toBeNull();
    expect(shadow.count()).toBeNull();
    expect(shadow.tickCount()).toBeNull();

    shadow.start(null, at(5));
    expect(shadow.position()).toBe(5);
    shadow.stop();

    expect(shadow.position()).toBeNull();
    expect(shadow.isRunning()).toBe(false);
  });

  it('laps a loop reading its start twice, then up to the frame before the one the gate-off takes', () => {
    const shadow = new ShadowPosition();
    shadow.start(loop(10, 16), at(10));

    // Over its E - S ticks a lap of [S, E) reads S, S, S+1, ..., E-2.
    expect(readings(shadow, 12)).toEqual([11, 12, 13, 14, 10, 10, 11, 12, 13, 14, 10, 10]);
  });

  it('holds on the tick after a wrap and says so', () => {
    const shadow = new ShadowPosition();
    shadow.start(loop(10, 14), at(11));
    const track = createTrackStructure();

    shadow.tick(track);
    expect(shadow.count()).toEqual({ frame: 12, held: false });
    shadow.tick(track);
    expect(shadow.count()).toEqual({ frame: 10, held: true });
    shadow.tick(track);
    expect(shadow.count()).toEqual({ frame: 10, held: false });
  });

  it('starts held when the count it is given is held', () => {
    const shadow = new ShadowPosition();
    shadow.start(null, at(10, true));

    expect(readings(shadow, 3)).toEqual([10, 11, 12]);
  });

  it('counts a loop too short to give up a frame as two ticks a lap', () => {
    const shadow = new ShadowPosition();
    shadow.start(loop(10, 11), at(10));

    expect(readings(shadow, 5)).toEqual([10, 10, 10, 10, 10]);
    expect(shadow.count()).toEqual({ frame: 10, held: true });
  });

  it('wraps where the track does when it has no loop, to the loop start or to 0', () => {
    const track = createTrackStructure();
    track.setTrackStructure({
      loopStartFrame: frames(4),
      loopPeriodFrames: frames(6),
      endedAtFrame: null,
    });
    const shadow = new ShadowPosition();
    shadow.start(null, at(7));

    const read: number[] = [];
    for (let tick = 0; tick < 7; tick++) {
      shadow.tick(track);
      read.push(shadow.position() ?? -1);
    }
    expect(read).toEqual([8, 4, 4, 5, 6, 7, 8]);

    track.setTrackStructure({
      loopStartFrame: null,
      loopPeriodFrames: null,
      endedAtFrame: frames(5),
    });
    shadow.start(null, at(2));
    const flat: number[] = [];
    for (let tick = 0; tick < 5; tick++) {
      shadow.tick(track);
      flat.push(shadow.position() ?? -1);
    }
    expect(flat).toEqual([3, 0, 0, 1, 2]);
  });

  it('counts on without a wrap when the track has no end', () => {
    const shadow = new ShadowPosition();
    shadow.start(null, at(0));

    expect(readings(shadow, 4)).toEqual([1, 2, 3, 4]);
  });

  it('counts ticks since it last started, held ones included, and restarts the count on a re-base', () => {
    const shadow = new ShadowPosition();
    shadow.start(loop(10, 14), at(10, true));
    readings(shadow, 5);
    expect(shadow.tickCount()).toBe(5);

    shadow.start(null, at(0));

    expect(shadow.tickCount()).toBe(0);
    expect(shadow.position()).toBe(0);
  });

  it('does not move while stopped', () => {
    const shadow = new ShadowPosition();
    shadow.start(null, at(3));
    shadow.stop();
    readings(shadow, 4);
    shadow.start(null, at(3));

    expect(shadow.position()).toBe(3);
  });
});

describe('countAfter', () => {
  it('is the count it started at after no ticks', () => {
    expect(countAfter(at(4, true), 0, loop(0, 10))).toEqual(at(4, true));
  });

  it('counts a held start through its gate-off tick without moving', () => {
    expect(countAfter(at(4, true), 1, null)).toEqual(at(4));
    expect(countAfter(at(4, true), 3, null)).toEqual(at(6));
  });

  it('never wraps with no loop', () => {
    expect(countAfter(at(0), 1000, null)).toEqual(at(1000));
  });

  it('follows the laps of a loop', () => {
    expect(countAfter(at(10), 4, loop(10, 16))).toEqual(at(14));
    expect(countAfter(at(10), 5, loop(10, 16))).toEqual(at(10, true));
    expect(countAfter(at(10), 6, loop(10, 16))).toEqual(at(10));
    expect(countAfter(at(10), 7, loop(10, 16))).toEqual(at(11));
  });

  it.each([
    ['a loop', loop(10, 17)],
    ['a loop too short to give up a frame', loop(10, 11)],
    ['a two-frame loop', loop(10, 12)],
    ['a whole loop carrying a lap phase', { ...loop(10, 17), lapPhase: 0.5 }],
  ])('equals stepping the shadow tick by tick over %s, from any place', (_, lap) => {
    const starts: ShadowCount[] = [];
    for (let frame = 0; frame <= 20; frame++) {
      starts.push(at(frame), at(frame, true));
    }
    for (const from of starts) {
      const shadow = new ShadowPosition();
      shadow.start(lap, from);
      const track = createTrackStructure();
      for (let ticks = 0; ticks <= 40; ticks++) {
        expect(countAfter(from, ticks, lap)).toEqual(shadow.count());
        shadow.tick(track);
      }
    }
  });
});

describe('a loop whose length is not a whole number of frames', () => {
  const fractional = (start: number, length: number, lapPhase?: number) => ({
    ...loop(start, start + length),
    ...(lapPhase === undefined ? {} : { lapPhase }),
  });

  /** The ticks each lap of the shadow takes, from a lap's start, held. */
  function lapTicks(shadow: ShadowPosition, laps: number): number[] {
    const track = createTrackStructure();
    const taken: number[] = [];
    let ticks = 0;
    while (taken.length < laps) {
      shadow.tick(track);
      ticks++;
      if (shadow.count()?.held === true) {
        taken.push(ticks);
        ticks = 0;
      }
    }
    return taken;
  }

  it('laps the shadow in alternating lengths, as the player laps the loop', () => {
    const atZero = new ShadowPosition();
    atZero.start(fractional(10, 3.5), at(10, true));
    expect(lapTicks(atZero, 6)).toEqual([4, 3, 4, 3, 4, 3]);

    const atHalf = new ShadowPosition();
    atHalf.start(fractional(10, 3.5, 0.5), at(10, true));
    expect(lapTicks(atHalf, 4)).toEqual([3, 4, 3, 4]);
  });

  it('counts from the lap the count names over the loop’s own phase, and says which lap it is in', () => {
    const shadow = new ShadowPosition();
    shadow.start(fractional(10, 3.5), { ...at(10, true), lapPhase: 0.5 });

    expect(shadow.count()).toEqual({ frame: 10, held: true, lapPhase: 0.5 });
    expect(lapTicks(shadow, 2)).toEqual([3, 4]);
    expect(shadow.count()).toEqual({ frame: 10, held: true, lapPhase: 0.5 });
    shadow.tick(createTrackStructure());
    expect(shadow.count()).toEqual({ frame: 10, held: false, lapPhase: 0.5 });
  });

  it('reports no lap phase on a whole loop or with none', () => {
    const shadow = new ShadowPosition();
    shadow.start({ ...loop(10, 14), lapPhase: 0.5 }, { ...at(10), lapPhase: 0.5 });
    expect(shadow.count()).toEqual({ frame: 10, held: false });
    expect(countAfter({ ...at(10), lapPhase: 0.5 }, 3, loop(10, 14))).toEqual(at(10, true));
    expect(countAfter({ ...at(10), lapPhase: 0.5 }, 3, null)).toEqual(at(13));
  });

  it.each([
    [2.5, [0, 0.5]],
    [2.75, [0, 0.25, 0.5, 0.75]],
    [3.5, [0, 0.5, 31.5]],
    [3.125, [0, 0.125, 0.5, 0.875]],
    [6.25, [0, 0.75]],
    [1.5, [0, 0.5]],
  ])(
    'countAfter equals stepping the shadow tick by tick over %s frames, from any place and phase',
    (length, phases) => {
      for (const phase of phases) {
        const lap = fractional(10, length, phase);
        const starts: ShadowCount[] = [];
        for (let frame = 0; frame <= 20; frame++) {
          starts.push(at(frame), at(frame, true));
          // A count handed in with its own lap's phase, which wins over the loop's.
          starts.push({ ...at(frame), lapPhase: lapPhaseAfterOne(phase, length) });
        }
        for (const from of starts) {
          const shadow = new ShadowPosition();
          shadow.start(lap, from);
          const track = createTrackStructure();
          for (let ticks = 0; ticks <= 300; ticks++) {
            expect(countAfter(from, ticks, lap)).toEqual(shadow.count());
            shadow.tick(track);
          }
        }
      }
    },
  );

  it('countAfter is the stepped count however many laps the ticks span', () => {
    const lap = fractional(10, 3.125, 0.375);
    const shadow = new ShadowPosition();
    const from = at(12);
    shadow.start(lap, from);
    const track = createTrackStructure();
    for (let ticks = 1; ticks <= 100_000; ticks++) {
      shadow.tick(track);
      if (ticks % 9973 === 0 || ticks === 100_000) {
        expect(countAfter(from, ticks, lap)).toEqual(shadow.count());
      }
    }
  });
});

/** The reduced phase a lap on from `phase`. */
function lapPhaseAfterOne(phase: number, length: number): number {
  const next = phase + length;
  return next - Math.floor(next);
}
