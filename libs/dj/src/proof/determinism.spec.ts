import { SID_FIELD_WIDTHS } from '@sidablist/core';
import { describe, expect, it } from 'vitest';
import type { DeckCommand, JumpTarget, NumberedSetting } from '../messages/commands.js';
import {
  SETTING_NUMBERS,
  describeSetting,
  type SettingInfo,
  type SettingKind,
} from '../messages/setting-table.js';
import { firstFrameDifference } from '../testing/compare.js';
import { Rig } from '../testing/harness.js';

/**
 * A scripted, seeded stream of commands across every playing state, kept as it landed (each
 * `landed` event's command and `fixed`) and sent again to a fresh deck ahead of its frames: the
 * deck's output must be what the first run's was, frame for frame.
 */

const DECK = 'a';
const GRID = { beatFrames: 20, beatOneFrame: 0 };
/** A loop with settings of its own, so the main ones are held aside while it plays. */
const OWN: JumpTarget = {
  startFrame: 100,
  endFrame: 140,
  wraps: true,
  settings: [{ setting: 2, value: 1 }],
};
const SHARED: JumpTarget = { startFrame: 200, endFrame: 230 };
const WAITED: JumpTarget = { startFrame: 350, endFrame: 380 };
const SLIPPED: JumpTarget = { startFrame: 250, endFrame: 267.4 };
const UNDER: JumpTarget = { startFrame: 160, endFrame: 200, wraps: true };

function random(seed: number): () => number {
  let state = seed * 2654435761 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
}

/** The next frame the deck's sink has not passed, read from its updates and its picture. */
function nextUnsent(rig: Rig): number {
  const updates = rig.ofKind('update');
  return updates[updates.length - 1].streamFrame + 1 - (rig.picture().output?.heldFrames ?? 0);
}

interface Step {
  readonly atMs: number;
  readonly command: (rig: Rig) => DeckCommand;
}

/**
 * A `settings` list for the list in play or for the other one, by the picture when it is pressed.
 * Which one plays on its landing frame is the deck's to say: a list for the other is dropped.
 */
function settingsList(
  rig: Rig,
  which: 'in play' | 'other',
  changes: readonly NumberedSetting[],
  when: { when?: { at: 'frame'; frame: number } },
): DeckCommand {
  const playing = rig.picture().settingsInPlay;
  const settingsIn = (which === 'in play') === (playing === 'main') ? 'main' : 'loop';
  return { kind: 'settings', deck: DECK, settingsIn, changes, ...when };
}

/** How a press is made: given the rig at the moment it is sent, and the `when` the script drew for it. */
type Make = (rig: Rig, when: { when?: { at: 'frame'; frame: number } }) => DeckCommand;

/** Draws a press's jitter, and whether and how far ahead of the frontier it names its frame. */
function pressesOf(next: () => number): (base: number, make: Make) => Step {
  return (base, make) => {
    const when = next();
    const frames = Math.floor(next() * 4);
    const jitter = Math.floor(next() * 40);
    return {
      atMs: base + jitter,
      command: (rig) =>
        make(rig, when < 0.3 ? { when: { at: 'frame', frame: nextUnsent(rig) + frames } } : {}),
    };
  };
}

const SETTINGS_BY_KIND = new Map<SettingKind, SettingInfo[]>();
for (const number of SETTING_NUMBERS) {
  const info = describeSetting(number);
  if (info === null) continue;
  SETTINGS_BY_KIND.set(info.kind, [...(SETTINGS_BY_KIND.get(info.kind) ?? []), info]);
}
/** The holds on a one-bit field: the switches a lock flips. */
const SWITCHES = (SETTINGS_BY_KIND.get('hold') ?? []).filter(
  (info) => info.field !== null && SID_FIELD_WIDTHS[info.field.name] === 1,
);

/** One setting of `kind`, drawn, with a value drawn from its range: a whole number unless the setting is not. */
function drawnSetting(next: () => number, kind: SettingKind): { setting: number; value: number } {
  const pool = SETTINGS_BY_KIND.get(kind) ?? [];
  const info = pool[Math.floor(next() * pool.length)];
  const span = info.max - info.min;
  const draw = next() * span;
  return { setting: info.setting, value: info.min + (info.whole ? Math.round(draw) : draw) };
}

/** The commands of one run: every state in turn, each press jittered, a few sent for a frame ahead. */
function script(seed: number): Step[] {
  const at = pressesOf(random(seed));
  // The new commands draw from a stream of their own, so the older presses' jitter stays as it was.
  const drawn = random(seed + 4096);
  const shaped = pressesOf(drawn);
  const switchSetting = SWITCHES[Math.floor(drawn() * SWITCHES.length)].setting;
  const hand = (rig: Rig): number => rig.time.ms;
  return [
    // a loop with its own settings: the main ones are held aside
    at(100, (_, when) => ({ kind: 'hot-cue', deck: DECK, target: OWN, ...when })),
    // a queue, an edit beside it, and the queue landing at the end of a pass
    at(400, (_, when) => ({ kind: 'hot-cue', deck: DECK, target: SHARED, ...when })),
    at(450, (_, when) => ({
      kind: 'loop-bounds',
      deck: DECK,
      startFrame: 100,
      endFrame: 130,
      ...when,
    })),
    at(520, (_, when) => ({ kind: 'loop-wraps', deck: DECK, wraps: false, ...when })),
    // an edit queued for the end of a pass, and a jump taken at the end of one
    at(1000, (_, when) => ({
      kind: 'loop-bounds',
      deck: DECK,
      startFrame: 200,
      endFrame: 225,
      ...when,
    })),
    at(1050, () => ({
      kind: 'jump',
      deck: DECK,
      target: UNDER,
      when: { at: 'pass-end' },
    })),
    // a wait: the target is declared, then pressed before its image is ready
    at(1500, (_, when) => ({
      kind: 'targets',
      deck: DECK,
      frames: [100, 160, 200, 250, 350],
      ...when,
    })),
    at(1505, (_, when) => ({ kind: 'hot-cue', deck: DECK, target: WAITED, ...when })),
    // slip, with a loop, the hand and a throw
    at(1700, (_, when) => ({ kind: 'slip', deck: DECK, on: true, ...when })),
    at(1720, (_, when) => ({ kind: 'hot-cue', deck: DECK, target: SLIPPED, ...when })),
    at(1800, (rig) => ({ kind: 'hand-touch', deck: DECK, atMs: hand(rig) })),
    at(1840, (rig) => ({ kind: 'hand-move', deck: DECK, travelFrames: -6, atMs: hand(rig) })),
    at(1900, (rig) => ({ kind: 'hand-move', deck: DECK, travelFrames: -2, atMs: hand(rig) })),
    at(1940, (rig) => ({ kind: 'hand-lift', deck: DECK, atMs: hand(rig), gripSeconds: 0.4 })),
    at(2200, (_, when) => ({ kind: 'stop-loop', deck: DECK, ...when })),
    // the live looper over a loop, resized, ended
    at(2300, (_, when) => ({ kind: 'hot-cue', deck: DECK, target: UNDER, ...when })),
    at(2500, (_, when) => ({ kind: 'live-loop', deck: DECK, ...when })),
    at(2640, (_, when) => ({ kind: 'live-loop-size', deck: DECK, lengthFrames: 20, ...when })),
    at(2760, (_, when) => ({ kind: 'live-loop-size', deck: DECK, lengthFrames: 60, ...when })),
    at(2900, (_, when) => ({ kind: 'live-loop-end', deck: DECK, ...when })),
    // tempo, a seek to a prepared frame, and a pause
    at(3000, (_, when) => ({ kind: 'speed', deck: DECK, value: 1.2, ...when })),
    at(3100, (_, when) => ({ kind: 'seek', deck: DECK, frame: 100, ...when })),
    at(3300, (_, when) => ({ kind: 'pause', deck: DECK, ...when })),
    // the numbered settings: one of every kind, on the settings in play
    ...(
      [
        [150, 'mute'],
        [200, 'offset'],
        [250, 'hold'],
        [1150, 'key'],
        [1200, 'coarse'],
        [1250, 'fine'],
      ] as const
    ).map(([base, kind]) => {
      const change = drawnSetting(drawn, kind);
      return shaped(base, (_, when) => ({ kind: 'setting', deck: DECK, ...change, ...when }));
    }),
    // a list for the settings in play lands, and one for the other is dropped
    ...(
      [
        [300, 'in play'],
        [330, 'other'],
        [1600, 'in play'],
        [1630, 'other'],
      ] as const
    ).map(([base, which]) => {
      const changes = (['offset', 'hold', 'mute'] as const).map((kind) =>
        drawnSetting(drawn, kind),
      );
      return shaped(base, (rig, when) => settingsList(rig, which, changes, when));
    }),
    // a voice held and let go
    shaped(1300, (_, when) => ({ kind: 'voice-hold', deck: DECK, voice: 1, held: true, ...when })),
    shaped(1360, (_, when) => ({ kind: 'voice-hold', deck: DECK, voice: 1, held: false, ...when })),
    shaped(2330, (_, when) => ({ kind: 'voice-hold', deck: DECK, voice: 0, held: true, ...when })),
    shaped(2400, (_, when) => ({ kind: 'voice-hold', deck: DECK, voice: 0, held: false, ...when })),
    // a lock pressed, set on, handed back
    ...(
      [
        [1400, undefined],
        [1440, true],
        [1480, false],
      ] as const
    ).map(([base, lockTo]) =>
      shaped(base, (_, when) => ({
        kind: 'flip-lock',
        deck: DECK,
        setting: switchSetting,
        ...(lockTo === undefined ? {} : { lock: lockTo }),
        ...when,
      })),
    ),
    // A run of taps on a playing record, closed by tap-end. It sits in a stretch with no resume and no
    // catch-up skip: a mark is the position of the latest frame due at the tap's time, so it replays
    // exactly only where due times do.
    ...[2000, 2050, 2100, 2150, 2200, 2250].map((base) =>
      shaped(base, (rig, when) => ({ kind: 'tap', deck: DECK, atMs: rig.time.ms, ...when })),
    ),
    shaped(2290, (_, when) => ({ kind: 'tap-end', deck: DECK, ...when })),
  ];
}

const RUN_MS = 3800;

/** Adds, loads and starts a rig's deck, paused first so the targets are declared before frames run. */
async function start(rig: Rig, tune: string): Promise<void> {
  rig.addDeck(DECK, { lookaheadMs: 60 });
  await rig.load(DECK, tune, { ends: 'paused', grid: GRID });
  rig.send({ kind: 'targets', deck: DECK, frames: [100, 160, 200, 250] });
  rig.send({ kind: 'live-loop-size', deck: DECK, lengthFrames: 40 });
  await rig.settle();
  rig.send({ kind: 'play', deck: DECK });
  await rig.settle();
}

/** Moves the rig through `RUN_MS`, ticking every 5 ms and calling `press` at each step's moment. */
async function run(
  rig: Rig,
  moments: readonly number[],
  press: (index: number) => void,
): Promise<void> {
  let at = 0;
  const order = moments.map((atMs, index) => ({ atMs, index })).sort((a, b) => a.atMs - b.atMs);
  for (let i = 0; i < order.length;) {
    const atMs = order[i].atMs;
    rig.advance(atMs - at);
    at = atMs;
    for (; i < order.length && order[i].atMs === atMs; i++) press(order[i].index);
    await rig.microtasks();
  }
  rig.advance(RUN_MS - at);
}

/** Still Time has no note starts a tap could fit a grid to; Insid3-out has them. */
const TUNES = ['still-time', 'insid3-out'] as const;

describe.each(TUNES)('a deck replayed from the commands that landed, on %s', (tune) => {
  for (let seed = 1; seed <= 10; seed++) {
    it(`gives the same frames, registers and due times (seed ${seed})`, async () => {
      const steps = script(seed);
      const moments = steps.map((step) => step.atMs);

      const first = new Rig();
      await start(first, tune);
      const sent: DeckCommand[] = [];
      const arrival: number[] = [];
      await run(first, moments, (index) => {
        sent[index] = { ...steps[index].command(first), pressedAtMs: first.time.ms };
        arrival.push(index);
        first.send(sent[index]);
      });

      const kept = arrival.flatMap((index) => {
        const landed = first.landed().find((event) => event.command === sent[index]);
        return landed === undefined ? [] : [{ command: landed.command, fixed: landed.fixed }];
      });
      const landedKinds = new Set(kept.map((item) => item.command.kind));
      for (const kind of [
        'hot-cue',
        'loop-bounds',
        'jump',
        'hand-touch',
        'hand-lift',
        'slip',
        'stop-loop',
        'live-loop',
        'live-loop-size',
        'live-loop-end',
        'speed',
        'seek',
        'pause',
        'setting',
        'settings',
        'voice-hold',
        'flip-lock',
        'tap',
        'tap-end',
      ] as const) {
        expect(landedKinds, `${kind} landed`).toContain(kind);
      }

      const second = new Rig();
      await start(second, tune);
      for (const item of kept) second.send({ ...item.command, when: item.fixed });
      await run(second, moments, () => undefined);

      expect(first.frames().length).toBeGreaterThan(100);
      // The registers, values and frame numbers of every frame the sinks passed.
      expect(
        firstFrameDifference(
          first.sinks.get(DECK)?.wire ?? [],
          second.sinks.get(DECK)?.wire ?? [],
          {
            dueTimes: false,
          },
        ),
      ).toBeNull();
      // The run has no resume and no catch-up skip, so the due times are equal as well.
      expect(
        firstFrameDifference(first.sinks.get(DECK)?.wire ?? [], second.sinks.get(DECK)?.wire ?? []),
      ).toBeNull();
      // A jump that waited for its image lands on the same frame.
      const landings = (rig: Rig): string[] =>
        rig
          .ofKind('jump-landed')
          .map((event) => `${event.frame} ${event.via} ${event.startFrame} ${event.endFrame}`);
      expect(landings(second)).toEqual(landings(first));
      // A list sent for the settings that were not in play was dropped, and one for those in play was not.
      const lists = first.landed('settings');
      expect(lists.some((event) => event.dropped === true)).toBe(true);
      expect(lists.some((event) => event.dropped !== true)).toBe(true);
      // The taps' grid, frame for frame, and the settings the two decks end holding.
      const fits = (rig: Rig): string[] =>
        rig
          .ofKind('grid-fitted')
          .map((event) => `${event.frame} ${event.taps} ${JSON.stringify(event.grid)}`);
      if (tune === 'insid3-out')
        expect(fits(first).length, 'the taps fitted a grid').toBeGreaterThan(0);
      expect(fits(second)).toEqual(fits(first));
      expect(second.picture().settings).toEqual(first.picture().settings);
      expect(second.picture().grid).toEqual(first.picture().grid);
      expect(first.warnings.filter((line) => !line.includes('refused'))).toEqual([]);
      expect(second.warnings.filter((line) => !line.includes('refused'))).toEqual([]);
      first.dispose();
      second.dispose();
    });
  }
});
