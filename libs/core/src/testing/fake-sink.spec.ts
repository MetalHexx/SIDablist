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

  it('holds nothing: every delivery has passed, replaceFrom answers the count and is recorded, and begin and reset restart it', () => {
    const sink = new FakeSink();
    const frame: SidFrame = {
      count: 0,
      registers: new Uint8Array(0),
      values: new Uint8Array(0),
      offsetsUs: new Int32Array(0),
    };
    sink.deliver(frame, frames(0), milliseconds(0), false);
    sink.deliver(frame, frames(1), milliseconds(20), false);
    sink.deliverNow(frame);

    expect(sink.passedCount()).toBe(2);
    expect(sink.replaceFrom(0)).toBe(2);
    expect(sink.replaceFromCalls).toEqual([0]);

    sink.reset();
    expect(sink.passedCount()).toBe(0);
    sink.deliver(frame, frames(0), milliseconds(0), false);
    sink.begin({ chipModel: 'mos6581' });
    expect(sink.passedCount()).toBe(0);
  });
});
