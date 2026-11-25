import { readSidField } from '@sidablist/core';
import type { JumpSettings, SidField, SidPlayer } from '@sidablist/core';
import type { NumberedSetting } from '../messages/commands.js';
import {
  HOLD_RELEASED,
  SETTING,
  SETTING_NUMBERS,
  SETTING_SLOTS,
  describeSetting,
  type SettingInfo,
} from '../messages/setting-table.js';

/** The voices a deck shapes. */
export const VOICE_COUNT = 3;

/**
 * What applying one setting asks of the engine, made once from the table at module load so applying
 * a setting allocates nothing. `pitch` is a voice's coarse or fine tuning, `key` the shift of all
 * three voices.
 */
type Step =
  | { readonly kind: 'mute'; readonly voice: number }
  | { readonly kind: 'offset' | 'hold'; readonly field: SidField }
  | { readonly kind: 'pitch'; readonly voice: number }
  | { readonly kind: 'key' };

function stepOf(info: SettingInfo): Step | undefined {
  switch (info.kind) {
    case 'mute':
      return info.voice === null ? undefined : { kind: 'mute', voice: info.voice };
    case 'coarse':
    case 'fine':
      return info.voice === null ? undefined : { kind: 'pitch', voice: info.voice };
    case 'offset':
    case 'hold':
      return info.field === null ? undefined : { kind: info.kind, field: info.field };
    case 'key':
      return { kind: 'key' };
  }
}

/** The step of each setting, by number; index 0 is unused. */
const STEPS: (Step | undefined)[] = new Array<Step | undefined>(SETTING_SLOTS).fill(undefined);
/** Each setting's home, by number: what a list holds when nothing is changed. */
const HOME = new Float64Array(SETTING_SLOTS);
/** The mute, coarse and fine setting of each voice. */
const MUTE_OF = new Array<number>(VOICE_COUNT).fill(0);
const COARSE_OF = new Array<number>(VOICE_COUNT).fill(0);
const FINE_OF = new Array<number>(VOICE_COUNT).fill(0);

for (const setting of SETTING_NUMBERS) {
  const info = describeSetting(setting);
  if (info === null) continue;
  STEPS[setting] = stepOf(info);
  HOME[setting] = info.home;
  if (info.voice === null) continue;
  if (info.kind === 'mute') MUTE_OF[info.voice] = setting;
  else if (info.kind === 'coarse') COARSE_OF[info.voice] = setting;
  else if (info.kind === 'fine') FINE_OF[info.voice] = setting;
}

/** Puts every setting of `list` (indexed by setting number) at home. */
export function homeList(list: Float64Array): void {
  list.set(HOME);
}

/**
 * Replaces `list` with every setting at home but the ones `settings` names, which is how a load and
 * a loop's own settings are complete: what they do not name is home.
 */
export function readList(
  settings: readonly NumberedSetting[] | undefined,
  list: Float64Array,
): void {
  homeList(list);
  if (settings === undefined) return;
  for (const { setting, value } of settings) {
    if (STEPS[setting] !== undefined) list[setting] = value;
  }
}

/** A new list holding `settings` over home. */
export function listOf(settings: readonly NumberedSetting[] | undefined): Float64Array {
  const list = new Float64Array(SETTING_SLOTS);
  readList(settings, list);
  return list;
}

/** `list`'s pitch coefficient for `voice`: Key, coarse and fine in semitones, exactly 1 at home. */
function pitchOf(list: Float64Array, voice: number): number {
  const semitones = list[SETTING.KEY] + list[COARSE_OF[voice]] + list[FINE_OF[voice]] / 100;
  return 2 ** (semitones / 12);
}

/**
 * Applies setting `setting`, at its value in `list`, to the engine. A mute sets the voice's latched
 * mute; an offset sets it (0 hands it back); a hold pins the field at full strength, or releases it
 * for `HOLD_RELEASED`; Key, coarse and fine set the pitch of the voices they reach from the whole of
 * `list`. Allocates nothing of its own.
 */
export function applySetting(player: SidPlayer, list: Float64Array, setting: number): void {
  const step = STEPS[setting];
  if (step === undefined) return;
  const value = list[setting];
  switch (step.kind) {
    case 'mute':
      player.setVoiceMuted(step.voice, value === 1);
      break;
    case 'offset':
      player.setFieldOffset(step.field, value);
      break;
    case 'hold':
      if (value === HOLD_RELEASED) player.releaseField(step.field);
      else player.holdField(step.field, value);
      break;
    case 'pitch':
      player.setVoicePitch(step.voice, pitchOf(list, step.voice));
      break;
    case 'key':
      for (let voice = 0; voice < VOICE_COUNT; voice++) {
        player.setVoicePitch(voice, pitchOf(list, voice));
      }
      break;
  }
}

/** Applies every setting of `list` to the engine, in number order. */
export function applyList(player: SidPlayer, list: Float64Array): void {
  for (let setting = 1; setting < SETTING_SLOTS; setting++) applySetting(player, list, setting);
}

/**
 * Applies to the engine, from `to`, every setting whose value differs between `from` and `to`: the
 * engine holds `from`, and is left holding `to`. Allocates nothing of its own.
 */
export function applyDifferences(player: SidPlayer, to: Float64Array, from: Float64Array): void {
  for (let setting = 1; setting < SETTING_SLOTS; setting++) {
    if (to[setting] !== from[setting]) applySetting(player, to, setting);
  }
}

/**
 * What a jump carries so `list` is in force when it lands: every field the package owns, so what the
 * playhead leaves behind is overwritten whole. Builds arrays, so it is made when the command lands and
 * never at the landing tick.
 */
export function jumpSettingsOf(list: Float64Array): JumpSettings {
  const voicePitch: number[] = [];
  const voiceMutes: boolean[] = [];
  for (let voice = 0; voice < VOICE_COUNT; voice++) {
    voicePitch.push(pitchOf(list, voice));
    voiceMutes.push(list[MUTE_OF[voice]] === 1);
  }
  const fieldOffsets: { field: SidField; amount: number }[] = [];
  const fieldHolds: { field: SidField; value: number | null }[] = [];
  for (let setting = 1; setting < SETTING_SLOTS; setting++) {
    const step = STEPS[setting];
    if (step?.kind === 'offset') {
      fieldOffsets.push({ field: step.field, amount: list[setting] });
    } else if (step?.kind === 'hold') {
      fieldHolds.push({
        field: step.field,
        value: list[setting] === HOLD_RELEASED ? null : list[setting],
      });
    }
  }
  return { voicePitch, fieldOffsets, fieldHolds, voiceMutes };
}

/**
 * Every setting of `list` that is not at home, in number order, as the numbered settings a picture
 * reports.
 */
export function offHome(list: Float64Array): NumberedSetting[] {
  const off: NumberedSetting[] = [];
  for (let setting = 1; setting < SETTING_SLOTS; setting++) {
    if (list[setting] !== HOME[setting]) off.push({ setting, value: list[setting] });
  }
  return off;
}

/**
 * The value a lock puts on the one-bit switch `setting`: the opposite of what the tune wrote, read
 * from `written`. Null when `setting` is not a hold.
 */
export function oppositeOfTune(setting: number, written: Uint8Array): number | null {
  const step = STEPS[setting];
  return step?.kind === 'hold' ? 1 - readSidField(written, step.field) : null;
}
