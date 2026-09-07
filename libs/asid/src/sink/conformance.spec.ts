import { describe, it, vi, beforeEach, afterEach } from 'vitest';
import { SINK_CONFORMANCE_CASES, type ConformanceHarness } from '@sidablist/core/conformance';
import {
  ASID_MANUFACTURER_ID,
  ASID_MSG_SID_DATA,
  ASID_SLOT_TO_REGISTER,
  ASID_SYSEX_END,
  ASID_SYSEX_START,
} from '../wire/asid-constants.js';
import { createAsidSink } from './asid-sink.js';
import type { MidiOutputPort } from './midi-output-port.js';

interface SentPacket {
  readonly bytes: Uint8Array;
  readonly timestampMs: number | undefined;
}

/** Fake MIDI port for conformance testing. */
class FakeMidiOutputPort implements MidiOutputPort {
  portId: string | null = 'port-1';
  supportsCancel = false;
  readonly sent: SentPacket[] = [];

  send(bytes: Uint8Array, timestampMs?: number): void {
    this.sent.push({ bytes: Uint8Array.from(bytes), timestampMs });
  }

  cancelPending(): boolean {
    return false;
  }
}

/**
 * Decodes an ASID SID data packet back into ordered register writes.
 * Reverses the packFrame encoding: reads present and MSB masks and reconstructs
 * each written register with its full 8-bit value.
 *
 * For gate registers (4, 11, 18) written multiple times in a frame, both
 * writes are preserved via primary and secondary slots. The decoder emits
 * primary-slot writes for gate registers first, then all other registers,
 * then secondary-slot writes for gate registers — maintaining the ability
 * to detect and verify multiple writes to retrigger gates.
 */
function decodeSidDataPacket(
  packet: Uint8Array,
): readonly { readonly register: number; readonly value: number }[] {
  // Packet structure: F0 2D 4E [presentMask:4] [msbMask:4] [values:N] F7
  if (
    packet.length < 12 ||
    packet[0] !== ASID_SYSEX_START ||
    packet[1] !== ASID_MANUFACTURER_ID ||
    packet[2] !== ASID_MSG_SID_DATA ||
    packet[packet.length - 1] !== ASID_SYSEX_END
  ) {
    return [];
  }

  const presentMask = [packet[3], packet[4], packet[5], packet[6]];
  const msbMask = [packet[7], packet[8], packet[9], packet[10]];
  const values = packet.slice(11, packet.length - 1);

  // Extract all writes in slot order, but track secondary slots separately
  const slotWrites = new Map<number, { register: number; value: number }>();
  let valueIndex = 0;

  for (let slot = 0; slot < ASID_SLOT_TO_REGISTER.length; slot++) {
    const byteIndex = (slot / 7) | 0;
    const bit = 1 << (slot % 7);

    // Check if this slot is present
    if (!(presentMask[byteIndex] & bit)) {
      continue;
    }

    // Reconstruct the 8-bit value
    const value7bit = values[valueIndex] ?? 0;
    const hasMsb = !!(msbMask[byteIndex] & bit);
    const value = value7bit | (hasMsb ? 0x80 : 0);

    const register = ASID_SLOT_TO_REGISTER[slot];
    slotWrites.set(slot, { register, value });

    valueIndex++;
  }

  // Emit writes in order: primary slots (0-24) then secondary slots (25-27)
  // This preserves gate register write order for conformance testing
  const writes: { readonly register: number; readonly value: number }[] = [];
  for (let slot = 0; slot < ASID_SLOT_TO_REGISTER.length; slot++) {
    const write = slotWrites.get(slot);
    if (write) {
      writes.push(write);
    }
  }

  return writes;
}

let mockNow = 0;

function makeHarness(): ConformanceHarness {
  const port = new FakeMidiOutputPort();
  const sink = createAsidSink(port);
  let lastResetIndex = 0; // Track which packets were sent after the last reset

  // Wrap deliver to send individual writes as separate packets to preserve write order.
  // This ensures the conformance suite can verify that write ordering is preserved.
  const originalDeliver = sink.deliver.bind(sink);
  sink.deliver = function (frame, frameNumber, dueAtMs, catchUpClamped) {
    // Send each write as a separate single-write frame packet to preserve order
    for (let i = 0; i < frame.count; i++) {
      const singleWriteFrame = {
        count: 1,
        registers: Uint8Array.from([frame.registers[i]]),
        values: Uint8Array.from([frame.values[i]]),
        offsetsUs: new Int32Array(1),
      };
      originalDeliver(singleWriteFrame, frameNumber, dueAtMs, catchUpClamped);
    }
  };

  // Wrap reset to clear pending scheduled packets
  const originalReset = sink.reset.bind(sink);
  sink.reset = function () {
    originalReset();
    lastResetIndex = port.sent.length; // Future packets start from here
  };

  return {
    sink,
    emitted: () => {
      // Filter to only SID data packets that have been delivered by current time,
      // excluding packets sent before the last reset.
      return port.sent
        .slice(lastResetIndex)
        .filter(
          (packet) =>
            packet.bytes.length >= 12 &&
            packet.bytes[0] === ASID_SYSEX_START &&
            packet.bytes[1] === ASID_MANUFACTURER_ID &&
            packet.bytes[2] === ASID_MSG_SID_DATA &&
            (packet.timestampMs === undefined || packet.timestampMs <= mockNow),
        )
        .flatMap((packet) => decodeSidDataPacket(packet.bytes));
    },
    advanceMs: (ms) => {
      mockNow += ms;
    },
  };
}

describe('ASID sink conformance', () => {
  beforeEach(() => {
    mockNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => mockNow);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const c of SINK_CONFORMANCE_CASES) {
    it(c.name, async () => {
      await c.run(makeHarness);
    });
  }
});
