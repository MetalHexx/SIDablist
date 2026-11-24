import { SETTING } from '../messages/commands.js';
import type { NumberedSetting } from '../messages/commands.js';

/** The voices a deck mutes: the main settings are one mute per voice. */
export const VOICE_COUNT = 3;

const MAIN_SETTINGS: readonly number[] = [
  SETTING.VOICE_1_MUTE,
  SETTING.VOICE_2_MUTE,
  SETTING.VOICE_3_MUTE,
];

/** Whether `setting` is one of the main settings, the voice mutes. */
export function isMainSetting(setting: number): boolean {
  return MAIN_SETTINGS.includes(setting);
}

/** The voice (0 to 2, as `setVoiceMuted` and `JumpSettings.voiceMutes` count them) a main setting mutes. */
export function voiceOf(setting: number): number {
  return setting - 1;
}

/**
 * Replaces `mutes` (one 0 or 1 a voice) with the voices `settings` names. A voice it does not name
 * sounds, which is how a load replaces the main settings rather than adding to them.
 */
export function readMutes(
  settings: readonly NumberedSetting[] | undefined,
  mutes: Int32Array,
): void {
  mutes.fill(0);
  for (const { setting, value } of settings ?? []) {
    if (isMainSetting(setting)) mutes[voiceOf(setting)] = value === 1 ? 1 : 0;
  }
}

/** `mutes` as the numbered settings a picture reports: every main setting, 0 sounding and 1 muted. */
export function mutesAsSettings(mutes: Int32Array): NumberedSetting[] {
  return MAIN_SETTINGS.map((setting) => ({ setting, value: mutes[voiceOf(setting)] }));
}

/**
 * `settings`' mutes as one boolean a voice, the shape `JumpSettings.voiceMutes` takes. A voice the
 * settings do not name sounds, as in a load's.
 */
export function mutesOfSettings(settings: readonly NumberedSetting[]): boolean[] {
  const muted = new Array<boolean>(VOICE_COUNT).fill(false);
  for (const { setting, value } of settings) {
    if (isMainSetting(setting)) muted[voiceOf(setting)] = value === 1;
  }
  return muted;
}

/** `mutes` (one 0 or 1 a voice) as one boolean a voice. */
export function mutesAsBooleans(mutes: Int32Array): boolean[] {
  const muted = new Array<boolean>(VOICE_COUNT);
  for (let voice = 0; voice < VOICE_COUNT; voice++) muted[voice] = mutes[voice] === 1;
  return muted;
}
