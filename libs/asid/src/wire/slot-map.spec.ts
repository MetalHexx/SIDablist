import { describe, it, expect } from 'vitest';
import type { SidFrame } from '@sidablist/core';
import { packFrame } from './slot-map.js';

/** Builds a `SidFrame` from an ordered write list — packFrame's whole contract is what it does
 *  with that ordering, so tests construct frames directly rather than through a producer. */
function frameOf(writes: readonly [register: number, value: number][]): SidFrame {
  return {
    count: writes.length,
    registers: Uint8Array.from(writes.map(([register]) => register)),
    values: Uint8Array.from(writes.map(([, value]) => value)),
    offsetsUs: new Int32Array(writes.length),
  };
}

describe('packFrame', () => {
  it('re-sorts an out-of-register-order frame into ascending slot order', () => {
    const frame = frameOf([
      [24, 0x33],
      [0, 0x11],
      [1, 0x22],
    ]);

    const { presentMask, msbMask, values } = packFrame(frame);

    // slots 0, 1 (byte 0, bits 0-1) and 21 (byte 3, bit 0).
    expect(presentMask).toEqual([0b11, 0, 0, 0b1]);
    expect(msbMask).toEqual([0, 0, 0, 0]);
    expect(values).toEqual([0x11, 0x22, 0x33]);
  });

  it('sets the MSB mask bit and carries only the low 7 bits for a value at or above 0x80', () => {
    const frame = frameOf([[0, 0xff]]);

    const { presentMask, msbMask, values } = packFrame(frame);

    expect(presentMask).toEqual([0b1, 0, 0, 0]);
    expect(msbMask).toEqual([0b1, 0, 0, 0]);
    expect(values).toEqual([0x7f]);
  });

  it('places a gate registers second write in its secondary slot alongside the first', () => {
    const frame = frameOf([
      [4, 0x01],
      [4, 0x02],
    ]);

    const { presentMask, values } = packFrame(frame);

    // slot 22 (byte 3, bit 1) and slot 25 (byte 3, bit 4).
    expect(presentMask).toEqual([0, 0, 0, (1 << 1) | (1 << 4)]);
    expect(values).toEqual([0x01, 0x02]);
  });

  it('overwrites a non-gate registers primary slot on a second write, reaching one slot only', () => {
    const frame = frameOf([
      [5, 0x01],
      [5, 0x02],
    ]);

    const { presentMask, values } = packFrame(frame);

    // slot 4 (register 5's primary slot) — byte 0, bit 4.
    expect(presentMask).toEqual([1 << 4, 0, 0, 0]);
    expect(values).toEqual([0x02]);
  });

  it('produces an empty packet shape for a frame with no writes', () => {
    const { presentMask, msbMask, values } = packFrame(frameOf([]));

    expect(presentMask).toEqual([0, 0, 0, 0]);
    expect(msbMask).toEqual([0, 0, 0, 0]);
    expect(values).toEqual([]);
  });
});
