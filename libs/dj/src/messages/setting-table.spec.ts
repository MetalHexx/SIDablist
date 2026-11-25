import { SID_FIELD_WIDTHS } from '@sidablist/core';
import type { SidFieldName } from '@sidablist/core';
import { describe, expect, it } from 'vitest';
import {
  HOLD_RELEASED,
  SETTING,
  SETTING_NUMBERS,
  SETTING_SLOTS,
  describeSetting,
} from './setting-table.js';
import type { SettingInfo } from './setting-table.js';

const NUMERIC: readonly SidFieldName[] = [
  'frequency',
  'pulseWidth',
  'attack',
  'decay',
  'sustain',
  'release',
  'cutoff',
  'resonance',
  'volume',
];
const VOICE_FIELDS: readonly SidFieldName[] = [
  'frequency',
  'pulseWidth',
  'waveform',
  'test',
  'ringMod',
  'sync',
  'gate',
  'attack',
  'decay',
  'sustain',
  'release',
  'filtered',
];

function all(): SettingInfo[] {
  return SETTING_NUMBERS.map((n) => describeSetting(n)!);
}

function actingOn(
  kind: 'offset' | 'hold',
  name: SidFieldName,
  voice: number | null,
): SettingInfo[] {
  return all().filter(
    (s) =>
      s.kind === kind &&
      s.field?.name === name &&
      (s.field as { voice?: number }).voice === (voice ?? undefined),
  );
}

describe('the setting table', () => {
  it('runs from 1 to 73 with every number once, and describes exactly those', () => {
    expect(SETTING_NUMBERS).toEqual(Array.from({ length: 73 }, (_, i) => i + 1));
    expect(SETTING_SLOTS).toBe(74);
    expect(Object.values(SETTING).sort((a, b) => a - b)).toEqual(SETTING_NUMBERS);
    expect(all().map((s) => s.setting)).toEqual(SETTING_NUMBERS);
    for (const bad of [0, 74, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(describeSetting(bad)).toBeNull();
    }
  });

  it('gives every field in core a hold per voice or one hold, and every numeric field an offset', () => {
    for (const name of Object.keys(SID_FIELD_WIDTHS) as SidFieldName[]) {
      const voices = VOICE_FIELDS.includes(name) ? [0, 1, 2] : [null];
      for (const voice of voices) {
        expect(actingOn('hold', name, voice), `${name} hold, voice ${voice}`).toHaveLength(1);
        expect(actingOn('offset', name, voice), `${name} offset, voice ${voice}`).toHaveLength(
          NUMERIC.includes(name) ? 1 : 0,
        );
      }
    }
  });

  it('takes its ranges from the field widths', () => {
    for (const s of all()) {
      if (s.field === null) continue;
      const top = 2 ** SID_FIELD_WIDTHS[s.field.name] - 1;
      if (s.kind === 'offset') expect([s.min, s.max, s.home]).toEqual([-top, top, 0]);
      else expect([s.min, s.max, s.home]).toEqual([HOLD_RELEASED, top, HOLD_RELEASED]);
      expect(s.whole).toBe(true);
    }
    expect(describeSetting(SETTING.VOICE_2_WAVEFORM_HOLD)).toMatchObject({ min: -1, max: 15 });
    expect(describeSetting(SETTING.VOICE_1_GATE_HOLD)).toMatchObject({ min: -1, max: 1 });
    expect(describeSetting(SETTING.VOICE_3_FREQUENCY_OFFSET)).toMatchObject({
      min: -65535,
      max: 65535,
    });
    expect(describeSetting(SETTING.FILTER_TYPE_HOLD)).toMatchObject({ max: 7 });
  });

  it('describes the mutes, the key and the tuning', () => {
    expect(describeSetting(SETTING.VOICE_3_MUTE)).toMatchObject({
      kind: 'mute',
      voice: 2,
      field: null,
      min: 0,
      max: 1,
      home: 0,
    });
    expect(describeSetting(SETTING.KEY)).toMatchObject({
      kind: 'key',
      voice: null,
      min: -96,
      max: 96,
      whole: true,
    });
    expect(describeSetting(SETTING.VOICE_2_COARSE)).toMatchObject({
      kind: 'coarse',
      voice: 1,
      min: -96,
      max: 96,
      whole: true,
    });
    expect(describeSetting(SETTING.VOICE_1_FINE)).toMatchObject({
      kind: 'fine',
      voice: 0,
      min: -100,
      max: 100,
      whole: false,
    });
  });

  it('keeps each named number on the setting its name says', () => {
    const camel = (word: string): string =>
      word.toLowerCase().replace(/_(.)/g, (_, c: string) => c.toUpperCase());
    for (const [name, number] of Object.entries(SETTING)) {
      const info = describeSetting(number)!;
      const voiced = /^VOICE_([123])_(.+)$/.exec(name);
      const rest = voiced !== null && voiced[2] !== 'OFF_HOLD' ? voiced[2] : name;
      expect(info.voice).toBe(
        voiced !== null && voiced[2] !== 'OFF_HOLD' ? Number(voiced[1]) - 1 : null,
      );
      if (rest === 'MUTE') expect(info.kind).toBe('mute');
      else if (rest === 'COARSE') expect(info.kind).toBe('coarse');
      else if (rest === 'FINE') expect(info.kind).toBe('fine');
      else if (rest === 'KEY') expect(info.kind).toBe('key');
      else {
        const suffix = rest.endsWith('_OFFSET') ? '_OFFSET' : '_HOLD';
        expect(info.kind).toBe(suffix === '_OFFSET' ? 'offset' : 'hold');
        expect(info.field?.name).toBe(camel(rest.slice(0, -suffix.length)));
      }
    }
  });
});
