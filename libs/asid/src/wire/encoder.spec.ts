import { describe, it, expect } from 'vitest';
import { createRegisterFrame } from '@sidablist/core';
import type { SidFrame } from '@sidablist/core';
import {
  buildDisplayCharsPacket,
  buildSidDataPacket,
  buildSidTypePacket,
  buildStartPacket,
  buildStopPacket,
  SID_DATA_PACKET_MAX_LENGTH,
  writeSidDataPacket,
} from './encoder.js';

function emptyFrame(): SidFrame {
  return {
    count: 0,
    registers: new Uint8Array(0),
    values: new Uint8Array(0),
    offsetsUs: new Int32Array(0),
  };
}

describe('buildStartPacket / buildStopPacket', () => {
  it('builds the four-byte start packet', () => {
    expect(buildStartPacket()).toEqual(Uint8Array.from([0xf0, 0x2d, 0x4c, 0xf7]));
  });

  it('builds the four-byte stop packet', () => {
    expect(buildStopPacket()).toEqual(Uint8Array.from([0xf0, 0x2d, 0x4d, 0xf7]));
  });
});

describe('buildSidTypePacket', () => {
  it('encodes a 6581 chip as type bit0 = 0', () => {
    expect(buildSidTypePacket(0, false)).toEqual(
      Uint8Array.from([0xf0, 0x2d, 0x32, 0x00, 0x00, 0xf7]),
    );
  });

  it('encodes an 8580 chip on a non-zero chip index as type bit0 = 1', () => {
    expect(buildSidTypePacket(2, true)).toEqual(
      Uint8Array.from([0xf0, 0x2d, 0x32, 0x02, 0x01, 0xf7]),
    );
  });
});

describe('buildDisplayCharsPacket', () => {
  it('wraps ASCII text bytes between the header and terminator', () => {
    expect(buildDisplayCharsPacket('HI')).toEqual(
      Uint8Array.from([0xf0, 0x2d, 0x4f, 0x48, 0x49, 0xf7]),
    );
  });

  it('drops characters at or above 0x80 rather than corrupting the stream with a masked byte', () => {
    const packet = buildDisplayCharsPacket('AéB'); // 'é' = 0xe9
    const dataBytes = packet.slice(3, -1); // the payload, excluding SysEx framing

    expect(Array.from(dataBytes)).toEqual([0x41, 0x42]); // A, B — é dropped
    expect(Array.from(dataBytes).every((byte) => byte < 0x80)).toBe(true);
  });
});

describe('buildSidDataPacket', () => {
  it('produces exactly twelve bytes, all mask bytes zero, for an empty frame', () => {
    const packet = buildSidDataPacket(emptyFrame());

    expect(packet).toHaveLength(12);
    expect(packet).toEqual(Uint8Array.from([0xf0, 0x2d, 0x4e, 0, 0, 0, 0, 0, 0, 0, 0, 0xf7]));
  });

  it('produces a 15-byte packet for writes to registers 0, 1 and 24, in ascending slot order', () => {
    const frame = createRegisterFrame();
    frame.onSidWrite(0, 0x11);
    frame.onSidWrite(1, 0x22);
    frame.onSidWrite(24, 0x33);

    const packet = buildSidDataPacket(frame.takeSnapshot());

    expect(packet).toHaveLength(15);
    // slots 0, 1 and 21 -> present-mask byte 0 bits 0-1, byte 3 bit 0
    expect(packet[3]).toBe(0b11);
    expect(packet[4]).toBe(0);
    expect(packet[5]).toBe(0);
    expect(packet[6]).toBe(0b1);
    expect(Array.from(packet.slice(11, 14))).toEqual([0x11, 0x22, 0x33]);
    expect(packet[14]).toBe(0xf7);
  });

  it('sets the MSB mask bit and sends the low 7 bits for a value >= 0x80', () => {
    const frame = createRegisterFrame();
    frame.onSidWrite(0, 0xff);

    const packet = buildSidDataPacket(frame.takeSnapshot());

    expect(packet[3]).toBe(0b1); // present mask, slot 0
    expect(packet[7]).toBe(0b1); // MSB mask, slot 0
    expect(packet[11]).toBe(0x7f);
  });

  it('carries both writes to register 4 in one frame, in slots 22 and 25', () => {
    const frame = createRegisterFrame();
    frame.onSidWrite(4, 0x01);
    frame.onSidWrite(4, 0x02);

    const packet = buildSidDataPacket(frame.takeSnapshot());

    // slot 22 -> byte 3 bit 1, slot 25 -> byte 3 bit 4
    expect(packet[6]).toBe((1 << 1) | (1 << 4));
    expect(Array.from(packet.slice(11, 13))).toEqual([0x01, 0x02]);
  });

  it('reproduces the pre-extraction implementations byte-for-byte packet for a mixed write set', () => {
    // Registers 0, 1 and 24 written once each, plus a gate retrigger on register 4 — the same
    // write sequence the pre-extraction RegisterFrame/asid-encoder pair in teensyrom-web produced
    // this exact packet for.
    const frame = createRegisterFrame();
    frame.onSidWrite(0, 0x11);
    frame.onSidWrite(1, 0x22);
    frame.onSidWrite(24, 0x33);
    frame.onSidWrite(4, 0x01);
    frame.onSidWrite(4, 0x02);

    const packet = buildSidDataPacket(frame.takeSnapshot());

    expect(packet).toEqual(
      Uint8Array.from([
        0xf0, 0x2d, 0x4e, 0x03, 0x00, 0x00, 0x13, 0x00, 0x00, 0x00, 0x00, 0x11, 0x22, 0x33, 0x01,
        0x02, 0xf7,
      ]),
    );
  });
});

describe('writeSidDataPacket', () => {
  function frameOf(writes: readonly (readonly [number, number])[]): SidFrame {
    return {
      count: writes.length,
      registers: Uint8Array.from(writes.map(([register]) => register)),
      values: Uint8Array.from(writes.map(([, value]) => value)),
      offsetsUs: new Int32Array(writes.length),
    };
  }

  it('writes the same bytes buildSidDataPacket returns, and the length, into the front of a larger buffer', () => {
    const frame = frameOf([
      [0, 0x91],
      [4, 0x01],
      [4, 0x02],
      [24, 0x0f],
    ]);
    const into = new Uint8Array(SID_DATA_PACKET_MAX_LENGTH).fill(0xee);

    const length = writeSidDataPacket(frame, into);

    expect(into.subarray(0, length)).toEqual(buildSidDataPacket(frame));
    expect(into[length]).toBe(0xee);
  });

  it('is the same for a frame that writes every slot', () => {
    const frame = frameOf(
      Array.from({ length: 25 }, (_, register) => [register, register + 1] as const),
    );
    const doubled = {
      ...frame,
      count: frame.count + 3,
      registers: Uint8Array.from([...frame.registers, 4, 11, 18]),
      values: Uint8Array.from([...frame.values, 0x40, 0x41, 0x42]),
      offsetsUs: new Int32Array(frame.count + 3),
    };
    const into = new Uint8Array(SID_DATA_PACKET_MAX_LENGTH);

    expect(writeSidDataPacket(doubled, into)).toBe(SID_DATA_PACKET_MAX_LENGTH);
    expect(into).toEqual(buildSidDataPacket(doubled));
  });

  it('leaves nothing of an earlier, fuller frame behind', () => {
    const into = new Uint8Array(SID_DATA_PACKET_MAX_LENGTH);
    writeSidDataPacket(
      frameOf([
        [0, 1],
        [1, 2],
        [2, 3],
      ]),
      into,
    );

    const length = writeSidDataPacket(frameOf([[24, 5]]), into);

    expect(into.subarray(0, length)).toEqual(buildSidDataPacket(frameOf([[24, 5]])));
  });

  it('refuses a buffer too small for the longest packet', () => {
    expect(() => writeSidDataPacket(frameOf([[0, 1]]), new Uint8Array(12))).toThrow(RangeError);
  });
});
