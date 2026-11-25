import { SID_FIELD_WIDTHS } from '@sidablist/core';
import type { SidField, SidFieldName } from '@sidablist/core';

/**
 * Every numbered setting. A number is fixed forever and never reused; a later setting takes the next
 * free number. A voice's settings sit together: voice 1 from 4, voice 2 from 24, voice 3 from 44.
 */
export const SETTING = {
  VOICE_1_MUTE: 1,
  VOICE_2_MUTE: 2,
  VOICE_3_MUTE: 3,
  VOICE_1_FREQUENCY_OFFSET: 4,
  VOICE_1_FREQUENCY_HOLD: 5,
  VOICE_1_PULSE_WIDTH_OFFSET: 6,
  VOICE_1_PULSE_WIDTH_HOLD: 7,
  VOICE_1_WAVEFORM_HOLD: 8,
  VOICE_1_TEST_HOLD: 9,
  VOICE_1_RING_MOD_HOLD: 10,
  VOICE_1_SYNC_HOLD: 11,
  VOICE_1_GATE_HOLD: 12,
  VOICE_1_ATTACK_OFFSET: 13,
  VOICE_1_ATTACK_HOLD: 14,
  VOICE_1_DECAY_OFFSET: 15,
  VOICE_1_DECAY_HOLD: 16,
  VOICE_1_SUSTAIN_OFFSET: 17,
  VOICE_1_SUSTAIN_HOLD: 18,
  VOICE_1_RELEASE_OFFSET: 19,
  VOICE_1_RELEASE_HOLD: 20,
  VOICE_1_FILTERED_HOLD: 21,
  VOICE_1_COARSE: 22,
  VOICE_1_FINE: 23,
  VOICE_2_FREQUENCY_OFFSET: 24,
  VOICE_2_FREQUENCY_HOLD: 25,
  VOICE_2_PULSE_WIDTH_OFFSET: 26,
  VOICE_2_PULSE_WIDTH_HOLD: 27,
  VOICE_2_WAVEFORM_HOLD: 28,
  VOICE_2_TEST_HOLD: 29,
  VOICE_2_RING_MOD_HOLD: 30,
  VOICE_2_SYNC_HOLD: 31,
  VOICE_2_GATE_HOLD: 32,
  VOICE_2_ATTACK_OFFSET: 33,
  VOICE_2_ATTACK_HOLD: 34,
  VOICE_2_DECAY_OFFSET: 35,
  VOICE_2_DECAY_HOLD: 36,
  VOICE_2_SUSTAIN_OFFSET: 37,
  VOICE_2_SUSTAIN_HOLD: 38,
  VOICE_2_RELEASE_OFFSET: 39,
  VOICE_2_RELEASE_HOLD: 40,
  VOICE_2_FILTERED_HOLD: 41,
  VOICE_2_COARSE: 42,
  VOICE_2_FINE: 43,
  VOICE_3_FREQUENCY_OFFSET: 44,
  VOICE_3_FREQUENCY_HOLD: 45,
  VOICE_3_PULSE_WIDTH_OFFSET: 46,
  VOICE_3_PULSE_WIDTH_HOLD: 47,
  VOICE_3_WAVEFORM_HOLD: 48,
  VOICE_3_TEST_HOLD: 49,
  VOICE_3_RING_MOD_HOLD: 50,
  VOICE_3_SYNC_HOLD: 51,
  VOICE_3_GATE_HOLD: 52,
  VOICE_3_ATTACK_OFFSET: 53,
  VOICE_3_ATTACK_HOLD: 54,
  VOICE_3_DECAY_OFFSET: 55,
  VOICE_3_DECAY_HOLD: 56,
  VOICE_3_SUSTAIN_OFFSET: 57,
  VOICE_3_SUSTAIN_HOLD: 58,
  VOICE_3_RELEASE_OFFSET: 59,
  VOICE_3_RELEASE_HOLD: 60,
  VOICE_3_FILTERED_HOLD: 61,
  VOICE_3_COARSE: 62,
  VOICE_3_FINE: 63,
  CUTOFF_OFFSET: 64,
  CUTOFF_HOLD: 65,
  RESONANCE_OFFSET: 66,
  RESONANCE_HOLD: 67,
  EXTERNAL_FILTERED_HOLD: 68,
  FILTER_TYPE_HOLD: 69,
  VOICE_3_OFF_HOLD: 70,
  VOLUME_OFFSET: 71,
  VOLUME_HOLD: 72,
  KEY: 73,
} as const;

/** A hold's value that hands the setting back to the tune. */
export const HOLD_RELEASED = -1;

/**
 * What a setting is: a voice `mute`, an `offset` added to a chip field, a `hold` that pins one, the
 * `key` shift (all voices), or a voice's `coarse` and `fine` tuning.
 */
export type SettingKind = 'mute' | 'offset' | 'hold' | 'key' | 'coarse' | 'fine';

/** One setting's description: what it acts on and the values the chip can take. */
export interface SettingInfo {
  readonly setting: number;
  readonly kind: SettingKind;
  /** The chip field an offset or hold acts on; null for the rest. */
  readonly field: SidField | null;
  /** 0 to 2 for a per-voice setting (mutes and tuning included); null otherwise. */
  readonly voice: number | null;
  readonly min: number;
  readonly max: number;
  /** 0, or `HOLD_RELEASED` for a hold. */
  readonly home: number;
  /** A value must be a whole number (every setting but `FINE`). */
  readonly whole: boolean;
}

const VOICES = 3;
const KEY_RANGE = 96;
const FINE_RANGE = 100;

const VOICE_FIELDS = [
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
] as const;

const CHIP_FIELDS = [
  'cutoff',
  'resonance',
  'externalFiltered',
  'filterType',
  'voice3Off',
  'volume',
] as const;

/** The fields an offset exists for; every field has a hold. */
const NUMERIC_FIELDS: ReadonlySet<SidFieldName> = new Set([
  'frequency',
  'pulseWidth',
  'attack',
  'decay',
  'sustain',
  'release',
  'cutoff',
  'resonance',
  'volume',
]);

function ceiling(name: SidFieldName): number {
  return 2 ** SID_FIELD_WIDTHS[name] - 1;
}

function buildTable(): readonly (SettingInfo | null)[] {
  const table: (SettingInfo | null)[] = [null];
  const add = (
    kind: SettingKind,
    field: SidField | null,
    voice: number | null,
    min: number,
    max: number,
    home: number,
    whole = true,
  ): void => {
    table.push({ setting: table.length, kind, field, voice, min, max, home, whole });
  };
  const addField = (name: SidFieldName, field: SidField, voice: number | null): void => {
    const top = ceiling(name);
    if (NUMERIC_FIELDS.has(name)) add('offset', field, voice, -top, top, 0);
    add('hold', field, voice, HOLD_RELEASED, top, HOLD_RELEASED);
  };

  for (let voice = 0; voice < VOICES; voice++) add('mute', null, voice, 0, 1, 0);
  for (let voice = 0; voice < VOICES; voice++) {
    for (const name of VOICE_FIELDS) addField(name, { name, voice }, voice);
    add('coarse', null, voice, -KEY_RANGE, KEY_RANGE, 0);
    add('fine', null, voice, -FINE_RANGE, FINE_RANGE, 0, false);
  }
  for (const name of CHIP_FIELDS) addField(name, { name }, null);
  add('key', null, null, -KEY_RANGE, KEY_RANGE, 0);
  return table;
}

const TABLE = buildTable();

/** The highest setting number plus one: the length of a list indexed by setting number. */
export const SETTING_SLOTS = TABLE.length;

/** Every setting number, ascending. */
export const SETTING_NUMBERS: readonly number[] = Array.from(
  { length: SETTING_SLOTS - 1 },
  (_, i) => i + 1,
);

/** The setting's description, or null for a number that is not a setting. */
export function describeSetting(setting: number): SettingInfo | null {
  return Number.isInteger(setting) ? (TABLE[setting] ?? null) : null;
}
