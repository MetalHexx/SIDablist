import { SINK_REPLACE_CASES, type ConformanceHarness } from '@sidablist/core/conformance';
import { describe, expect, it } from 'vitest';
import { HoldingSink } from './holding-sink.js';

function makeHarness(): ConformanceHarness {
  const sink = new HoldingSink();
  return { sink, emitted: () => sink.emitted(), advanceMs: (ms) => sink.advanceMs(ms) };
}

describe('HoldingSink', () => {
  for (const conformanceCase of SINK_REPLACE_CASES) {
    it(conformanceCase.name, () => conformanceCase.run(makeHarness));
  }

  it('holds a frame until its due time and passes frames in order', () => {
    const sink = new HoldingSink();
    const frame = {
      count: 1,
      registers: Uint8Array.of(4),
      values: Uint8Array.of(0x41),
      offsetsUs: new Int32Array(1),
    };
    sink.deliver(frame, 0 as never, 10 as never, false);
    sink.deliver(frame, 1 as never, 30 as never, false);

    expect(sink.passedCount()).toBe(0);
    expect(sink.holding).toBe(2);
    sink.advanceTo(10);
    expect(sink.passedCount()).toBe(1);
    sink.advanceTo(100);
    expect(sink.passedCount()).toBe(2);
    expect(sink.wire.map((item) => (item.kind === 'frame' ? item.frameNumber : -1))).toEqual([
      0, 1,
    ]);
  });
});
