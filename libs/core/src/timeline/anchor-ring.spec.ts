import { beforeEach, describe, expect, it } from 'vitest';
import { createC64Machine } from '../cpu/c64-machine.js';
import type { C64Machine } from '../cpu/c64-machine.js';
import { createRegisterFrame } from '../registers/register-frame.js';
import type { RegisterFrame } from '../registers/register-frame.js';
import type { SidFile } from '../sid/sid-file.model.js';
import { frames, type Frames } from '../units.js';
import { createAnchorRing, type AnchorRing } from './anchor-ring.js';

const RTS = 0x60;

/** init and play both return at once: these cases snapshot the machine, they never run it. */
function idleTune(): SidFile {
  const data = new Uint8Array(0x11);
  data[0x00] = RTS; // init
  data[0x10] = RTS; // play
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

describe('createAnchorRing', () => {
  let registers: RegisterFrame;
  let machine: C64Machine;
  let range: Frames;
  let ring: AnchorRing;

  beforeEach(() => {
    registers = createRegisterFrame();
    machine = createC64Machine(idleTune(), registers);
    machine.initSubtune(1);
    range = frames(50); // an anchor every 25 frames
    ring = createAnchorRing(() => range);
  });

  /** Records an anchor at each position, as a load's seed and the tick loop's spacing check would. */
  function recordAt(...positions: readonly number[]): void {
    for (const position of positions) {
      ring.record(machine, registers, frames(position));
    }
  }

  /** Offers the ring an anchor on every frame from 0 to `last`, the way a tick loop does. */
  function offerThrough(last: number): void {
    for (let position = 0; position <= last; position++) {
      ring.maybeRecord(machine, registers, frames(position));
    }
  }

  it('has nothing to seek from until it is seeded', () => {
    expect(ring.select(frames(100))).toBeNull();
  });

  it('selects the newest anchor a full backward nudge from the target still lands after', () => {
    recordAt(0, 25, 50, 75);

    expect(ring.select(frames(120))?.frame).toBe(50);
  });

  it('takes an anchor sitting exactly on the boundary of the backward nudge range, and no later one', () => {
    recordAt(0, 25, 50);

    expect(ring.select(frames(75))?.frame).toBe(25);
    expect(ring.select(frames(74))?.frame).toBe(0);
  });

  it('falls back to the seed when every recording sits inside the nudge range', () => {
    recordAt(0, 25, 50);

    expect(ring.select(frames(30))?.frame).toBe(0);
  });

  it('returns nothing rather than an anchor after the target, which a seek could only reach backwards', () => {
    recordAt(40); // reseeded away from frame 0, as a subtune re-init mid-tune leaves it

    expect(ring.select(frames(30))).toBeNull();
    expect(ring.select(frames(40))?.frame).toBe(40);
  });

  it('evicts the oldest recording rather than the seed once full', () => {
    recordAt(0, 25, 50, 75, 100); // one past what the ring holds

    expect(ring.select(frames(75))?.frame).toBe(0); // the recording at 25 is gone, the seed is not
    expect(ring.select(frames(160))?.frame).toBe(100);
  });

  it('records once every interval frames, the interval derived from the nudge range', () => {
    offerThrough(30);

    expect(ring.select(frames(1000))?.frame).toBe(25); // 26..30 were offered and declined
    expect(ring.select(frames(70))?.frame).toBe(0); // nothing recorded between the seed and 25
  });

  it('widens the spacing for a wider nudge range, reading it as it records', () => {
    range = frames(100);

    offerThrough(60);

    expect(ring.select(frames(1000))?.frame).toBe(50);
  });

  it('records every frame for a nudge range narrower than a single frame', () => {
    range = frames(0);

    offerThrough(3);

    expect(ring.select(frames(3))?.frame).toBe(3);
  });

  it('drops the seed along with the rest on reset, and takes a new one', () => {
    recordAt(0, 25);

    ring.reset();
    expect(ring.select(frames(100))).toBeNull();

    recordAt(0);
    expect(ring.select(frames(100))?.frame).toBe(0);
  });
});
