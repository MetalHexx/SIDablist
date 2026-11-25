import { describe, expect, it } from 'vitest';
import type { JumpTarget } from '../messages/commands.js';
import { Rig } from '../testing/harness.js';
import { ALLOCATION_NOISE_BYTES, measureAllocation } from '../testing/measure-allocation.js';

/**
 * Frames a pass renders. The engine's clock callback is handed each frame's due time, a fractional
 * double that V8 boxes: about 16 bytes a frame that nothing here can avoid. The pass is long enough
 * for a per-frame allocation of any size to show above the noise, and short enough that those boxes
 * do not reach it.
 */
const FRAMES = 5_000;
const PRESSES = 300;
/** Enough passes for the engine to have optimised everything the frame path reaches. */
const WARMUP_FRAMES = 8;
/** A pass of presses is short, so it takes many more to tier everything a press reaches up; code still being tiered up allocates. */
const WARMUP_PRESSES = 60;
const LONG_RUN_MS = 120_000;

describe('the frame path', { timeout: LONG_RUN_MS }, () => {
  it('allocates nothing over plain play with a restore point saved and an update made every frame', async () => {
    const rig = new Rig({ quiet: true });
    const { sink } = rig.addDeck('a', { lookaheadMs: 60 });
    await rig.load('a', 'still-time', { ends: 'playing' });
    const { time, wake } = rig;
    rig.advance(500);

    const { heapGrowthBytes, scavenges } = await measureAllocation(
      () => {
        for (let i = 0; i < FRAMES; i++) {
          time.ms += 20;
          sink!.advanceTo(time.ms);
          wake.fire();
        }
      },
      { warmup: WARMUP_FRAMES },
    );

    expect(scavenges).toBe(0);
    expect(heapGrowthBytes, `grew ${heapGrowthBytes}`).toBeLessThan(ALLOCATION_NOISE_BYTES);
    rig.dispose();
  });

  it('allocates nothing in the re-render and the saves of presses that each rewind 120 ms of held frames', async () => {
    const rig = new Rig({ quiet: true });
    const { sink } = rig.addDeck('a', { lookaheadMs: 120 });
    await rig.load('a', 'still-time', { ends: 'playing' });
    const { time, wake, dj } = rig;
    rig.advance(500);
    // A nudge of 0 on a nudge that is already 0: each press lands, rewinds and re-renders, and
    // changes no field of the picture, so none is built.
    const release = { kind: 'nudge', deck: 'a', amount: 0 } as const;

    const { heapGrowthBytes, scavenges } = await measureAllocation(
      () => {
        for (let i = 0; i < PRESSES; i++) {
          time.ms += 20;
          sink!.advanceTo(time.ms);
          dj.send(release);
          wake.fire();
        }
      },
      { warmup: WARMUP_PRESSES },
    );

    const rewinds = rig.picture().timing.rewinds;
    expect(rewinds).toBeGreaterThan(PRESSES * 8);
    expect(rig.picture().timing.rewoundFrames).toBeGreaterThan(rewinds * 4);
    expect(scavenges).toBe(0);
    expect(heapGrowthBytes, `grew ${heapGrowthBytes}`).toBeLessThan(ALLOCATION_NOISE_BYTES);
    rig.dispose();
  });
});

/**
 * A deck with a loop running boxes the `lapProgress` of every update it reports (and, for a length
 * that is not whole, the lap phase and length it is worked out from): up to about 70 bytes a frame
 * over the due time's 16. The pass is shorter than the plain one so those boxes stay under the
 * budget, and still long enough for an allocation of a hundred bytes a frame to show above it.
 */
const LOOP_FRAMES = 2_000;
/** Handed off between this many times in a pass, with a press for each: each landing builds its pictures. */
const HAND_OFFS = 8;
const FRAMES_PER_HAND_OFF = 25;

/** Loops the allocation specs run: two whole ones to hand off between, and one whose length is not whole. */
const LOOP_A: JumpTarget = { startFrame: 500, endFrame: 510 };
const LOOP_B: JumpTarget = { startFrame: 1000, endFrame: 1010 };
const FRACTIONAL: JumpTarget = { startFrame: 500, endFrame: 517.4 };

/** A quiet rig whose deck has `target` running as a loop, with 500 and 1000 ready. */
async function looping(target: JumpTarget): Promise<Rig> {
  const rig = new Rig({ quiet: true });
  rig.addDeck('a', { lookaheadMs: 60 });
  await rig.load('a', 'still-time', { ends: 'playing' });
  rig.send({ kind: 'targets', deck: 'a', frames: [500, 1000] });
  await rig.settle();
  rig.advance(300);
  rig.send({ kind: 'hot-cue', deck: 'a', target });
  await rig.microtasks();
  rig.advance(100);
  expect(rig.picture().loop).toMatchObject({ startFrame: target.startFrame });
  return rig;
}

describe('the frame path with a loop running', () => {
  for (const [name, target] of [
    ['whole', LOOP_A],
    ['not whole', FRACTIONAL],
  ] as const) {
    it(`allocates nothing but boxed numbers over the laps of a loop whose length is ${name}`, async () => {
      const rig = await looping(target);
      const { time, wake } = rig;
      const sink = rig.sinks.get('a')!;
      const before = rig.picture().timing.framesDelivered;

      const { heapGrowthBytes, scavenges } = await measureAllocation(
        () => {
          for (let i = 0; i < LOOP_FRAMES; i++) {
            time.ms += 20;
            sink.advanceTo(time.ms);
            wake.fire();
          }
        },
        { warmup: WARMUP_FRAMES },
      );

      expect(rig.picture().timing.framesDelivered).toBeGreaterThan(before + LOOP_FRAMES);
      expect(rig.picture().loop).toMatchObject({ startFrame: target.startFrame });
      expect(scavenges).toBe(0);
      expect(heapGrowthBytes, `grew ${heapGrowthBytes}`).toBeLessThan(ALLOCATION_NOISE_BYTES);
      rig.dispose();
    });
  }

  it('reads each queued landing from the hand-offs, and builds a picture only where something changed', async () => {
    const rig = await looping(LOOP_A);
    const { time, wake, dj } = rig;
    const sink = rig.sinks.get('a')!;
    const queueB = { kind: 'hot-cue', deck: 'a', target: LOOP_B } as const;
    const queueA = { kind: 'hot-cue', deck: 'a', target: LOOP_A } as const;
    const pass = (): void => {
      for (let i = 0; i < HAND_OFFS; i++) {
        dj.send(i % 2 === 0 ? queueB : queueA);
        for (let frame = 0; frame < FRAMES_PER_HAND_OFF; frame++) {
          time.ms += 20;
          sink.advanceTo(time.ms);
          wake.fire();
        }
      }
    };

    const { heapGrowthBytes, scavenges } = await measureAllocation(pass, {
      warmup: WARMUP_PRESSES,
    });

    // Each press queued the other loop, which landed at the wrap: the deck ends where it began.
    expect(rig.picture().loop).toMatchObject({ startFrame: 500 });
    expect(rig.picture().queued).toBeNull();
    expect(scavenges).toBe(0);
    expect(heapGrowthBytes, `grew ${heapGrowthBytes}`).toBeLessThan(ALLOCATION_NOISE_BYTES);

    // What a pass reports: a picture for each press (a target queued) and for each landing (a loop
    // running, nothing queued), and none on the frames between.
    const pictures = (): number => rig.ofKind('picture').length;
    const built = pictures();
    pass();
    expect(pictures() - built).toBeLessThanOrEqual(HAND_OFFS * 2);
    expect(pictures() - built).toBeGreaterThanOrEqual(HAND_OFFS);
    rig.dispose();
  });
});

/**
 * A tick under the hand asks the rate source, which runs inside the engine's tick: it reads and
 * writes the hand's numbers and allocates nothing of its own. What the pass allocates is what a
 * loop's does (the boxed doubles the engine hands it and takes back, the update's lap progress
 * and, while slip counts, its position), so the pass is no longer than a loop's.
 */
const HAND_FRAMES = 1_500;

/** A wrapping loop the record can be thrown round for as long as a pass lasts, inside the register record's reach. */
const WRAPPING: JumpTarget = { startFrame: 100, endFrame: 120, wraps: true };

describe('the frame path with the hand on the record', () => {
  /** A quiet rig whose deck loops with slip on, so a hand on the record is a nested departure. */
  async function handOnLoop(): Promise<Rig> {
    const rig = new Rig({ quiet: true });
    rig.addDeck('a', { lookaheadMs: 60 });
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.send({ kind: 'targets', deck: 'a', frames: [100] });
    await rig.settle();
    rig.advance(300);
    rig.send({ kind: 'slip', deck: 'a', on: true });
    rig.send({ kind: 'hot-cue', deck: 'a', target: WRAPPING });
    await rig.microtasks();
    rig.advance(100);
    rig.send({ kind: 'hand-touch', deck: 'a', atMs: rig.time.ms });
    await rig.microtasks();
    rig.advance(100);
    expect(rig.picture().hand).toBe('down');
    return rig;
  }

  it('allocates nothing but boxed numbers over the ticks of a hand that holds the record, and of a throw', async () => {
    const rig = await handOnLoop();
    const { time, wake } = rig;
    const sink = rig.sinks.get('a')!;
    const tick = (): void => {
      time.ms += 20;
      sink.advanceTo(time.ms);
      wake.fire();
    };

    for (const phase of ['held', 'thrown'] as const) {
      if (phase === 'thrown') {
        // With slip on a lift lands the deck on the count; off, it throws. A grip this long keeps
        // the throw at its release speed for the whole pass.
        rig.send({ kind: 'slip', deck: 'a', on: false });
        rig.send({ kind: 'hand-move', deck: 'a', travelFrames: 4, atMs: 100 });
        rig.send({ kind: 'hand-move', deck: 'a', travelFrames: 8, atMs: 120 });
        rig.send({ kind: 'hand-lift', deck: 'a', atMs: 130, gripSeconds: 1_000_000 });
        await rig.microtasks();
        rig.advance(100);
        expect(rig.picture().hand).toBe('thrown');
      }
      const before = rig.picture().timing.framesDelivered;

      const { heapGrowthBytes, scavenges } = await measureAllocation(
        () => {
          for (let i = 0; i < HAND_FRAMES; i++) tick();
        },
        { warmup: WARMUP_FRAMES },
      );

      expect(rig.picture().timing.framesDelivered).toBeGreaterThan(before + HAND_FRAMES);
      expect(rig.picture().hand).toBe(phase === 'held' ? 'down' : 'thrown');
      expect(scavenges, `${phase} scavenged`).toBe(0);
      expect(heapGrowthBytes, `${phase} grew ${heapGrowthBytes}`).toBeLessThan(
        ALLOCATION_NOISE_BYTES,
      );
    }
    rig.dispose();
  });

  it('allocates nothing in the saves of presses that rewind a hand that is down', async () => {
    const rig = await handOnLoop();
    const { time, wake, dj } = rig;
    const sink = rig.sinks.get('a')!;
    // A hand move to where the hand already is: it lands, rewinds and re-renders, and changes
    // nothing a picture holds.
    const hold = { kind: 'hand-move', deck: 'a', travelFrames: 0, atMs: 0 } as const;

    const { heapGrowthBytes, scavenges } = await measureAllocation(
      () => {
        for (let i = 0; i < PRESSES; i++) {
          time.ms += 20;
          sink.advanceTo(time.ms);
          dj.send(hold);
          wake.fire();
        }
      },
      { warmup: WARMUP_PRESSES },
    );

    expect(rig.picture().timing.rewinds).toBeGreaterThan(PRESSES * 4);
    expect(rig.picture().hand).toBe('down');
    expect(scavenges).toBe(0);
    expect(heapGrowthBytes, `grew ${heapGrowthBytes}`).toBeLessThan(ALLOCATION_NOISE_BYTES);
    rig.dispose();
  });
});
