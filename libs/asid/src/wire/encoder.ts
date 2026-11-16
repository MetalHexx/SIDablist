import type { SidFrame } from '@sidablist/core';
import {
  ASID_MANUFACTURER_ID,
  ASID_MSG_DISPLAY_CHARS,
  ASID_MSG_SID_DATA,
  ASID_MSG_SID_TYPE,
  ASID_MSG_START,
  ASID_MSG_STOP,
  ASID_SLOT_COUNT,
  ASID_SYSEX_END,
  ASID_SYSEX_START,
} from './asid-constants.js';
import { createPackScratch, packFrameInto } from './slot-map.js';

/** Pure ASID SysEx packet builders — byte layouts only, no I/O. See `asid-constants.ts` for the
 *  transcribed protocol values these assemble and `slot-map.ts` for how a frame's writes land in
 *  the 28 slots. */

/** The shortest SID_DATA packet: `F0 2D 4E`, the two masks, no values, `F7`. A packet is this plus one
 *  byte per slot the frame wrote. */
export const SID_DATA_PACKET_MIN_LENGTH = 12;
/** The longest: every one of the 28 slots written. */
export const SID_DATA_PACKET_MAX_LENGTH = SID_DATA_PACKET_MIN_LENGTH + ASID_SLOT_COUNT;

const packScratch = createPackScratch();
const allocatingPacketBuffer = new Uint8Array(SID_DATA_PACKET_MAX_LENGTH);

/**
 * Writes `F0 2D 4E <present masks> <MSB masks> <values> F7` into the front of `into` and returns its
 * length, `12 + values.length`. Allocates nothing: this is the form the frame path uses. `into` must
 * hold `SID_DATA_PACKET_MAX_LENGTH` bytes, since the length is not known until the frame is packed.
 */
export function writeSidDataPacket(frame: SidFrame, into: Uint8Array): number {
  if (into.length < SID_DATA_PACKET_MAX_LENGTH) {
    throw new RangeError(
      `a SID data packet needs a ${SID_DATA_PACKET_MAX_LENGTH}-byte buffer, got ${into.length}`,
    );
  }
  packFrameInto(frame, packScratch);
  const length = SID_DATA_PACKET_MIN_LENGTH + packScratch.valueCount;
  into[0] = ASID_SYSEX_START;
  into[1] = ASID_MANUFACTURER_ID;
  into[2] = ASID_MSG_SID_DATA;
  into.set(packScratch.presentMask, 3);
  into.set(packScratch.msbMask, 7);
  into.set(packScratch.values.subarray(0, packScratch.valueCount), 11);
  into[length - 1] = ASID_SYSEX_END;
  return length;
}

/** `F0 2D 4E <present masks> <MSB masks> <values> F7`, `12 + values.length` bytes total — the
 *  allocating form of `writeSidDataPacket`, for callers off the frame path. */
export function buildSidDataPacket(frame: SidFrame): Uint8Array {
  return allocatingPacketBuffer.slice(0, writeSidDataPacket(frame, allocatingPacketBuffer));
}

export function buildStartPacket(): Uint8Array {
  return Uint8Array.from([ASID_SYSEX_START, ASID_MANUFACTURER_ID, ASID_MSG_START, ASID_SYSEX_END]);
}

export function buildStopPacket(): Uint8Array {
  return Uint8Array.from([ASID_SYSEX_START, ASID_MANUFACTURER_ID, ASID_MSG_STOP, ASID_SYSEX_END]);
}

/**
 * `F0 2D 4F <ascii...> F7` — the cartridge converts the bytes to PETSCII. Every MIDI data byte must
 * be under 0x80 or it corrupts the SysEx stream, so a character outside that range is dropped
 * rather than masked into a different, wrong character.
 */
export function buildDisplayCharsPacket(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    }
  }
  return Uint8Array.from([
    ASID_SYSEX_START,
    ASID_MANUFACTURER_ID,
    ASID_MSG_DISPLAY_CHARS,
    ...bytes,
    ASID_SYSEX_END,
  ]);
}

/** `F0 2D 32 <chipIndex> <type> F7` — type bit0: 0 = 6581, 1 = 8580. */
export function buildSidTypePacket(chipIndex: number, is8580: boolean): Uint8Array {
  return Uint8Array.from([
    ASID_SYSEX_START,
    ASID_MANUFACTURER_ID,
    ASID_MSG_SID_TYPE,
    chipIndex & 0x7f,
    is8580 ? 1 : 0,
    ASID_SYSEX_END,
  ]);
}
