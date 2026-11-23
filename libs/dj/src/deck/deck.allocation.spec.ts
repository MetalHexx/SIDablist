import { describe, expect, it } from 'vitest';
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
