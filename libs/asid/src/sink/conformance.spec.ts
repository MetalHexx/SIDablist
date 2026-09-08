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

/** Fake MIDI port for conformance testing. `cancelPending()` actually removes not-yet-due sends
 *  rather than merely reporting success, so a sink that skipped calling it would still show the
 *  stale packet once its due time passed — real enough to prove `AsidSink.reset()`/`retime()`
 *  genuinely withdraw, not just report that they did. */
class FakeMidiOutputPort implements MidiOutputPort {
  portId: string | null = 'port-1';
  sent: SentPacket[] = [];

  constructor(
    public readonly supportsCancel: boolean,
    private readonly nowMs: () => number,
  ) {}

  send(bytes: Uint8Array, timestampMs?: number): void {
    this.sent.push({ bytes: Uint8Array.from(bytes), timestampMs });
  }

  cancelPending(): boolean {
    if (!this.supportsCancel) {
      return false; // matches MidiOutputPort's contract: no cancel support at all reports false
    }
    const now = this.nowMs();
    const before = this.sent.length;
    this.sent = this.sent.filter(
      (packet) => packet.timestampMs === undefined || packet.timestampMs <= now,
    );
    return this.sent.length < before;
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

function makeHarness(supportsCancel: boolean): ConformanceHarness {
  const port = new FakeMidiOutputPort(supportsCancel, () => mockNow);
  const sink = createAsidSink(port);

  return {
    sink,
    emitted: () => {
      // Filter to only SID data packets that have been delivered by current time. A reset or a
      // successful cancel actually removes not-yet-due entries from `port.sent` (see
      // `FakeMidiOutputPort.cancelPending`), so no separate "since the last reset" bookkeeping is
      // needed here — what's left in `port.sent` is what the transport genuinely still holds.
      return port.sent
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

// Run against both a cancelling and a non-cancelling port: `AsidSink.capabilities.cancellation`
// mirrors `port.supportsCancel` directly, and several cases (`honorsNoCancellationOnRetime`,
// `resetDropsOutstandingAndReopens`) branch on it — a suite that only ever ran one value would
// silently stop proving the other.
describe.each([
  ['a port that can cancel', true],
  ['a port that cannot cancel', false],
] as const)('ASID sink conformance, %s', (_label, supportsCancel) => {
  beforeEach(() => {
    mockNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => mockNow);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const c of SINK_CONFORMANCE_CASES) {
    it(c.name, async () => {
      await c.run(() => makeHarness(supportsCancel));
    });
  }
});
