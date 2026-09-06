import { describe, expect, it } from 'vitest';
import { C64Machine, UnplayableTuneError } from '../cpu/c64-machine.js';
import { RegisterFrame } from '../registers/register-frame.js';
import type { SidFile } from '../sid/sid-file.model.js';
import { frames } from '../units.js';
import { FrameBudgetExceededError, runFramesTo } from './run-frames.js';

interface CodeBlock {
  readonly at: number;
  readonly bytes: readonly number[];
}

function tune(blocks: readonly CodeBlock[]): SidFile {
  const loadAddress = 0x1000;
  const codeEnd = blocks.reduce(
    (end, block) => Math.max(end, block.at + block.bytes.length),
    loadAddress,
  );
  const data = new Uint8Array(codeEnd - loadAddress);
  for (const block of blocks) {
    data.set(block.bytes, block.at - loadAddress);
  }

  return {
    format: 'PSID',
    version: 2,
    loadAddress,
    initAddress: loadAddress,
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

const RTS = 0x60;

/** init returns immediately; play increments a zero-page counter — cheap and always completes. */
function counterTune(): SidFile {
  return tune([
    { at: 0x1000, bytes: [RTS] },
    { at: 0x1010, bytes: [0xe6, 0xfb, RTS] }, // INC $FB / RTS
  ]);
}

/** The play routine never returns, so every frame burns its whole cycle budget. */
function runawayTune(): SidFile {
  return tune([
    { at: 0x1000, bytes: [RTS] },
    { at: 0x1010, bytes: [0x4c, 0x10, 0x10] }, // JMP $1010
  ]);
}

function initializedMachine(file: SidFile): C64Machine {
  const machine = new C64Machine(file, new RegisterFrame());
  machine.initSubtune(1);
  return machine;
}

describe('runFramesTo', () => {
  it('calls onFrame once per frame that completes inside its budget', () => {
    const machine = initializedMachine(counterTune());
    let calls = 0;

    runFramesTo(machine, frames(0), frames(5), () => {
      calls++;
    });

    expect(calls).toBe(5);
  });

  it('runs the span between two arbitrary frame numbers, not just from 0', () => {
    const machine = initializedMachine(counterTune());
    let calls = 0;

    runFramesTo(machine, frames(3), frames(8), () => {
      calls++;
    });

    expect(calls).toBe(5);
  });

  it('does nothing when the target is not after the starting frame', () => {
    const machine = initializedMachine(counterTune());
    let calls = 0;

    runFramesTo(machine, frames(5), frames(5), () => {
      calls++;
    });

    expect(calls).toBe(0);
  });

  it('throws FrameBudgetExceededError for the frame that ran out of budget, without calling onFrame for it', () => {
    const machine = initializedMachine(runawayTune());
    let calls = 0;

    expect(() =>
      runFramesTo(machine, frames(0), frames(3), () => {
        calls++;
      }),
    ).toThrow(FrameBudgetExceededError);
    expect(calls).toBe(0);
  });

  it('lets a thrown emulation error propagate untouched', () => {
    const machine = new C64Machine(counterTune(), new RegisterFrame()); // never initialised

    expect(() => runFramesTo(machine, frames(0), frames(1), () => undefined)).toThrow(
      UnplayableTuneError,
    );
  });
});
