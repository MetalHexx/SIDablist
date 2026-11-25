import { readSidField } from '@sidablist/core';
import type { SidField } from '@sidablist/core';
import { describe, expect, it } from 'vitest';
import type { DeckCommand, JumpTarget } from '../messages/commands.js';
import { HOLD_RELEASED, SETTING } from '../messages/setting-table.js';
import { Rig } from '../testing/harness.js';
import { COPY_TABLE, STEADY, psid } from '../testing/steady-tune.js';
import { DeckState } from './deck-state.js';

/** Writes the frame count's low bit to voice 1's control register every frame: INC $FB; LDA $FB; AND #1; STA $D404; RTS. */
const TOGGLE_GATE = [0xe6, 0xfb, 0xa5, 0xfb, 0x29, 0x01, 0x8d, 0x04, 0xd4, 0x60];

const CONTROL = [4, 11, 18];
const CUTOFF: SidField = { name: 'cutoff' };
const VOLUME: SidField = { name: 'volume' };
const waveform = (voice: number): SidField => ({ name: 'waveform', voice });
const frequency = (voice: number): SidField => ({ name: 'frequency', voice });

/** A deck playing the steady tune. */
async function steady(load: Partial<Extract<DeckCommand, { kind: 'load' }>> = {}): Promise<Rig> {
  const rig = new Rig();
  rig.addTune('steady', psid(COPY_TABLE, STEADY));
  rig.addDeck('a');
  await rig.load('a', 'steady', { ends: 'playing', ...load });
  rig.advance(200);
  return rig;
}

/** Sends a command, lets its flush run and the deck render on past it. */
async function press(rig: Rig, command: Parameters<Rig['send']>[0]): Promise<void> {
  rig.send(command);
  await rig.microtasks();
  rig.advance(100);
}

const set = (setting: number, value: number): DeckCommand => ({
  kind: 'setting',
  deck: 'a',
  setting,
  value,
});

/** The chip's registers as the tune wrote them and as they are sent, at the frontier. */
function registers(rig: Rig): { written: Uint8Array; sent: Uint8Array; streamFrame: number } {
  rig.send({ kind: 'registers', deck: 'a' });
  const answers = rig.ofKind('registers');
  return answers[answers.length - 1];
}

const settingsOf = (rig: Rig, list: 'main' | 'loop' = 'main'): number[] =>
  (rig.picture().settings[list] ?? []).map((entry) => entry.setting);

describe('the settings a deck shapes the tune with', () => {
  it('adds an offset to a field, and hands the field back at 0', async () => {
    const rig = await steady();
    await press(rig, set(SETTING.CUTOFF_OFFSET, 100));
    let now = registers(rig);
    expect(readSidField(now.sent, CUTOFF)).toBe(readSidField(now.written, CUTOFF) + 100);

    await press(rig, set(SETTING.CUTOFF_OFFSET, 0));
    now = registers(rig);
    expect(readSidField(now.sent, CUTOFF)).toBe(readSidField(now.written, CUTOFF));
    expect(rig.landed('setting').map((event) => event.settingsIn)).toEqual(['main', 'main']);
    rig.dispose();
  });

  it('holds a field at full strength against what the tune writes, until it is released', async () => {
    const rig = await steady();
    const written = readSidField(registers(rig).written, waveform(0));
    const held = written === 8 ? 2 : 8;

    await press(rig, set(SETTING.VOICE_1_WAVEFORM_HOLD, held));
    let now = registers(rig);
    expect(readSidField(now.written, waveform(0))).toBe(written);
    expect(readSidField(now.sent, waveform(0))).toBe(held);

    await press(rig, set(SETTING.CUTOFF_HOLD, 1000));
    expect(readSidField(registers(rig).sent, CUTOFF)).toBe(1000);

    await press(rig, set(SETTING.VOICE_1_WAVEFORM_HOLD, HOLD_RELEASED));
    now = registers(rig);
    expect(readSidField(now.sent, waveform(0))).toBe(written);
    expect(readSidField(now.sent, CUTOFF)).toBe(1000);
    rig.dispose();
  });

  it('combines Key and a voice’s own tuning into one pitch for it, exactly home at 0', async () => {
    const rig = await steady();
    const home = registers(rig).sent;
    const pitches = (): number[] => {
      const sent = registers(rig).sent;
      return [0, 1, 2].map((voice) => readSidField(sent, frequency(voice)));
    };
    const homePitches = [0, 1, 2].map((voice) => readSidField(home, frequency(voice)));

    await press(rig, set(SETTING.KEY, 12));
    expect(pitches()).toEqual(homePitches.map((pitch) => pitch * 2));

    await press(rig, set(SETTING.VOICE_1_COARSE, -12));
    expect(pitches()).toEqual([homePitches[0], homePitches[1] * 2, homePitches[2] * 2]);

    await press(rig, set(SETTING.KEY, 0));
    await press(rig, set(SETTING.VOICE_1_COARSE, 0));
    expect(pitches()).toEqual(homePitches);

    await press(rig, set(SETTING.VOICE_3_FINE, 100));
    const [, , third] = pitches();
    expect(Math.abs(third - homePitches[2] * 2 ** (1 / 12))).toBeLessThanOrEqual(1);
    rig.dispose();
  });

  it('mutes a voice and sounds it again', async () => {
    const rig = await steady();
    await press(rig, set(SETTING.VOICE_2_MUTE, 1));
    let now = registers(rig);
    expect(now.sent[CONTROL[1]]).toBe(0);
    expect(now.sent[CONTROL[0]]).toBe(0x41);

    await press(rig, set(SETTING.VOICE_2_MUTE, 0));
    now = registers(rig);
    expect(now.sent[CONTROL[1]]).toBe(now.written[CONTROL[1]]);
    expect(now.sent[CONTROL[1]]).toBe(0x41);
    rig.dispose();
  });

  it('inverts a voice’s mute while its hold is down: Punch on a muted voice, Kill on a sounding one', async () => {
    const rig = await steady();
    await press(rig, set(SETTING.VOICE_2_MUTE, 1));
    expect(registers(rig).sent[CONTROL[1]]).toBe(0);

    await press(rig, { kind: 'voice-hold', deck: 'a', voice: 1, held: true });
    expect(registers(rig).sent[CONTROL[1]]).toBe(0x41);
    await press(rig, { kind: 'voice-hold', deck: 'a', voice: 0, held: true });
    expect(registers(rig).sent[CONTROL[0]]).toBe(0);
    expect(settingsOf(rig)).toEqual([SETTING.VOICE_2_MUTE]);

    await press(rig, { kind: 'voice-hold', deck: 'a', voice: 1, held: false });
    await press(rig, { kind: 'voice-hold', deck: 'a', voice: 0, held: false });
    const now = registers(rig);
    expect(now.sent[CONTROL[1]]).toBe(0);
    expect(now.sent[CONTROL[0]]).toBe(0x41);
    rig.dispose();
  });

  it('lands a settings list together on one frame', async () => {
    const rig = await steady();
    const before = rig.frames().length;
    await press(rig, {
      kind: 'settings',
      deck: 'a',
      settingsIn: 'main',
      changes: [
        { setting: SETTING.CUTOFF_OFFSET, value: 100 },
        { setting: SETTING.VOLUME_HOLD, value: 5 },
        { setting: SETTING.VOICE_2_MUTE, value: 1 },
      ],
    });

    const landed = rig.landed('settings');
    expect(landed).toHaveLength(1);
    expect(landed[0].settingsIn).toBe('main');
    expect(landed[0].dropped).toBeUndefined();
    // The tune writes every register each frame, so what moves on the landing frame is the value.
    const wrote = (frame: number, register: number): number | undefined => {
      const delivered = rig.frames()[frame];
      return delivered.values[delivered.registers.lastIndexOf(register)];
    };
    const at = landed[0].frame;
    expect(at).toBeGreaterThan(before - 1);
    for (const register of [22, 24, CONTROL[1]]) {
      expect(wrote(at - 1, register)).toBe(STEADY[register]);
      expect(wrote(at, register)).not.toBe(STEADY[register]);
    }
    expect(readSidField(registers(rig).sent, VOLUME)).toBe(5);
    expect(settingsOf(rig)).toEqual([
      SETTING.VOICE_2_MUTE,
      SETTING.CUTOFF_OFFSET,
      SETTING.VOLUME_HOLD,
    ]);
    rig.dispose();
  });
});

describe('a lock on a one-bit switch', () => {
  const TEST_HOLD = SETTING.VOICE_2_TEST_HOLD;
  const testBit: SidField = { name: 'test', voice: 1 };
  const flip = (lock?: boolean): DeckCommand => ({
    kind: 'flip-lock',
    deck: 'a',
    setting: TEST_HOLD,
    ...(lock === undefined ? {} : { lock }),
  });

  it('locks a released switch to the opposite of the tune and hands a held one back', async () => {
    const rig = await steady();
    const tune = readSidField(registers(rig).written, testBit);

    await press(rig, flip());
    let now = registers(rig);
    expect(readSidField(now.sent, testBit)).toBe(1 - tune);
    expect(readSidField(now.written, testBit)).toBe(tune);
    expect(rig.picture().settings.main).toEqual([{ setting: TEST_HOLD, value: 1 - tune }]);

    await press(rig, flip());
    now = registers(rig);
    expect(readSidField(now.sent, testBit)).toBe(tune);
    expect(settingsOf(rig)).toEqual([]);
    expect(rig.landed('flip-lock').map((event) => event.settingsIn)).toEqual(['main', 'main']);
    rig.dispose();
  });

  it('keeps a held switch on lock true and hands any switch back on lock false', async () => {
    const rig = await steady();
    const tune = readSidField(registers(rig).written, testBit);

    // Held at the tune's own value: a lock would put it at the opposite, so a switch that stays proves it was held.
    await press(rig, set(TEST_HOLD, tune));
    await press(rig, flip(true));
    expect(rig.picture().settings.main).toEqual([{ setting: TEST_HOLD, value: tune }]);

    await press(rig, flip(false));
    expect(settingsOf(rig)).toEqual([]);
    expect(readSidField(registers(rig).sent, testBit)).toBe(tune);

    await press(rig, flip(true));
    expect(rig.picture().settings.main).toEqual([{ setting: TEST_HOLD, value: 1 - tune }]);
    rig.dispose();
  });

  it('locks to what the tune wrote in the frame before its landing', async () => {
    const rig = new Rig();
    rig.addTune('toggle', psid(TOGGLE_GATE));
    rig.addDeck('a');
    await rig.load('a', 'toggle', { ends: 'playing' });
    rig.advance(200);

    await press(rig, { kind: 'flip-lock', deck: 'a', setting: SETTING.VOICE_1_GATE_HOLD });
    const landing = rig.landed('flip-lock')[0].frame;
    const before = rig.frames()[landing - 1];
    const wroteBefore = before.values[before.registers.indexOf(4)] & 1;
    // The tune's own gate alternates every frame, so a lock to anything but the frame before it is the one the tune writes next.
    const now = registers(rig);
    expect(now.sent[4] & 1).toBe(1 - wroteBefore);
    expect(rig.picture().settings.main).toEqual([
      { setting: SETTING.VOICE_1_GATE_HOLD, value: 1 - wroteBefore },
    ]);
    rig.dispose();
  });
});

describe('a settings list for the settings that are not in play', () => {
  const OWN: JumpTarget = {
    startFrame: 100,
    endFrame: 130,
    settings: [{ setting: SETTING.VOICE_2_MUTE, value: 1 }],
  };

  async function inLoop(): Promise<Rig> {
    const rig = await steady();
    rig.send({ kind: 'targets', deck: 'a', frames: [100] });
    await rig.settle();
    rig.advance(100);
    await press(rig, { kind: 'hot-cue', deck: 'a', target: OWN });
    expect(rig.picture().settingsInPlay).toBe('loop');
    return rig;
  }

  const unsent = (rig: Rig): number => {
    const updates = rig.ofKind('update');
    return updates[updates.length - 1].streamFrame + 1 - (rig.sinks.get('a')?.holding ?? 0);
  };

  it('drops the main list’s while a loop’s own plays, and changes nothing', async () => {
    const rig = await inLoop();
    const before = registers(rig).sent;
    await press(rig, {
      kind: 'settings',
      deck: 'a',
      settingsIn: 'main',
      changes: [{ setting: SETTING.CUTOFF_OFFSET, value: 100 }],
    });

    const [dropped] = rig.landed('settings');
    expect(dropped.dropped).toBe(true);
    expect(dropped.settingsIn).toBeUndefined();
    expect(settingsOf(rig)).toEqual([]);
    expect(settingsOf(rig, 'loop')).toEqual([SETTING.VOICE_2_MUTE]);
    expect(registers(rig).sent[21]).toBe(before[21]);
    expect(registers(rig).sent[22]).toBe(before[22]);
    rig.dispose();
  });

  it('lands the loop’s own list in play, and drops it once the loop has let go on an earlier frame', async () => {
    const rig = await inLoop();
    await press(rig, {
      kind: 'settings',
      deck: 'a',
      settingsIn: 'loop',
      changes: [{ setting: SETTING.VOLUME_HOLD, value: 4 }],
    });
    expect(rig.landed('settings')[0]).toMatchObject({ settingsIn: 'loop' });
    expect(settingsOf(rig, 'loop')).toEqual([SETTING.VOICE_2_MUTE, SETTING.VOLUME_HOLD]);

    // Sent a frame behind the let-go, as a host's would be.
    const at = unsent(rig) + 2;
    rig.send({ kind: 'let-go', deck: 'a', when: { at: 'frame', frame: at } });
    rig.send({
      kind: 'settings',
      deck: 'a',
      settingsIn: 'loop',
      changes: [{ setting: SETTING.CUTOFF_OFFSET, value: 100 }],
      when: { at: 'frame', frame: at + 1 },
    });
    await rig.microtasks();
    rig.advance(100);

    const [, late] = rig.landed('settings');
    expect(late).toMatchObject({ dropped: true, frame: at + 1 });
    expect(late.settingsIn).toBeUndefined();
    expect(rig.picture()).toMatchObject({
      settingsInPlay: 'main',
      settings: { main: [], loop: null },
    });
    const now = registers(rig);
    expect(readSidField(now.sent, CUTOFF)).toBe(readSidField(now.written, CUTOFF));
    expect(readSidField(now.sent, VOLUME)).toBe(readSidField(now.written, VOLUME));
    rig.dispose();
  });

  it('reports the list a setting, a settings and a lock went to', async () => {
    const rig = await inLoop();
    await press(rig, set(SETTING.CUTOFF_OFFSET, 10));
    await press(rig, { kind: 'flip-lock', deck: 'a', setting: SETTING.VOICE_1_TEST_HOLD });
    expect(rig.landed('setting')[0].settingsIn).toBe('loop');
    expect(rig.landed('flip-lock')[0].settingsIn).toBe('loop');
    expect(settingsOf(rig)).toEqual([]);
    rig.dispose();
  });
});

describe('a loop with a full list of its own', () => {
  const OWN: JumpTarget = {
    startFrame: 100,
    endFrame: 130,
    settings: [
      { setting: SETTING.VOICE_2_MUTE, value: 1 },
      { setting: SETTING.CUTOFF_HOLD, value: 300 },
      { setting: SETTING.VOICE_3_COARSE, value: 12 },
    ],
  };
  const SHARED: JumpTarget = { startFrame: 100, endFrame: 130 };

  async function playing(): Promise<Rig> {
    const rig = await steady();
    rig.send({ kind: 'targets', deck: 'a', frames: [100] });
    await rig.settle();
    rig.advance(100);
    return rig;
  }

  const pitches = (rig: Rig): number[] =>
    [0, 1, 2].map((voice) => readSidField(registers(rig).sent, frequency(voice)));

  it('replaces every field of the main list on its frame, and gives each back on its let-go', async () => {
    const rig = await playing();
    const home = pitches(rig);
    await press(rig, set(SETTING.KEY, 12));
    await press(rig, set(SETTING.CUTOFF_OFFSET, 100));
    await press(rig, set(SETTING.VOLUME_HOLD, 7));
    const main = registers(rig);
    expect(pitches(rig)).toEqual(home.map((pitch) => pitch * 2));
    expect(readSidField(main.sent, VOLUME)).toBe(7);

    await press(rig, { kind: 'hot-cue', deck: 'a', target: OWN });
    let now = registers(rig);
    // Key, the offset and the volume hold are not in the loop's list, so they are home inside it.
    expect(pitches(rig)).toEqual([home[0], home[1], home[2] * 2]);
    expect(now.sent[CONTROL[1]]).toBe(0);
    expect(readSidField(now.sent, CUTOFF)).toBe(300);
    expect(readSidField(now.sent, VOLUME)).toBe(readSidField(now.written, VOLUME));
    expect(rig.picture().settings.main.map((entry) => entry.setting)).toEqual([
      SETTING.CUTOFF_OFFSET,
      SETTING.VOLUME_HOLD,
      SETTING.KEY,
    ]);
    expect(settingsOf(rig, 'loop')).toEqual([
      SETTING.VOICE_2_MUTE,
      SETTING.VOICE_3_COARSE,
      SETTING.CUTOFF_HOLD,
    ]);

    await press(rig, { kind: 'let-go', deck: 'a' });
    now = registers(rig);
    expect(pitches(rig)).toEqual(home.map((pitch) => pitch * 2));
    expect(now.sent[CONTROL[1]]).toBe(now.written[CONTROL[1]]);
    expect(readSidField(now.sent, CUTOFF)).toBe(readSidField(now.written, CUTOFF) + 100);
    expect(readSidField(now.sent, VOLUME)).toBe(7);
    expect(rig.picture().settingsInPlay).toBe('main');
    rig.dispose();
  });

  it('carries the complete main list into a jump that has none of its own', async () => {
    const rig = await playing();
    await press(rig, set(SETTING.KEY, 12));
    await press(rig, set(SETTING.CUTOFF_OFFSET, 100));
    const home = pitches(rig).map((pitch) => pitch / 2);
    await press(rig, { kind: 'hot-cue', deck: 'a', target: OWN });
    await press(rig, set(SETTING.VOLUME_HOLD, 2));

    await press(rig, { kind: 'jump', deck: 'a', target: SHARED });
    const now = registers(rig);
    expect(rig.picture().settingsInPlay).toBe('main');
    expect(pitches(rig)).toEqual(home.map((pitch) => pitch * 2));
    expect(now.sent[CONTROL[1]]).toBe(now.written[CONTROL[1]]);
    expect(readSidField(now.sent, CUTOFF)).toBe(readSidField(now.written, CUTOFF) + 100);
    expect(readSidField(now.sent, VOLUME)).toBe(readSidField(now.written, VOLUME));
    rig.dispose();
  });
});

describe('the gate and the load', () => {
  it('refuses a voice hold press on a deck with no tune, and takes a release and a settings', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    rig.send({ kind: 'voice-hold', deck: 'a', voice: 0, held: true });
    rig.send({ kind: 'flip-lock', deck: 'a', setting: SETTING.VOICE_1_GATE_HOLD });
    rig.send(set(SETTING.KEY, 1));
    expect(rig.warnings).toEqual([
      'dj: refused voice-hold: voice-hold on a deck that is empty',
      'dj: refused flip-lock: flip-lock on a deck that is empty',
      'dj: refused setting: setting on a deck that is empty',
    ]);

    rig.send({ kind: 'voice-hold', deck: 'a', voice: 0, held: false });
    rig.send({
      kind: 'settings',
      deck: 'a',
      settingsIn: 'main',
      changes: [{ setting: SETTING.KEY, value: 3 }],
    });
    await rig.microtasks();
    expect(rig.warnings).toHaveLength(3);
    expect(rig.landed('settings')[0]).toMatchObject({ settingsIn: 'main' });
    expect(rig.picture().settings.main).toEqual([{ setting: SETTING.KEY, value: 3 }]);
    rig.dispose();
  });

  it('goes home at its landing, before its first wait, and ends there if it fails', async () => {
    const rig = new Rig();
    rig.addTune('steady', psid(COPY_TABLE, STEADY));
    rig.addDeck('a');
    // A settings sent to a deck with no tune lands on the main list, which a load replaces.
    rig.send({
      kind: 'settings',
      deck: 'a',
      settingsIn: 'main',
      changes: [{ setting: SETTING.VOLUME_HOLD, value: 3 }],
    });
    await rig.microtasks();
    expect(settingsOf(rig)).toEqual([SETTING.VOLUME_HOLD]);

    const slow = rig.holdFetch('steady');
    rig.send({ kind: 'load', deck: 'a', tune: 'steady', subtune: 1 });
    await rig.microtasks();
    expect(settingsOf(rig)).toEqual([]);
    slow.fail(new Error('gone'));
    await rig.settle();
    expect(rig.picture().transport).toBe('failed');
    expect(settingsOf(rig)).toEqual([]);
    rig.dispose();
  });

  it('writes the whole list its load carries, so nothing of the last tune’s settings is left in the engine', async () => {
    const rig = await steady({
      settings: [
        { setting: SETTING.VOLUME_HOLD, value: 2 },
        { setting: SETTING.KEY, value: 12 },
      ],
    });
    await press(rig, { kind: 'voice-hold', deck: 'a', voice: 0, held: true });
    expect(readSidField(registers(rig).sent, VOLUME)).toBe(2);
    expect(registers(rig).sent[CONTROL[0]]).toBe(0);

    rig.addTune('steady-b', psid(COPY_TABLE, STEADY));
    await rig.load('a', 'steady-b', {
      ends: 'playing',
      settings: [{ setting: SETTING.CUTOFF_OFFSET, value: 50 }],
    });
    rig.advance(200);

    const now = registers(rig);
    expect(readSidField(now.sent, CUTOFF)).toBe(readSidField(now.written, CUTOFF) + 50);
    expect(readSidField(now.sent, VOLUME)).toBe(readSidField(now.written, VOLUME));
    expect(readSidField(now.sent, frequency(0))).toBe(readSidField(now.written, frequency(0)));
    expect(now.sent[CONTROL[0]]).toBe(0x41);
    expect(rig.picture().settings.main).toEqual([{ setting: SETTING.CUTOFF_OFFSET, value: 50 }]);
    rig.dispose();
  });
});

describe('the saved state', () => {
  it('holds both settings lists, each at home when made, and puts back what a save took', () => {
    const state = new DeckState();
    expect(state.mainSettings[SETTING.CUTOFF_HOLD]).toBe(HOLD_RELEASED);
    expect(state.loopSettings[SETTING.VOICE_1_MUTE]).toBe(0);

    state.mainSettings[SETTING.KEY] = 5;
    state.loopSettings[SETTING.CUTOFF_HOLD] = 700;
    const image = state.createState();
    state.saveInto(image);
    state.mainSettings[SETTING.KEY] = 0;
    state.loopSettings[SETTING.CUTOFF_HOLD] = HOLD_RELEASED;
    state.restoreFrom(image);

    expect(state.mainSettings[SETTING.KEY]).toBe(5);
    expect(state.loopSettings[SETTING.CUTOFF_HOLD]).toBe(700);
  });
});
