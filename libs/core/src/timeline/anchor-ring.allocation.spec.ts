import { describe, expect, it } from 'vitest';
import { createC64Machine } from '../cpu/c64-machine.js';
import { createRegisterFrame } from '../registers/register-frame.js';
import type { SidFile } from '../sid/sid-file.model.js';
import { ALLOCATION_NOISE_BYTES, measureAllocation } from '../testing/measure-allocation.js';
import { frames } from '../units.js';
import { createAnchorRing } from './anchor-ring.js';

const RTS = 0x60;

/** play counts in a zero-page byte and stores it to $D400, so the register shadow says which play
 *  call an anchor was taken after. */
function counterTune(): SidFile {
  const data = new Uint8Array(0x18);
  data[0x00] = RTS;
  data.set([0xe6, 0xfb, 0xa5, 0xfb, 0x8d, 0x00, 0xd4, RTS], 0x10);
  return {
    format: 'PSID',
    version: 2,
    loadAddress: 0x1000,
    initAddress: 0x1000,
    playAddress: 0x1010,
    songs: 1,
    startSong: 1,
    speedFlags: 0,
    name: '',
    author: '',
    released: '',
    clock: 'pal',
    model: 'unknown',
    secondSidAddress: null,
    thirdSidAddress: null,
    data,
  };
}

function running() {
  const registers = createRegisterFrame();
  const machine = createC64Machine(counterTune(), registers);
  machine.initSubtune(1);
  return { registers, machine };
}

describe('the anchor ring on the frame path', () => {
  it('allocates nothing over ten thousand recordings', async () => {
    const { registers, machine } = running();
    const ring = createAnchorRing(() => frames(50));
    ring.record(machine, registers, frames(0));
    let position = 0;

    const { heapGrowthBytes, scavenges } = await measureAllocation(() => {
      for (let index = 0; index < 10_000; index++)
        ring.record(machine, registers, frames(++position));
    });

    expect(scavenges).toBe(0);
    expect(heapGrowthBytes).toBeLessThan(ALLOCATION_NOISE_BYTES);
  });

  it('keeps the seed and the three newest, each holding the machine as it stood when recorded', () => {
    const { registers, machine } = running();
    const ring = createAnchorRing(() => frames(50));
    ring.record(machine, registers, frames(0));
    for (let position = 1; position <= 10; position++) {
      machine.runFrame();
      registers.takeSnapshot();
      ring.record(machine, registers, frames(position));
    }

    const newest = ring.select(frames(1000));
    const older = ring.select(frames(58));
    const seed = ring.select(frames(20));

    expect([newest?.frame, older?.frame, seed?.frame]).toEqual([10, 8, 0]);
    expect([newest, older, seed].map((anchor) => anchor?.registers.values[0])).toEqual([10, 8, 0]);
  });
});
