import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SidFrame } from '@sidablist/core';
import { frames, microseconds, milliseconds } from '@sidablist/core';
import {
  buildDisplayCharsPacket,
  buildSidDataPacket,
  buildSidTypePacket,
  buildStartPacket,
  buildStopPacket,
} from '../wire/encoder.js';
import {
  createAsidSink,
  UNCANCELLABLE_SCHEDULE_AHEAD_CEILING_MS,
  type AsidSink,
} from './asid-sink.js';
import type { MidiOutputPort } from './midi-output-port.js';

interface SentPacket {
  readonly bytes: Uint8Array;
  readonly timestampMs: number | undefined;
}

/** The `MidiOutputPort` double every test drives — `supportsCancel` and `cancelPendingReturns` are
 *  two separate switches because a real port can report "yes, cancellable" while a given cancel
 *  request still turns up nothing to withdraw. */
class FakeMidiOutputPort implements MidiOutputPort {
  portId: string | null = 'port-1';
  supportsCancel = false;
  cancelPendingReturns = false;
  cancelPendingCallCount = 0;
  readonly sent: SentPacket[] = [];

  send(bytes: Uint8Array, timestampMs?: number): void {
    this.sent.push({ bytes: Uint8Array.from(bytes), timestampMs });
  }

  cancelPending(): boolean {
    this.cancelPendingCallCount++;
    return this.cancelPendingReturns;
  }
}

const ONE_INTERVAL_US = 20_000; // 20 ms, a round PAL-ish frame for arithmetic that reads cleanly

function frame(registers: readonly number[], values: readonly number[]): SidFrame {
  return {
    count: registers.length,
    registers: Uint8Array.from(registers),
    values: Uint8Array.from(values),
    offsetsUs: new Int32Array(registers.length),
  };
}

describe('createAsidSink', () => {
  let port: FakeMidiOutputPort;
  let sink: AsidSink;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    port = new FakeMidiOutputPort();
    sink = createAsidSink(port);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('core control path', () => {
    it('sends the chip-model packet then the start packet on begin, both immediately', () => {
      sink.begin({ chipModel: 'mos8580' });

      expect(port.sent).toEqual([
        { bytes: buildSidTypePacket(0, true), timestampMs: undefined },
        { bytes: buildStartPacket(), timestampMs: undefined },
      ]);
    });

    it('sends the stop packet on end, and drops whatever was still outstanding', () => {
      port.supportsCancel = true;
      sink.setScheduleAhead(milliseconds(200));
      sink.deliver(frame([0], [0x11]), frames(0), milliseconds(performance.now() + 1000), false);
      expect(sink.readAt().inFlight).toBe(1);

      sink.end();

      expect(port.sent.at(-1)).toEqual({ bytes: buildStopPacket(), timestampMs: undefined });
      expect(sink.readAt().inFlight).toBe(0);
    });

    it('sends a delivered-now frame immediately, with no timestamp, without touching in-flight depth', () => {
      port.supportsCancel = true;
      sink.setScheduleAhead(milliseconds(200));
      sink.deliver(frame([0], [0x11]), frames(0), milliseconds(performance.now() + 1000), false);
      const inFlightBefore = sink.readAt().inFlight;

      sink.deliverNow(frame([4], [0x20]));

      expect(port.sent.at(-1)).toEqual({
        bytes: buildSidDataPacket(frame([4], [0x20])),
        timestampMs: undefined,
      });
      expect(sink.readAt().inFlight).toBe(inFlightBefore);
    });
  });

  describe('showText', () => {
    it('sends a display-chars packet straight through the port, uncounted by the delivery stats', () => {
      const statsBefore = sink.stats;

      sink.showText('TEST');

      expect(port.sent.at(-1)).toEqual({
        bytes: buildDisplayCharsPacket('TEST'),
        timestampMs: undefined,
      });
      expect(sink.stats.packetsSent).toBe(statsBefore.packetsSent);
      expect(sink.stats.bytesSent).toBe(statsBefore.bytesSent);
    });
  });

  describe('capabilities', () => {
    it('reports no per-write offsets and the live cancellation and schedule-ahead state', () => {
      port.supportsCancel = true;
      sink.setScheduleAhead(milliseconds(150));

      expect(sink.capabilities).toEqual({
        perWriteOffsets: false,
        cancellation: true,
        scheduleAheadMs: 150,
      });
    });
  });

  describe('setScheduleAhead ceiling', () => {
    it('clamps to the uncancellable ceiling when the port cannot cancel pending sends', () => {
      port.supportsCancel = false;

      sink.setScheduleAhead(milliseconds(500));

      expect(sink.capabilities.scheduleAheadMs).toBe(UNCANCELLABLE_SCHEDULE_AHEAD_CEILING_MS);
    });

    it('does not clamp when the port can cancel pending sends', () => {
      port.supportsCancel = true;

      sink.setScheduleAhead(milliseconds(500));

      expect(sink.capabilities.scheduleAheadMs).toBe(500);
    });

    it('re-clamps the window actually sent on a mid-session loss of cancel support, without a fresh setScheduleAhead() call', () => {
      port.supportsCancel = true;
      sink.setScheduleAhead(milliseconds(200));

      sink.deliver(frame([0], [0x11]), frames(0), milliseconds(1_000_000), false);
      expect(port.sent[0].timestampMs).toBeCloseTo(1_000_000 + 200, 6);

      port.supportsCancel = false; // a port swap or reconnect, with no fresh setScheduleAhead() call
      expect(sink.capabilities.scheduleAheadMs).toBe(UNCANCELLABLE_SCHEDULE_AHEAD_CEILING_MS);

      sink.deliver(frame([1], [0x22]), frames(1), milliseconds(1_001_000), false);
      expect(port.sent[1].timestampMs).toBeCloseTo(
        1_001_000 + UNCANCELLABLE_SCHEDULE_AHEAD_CEILING_MS,
        6,
      );
    });

    it('ignores a negative or non-finite value', () => {
      sink.setScheduleAhead(milliseconds(10));

      sink.setScheduleAhead(milliseconds(-5));
      sink.setScheduleAhead(milliseconds(NaN));

      expect(sink.capabilities.scheduleAheadMs).toBe(10);
    });
  });

  describe('retime on tempo change', () => {
    it('cancels and re-times every still-committed send once, at the new interval, with a port that can cancel', () => {
      port.supportsCancel = true;
      port.cancelPendingReturns = true;
      sink.setScheduleAhead(milliseconds(200));
      sink.deliver(frame([0], [0x11]), frames(0), milliseconds(1_000_000), false);
      sink.deliver(frame([1], [0x22]), frames(1), milliseconds(1_000_020), false);
      const committed = port.sent.map((p) => p.bytes);

      sink.retime(microseconds(ONE_INTERVAL_US / 1.2));

      expect(port.cancelPendingCallCount).toBe(1);
      const resent = port.sent.slice(-2);
      expect(resent.map((p) => p.bytes)).toEqual(committed);
      const newIntervalMs = ONE_INTERVAL_US / 1.2 / 1000;
      expect((resent[1].timestampMs ?? 0) - (resent[0].timestampMs ?? 0)).toBeCloseTo(
        newIntervalMs,
        6,
      );
    });

    it('never calls cancelPending with a port that cannot cancel', () => {
      port.supportsCancel = false;
      sink.deliver(frame([0], [0x11]), frames(0), milliseconds(1_000_000), false);
      const before = port.sent.length;

      sink.retime(microseconds(ONE_INTERVAL_US));

      expect(port.cancelPendingCallCount).toBe(0);
      expect(port.sent.length).toBe(before);
    });

    it('does not resend when cancelPending() reports it did not actually cancel anything', () => {
      port.supportsCancel = true;
      port.cancelPendingReturns = false;
      sink.deliver(frame([0], [0x11]), frames(0), milliseconds(1_000_000), false);
      const before = port.sent.length;

      sink.retime(microseconds(ONE_INTERVAL_US));

      expect(port.cancelPendingCallCount).toBe(1);
      expect(port.sent.length).toBe(before);
    });

    it('re-times only the sends still in the future, never one whose delivery time has already passed', () => {
      port.supportsCancel = true;
      port.cancelPendingReturns = true;
      sink.setScheduleAhead(milliseconds(200));
      sink.deliver(frame([0], [0x11]), frames(0), milliseconds(performance.now() - 1000), false); // already past due
      sink.deliver(frame([1], [0x22]), frames(1), milliseconds(1_000_000), false);
      const before = port.sent.length;

      sink.retime(microseconds(ONE_INTERVAL_US));

      expect(port.sent.length).toBe(before + 1);
    });

    it('records how far the furthest-out committed send reached past the cancel request', () => {
      port.supportsCancel = true;
      port.cancelPendingReturns = true;
      const nowMs = performance.now();
      sink.setScheduleAhead(milliseconds(200));
      sink.deliver(frame([0], [0x11]), frames(0), milliseconds(nowMs), false);
      sink.deliver(frame([1], [0x22]), frames(1), milliseconds(nowMs), false);

      sink.retime(microseconds(ONE_INTERVAL_US));

      expect(sink.stats.lastCancelLatencyMs).toBeGreaterThan(100);
      expect(sink.stats.lastCancelLatencyMs).toBeLessThan(300);
    });

    it('falls back to -1 on a mid-session swap to a port that cannot cancel', () => {
      port.supportsCancel = true;
      port.cancelPendingReturns = true;
      sink.setScheduleAhead(milliseconds(200));
      sink.deliver(frame([0], [0x11]), frames(0), milliseconds(performance.now()), false);
      sink.retime(microseconds(ONE_INTERVAL_US));
      expect(sink.stats.lastCancelLatencyMs).toBeGreaterThan(-1);

      port.supportsCancel = false;

      expect(sink.stats.lastCancelLatencyMs).toBe(-1);
    });
  });

  describe('reset', () => {
    it('drops everything outstanding, without sending a stop packet or leaving anything for a later retime to catch', () => {
      port.supportsCancel = true;
      port.cancelPendingReturns = true;
      sink.deliver(frame([0], [0x11]), frames(0), milliseconds(1_000_000), false);
      const sentBefore = port.sent.length;

      sink.reset();

      expect(sink.readAt().inFlight).toBe(0);
      sink.retime(microseconds(ONE_INTERVAL_US)); // nothing left to retime
      expect(port.cancelPendingCallCount).toBe(0);
      expect(port.sent.length).toBe(sentBefore);
    });
  });

  describe('readAt', () => {
    it('reports unknown consumption with the live outstanding-send depth, pruning what has become due', () => {
      vi.spyOn(performance, 'now').mockReturnValue(1_000_000);
      sink.deliver(frame([0], [0x11]), frames(0), milliseconds(1_000_100), false);
      sink.deliver(frame([1], [0x22]), frames(1), milliseconds(1_000_200), false);

      expect(sink.readAt()).toEqual({ kind: 'unknown', inFlight: 2 });

      vi.spyOn(performance, 'now').mockReturnValue(1_000_250); // both now due

      expect(sink.readAt()).toEqual({ kind: 'unknown', inFlight: 0 });
    });
  });

  describe('deliver packs immediately', () => {
    it('packs a delivered frame to bytes right away, so mutating the shared buffers afterward cannot change what was already sent', () => {
      const buffer = frame([0], [0x11]);
      const expectedBytesForA = buildSidDataPacket({
        count: buffer.count,
        registers: buffer.registers.slice(),
        values: buffer.values.slice(),
        offsetsUs: buffer.offsetsUs.slice(),
      });

      sink.deliver(buffer, frames(0), milliseconds(1_000_000), false);

      // core reuses the same buffer for the next frame's writes
      buffer.registers.set([1]);
      buffer.values.set([0x22]);

      sink.deliver(buffer, frames(1), milliseconds(1_000_020), false);

      expect(port.sent[0].bytes).toEqual(expectedBytesForA);
      expect(port.sent[0].bytes).not.toEqual(port.sent[1].bytes);
    });
  });

  describe('stats', () => {
    it('counts packets and bytes across the control and frame paths, but not showText', () => {
      sink.begin({ chipModel: 'mos6581' }); // chip-type + start: 2
      sink.deliver(frame([0], [0x11]), frames(0), milliseconds(1_000_000), false); // 1
      sink.deliverNow(frame([4], [0x20])); // 1
      sink.showText('HI'); // uncounted

      expect(port.sent.length).toBe(5);
      const stats = sink.stats;
      expect(stats.packetsSent).toBe(4);
      expect(stats.bytesSent).toBe(
        port.sent.slice(0, 4).reduce((sum, p) => sum + p.bytes.length, 0),
      );
    });
  });
});
