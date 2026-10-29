import { describe, expect, it } from 'vitest';
import { isUsableRegisterRecord } from './register-record.js';
import type { RegisterRecord } from './register-record.js';
import { SID_REGISTER_COUNT } from './sid-constants.js';

function record(overrides: Partial<RegisterRecord> = {}): RegisterRecord {
  return {
    frames: 4,
    values: new Uint8Array(4 * SID_REGISTER_COUNT),
    retriggerEntries: Uint32Array.from([1, 1, 3]),
    retriggerRegisters: Uint8Array.from([4, 11, 18]),
    retriggerValues: Uint8Array.from([0x40, 0x40, 0x10]),
    ...overrides,
  };
}

describe('isUsableRegisterRecord', () => {
  it('accepts a record of the documented shape, with or without retriggers', () => {
    expect(isUsableRegisterRecord(record())).toBe(true);
    expect(
      isUsableRegisterRecord(
        record({
          retriggerEntries: new Uint32Array(0),
          retriggerRegisters: new Uint8Array(0),
          retriggerValues: new Uint8Array(0),
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ['no entries', { frames: 0, values: new Uint8Array(0) }],
    ['a fractional length', { frames: 1.5 }],
    ['a values array of the wrong size', { values: new Uint8Array(3 * SID_REGISTER_COUNT) }],
    ['values that are not bytes', { values: new Array(100).fill(0) as unknown as Uint8Array }],
    ['retrigger arrays of different lengths', { retriggerValues: Uint8Array.from([0x40]) }],
    ['a retrigger beyond the last entry', { retriggerEntries: Uint32Array.from([1, 1, 4]) }],
    ['retriggers out of order', { retriggerEntries: Uint32Array.from([3, 1, 1]) }],
    [
      'a retrigger on a register that is not a voice control',
      {
        retriggerRegisters: Uint8Array.from([4, 11, 5]),
      },
    ],
  ])('refuses %s', (_label, overrides) => {
    expect(isUsableRegisterRecord(record(overrides as Partial<RegisterRecord>))).toBe(false);
  });
});
