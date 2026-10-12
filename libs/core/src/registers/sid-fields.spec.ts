import { describe, it, expect } from 'vitest';
import { SID_REGISTER_COUNT } from './sid-constants.js';
import {
  SID_FIELD_TABLE,
  SID_FIELD_WIDTHS,
  isUsableHold,
  readSidField,
  resolveSidField,
} from './sid-fields.js';
import type { SidField, SidFieldEntry } from './sid-fields.js';

/** A distinct byte per register, so a field that read the wrong register or the wrong bits would
 *  come out as the wrong number. */
function distinctRegisters(): Uint8Array {
  return Uint8Array.from(
    { length: SID_REGISTER_COUNT },
    (_, register) => (register * 37 + 0x5b) & 0xff,
  );
}

/** The public identifier a table entry stands for. */
function fieldOf(entry: SidFieldEntry): SidField {
  return (
    entry.voice < 0 ? { name: entry.name } : { name: entry.name, voice: entry.voice }
  ) as SidField;
}

describe('readSidField', () => {
  const r = distinctRegisters();

  it('joins a 16-bit pair with the first register carrying the low byte', () => {
    expect(readSidField(r, { name: 'frequency', voice: 1 })).toBe((r[8] << 8) | r[7]);
  });

  it('leaves the pulse-width pairs unused high nibble out', () => {
    expect(readSidField(r, { name: 'pulseWidth', voice: 2 })).toBe(((r[17] & 0x0f) << 8) | r[16]);
  });

  it('splits cutoff across the low three bits of one register and all eight of the next', () => {
    expect(readSidField(r, { name: 'cutoff' })).toBe((r[22] << 3) | (r[21] & 0x07));
  });

  it('decodes a voice control register as a waveform nibble and four single bits', () => {
    const control = r[11];
    expect(readSidField(r, { name: 'waveform', voice: 1 })).toBe(control >> 4);
    expect(readSidField(r, { name: 'test', voice: 1 })).toBe((control >> 3) & 1);
    expect(readSidField(r, { name: 'ringMod', voice: 1 })).toBe((control >> 2) & 1);
    expect(readSidField(r, { name: 'sync', voice: 1 })).toBe((control >> 1) & 1);
    expect(readSidField(r, { name: 'gate', voice: 1 })).toBe(control & 1);
  });

  it('decodes the envelope nibbles of a voice', () => {
    expect(readSidField(r, { name: 'attack', voice: 2 })).toBe(r[19] >> 4);
    expect(readSidField(r, { name: 'decay', voice: 2 })).toBe(r[19] & 0x0f);
    expect(readSidField(r, { name: 'sustain', voice: 2 })).toBe(r[20] >> 4);
    expect(readSidField(r, { name: 'release', voice: 2 })).toBe(r[20] & 0x0f);
  });

  it('decodes filter routing as bit v of register 23, beside resonance and the external input', () => {
    for (let voice = 0; voice < 3; voice++) {
      expect(readSidField(r, { name: 'filtered', voice })).toBe((r[23] >> voice) & 1);
    }
    expect(readSidField(r, { name: 'externalFiltered' })).toBe((r[23] >> 3) & 1);
    expect(readSidField(r, { name: 'resonance' })).toBe(r[23] >> 4);
  });

  it('decodes register 24 as volume, filter type and voice-3 off', () => {
    expect(readSidField(r, { name: 'volume' })).toBe(r[24] & 0x0f);
    expect(readSidField(r, { name: 'filterType' })).toBe((r[24] >> 4) & 0x07);
    expect(readSidField(r, { name: 'voice3Off' })).toBe(r[24] >> 7);
  });

  it('reads every field of a full chip as its width of ones, and of a silent one as zero', () => {
    const ones = new Uint8Array(SID_REGISTER_COUNT).fill(0xff);
    const zeros = new Uint8Array(SID_REGISTER_COUNT);
    for (const entry of SID_FIELD_TABLE) {
      const field = fieldOf(entry);
      expect(readSidField(ones, field)).toBe(2 ** SID_FIELD_WIDTHS[entry.name] - 1);
      expect(readSidField(zeros, field)).toBe(0);
    }
  });
});

describe('resolveSidField', () => {
  it('gives every voice of every field, and every chip field, its own index', () => {
    const resolved = SID_FIELD_TABLE.map((entry) => resolveSidField(fieldOf(entry)));

    expect(resolved).toEqual(SID_FIELD_TABLE.map((_, index) => index));
  });

  it('refuses a name that is not a field', () => {
    expect(resolveSidField({ name: 'bogus' } as unknown as SidField)).toBe(-1);
  });

  it.each([3, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a per-voice field on voice %s',
    (voice) => {
      expect(resolveSidField({ name: 'gate', voice })).toBe(-1);
    },
  );

  it('refuses a per-voice field with no voice at all', () => {
    expect(resolveSidField({ name: 'gate' } as unknown as SidField)).toBe(-1);
  });

  it('ignores a voice on a whole-chip field', () => {
    const plain = resolveSidField({ name: 'cutoff' });
    expect(plain).toBeGreaterThanOrEqual(0);
    expect(resolveSidField({ name: 'cutoff', voice: 7 } as unknown as SidField)).toBe(plain);
  });
});

describe('isUsableHold', () => {
  const cutoff = resolveSidField({ name: 'cutoff' });

  it('takes any integer up to the width of the field, and an amount from 0 to 1', () => {
    expect(isUsableHold(cutoff, 0, 0)).toBe(true);
    expect(isUsableHold(cutoff, 2047, 1)).toBe(true);
    expect(isUsableHold(cutoff, 100, 0.5)).toBe(true);
  });

  it.each([1.5, -1, 2048, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a cutoff value of %s',
    (value) => {
      expect(isUsableHold(cutoff, value, 1)).toBe(false);
    },
  );

  it.each([Number.NaN, -0.1, 1.1, Number.POSITIVE_INFINITY])(
    'refuses an amount of %s',
    (amount) => {
      expect(isUsableHold(cutoff, 100, amount)).toBe(false);
    },
  );

  it('refuses an index that is not in the table', () => {
    expect(isUsableHold(-1, 0, 1)).toBe(false);
    expect(isUsableHold(SID_FIELD_TABLE.length, 0, 1)).toBe(false);
  });
});
