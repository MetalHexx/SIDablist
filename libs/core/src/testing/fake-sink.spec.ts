import { describe, expect, it } from 'vitest';
import { FakeSink } from './fake-sink.js';
import type { SidFrame } from '../registers/sid-frame.js';
import { frames, milliseconds } from '../units.js';

describe('FakeSink', () => {
  it('copies each delivered frame, so a later mutation of the reused buffers does not change it', () => {
    const sink = new FakeSink();
    const reused: SidFrame = {
      count: 1,
      registers: Uint8Array.from([4]),
      values: Uint8Array.from([0x11]),
      offsetsUs: Int32Array.from([0]),
    };

    sink.deliver(reused, frames(0), milliseconds(0), false);
    reused.registers[0] = 24;
    reused.values[0] = 0xff;
    (reused as { count: number }).count = 1;
    sink.deliver(reused, frames(1), milliseconds(1000 / 50), false);

    const [first, second] = sink.deliveredFrames;
    expect(Array.from(first.frame.registers)).toEqual([4]);
    expect(Array.from(first.frame.values)).toEqual([0x11]);
    expect(Array.from(second.frame.registers)).toEqual([24]);
    expect(Array.from(second.frame.values)).toEqual([0xff]);
  });
});
