import { describe, it } from 'vitest';
import type { FarEndConsumption, SidSink, SinkCapabilities } from '../ports/sink.js';
import type { SidFrame } from '../registers/sid-frame.js';
import type { Frames, Milliseconds } from '../units.js';
import { SINK_CONFORMANCE_CASES, type ConformanceHarness } from './index.js';

const REFERENCE_CAPABILITIES: SinkCapabilities = {
  perWriteOffsets: false,
  cancellation: false,
  scheduleAheadMs: null,
  // `SchedulingFakeSink.deliver` unrolls a frame straight onto its wire in arrival order, so it
  // genuinely earns this claim — unlike ASID's slot-packed wire, which cannot.
  preservesWriteOrder: true,
};

interface Write {
  readonly register: number;
  readonly value: number;
}

function unroll(sidFrame: SidFrame): Write[] {
  const writes: Write[] = [];
  for (let i = 0; i < sidFrame.count; i++) {
    writes.push({ register: sidFrame.registers[i], value: sidFrame.values[i] });
  }
  return writes;
}

/**
 * A reference `SidSink` built solely to prove the conformance suite out. The exported `FakeSink`
 * (`../testing/fake-sink.ts`) is a bare call recorder with no notion of time — right for the
 * engine specs it serves, but silent on due-time gating, so it cannot exercise the cases here
 * that pin ordering across a schedule. This one queues by due time and releases only as the
 * harness advances its clock, which is the minimum a real sink needs to be conformance-tested
 * against.
 */
class SchedulingFakeSink implements SidSink {
  private readonly pending: { writes: readonly Write[]; dueAtMs: number }[] = [];
  private readonly wire: Write[] = [];
  private now = 0;

  private began = 0;
  private ended = 0;

  constructor(private readonly caps: SinkCapabilities) {}

  get capabilities(): SinkCapabilities {
    return this.caps;
  }

  begin(): void {
    this.began++;
  }

  end(): void {
    this.ended++;
  }

  get beginCallCount(): number {
    return this.began;
  }

  get endCallCount(): number {
    return this.ended;
  }

  deliver(sidFrame: SidFrame, frameNumber: Frames, dueAtMs: Milliseconds): void {
    this.pending.push({ writes: unroll(sidFrame), dueAtMs });
    this.release();
  }

  deliverNow(sidFrame: SidFrame): void {
    this.wire.push(...unroll(sidFrame));
  }

  retime(): void {
    // A sink with no cancellation support must not drop what's outstanding; one that supports
    // it is free to withdraw everything queued, which is what this reference chooses to do.
    if (this.caps.cancellation) this.pending.length = 0;
  }

  reset(): void {
    this.pending.length = 0;
  }

  readAt(): FarEndConsumption {
    return { kind: 'unknown', inFlight: this.pending.length };
  }

  /** Advances this sink's own notion of time, releasing whatever fell due. */
  advanceMs(ms: number): void {
    this.now += ms;
    this.release();
  }

  get emittedWrites(): readonly Write[] {
    return this.wire;
  }

  private release(): void {
    while (this.pending.length > 0 && this.pending[0].dueAtMs <= this.now) {
      const next = this.pending.shift();
      if (next) this.wire.push(...next.writes);
    }
  }
}

function makeReferenceHarness(): ConformanceHarness {
  const sink = new SchedulingFakeSink(REFERENCE_CAPABILITIES);
  return {
    sink,
    emitted: () => sink.emittedWrites,
    advanceMs: (ms) => sink.advanceMs(ms),
  };
}

describe('SINK_CONFORMANCE_CASES', () => {
  for (const conformanceCase of SINK_CONFORMANCE_CASES) {
    it(conformanceCase.name, () => conformanceCase.run(makeReferenceHarness));
  }
});
