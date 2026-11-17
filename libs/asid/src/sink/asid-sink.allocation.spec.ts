import { describe, expect, it } from 'vitest';
import type { EngineLog, SidFrame, TimeSource } from '@sidablist/core';
import { frames, microseconds, milliseconds } from '@sidablist/core';
import { buildSidDataPacket } from '../wire/encoder.js';
import { createAsidSink, type AsidSink } from './asid-sink.js';
import { ALLOCATION_NOISE_BYTES, measureAllocation } from './measure-allocation.js';
import type { MidiOutputPort } from './midi-output-port.js';

const FRAME_INTERVAL_MS = 20;
const STRETCH_LENGTH = 10_000;
const STRETCHES = 3;

/** Takes the bytes and keeps nothing, so what a run allocates is the sink's own. */
class CountingPort implements MidiOutputPort {
  portId: string | null = 'counting';
  supportsCancel = false;
  sends = 0;

  send(): void {
    this.sends++;
  }

  cancelPending(): boolean {
    return false;
  }
}

/** Writes to a spread of registers, the gate twice and a value with its high bit set, so packets
 *  vary in length and take the secondary-slot and MSB paths. */
function makeFrame(): SidFrame {
  return {
    count: 6,
    registers: Uint8Array.from([0, 1, 4, 4, 18, 24]),
    values: Uint8Array.from([0, 0x91, 0x21, 0x20, 0x11, 0x0f]),
    offsetsUs: new Int32Array(6),
  };
}

describe('the ASID sink on the frame path', () => {
  it('allocates nothing over thirty thousand deliveries at the uncancellable ceiling, across retimes and reads between stretches', async () => {
    let nowMs = 0;
    const time: TimeSource = { now: () => milliseconds(nowMs) };
    const port = new CountingPort();
    const sink: AsidSink = createAsidSink(port, { time, scheduleAheadMs: milliseconds(40) });
    const frame = makeFrame();
    let tick = 0;
    let observedAheadMs: number | null = null;

    const stretch = (): void => {
      for (let i = 0; i < STRETCH_LENGTH; i++) {
        const dueAtMs = tick * FRAME_INTERVAL_MS;
        nowMs = dueAtMs;
        frame.values[0] = tick & 0x7f;
        sink.deliver(frame, frames(tick), milliseconds(dueAtMs), false);
        observedAheadMs = sink.capabilities.scheduleAheadMs;
        tick++;
      }
    };

    for (let stretchIndex = 0; stretchIndex < STRETCHES; stretchIndex++) {
      const { heapGrowthBytes, scavenges } = await measureAllocation(stretch);
      expect(scavenges).toBe(0);
      expect(heapGrowthBytes).toBeLessThan(ALLOCATION_NOISE_BYTES);
      // Off the frame path: a tempo command and a stats read.
      sink.retime(microseconds(FRAME_INTERVAL_MS * 1000));
      expect(sink.readAt().inFlight).toBeGreaterThan(0);
    }
    expect(port.sends).toBe(STRETCHES * 3 * STRETCH_LENGTH);
    expect(observedAheadMs).toBe(40);
  });

  it('allocates nothing when more sends are outstanding than the ring holds, and stops tracking the oldest', async () => {
    const nowMs = 1_000;
    const time: TimeSource = { now: () => milliseconds(nowMs) };
    const port = new CountingPort();
    const sink = createAsidSink(port, { time, scheduleAheadMs: milliseconds(40) });
    const frame = makeFrame();
    let tick = 0;

    // Every one of these is due in the future and none ever falls due, so the ring is always full.
    const burst = (): void => {
      for (let i = 0; i < STRETCH_LENGTH; i++) {
        frame.values[0] = tick & 0x7f;
        sink.deliver(frame, frames(tick), milliseconds(nowMs + (tick & 3)), false);
        tick++;
      }
    };

    const { heapGrowthBytes, scavenges } = await measureAllocation(burst);

    expect(scavenges).toBe(0);
    expect(heapGrowthBytes).toBeLessThan(ALLOCATION_NOISE_BYTES);
    const tracked = sink.readAt().inFlight;
    expect(tracked).toBeGreaterThan(0);
    expect(tracked).toBeLessThan(tick);
  });
});

describe('a ring that overflows', () => {
  it('re-sends only the newest sends on a retime, the oldest having been dropped from tracking', () => {
    let nowMs = 1_000;
    const time: TimeSource = { now: () => milliseconds(nowMs) };
    const resent: Uint8Array[] = [];
    let retiming = false;
    const port: MidiOutputPort = {
      portId: 'cancelling',
      supportsCancel: true,
      send(bytes) {
        if (retiming) resent.push(Uint8Array.from(bytes));
      },
      cancelPending: () => true,
    };
    const sink = createAsidSink(port, { time, scheduleAheadMs: milliseconds(40) });

    const sent: Uint8Array[] = [];
    const total = 2_000;
    for (let tick = 0; tick < total; tick++) {
      const frame: SidFrame = {
        count: 2,
        registers: Uint8Array.from([0, 1]),
        values: Uint8Array.from([tick & 0x7f, (tick >> 7) & 0x7f]),
        offsetsUs: new Int32Array(2),
      };
      sent.push(buildSidDataPacket(frame));
      sink.deliver(frame, frames(tick), milliseconds(nowMs), false);
    }
    const tracked = sink.readAt().inFlight;
    expect(tracked).toBeLessThan(total);

    retiming = true;
    nowMs += 1;
    sink.retime(microseconds(FRAME_INTERVAL_MS * 1000));

    expect(resent).toEqual(sent.slice(total - tracked));
  });

  it('tells the log once that it dropped the oldest, and again after a reset', () => {
    const nowMs = 1_000;
    const time: TimeSource = { now: () => milliseconds(nowMs) };
    const warnings: string[] = [];
    const log: EngineLog = { warn: (message) => warnings.push(message), error: () => undefined };
    const sink = createAsidSink(new CountingPort(), {
      time,
      scheduleAheadMs: milliseconds(40),
      log,
    });
    const frame = makeFrame();
    const fill = (): void => {
      for (let tick = 0; tick < 2_000; tick++) {
        sink.deliver(frame, frames(tick), milliseconds(nowMs + 5), false);
      }
    };

    fill();
    expect(warnings).toEqual([
      expect.stringMatching(/^ASID sink: more sends are outstanding than/),
    ]);

    sink.reset();
    fill();
    expect(warnings).toHaveLength(2);
  });
});
