import { describe, expect, it } from 'vitest';
import { createC64Machine } from '../cpu/c64-machine.js';
import { recordFromTune } from '../registers/__fixtures__/record-from-tune.js';
import { ALLOCATION_NOISE_BYTES } from '../testing/measure-allocation.js';
import { frames } from '../units.js';
import {
  counterTune,
  FRAMES,
  measureWork,
  playing,
  RESTORES,
  settled,
  type Running,
} from './allocation-harness.js';
import type { SavedPlayerState } from './sid-player.js';

/** A pass over tens of thousands of frames, run a dozen times over, takes seconds, and longer on a loaded machine. */
const LONG_RUN_MS = 60_000;

async function expectNoAllocation(work: () => void): Promise<void> {
  const { heapGrowthBytes, scavenges } = await measureWork(work);
  expect(scavenges).toBe(0);
  expect(heapGrowthBytes).toBeLessThan(ALLOCATION_NOISE_BYTES);
}

describe('the frame path', { timeout: LONG_RUN_MS }, () => {
  it('allocates nothing over plain play', async () => {
    const { run } = await playing(counterTune());

    await expectNoAllocation(() => run(FRAMES));
  });

  it('allocates nothing while a loop laps every fifty frames', async () => {
    const { player, run } = await playing(counterTune());
    run(200);
    player.setActiveLoop({ startFrame: frames(100), endFrame: frames(150) });
    await settled();

    await expectNoAllocation(() => run(FRAMES));

    expect(player.getPosition()).toBeLessThan(150);
  });

  it('allocates nothing across a loop whose length is not whole frames', async () => {
    const { player, run } = await playing(counterTune());
    run(200);
    player.setActiveLoop({ startFrame: frames(100), endFrame: frames(150.5), lapPhase: 0 });
    await settled();

    await expectNoAllocation(() => run(FRAMES));
  });

  it('allocates nothing on a tick when a queued jump lands on a held image, over and over', async () => {
    const { player, run } = await playing(counterTune());
    run(150);
    player.setJumpTargets([frames(100), frames(300)]);
    player.setActiveLoop({ startFrame: frames(100), endFrame: frames(110) });
    await settled();
    const landings = (): number => player.getSnapshot().tune?.handOffs ?? 0;
    const before = landings();
    let toSecond = true;

    // The queue is a host's command and the landing publishes a hand-off, so a few of each ride along
    // with the ticks; it is the ticks between them that must allocate nothing. Settings go
    // along: a landing applies what `queueJump` prepared.
    await expectNoAllocation(() => {
      for (let hop = 0; hop < 4; hop++) {
        const startFrame = toSecond ? 300 : 100;
        toSecond = !toSecond;
        player.queueJump({
          startFrame: frames(startFrame),
          endFrame: frames(startFrame + 10),
          settings: { voicePitch: [1, 1, 1], voiceMutes: [false, false, false] },
        });
        run(FRAMES / 4);
      }
    });

    expect(landings()).toBeGreaterThan(before);
  });

  it('allocates nothing with the hand on the record', async () => {
    const file = counterTune();
    const { player, run } = await playing(file);
    player.setRegisterRecord(recordFromTune(file, 1, 2_000));
    run(10);
    // Reads the position it is handed and allocates nothing itself: a swing around frame 1000
    // feeds a new record entry on every tick.
    expect(player.enterVarispeed((position) => (position < 1_000 ? 1 : -1))).toBe(true);

    await expectNoAllocation(() => run(FRAMES));
  });
});

describe('saving and restoring a player', { timeout: LONG_RUN_MS }, () => {
  const STATES = 8;
  const RESTORE_EVERY = 50;

  /** A player with a good deal in play — a loop of a length that is not whole frames, crossing
   *  lines holding images, the shadow, a tempo, a hold, an offset and a mute — and `STATES` states
   *  to keep restore points in, as a host does. */
  async function keeping(): Promise<Running & { readonly states: readonly SavedPlayerState[] }> {
    const running = await playing(counterTune());
    const { player, run } = running;
    player.setCrossingCaptures([{ originFrame: 0, periodFrames: 25, keep: 2 }]);
    player.setTempo(1.25);
    player.holdField({ name: 'resonance' }, 9, 0.5);
    player.setFieldOffset({ name: 'frequency', voice: 0 }, 40);
    player.setVoiceMuted(1, true);
    run(200);
    player.setActiveLoop({ startFrame: frames(100), endFrame: frames(150.5), lapPhase: 0 });
    await settled();
    player.startShadow(null);
    return {
      ...running,
      states: Array.from({ length: STATES }, () => player.createSavedState()),
    };
  }

  it('allocates nothing over frames saved every frame and restored every fifty', async () => {
    const { player, run, states } = await keeping();
    const published = player.getSnapshot();
    let frame = 0;
    let restores = 0;

    // A restore goes back to the state saved seven frames before: the same loop, tempo, mutes and
    // shadow, so nothing a snapshot publishes differs and none is built.
    await expectNoAllocation(() => {
      for (let index = 0; index < FRAMES; index++) {
        run(1);
        player.saveState(states[frame % STATES]);
        frame++;
        if (frame % RESTORE_EVERY === 0) {
          player.restoreState(states[(frame + 1) % STATES]);
          restores++;
        }
      }
    });

    expect(restores).toBeGreaterThan(FRAMES / RESTORE_EVERY);
    expect(player.getSnapshot()).toBe(published);
  });

  it('allocates nothing across restores alone', async () => {
    const { player, states } = await keeping();
    player.saveState(states[0]);

    // The same state onto itself, the no-op path: nothing is copied back.
    await expectNoAllocation(() => {
      for (let index = 0; index < RESTORES; index++) player.restoreState(states[0]);
    });
  });

  it('allocates nothing across alternating restores', async () => {
    const { player, run, states } = await keeping();
    player.saveState(states[0]);
    // Far enough on to differ in position and to have stamped another crossing slot.
    run(60);
    player.saveState(states[1]);

    // No tick between them, so every restore copies a state back over the other and moves what a
    // restore moves.
    await expectNoAllocation(() => {
      for (let index = 0; index < RESTORES; index++) player.restoreState(states[index % 2]);
    });
  });

  it('allocates nothing restoring while playing', async () => {
    const { player, run, states } = await keeping();
    for (const state of states) {
      run(5);
      player.saveState(state);
    }
    let frame = 0;

    await expectNoAllocation(() => {
      for (let index = 0; index < FRAMES; index++) {
        run(1);
        player.restoreState(states[frame++ % STATES]);
      }
    });
  });

  it('saves in microseconds, not milliseconds', async () => {
    const { player, run, states } = await keeping();
    const samples: number[] = [];
    for (let index = 0; index < 2_000; index++) {
      run(1);
      const start = performance.now();
      player.saveState(states[0]);
      samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    const median = samples[samples.length >> 1];
    const micros = (milliseconds: number): string => (milliseconds * 1000).toFixed(1);
    console.info(
      `saveState: median ${micros(median)} µs, p95 ${micros(samples[Math.floor(samples.length * 0.95)])} µs over ${samples.length} saves`,
    );

    // A save is about 2 µs here; the ceiling is several times that so a loaded CI machine passes and a
    // save that has started copying more than a machine image does not.
    expect(median).toBeLessThan(0.02);
  });
});

describe('the machine', { timeout: LONG_RUN_MS }, () => {
  it('runs a frame without building its result', async () => {
    const machine = createC64Machine(counterTune(), { onSidWrite: () => undefined });
    machine.initSubtune(1);

    await expectNoAllocation(() => {
      for (let index = 0; index < FRAMES; index++) machine.runFrame();
    });
  });
});
