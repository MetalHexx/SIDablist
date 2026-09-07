import { beforeEach, describe, expect, it } from 'vitest';
import { createC64Machine, type C64Machine, type MachineSnapshot } from '../cpu/c64-machine.js';
import {
  createRegisterFrame,
  type RegisterFrame,
  type RegisterValuesSnapshot,
} from '../registers/register-frame.js';
import { runFramesTo } from '../replay/run-frames.js';
import type { SidFile } from '../sid/sid-file.model.js';
import { frames, type Frames } from '../units.js';
import { createAnchorRing, type AnchorRing } from './anchor-ring.js';
import { seekToFrame } from './seek.js';

const RTS = 0x60;

/** play counts up in zero page and writes the count to $D400, so no two frames of this tune leave
 *  the machine or the registers in the same state — which is what makes a landing checkable. */
function counterTune(): SidFile {
  const data = new Uint8Array(0x18);
  data[0x00] = RTS; // init
  data.set([0xe6, 0xfb, 0xa5, 0xfb, 0x8d, 0x00, 0xd4, RTS], 0x10); // INC $FB; LDA $FB; STA $D400
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

interface State {
  readonly machine: MachineSnapshot;
  readonly registers: RegisterValuesSnapshot;
}

/** Where an unbroken run from `init` stands at `target` — the control a seek is measured against. */
function runUnbrokenTo(target: Frames): State {
  const registers = createRegisterFrame();
  const machine = createC64Machine(counterTune(), registers);
  machine.initSubtune(1);
  runFramesTo(machine, frames(0), target, () => {
    registers.takeSnapshot();
  });
  return { machine: machine.snapshot(), registers: registers.snapshotValues() };
}

describe('seekToFrame', () => {
  let registers: RegisterFrame;
  let machine: C64Machine;
  let ring: AnchorRing;
  let position: number;

  beforeEach(() => {
    registers = createRegisterFrame();
    machine = createC64Machine(counterTune(), registers);
    machine.initSubtune(1);
    ring = createAnchorRing(() => frames(50)); // an anchor every 25 frames
    ring.record(machine, registers, frames(0)); // the frame-0 seed a load takes
    position = 0;
  });

  /** Drives the live pair the way a tick loop would, offering the ring an anchor each frame. */
  function play(count: number): void {
    for (let i = 0; i < count; i++) {
      machine.runFrame();
      registers.takeSnapshot();
      position++;
      ring.maybeRecord(machine, registers, frames(position));
    }
  }

  function liveState(): State {
    return { machine: machine.snapshot(), registers: registers.snapshotValues() };
  }

  it('lands on the requested frame with the state an unbroken run reaches it in', () => {
    play(100);

    const anchor = seekToFrame(machine, registers, ring, frames(140));

    expect(anchor?.frame).toBe(75); // a recent anchor: 65 frames of replay rather than 140
    expect(liveState()).toEqual(runUnbrokenTo(frames(140)));
  });

  it('falls back to the seed for a target no recent anchor reaches, and still lands correctly', () => {
    play(100);

    const anchor = seekToFrame(machine, registers, ring, frames(30));

    expect(anchor?.frame).toBe(0);
    expect(liveState()).toEqual(runUnbrokenTo(frames(30)));
  });

  it('resolves a target before the start of the tune to frame 0', () => {
    play(40);

    const anchor = seekToFrame(machine, registers, ring, frames(-25));

    expect(anchor?.frame).toBe(0);
    expect(liveState()).toEqual(runUnbrokenTo(frames(0)));
  });

  it('leaves the pair where it stands when the ring holds nothing to seek from', () => {
    play(40);
    const before = liveState();
    ring.reset();

    expect(seekToFrame(machine, registers, ring, frames(10))).toBeNull();
    expect(liveState()).toEqual(before);
  });
});
