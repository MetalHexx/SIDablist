import { describe, expect, it } from 'vitest';
import type { DeckCommand, DeckId, JumpTarget, When } from '../messages/commands.js';
import { HOLD_RELEASED, SETTING } from '../messages/setting-table.js';
import { compareRewound, type Press } from '../testing/compare.js';
import type { Rig } from '../testing/harness.js';

/**
 * The harness later tasks extend: two decks on one tune, one straight and one taking commands at
 * held frames through rewinds, compared delivery by delivery. A rewound deck whose output differs
 * from the straight one has lost or kept something it should not have.
 */

const press = (atMs: number, command: (deck: DeckId, rig: Rig) => DeckCommand): Press => ({
  atMs,
  command,
});

/** The next frame the deck's sink has not passed, read the way a host could: from its updates and its picture. */
function nextUnsent(rig: Rig): number {
  const updates = rig.ofKind('update');
  const frontier = updates[updates.length - 1].streamFrame + 1;
  return frontier - (rig.picture().output?.heldFrames ?? 0);
}

describe('a deck rewound against a deck that ran straight', () => {
  it('pauses on the next frame not yet sent and drops the frames held after it', async () => {
    let unsent = -1;
    const { rewound, straight, landings, difference } = await compareRewound({
      presses: [
        press(300, (deck, rig) => {
          unsent = nextUnsent(rig);
          return { kind: 'pause', deck };
        }),
      ],
      runMs: 600,
    });

    expect(difference).toBeNull();
    expect(landings[0]).toBe(unsent);
    expect(rewound.picture().timing.rewinds).toBeGreaterThan(0);
    expect(straight.picture().timing.rewinds).toBe(0);
    const delivered = rewound.frames();
    expect(delivered[delivered.length - 1].frameNumber).toBe(landings[0] - 1);
    expect(rewound.picture().transport).toBe('paused');
  });

  it('lands a seek to a prepared frame on the next frame not yet sent', async () => {
    let unsent = -1;
    const { rewound, landings, difference } = await compareRewound({
      prepare: (deck) => [{ kind: 'targets', deck, frames: [1500] }],
      presses: [
        press(300, (deck, rig) => {
          unsent = nextUnsent(rig);
          return { kind: 'seek', deck, frame: 1500 };
        }),
      ],
      runMs: 800,
    });

    expect(difference).toBeNull();
    expect(landings[0]).toBe(unsent);
    const frames = rewound.frames();
    const jumped = frames.find((item) => item.frameNumber >= 1500);
    expect(jumped).toBeDefined();
    expect(frames.findIndex((item) => item === jumped)).toBe(landings[0]);
  });

  it('changes speed from the landing frame, re-timing nothing already held', async () => {
    let unsent = -1;
    const { difference, rewound, landings } = await compareRewound({
      presses: [
        press(300, (deck, rig) => {
          unsent = nextUnsent(rig);
          return { kind: 'speed', deck, value: 1.25 };
        }),
      ],
      runMs: 800,
    });

    expect(difference).toBeNull();
    expect(landings[0]).toBe(unsent);
    expect(rewound.picture().tempo.effective).toBe(1.25);
    // Frames before the landing keep their spacing; from it on they are closer together.
    const sent = rewound.frames();
    expect(sent[unsent].dueAtMs - sent[unsent - 1].dueAtMs).toBeCloseTo(19.95);
    expect(sent[unsent + 1].dueAtMs - sent[unsent].dueAtMs).toBeCloseTo(19.95 / 1.25);
  });

  it('holds a nudge while it is held and lets go of it', async () => {
    const { difference, rewound } = await compareRewound({
      presses: [
        press(300, (deck) => ({ kind: 'nudge', deck, amount: 0.1 })),
        press(500, (deck) => ({ kind: 'nudge', deck, amount: 0 })),
      ],
      runMs: 900,
    });

    expect(difference).toBeNull();
    expect(rewound.picture().tempo.nudge).toBe(0);
  });

  it('keeps a speed-jump through a later speed', async () => {
    const { difference, rewound } = await compareRewound({
      presses: [
        press(300, (deck) => ({ kind: 'speed-jump', deck, amount: 0.2 })),
        press(500, (deck) => ({ kind: 'speed', deck, value: 1.1 })),
      ],
      runMs: 900,
    });

    expect(difference).toBeNull();
    const tempo = rewound.picture().tempo;
    expect(tempo.jump).toBe(0.2);
    expect(tempo.effective).toBeCloseTo(1.3);
  });

  it('stops on the frame it lands on, alone and after a speed change', async () => {
    let unsent = -1;
    const alone = await compareRewound({
      presses: [
        press(300, (deck, rig) => {
          unsent = nextUnsent(rig);
          return { kind: 'stop', deck };
        }),
      ],
      runMs: 600,
    });
    expect(alone.difference).toBeNull();
    expect(alone.landings[0]).toBe(unsent);
    expect(alone.rewound.picture().timing.rewinds).toBeGreaterThan(0);
    expect(alone.straight.picture().timing.rewinds).toBe(0);
    const aloneDelivered = alone.rewound.frames();
    expect(aloneDelivered[aloneDelivered.length - 1].frameNumber).toBe(alone.landings[0] - 1);
    expect(alone.rewound.picture().transport).toBe('stopped');

    let unsentAtStop = -1;
    const afterSpeed = await compareRewound({
      tune: 'insid3-out',
      presses: [
        press(200, (deck) => ({ kind: 'speed', deck, value: 1.25 })),
        press(400, (deck, rig) => {
          unsentAtStop = nextUnsent(rig);
          return { kind: 'stop', deck };
        }),
      ],
      runMs: 600,
    });
    expect(afterSpeed.difference).toBeNull();
    expect(afterSpeed.landings[1]).toBe(unsentAtStop);
    expect(afterSpeed.rewound.picture().timing.rewinds).toBeGreaterThan(0);
    expect(afterSpeed.straight.picture().timing.rewinds).toBe(0);
    const speedDelivered = afterSpeed.rewound.frames();
    expect(speedDelivered[speedDelivered.length - 1].frameNumber).toBe(afterSpeed.landings[1] - 1);
    expect(afterSpeed.rewound.picture().transport).toBe('stopped');
  });

  it('turns repeat off and on', async () => {
    const { difference, rewound } = await compareRewound({
      presses: [
        press(300, (deck) => ({ kind: 'repeat', deck, on: false })),
        press(500, (deck) => ({ kind: 'repeat', deck, on: true })),
      ],
      runMs: 900,
    });

    expect(difference).toBeNull();
    expect(rewound.picture().repeat).toBe(true);
  });

  it('mutes a voice and brings it back', async () => {
    const { difference, rewound } = await compareRewound({
      presses: [
        press(300, (deck) => ({ kind: 'setting', deck, setting: 2, value: 1 })),
        press(500, (deck) => ({ kind: 'setting', deck, setting: 2, value: 0 })),
      ],
      runMs: 900,
    });

    expect(difference).toBeNull();
    expect(rewound.picture().settings.main.find((s) => s.setting === 2)).toBeUndefined();
    expect(rewound.landed('setting').every((event) => event.settingsIn === 'main')).toBe(true);
  });

  it('folds several commands sent in one turn into one rewind', async () => {
    const { difference, rewound, straight } = await compareRewound({
      presses: [
        press(300, (deck) => ({ kind: 'speed', deck, value: 1.2 })),
        press(300, (deck) => ({ kind: 'setting', deck, setting: 1, value: 1 })),
        press(300, (deck) => ({ kind: 'nudge', deck, amount: 0.05 })),
      ],
      runMs: 800,
    });

    expect(difference).toBeNull();
    expect(rewound.picture().timing.rewinds).toBe(1);
    expect(straight.picture().timing.rewinds).toBe(0);
    const pressed = rewound
      .landed()
      .filter((event) => ['speed', 'setting', 'nudge'].includes(event.command.kind));
    expect(pressed).toHaveLength(3);
    expect(new Set(pressed.map((event) => event.frame)).size).toBe(1);
  });

  it('keeps the earlier command when a second flush lands on the same frame', async () => {
    const { difference, landings, rewound } = await compareRewound({
      presses: [
        press(300, (deck) => ({ kind: 'speed', deck, value: 1.3 })),
        press(301, (deck) => ({ kind: 'setting', deck, setting: 3, value: 1 })),
      ],
      runMs: 800,
    });

    expect(landings[1]).toBe(landings[0]);
    expect(difference).toBeNull();
    expect(rewound.picture().tempo.effective).toBe(1.3);
  });

  it('keeps a command already applied in the held frames when a press lands before it', async () => {
    const { difference, landings, rewound } = await compareRewound({
      presses: [
        press(300, (deck, rig) => ({
          kind: 'speed',
          deck,
          value: 1.4,
          when: { at: 'frame', frame: nextUnsent(rig) + 2 },
        })),
        press(302, (deck) => ({ kind: 'nudge', deck, amount: -0.1 })),
      ],
      runMs: 800,
    });

    expect(landings[1]).toBeLessThan(landings[0]);
    expect(difference).toBeNull();
    expect(rewound.picture().tempo.effective).toBeCloseTo(1.3);
  });
});

/**
 * A setting and the values a press may give it, for the random presses: an offset, holds that
 * release, the pitch settings.
 */
const SHAPES: readonly { readonly setting: number; readonly values: readonly number[] }[] = [
  { setting: SETTING.CUTOFF_OFFSET, values: [-60, 0, 90] },
  { setting: SETTING.VOICE_2_WAVEFORM_HOLD, values: [HOLD_RELEASED, 1, 8] },
  { setting: SETTING.VOLUME_HOLD, values: [HOLD_RELEASED, 9] },
  { setting: SETTING.KEY, values: [0, 5, -7] },
  { setting: SETTING.VOICE_1_COARSE, values: [0, 12, -3] },
  { setting: SETTING.VOICE_3_FINE, values: [0, 40] },
  { setting: SETTING.VOICE_1_FREQUENCY_OFFSET, values: [0, 200] },
  { setting: SETTING.VOICE_3_MUTE, values: [0, 1] },
];
const SWITCHES = [SETTING.VOICE_1_GATE_HOLD, SETTING.VOICE_2_TEST_HOLD, SETTING.VOICE_3_SYNC_HOLD];

/** What a random press of one of the settings commands is, from numbers drawn when the press is made up. */
interface ShapingDraw {
  readonly shape: number;
  readonly value: number;
  readonly other: number;
  readonly voice: number;
  readonly held: boolean;
  readonly lock: boolean | undefined;
  readonly inLoop: boolean;
}

function drawShaping(next: () => number): ShapingDraw {
  const shape = Math.floor(next() * SHAPES.length);
  const lock = Math.floor(next() * 3);
  return {
    shape,
    value: Math.floor(next() * 3),
    other: Math.floor(next() * SHAPES.length),
    voice: Math.floor(next() * 3),
    held: next() < 0.6,
    lock: lock === 0 ? undefined : lock === 1,
    inLoop: next() < 0.5,
  };
}

function shapingPress(deck: DeckId, draw: ShapingDraw, kind: number): DeckCommand {
  const shape = SHAPES[draw.shape];
  const value = shape.values[draw.value % shape.values.length];
  switch (kind) {
    case 0:
      return { kind: 'setting', deck, setting: shape.setting, value };
    case 1: {
      const other =
        SHAPES[(draw.other === draw.shape ? draw.other + 1 : draw.other) % SHAPES.length];
      return {
        kind: 'settings',
        deck,
        settingsIn: draw.inLoop ? 'loop' : 'main',
        changes: [
          { setting: shape.setting, value },
          { setting: other.setting, value: other.values[draw.value % other.values.length] },
        ],
      };
    }
    case 2:
      return { kind: 'voice-hold', deck, voice: draw.voice, held: draw.held };
    default:
      return {
        kind: 'flip-lock',
        deck,
        setting: SWITCHES[draw.voice],
        ...(draw.lock === undefined ? {} : { lock: draw.lock }),
      };
  }
}

/** A small seeded random source, so every run presses the same moments. */
function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
}

describe('a deck rewound by presses at random moments', () => {
  for (let seed = 1; seed <= 12; seed++) {
    it(`gives what a straight deck gives (seed ${seed})`, async () => {
      const next = random(seed);
      const presses: Press[] = [];
      for (let i = 0, count = 4 + Math.floor(next() * 8); i < count; i++) {
        const atMs = 100 + Math.floor(next() * 700);
        const kind = Math.floor(next() * 12);
        const ahead = next() < 0.3 ? Math.floor(next() * 5) : -1;
        const value = 0.6 + Math.floor(next() * 12) / 10;
        const voice = 1 + Math.floor(next() * 3);
        const on = next() < 0.5;
        const draw = drawShaping(next);
        presses.push(
          press(atMs, (deck, rig): DeckCommand => {
            const when =
              ahead < 0 ? {} : { when: { at: 'frame' as const, frame: nextUnsent(rig) + ahead } };
            switch (kind) {
              case 0:
                return { kind: 'speed', deck, value, ...when };
              case 1:
                return { kind: 'nudge', deck, amount: (value - 1) / 4, ...when };
              case 2:
                return { kind: 'speed-jump', deck, amount: (value - 1) / 3, ...when };
              case 3:
                return { kind: 'setting', deck, setting: voice, value: on ? 1 : 0, ...when };
              case 4:
                return { kind: 'repeat', deck, on, ...when };
              case 5:
                return { kind: 'seek', deck, frame: 1500, ...when };
              case 6:
                return { kind: 'targets', deck, frames: [1500, 2500], ...when };
              case 7:
              case 8:
              case 9:
              case 10:
                return { ...shapingPress(deck, draw, kind - 7), ...when };
              default:
                return { kind: 'nudge', deck, amount: 0, ...when };
            }
          }),
        );
      }

      const { difference, rewound } = await compareRewound({
        lookaheadMs: 60 + Math.floor(next() * 3) * 30,
        prepare: (deck) => [{ kind: 'targets', deck, frames: [1500] }],
        presses,
        runMs: 1800,
      });

      expect(difference).toBeNull();
      expect(rewound.warnings).toEqual([]);
    });
  }
});

const LOOP_A: JumpTarget = { startFrame: 500, endFrame: 520 };
const LOOP_B: JumpTarget = { startFrame: 1000, endFrame: 1010 };
const CUE: JumpTarget = { startFrame: 1500, endFrame: null };
const TARGETS = (deck: DeckId): DeckCommand[] => [
  { kind: 'targets', deck, frames: [500, 1000, 1500, 200, 300] },
];

/** `jump-landed` events as (frame, via, start) so two decks' can be compared. */
const landings = (rig: Rig): string[] =>
  rig.ofKind('jump-landed').map((event) => `${event.frame} ${event.via} ${event.startFrame}`);

/** A press every `everyMs` from `fromMs`, each a nudge of 0: it lands, rewinds and changes nothing. */
function rewindsEvery(fromMs: number, toMs: number, everyMs: number): Press[] {
  const presses: Press[] = [];
  for (let at = fromMs; at < toMs; at += everyMs) {
    presses.push(press(at, (deck) => ({ kind: 'nudge', deck, amount: 0 })));
  }
  return presses;
}

describe('a deck rewound with loops in play', () => {
  it('runs a loop through rewinds inside its laps', async () => {
    const { difference, rewound, straight } = await compareRewound({
      prepare: TARGETS,
      presses: [
        press(150, (deck) => ({ kind: 'hot-cue', deck, target: LOOP_A })),
        ...rewindsEvery(200, 700, 23),
      ],
      runMs: 900,
    });

    expect(difference).toBeNull();
    expect(rewound.picture().timing.rewinds).toBeGreaterThan(10);
    expect(rewound.picture().loop).toMatchObject({ startFrame: 500, endFrame: 520 });
    expect(straight.picture().loop).toMatchObject({ startFrame: 500, endFrame: 520 });
    expect(rewound.warnings).toEqual([]);
  });

  it('lands a queued jump at the wrap through rewinds across the hand-off', async () => {
    const { difference, rewound, straight } = await compareRewound({
      prepare: TARGETS,
      presses: [
        press(150, (deck) => ({ kind: 'hot-cue', deck, target: LOOP_A })),
        press(250, (deck) => ({ kind: 'hot-cue', deck, target: LOOP_B })),
        ...rewindsEvery(260, 700, 17),
      ],
      runMs: 900,
    });

    expect(difference).toBeNull();
    expect(landings(rewound)).toHaveLength(1);
    expect(landings(rewound)).toEqual(landings(straight));
    expect(rewound.picture()).toMatchObject({
      queued: null,
      loop: { startFrame: 1000, endFrame: 1010 },
    });
    expect(rewound.warnings).toEqual([]);
  });

  it('waits for a target that is not ready, and lands it where a straight deck does', async () => {
    const { difference, rewound, straight } = await compareRewound({
      prepare: TARGETS,
      presses: [
        press(150, (deck) => ({ kind: 'hot-cue', deck, target: LOOP_A })),
        press(250, (deck) => ({
          kind: 'jump',
          deck,
          target: { startFrame: 2500, endFrame: null },
        })),
        ...rewindsEvery(260, 700, 19),
      ],
      runMs: 900,
    });

    expect(difference).toBeNull();
    expect(landings(rewound)).toHaveLength(1);
    expect(landings(rewound)).toEqual(landings(straight));
    expect(rewound.ofKind('jump-landed')[0].via).toBe('ready');
    expect(rewound.picture()).toMatchObject({ waiting: null, loop: null });
  });

  it('plays a loop change from the wrap through rewinds across it', async () => {
    const { difference, rewound, straight } = await compareRewound({
      prepare: TARGETS,
      presses: [
        press(150, (deck) => ({ kind: 'hot-cue', deck, target: LOOP_A })),
        press(250, (deck) => ({ kind: 'loop-bounds', deck, startFrame: 500, endFrame: 510 })),
        ...rewindsEvery(260, 700, 17),
      ],
      runMs: 900,
    });

    expect(difference).toBeNull();
    expect(rewound.picture()).toMatchObject({
      pendingBounds: null,
      loop: { startFrame: 500, endFrame: 510 },
    });
    expect(straight.picture().loop).toMatchObject({ endFrame: 510 });
    expect(rewound.warnings).toEqual([]);
  });

  it('names a pending change and a queued jump again after a change of wrap, through rewinds', async () => {
    const { difference, rewound } = await compareRewound({
      prepare: TARGETS,
      presses: [
        press(150, (deck) => ({ kind: 'hot-cue', deck, target: LOOP_A })),
        press(250, (deck) => ({ kind: 'loop-bounds', deck, startFrame: 500, endFrame: 510 })),
        press(300, (deck) => ({ kind: 'loop-wraps', deck, wraps: true })),
        ...rewindsEvery(310, 600, 21),
        press(620, (deck) => ({ kind: 'hot-cue', deck, target: CUE })),
        press(650, (deck) => ({ kind: 'loop-wraps', deck, wraps: false })),
        ...rewindsEvery(660, 900, 21),
      ],
      runMs: 1100,
    });

    expect(difference).toBeNull();
    expect(rewound.picture()).toMatchObject({ pendingBounds: null, queued: null, loop: null });
    expect(landings(rewound)).toHaveLength(1);
    expect(rewound.warnings).toEqual([]);
  });

  it('holds the main settings aside while a loop plays its own, and puts them back', async () => {
    const own: JumpTarget = {
      startFrame: 200,
      endFrame: 230,
      settings: [{ setting: 2, value: 1 }],
    };
    const shared: JumpTarget = { startFrame: 300, endFrame: 330 };
    const { difference, rewound, straight } = await compareRewound({
      tune: 'insid3-out',
      prepare: TARGETS,
      presses: [
        press(150, (deck) => ({ kind: 'hot-cue', deck, target: own })),
        press(260, (deck) => ({ kind: 'setting', deck, setting: 1, value: 1 })),
        press(330, (deck) => ({ kind: 'hot-cue', deck, target: shared })),
        press(360, (deck) => ({ kind: 'loop-wraps', deck, wraps: true })),
        ...rewindsEvery(370, 800, 19),
        press(850, (deck) => ({ kind: 'hot-cue', deck, target: own })),
        press(1000, (deck) => ({ kind: 'let-go', deck })),
      ],
      runMs: 1200,
    });

    expect(difference).toBeNull();
    expect(landings(rewound)).toEqual(landings(straight));
    expect(rewound.picture()).toMatchObject({ settingsInPlay: 'main', loop: null });
    expect(rewound.picture().settings.main.find((s) => s.setting === 1)).toBeUndefined();
    expect(rewound.warnings).toEqual([]);
  });
});

describe('a deck rewound by loop presses at random moments', () => {
  const OWN: JumpTarget = { startFrame: 200, endFrame: 230, settings: [{ setting: 2, value: 1 }] };
  const SHARED: JumpTarget = { startFrame: 300, endFrame: 330 };
  const OWN_WRAPS: JumpTarget = { startFrame: 1000, endFrame: 1020, wraps: true, settings: [] };
  const OWN_FULL: JumpTarget = {
    startFrame: 200,
    endFrame: 240,
    settings: [
      { setting: SETTING.KEY, value: 12 },
      { setting: SETTING.CUTOFF_HOLD, value: 300 },
      { setting: SETTING.VOICE_3_WAVEFORM_HOLD, value: 8 },
      { setting: SETTING.VOICE_2_COARSE, value: -5 },
      { setting: SETTING.VOICE_1_MUTE, value: 1 },
    ],
  };
  const TARGET_LIST = [LOOP_A, LOOP_B, CUE, OWN, SHARED, OWN_WRAPS, OWN_FULL];

  for (let seed = 1; seed <= 16; seed++) {
    it(`gives what a straight deck gives (seed ${seed})`, async () => {
      const next = random(seed * 7919);
      const presses: Press[] = [];
      for (let i = 0, count = 6 + Math.floor(next() * 8); i < count; i++) {
        const atMs = 100 + Math.floor(next() * 800);
        const kind = Math.floor(next() * 16);
        const target = TARGET_LIST[Math.floor(next() * TARGET_LIST.length)];
        const ahead = next() < 0.3 ? Math.floor(next() * 5) : -1;
        const on = next() < 0.5;
        const draw = drawShaping(next);
        presses.push(
          press(atMs, (deck, rig): DeckCommand => {
            const when =
              ahead < 0 ? {} : { when: { at: 'frame' as const, frame: nextUnsent(rig) + ahead } };
            switch (kind) {
              case 0:
              case 1:
              case 2:
                return { kind: 'hot-cue', deck, target, ...when };
              case 12:
              case 13:
              case 14:
              case 15:
                return { ...shapingPress(deck, draw, kind - 12), ...when };
              case 3:
                return { kind: 'jump', deck, target, ...when };
              case 4:
                return { kind: 'let-go', deck, ...when };
              case 5:
                return { kind: 'cancel-queued', deck, ...when };
              case 6:
                return { kind: 'stop-loop', deck, ...when };
              case 7:
                return {
                  kind: 'loop-bounds',
                  deck,
                  startFrame: target.startFrame,
                  endFrame: on ? target.startFrame + 12 : null,
                  ...when,
                };
              case 8:
                return { kind: 'loop-wraps', deck, wraps: on, ...when };
              case 9:
                return {
                  kind: 'setting',
                  deck,
                  setting: 1 + Math.floor(next() * 3),
                  value: on ? 1 : 0,
                  ...when,
                };
              case 10:
                return { kind: 'speed', deck, value: 0.8 + Math.floor(next() * 6) / 10, ...when };
              default:
                return { kind: 'nudge', deck, amount: 0, ...when };
            }
          }),
        );
      }

      const { difference, rewound } = await compareRewound({
        tune: 'insid3-out',
        lookaheadMs: 60 + Math.floor(next() * 3) * 30,
        prepare: (deck) => [{ kind: 'targets', deck, frames: [200, 300, 500, 1000, 1500] }],
        presses,
        runMs: 1400,
      });

      expect(difference).toBeNull();
      // An edit sent with no loop to edit is the one thing the random presses may get refused.
      expect(rewound.warnings.filter((line) => !line.includes('kept its loop'))).toEqual([]);
    });
  }
});

describe('a deck rewound with the tune shaped', () => {
  const FULL_LIST: JumpTarget = {
    startFrame: 200,
    endFrame: 230,
    settings: [
      { setting: SETTING.VOICE_2_MUTE, value: 1 },
      { setting: SETTING.KEY, value: 7 },
      { setting: SETTING.CUTOFF_HOLD, value: 600 },
      { setting: SETTING.VOICE_3_WAVEFORM_HOLD, value: 8 },
      { setting: SETTING.VOICE_1_FINE, value: -35 },
    ],
  };
  const set = (setting: number, value: number) => (deck: DeckId) =>
    ({ kind: 'setting', deck, setting, value }) as DeckCommand;

  it('sweeps an offset a setting at a time among held frames', async () => {
    const sweep: Press[] = [];
    for (let at = 150, i = 0; at < 800; at += 11, i++) {
      sweep.push(press(at, set(SETTING.CUTOFF_OFFSET, ((i * 37) % 200) - 100)));
    }
    const { difference, rewound } = await compareRewound({ presses: sweep, runMs: 900 });

    expect(difference).toBeNull();
    expect(rewound.picture().timing.rewinds).toBeGreaterThan(20);
    expect(rewound.warnings).toEqual([]);
  });

  it('lands a settings list on one frame, with an offset, a hold and a pitch together', async () => {
    const { difference, rewound } = await compareRewound({
      presses: [
        press(300, (deck) => ({
          kind: 'settings',
          deck,
          settingsIn: 'main',
          changes: [
            { setting: SETTING.CUTOFF_OFFSET, value: 120 },
            { setting: SETTING.VOICE_2_WAVEFORM_HOLD, value: 8 },
            { setting: SETTING.KEY, value: -5 },
            { setting: SETTING.VOICE_1_MUTE, value: 1 },
          ],
        })),
        ...rewindsEvery(310, 700, 17),
        press(720, (deck) => ({
          kind: 'settings',
          deck,
          settingsIn: 'main',
          changes: [
            { setting: SETTING.VOICE_2_WAVEFORM_HOLD, value: HOLD_RELEASED },
            { setting: SETTING.KEY, value: 0 },
          ],
        })),
      ],
      runMs: 900,
    });

    expect(difference).toBeNull();
    expect(rewound.landed('settings').every((event) => event.settingsIn === 'main')).toBe(true);
    expect(rewound.picture().settings.main.map((entry) => entry.setting)).toEqual([
      SETTING.VOICE_1_MUTE,
      SETTING.CUTOFF_OFFSET,
    ]);
    expect(rewound.warnings).toEqual([]);
  });

  it('holds Kill across held frames and lets it go', async () => {
    const { difference, rewound } = await compareRewound({
      presses: [
        press(300, (deck) => ({ kind: 'voice-hold', deck, voice: 0, held: true })),
        ...rewindsEvery(310, 600, 13),
        press(620, set(SETTING.VOICE_2_MUTE, 1)),
        press(650, (deck) => ({ kind: 'voice-hold', deck, voice: 1, held: true })),
        ...rewindsEvery(660, 800, 13),
        press(820, (deck) => ({ kind: 'voice-hold', deck, voice: 0, held: false })),
        press(850, (deck) => ({ kind: 'voice-hold', deck, voice: 1, held: false })),
      ],
      runMs: 1000,
    });

    expect(difference).toBeNull();
    expect(rewound.picture().settings.main).toEqual([{ setting: SETTING.VOICE_2_MUTE, value: 1 }]);
    expect(rewound.warnings).toEqual([]);
  });

  it('flips a lock on and off, and sets and releases it, through rewinds', async () => {
    const lock = (lockTo?: boolean) => (deck: DeckId) =>
      ({
        kind: 'flip-lock',
        deck,
        setting: SETTING.VOICE_1_GATE_HOLD,
        ...(lockTo === undefined ? {} : { lock: lockTo }),
      }) as DeckCommand;
    const { difference, rewound } = await compareRewound({
      presses: [
        press(300, lock()),
        ...rewindsEvery(310, 450, 13),
        press(470, lock()),
        ...rewindsEvery(480, 560, 13),
        press(580, lock(true)),
        press(640, lock(true)),
        ...rewindsEvery(650, 760, 13),
        press(780, lock(false)),
      ],
      runMs: 900,
    });

    expect(difference).toBeNull();
    expect(rewound.landed('flip-lock')).toHaveLength(5);
    expect(rewound.picture().settings.main).toEqual([]);
    expect(rewound.warnings).toEqual([]);
  });

  it('flips a lock in a loop’s own list through rewinds between the two presses', async () => {
    // A lock named a couple of frames ahead lands inside the held frames, and the presses after it rewind to before it.
    const lock = (deck: DeckId, rig: Rig): DeckCommand => ({
      kind: 'flip-lock',
      deck,
      setting: SETTING.VOICE_3_TEST_HOLD,
      when: { at: 'frame', frame: nextUnsent(rig) + 2 },
    });
    const own: JumpTarget = {
      startFrame: 200,
      endFrame: 230,
      settings: [{ setting: SETTING.VOICE_2_MUTE, value: 1 }],
    };
    const { difference, rewound } = await compareRewound({
      tune: 'insid3-out',
      prepare: TARGETS,
      presses: [
        press(150, (deck) => ({ kind: 'hot-cue', deck, target: own })),
        ...rewindsEvery(160, 290, 13),
        press(300, lock),
        ...rewindsEvery(303, 460, 3),
        press(470, lock),
        ...rewindsEvery(473, 600, 3),
        press(620, (deck) => ({ kind: 'let-go', deck })),
      ],
      runMs: 800,
    });

    expect(difference).toBeNull();
    expect(rewound.landed('flip-lock').map((event) => event.settingsIn)).toEqual(['loop', 'loop']);
    expect(rewound.picture().settings).toMatchObject({ main: [], loop: null });
    expect(rewound.warnings).toEqual([]);
  });

  it('plays a loop with a full list of its own in and out through rewinds across both frames', async () => {
    const { difference, rewound, straight } = await compareRewound({
      tune: 'insid3-out',
      prepare: TARGETS,
      presses: [
        press(100, set(SETTING.CUTOFF_OFFSET, 80)),
        press(120, set(SETTING.VOICE_3_FREQUENCY_HOLD, 900)),
        press(150, (deck) => ({ kind: 'hot-cue', deck, target: FULL_LIST })),
        ...rewindsEvery(160, 500, 19),
        press(520, (deck) => ({
          kind: 'settings',
          deck,
          settingsIn: 'loop',
          changes: [{ setting: SETTING.VOLUME_HOLD, value: 6 }],
        })),
        ...rewindsEvery(530, 700, 19),
        press(720, (deck) => ({ kind: 'let-go', deck })),
        ...rewindsEvery(730, 900, 19),
        press(920, (deck) => ({ kind: 'hot-cue', deck, target: FULL_LIST })),
        ...rewindsEvery(930, 1100, 19),
        press(1120, (deck) => ({ kind: 'seek', deck, frame: 300 })),
      ],
      runMs: 1300,
    });

    expect(difference).toBeNull();
    expect(landings(rewound)).toEqual(landings(straight));
    expect(rewound.picture()).toMatchObject({ settingsInPlay: 'main', loop: null });
    expect(rewound.picture().settings.main.map((entry) => entry.setting)).toEqual([
      SETTING.VOICE_3_FREQUENCY_HOLD,
      SETTING.CUTOFF_OFFSET,
    ]);
    expect(rewound.warnings).toEqual([]);
  });
});

/** Loops and a cue inside the first 400 frames, which is as far as the register record the hand and slip work on reaches. */
const SLIPPED: JumpTarget = { startFrame: 100, endFrame: 117.4 };
const SLIPPED_B: JumpTarget = { startFrame: 200, endFrame: 210, wraps: true };
const SLIPPED_CUE: JumpTarget = { startFrame: 300, endFrame: null };
const SLIP_TARGETS = (deck: DeckId): DeckCommand[] => [
  { kind: 'targets', deck, frames: [100, 200, 300] },
];

const touch = (deck: DeckId, rig: Rig): DeckCommand => ({
  kind: 'hand-touch',
  deck,
  atMs: rig.time.ms,
});
const moveTo =
  (travelFrames: number) =>
  (deck: DeckId, rig: Rig): DeckCommand => ({
    kind: 'hand-move',
    deck,
    travelFrames,
    atMs: rig.time.ms,
  });
const liftWith =
  (gripSeconds: number) =>
  (deck: DeckId, rig: Rig): DeckCommand => ({
    kind: 'hand-lift',
    deck,
    atMs: rig.time.ms,
    gripSeconds,
  });
const slipOn =
  (on: boolean) =>
  (deck: DeckId): DeckCommand => ({ kind: 'slip', deck, on });

describe('a deck rewound with the hand on the record', () => {
  it('follows the hand through rewinds while it is down', async () => {
    const { difference, rewound, straight } = await compareRewound({
      presses: [
        press(300, touch),
        press(340, moveTo(4)),
        press(380, moveTo(-3)),
        press(420, moveTo(9)),
        ...rewindsEvery(310, 700, 17),
      ],
      runMs: 800,
    });

    expect(difference).toBeNull();
    expect(rewound.picture().timing.rewinds).toBeGreaterThan(10);
    expect(rewound.picture().hand).toBe('down');
    expect(straight.picture().hand).toBe('down');
    expect(rewound.warnings).toEqual([]);
  });

  it('plays a throw through rewinds, from the lift to the arrival and the handback', async () => {
    const { difference, rewound } = await compareRewound({
      presses: [
        press(300, touch),
        press(330, moveTo(2)),
        press(350, moveTo(5)),
        press(370, moveTo(8)),
        press(390, liftWith(0.2)),
        ...rewindsEvery(310, 1800, 29),
      ],
      runMs: 2000,
    });

    expect(difference).toBeNull();
    expect(rewound.picture().hand).toBe('up');
    expect(rewound.warnings).toEqual([]);
  });

  it('grabs a thrown record again through rewinds', async () => {
    const { difference, rewound } = await compareRewound({
      presses: [
        press(300, touch),
        press(320, moveTo(3)),
        press(340, moveTo(6)),
        press(360, liftWith(5)),
        ...rewindsEvery(370, 500, 13),
        press(520, touch),
        press(560, moveTo(-2)),
        ...rewindsEvery(570, 700, 13),
        press(720, liftWith(0.2)),
        ...rewindsEvery(730, 1200, 31),
      ],
      runMs: 1300,
    });

    expect(difference).toBeNull();
    expect(rewound.warnings).toEqual([]);
  });

  it('stops a record thrown backward at the start of a loop, and wraps one that wraps', async () => {
    const { difference, rewound } = await compareRewound({
      prepare: SLIP_TARGETS,
      presses: [
        press(150, (deck) => ({ kind: 'hot-cue', deck, target: SLIPPED_B })),
        press(500, touch),
        press(520, moveTo(-6)),
        press(540, moveTo(-12)),
        press(560, liftWith(2)),
        ...rewindsEvery(570, 900, 19),
        press(920, (deck) => ({ kind: 'loop-wraps', deck, wraps: false })),
        press(940, touch),
        press(960, moveTo(-8)),
        press(980, moveTo(-20)),
        press(1000, liftWith(2)),
        ...rewindsEvery(1010, 1400, 19),
      ],
      runMs: 1500,
    });

    expect(difference).toBeNull();
    expect(rewound.warnings).toEqual([]);
  });
});

describe('a deck rewound with slip departed', () => {
  it('lands a loop on the count it would have reached through rewinds, across a queued hand-off', async () => {
    const { difference, rewound, straight } = await compareRewound({
      prepare: SLIP_TARGETS,
      presses: [
        press(150, slipOn(true)),
        press(200, (deck) => ({ kind: 'hot-cue', deck, target: SLIPPED })),
        ...rewindsEvery(210, 500, 23),
        press(520, (deck) => ({ kind: 'hot-cue', deck, target: SLIPPED_B })),
        ...rewindsEvery(530, 900, 23),
        press(920, (deck) => ({ kind: 'let-go', deck })),
        ...rewindsEvery(930, 1100, 23),
      ],
      runMs: 1200,
    });

    expect(difference).toBeNull();
    expect(rewound.picture().slip).toEqual({ on: true, departed: false });
    expect(rewound.picture().loop).toBeNull();
    expect(landings(rewound)).toEqual(landings(straight));
    expect(rewound.warnings).toEqual([]);
  });

  it('nests the hand in a loop departure and lands each on its own count through rewinds', async () => {
    const { difference, rewound } = await compareRewound({
      prepare: SLIP_TARGETS,
      presses: [
        press(150, slipOn(true)),
        press(200, (deck) => ({ kind: 'hot-cue', deck, target: SLIPPED })),
        ...rewindsEvery(210, 400, 23),
        press(420, touch),
        press(450, moveTo(15)),
        press(480, moveTo(-8)),
        ...rewindsEvery(490, 600, 17),
        press(620, liftWith(0.5)),
        ...rewindsEvery(630, 800, 17),
        press(820, (deck) => ({ kind: 'stop-loop', deck })),
        ...rewindsEvery(830, 1000, 17),
      ],
      runMs: 1100,
    });

    expect(difference).toBeNull();
    expect(rewound.picture()).toMatchObject({ slip: { departed: false }, hand: 'up', loop: null });
    expect(rewound.warnings).toEqual([]);
  });

  it('lands a hand on the count with slip on, and throws once slip is off', async () => {
    const { difference, rewound } = await compareRewound({
      presses: [
        press(150, slipOn(true)),
        press(300, touch),
        press(340, moveTo(7)),
        ...rewindsEvery(350, 500, 19),
        press(520, liftWith(0.5)),
        ...rewindsEvery(530, 700, 19),
        press(720, slipOn(false)),
        press(740, touch),
        press(780, moveTo(-4)),
        press(820, liftWith(0.5)),
        ...rewindsEvery(830, 1000, 19),
      ],
      runMs: 1200,
    });

    expect(difference).toBeNull();
    expect(rewound.picture().slip.on).toBe(false);
    expect(rewound.warnings).toEqual([]);
  });
});

describe('a deck rewound by hand and slip presses at random moments', () => {
  const TARGET_LIST = [SLIPPED, SLIPPED_B, SLIPPED_CUE];

  for (let seed = 1; seed <= 12; seed++) {
    it(`gives what a straight deck gives (seed ${seed})`, async () => {
      const next = random(seed * 104729);
      const presses: Press[] = [];
      let travel = 0;
      for (let i = 0, count = 8 + Math.floor(next() * 10); i < count; i++) {
        const atMs = 100 + Math.floor(next() * 800);
        const kind = Math.floor(next() * 12);
        const target = TARGET_LIST[Math.floor(next() * TARGET_LIST.length)];
        const ahead = next() < 0.3 ? Math.floor(next() * 5) : -1;
        travel += Math.floor(next() * 9) - 4;
        const at = travel;
        const grip = 0.2 + Math.floor(next() * 5) / 5;
        const on = next() < 0.5;
        presses.push(
          press(atMs, (deck, rig): DeckCommand => {
            const when =
              ahead < 0 ? {} : { when: { at: 'frame' as const, frame: nextUnsent(rig) + ahead } };
            switch (kind) {
              case 0:
              case 1:
                return { ...touch(deck, rig), ...when };
              case 2:
              case 3:
                return { ...moveTo(at)(deck, rig), ...when };
              case 4:
                return { ...liftWith(grip)(deck, rig), ...when };
              case 5:
                return { kind: 'slip', deck, on, ...when };
              case 6:
              case 7:
                return { kind: 'hot-cue', deck, target, ...when };
              case 8:
                return { kind: 'let-go', deck, ...when };
              case 9:
                return { kind: 'stop-loop', deck, ...when };
              case 10:
                return { kind: 'cancel-queued', deck, ...when };
              default:
                return { kind: 'nudge', deck, amount: 0, ...when };
            }
          }),
        );
      }

      const { difference, rewound } = await compareRewound({
        lookaheadMs: 60 + Math.floor(next() * 3) * 30,
        prepare: SLIP_TARGETS,
        presses,
        runMs: 1400,
      });

      expect(difference).toBeNull();
      expect(rewound.warnings).toEqual([]);
    });
  }
});

/** The grid the live looper runs on, and a loop for it to run over, inside the register record. */
const LIVE_GRID = { beatFrames: 20, beatOneFrame: 0 };
const LIVE_UNDER: JumpTarget = { startFrame: 200, endFrame: 240, wraps: true };
const LIVE_QUEUED: JumpTarget = { startFrame: 300, endFrame: 310 };
const LIVE_TARGETS = (deck: DeckId): DeckCommand[] => [
  { kind: 'targets', deck, frames: [200, 300] },
  { kind: 'live-loop-size', deck, lengthFrames: 40 },
];
const liveSize =
  (lengthFrames: number) =>
  (deck: DeckId): DeckCommand => ({ kind: 'live-loop-size', deck, lengthFrames });
const liveStart = (deck: DeckId): DeckCommand => ({ kind: 'live-loop', deck });
const liveEnd = (deck: DeckId): DeckCommand => ({ kind: 'live-loop-end', deck });
const hotCueUnder = (deck: DeckId): DeckCommand => ({ kind: 'hot-cue', deck, target: LIVE_UNDER });

describe('a deck rewound with a live loop', () => {
  it('runs a live loop through rewinds, with a shrink pending, a grown size and its end', async () => {
    const { difference, rewound } = await compareRewound({
      load: { grid: LIVE_GRID },
      prepare: LIVE_TARGETS,
      presses: [
        press(400, liveStart),
        ...rewindsEvery(410, 640, 23),
        press(700, liveSize(8)),
        ...rewindsEvery(710, 820, 17),
        press(840, liveSize(30)),
        ...rewindsEvery(850, 950, 19),
        press(970, liveEnd),
        ...rewindsEvery(980, 1150, 23),
      ],
      runMs: 1200,
    });

    expect(difference).toBeNull();
    expect(rewound.picture()).toMatchObject({ loop: null, liveLoop: null, liveLoopSize: 30 });
    const pictures = rewound.ofKind('picture');
    expect(pictures.some((picture) => picture.liveLoop?.pendingEndFrame != null)).toBe(true);
    expect(pictures.some((picture) => picture.loop?.live === true)).toBe(true);
    expect(rewound.warnings).toEqual([]);
  });

  it('runs a live loop over a loop through rewinds and lands on slip’s count at its end', async () => {
    const { difference, rewound } = await compareRewound({
      load: { grid: LIVE_GRID },
      prepare: LIVE_TARGETS,
      presses: [
        press(100, slipOn(true)),
        press(150, hotCueUnder),
        ...rewindsEvery(160, 300, 23),
        press(320, liveStart),
        press(330, (deck) => ({ kind: 'hot-cue', deck, target: LIVE_QUEUED })),
        ...rewindsEvery(340, 480, 19),
        press(500, (deck) => ({
          kind: 'loop-bounds',
          deck,
          startFrame: 200,
          endFrame: 230,
        })),
        ...rewindsEvery(510, 640, 19),
        press(660, liveEnd),
        ...rewindsEvery(670, 900, 23),
      ],
      runMs: 1000,
    });

    expect(difference).toBeNull();
    expect(rewound.picture().liveLoop).toBeNull();
    const pictures = rewound.ofKind('picture');
    expect(pictures.some((picture) => picture.liveLoop?.overLoop === true)).toBe(true);
    expect(pictures.some((picture) => picture.pendingBounds !== null)).toBe(true);
    expect(rewound.warnings).toEqual([]);
  });

  it('folds into the loop underneath through rewinds with slip off', async () => {
    const { difference, rewound } = await compareRewound({
      load: { grid: LIVE_GRID },
      prepare: LIVE_TARGETS,
      presses: [
        press(150, hotCueUnder),
        ...rewindsEvery(160, 300, 23),
        press(320, liveStart),
        ...rewindsEvery(330, 560, 19),
        press(580, liveEnd),
        ...rewindsEvery(590, 800, 23),
      ],
      runMs: 900,
    });

    expect(difference).toBeNull();
    expect(rewound.picture()).toMatchObject({
      liveLoop: null,
      loop: { startFrame: 200, endFrame: 240 },
    });
    expect(rewound.ofKind('picture').some((picture) => picture.liveLoop?.overLoop === true)).toBe(
      true,
    );
    expect(rewound.warnings).toEqual([]);
  });

  it('adopts a live loop and drops one through rewinds', async () => {
    const { difference, rewound } = await compareRewound({
      load: { grid: LIVE_GRID },
      prepare: LIVE_TARGETS,
      presses: [
        press(150, hotCueUnder),
        press(300, liveStart),
        ...rewindsEvery(310, 440, 17),
        press(460, (deck) => ({ kind: 'live-loop-adopt', deck })),
        ...rewindsEvery(470, 560, 17),
        press(580, (deck) => ({ kind: 'stop-loop', deck })),
        press(620, liveStart),
        ...rewindsEvery(630, 760, 17),
        press(780, (deck) => ({ kind: 'seek', deck, frame: 300 })),
        ...rewindsEvery(790, 900, 17),
      ],
      runMs: 1000,
    });

    expect(difference).toBeNull();
    expect(rewound.picture()).toMatchObject({ loop: null, liveLoop: null });
    expect(rewound.warnings).toEqual([]);
  });
});

describe('a deck rewound with a live loop that is slip’s only departure', () => {
  it('lands on slip’s count when the loop is stopped, through rewinds', async () => {
    const { difference, rewound } = await compareRewound({
      load: { grid: LIVE_GRID },
      prepare: LIVE_TARGETS,
      presses: [
        press(100, slipOn(true)),
        press(300, liveStart),
        ...rewindsEvery(310, 440, 17),
        press(460, (deck) => ({ kind: 'stop-loop', deck })),
        ...rewindsEvery(470, 640, 19),
      ],
      runMs: 700,
    });

    expect(difference).toBeNull();
    expect(rewound.picture()).toMatchObject({
      loop: null,
      liveLoop: null,
      slip: { departed: false },
    });
    const pictures = rewound.ofKind('picture');
    expect(pictures.some((picture) => picture.liveLoop?.overLoop === false)).toBe(true);
    expect(rewound.warnings).toEqual([]);
  });
});

describe('a deck rewound by live loop presses at random moments', () => {
  for (let seed = 1; seed <= 12; seed++) {
    it(`gives what a straight deck gives (seed ${seed})`, async () => {
      const next = random(seed * 15485863);
      const presses: Press[] = [];
      const sizes = [8, 12, 20, 31.5, 40, 60];
      for (let i = 0, count = 8 + Math.floor(next() * 10); i < count; i++) {
        const atMs = 100 + Math.floor(next() * 800);
        const kind = Math.floor(next() * 12);
        const ahead = next() < 0.3 ? Math.floor(next() * 5) : -1;
        const size = sizes[Math.floor(next() * sizes.length)];
        const on = next() < 0.5;
        presses.push(
          press(atMs, (deck, rig): DeckCommand => {
            const when =
              ahead < 0 ? {} : { when: { at: 'frame' as const, frame: nextUnsent(rig) + ahead } };
            switch (kind) {
              case 0:
              case 1:
                return { ...liveStart(deck), ...when };
              case 2:
              case 3:
                return { ...liveEnd(deck), ...when };
              case 4:
              case 5:
                return { ...liveSize(size)(deck), ...when };
              case 6:
                return { kind: 'live-loop-adopt', deck, ...when };
              case 7:
                return { kind: 'slip', deck, on, ...when };
              case 8:
                return { ...hotCueUnder(deck), ...when };
              case 9:
                return { kind: 'hot-cue', deck, target: LIVE_QUEUED, ...when };
              case 10:
                return { kind: 'stop-loop', deck, ...when };
              default:
                return { kind: 'nudge', deck, amount: 0, ...when };
            }
          }),
        );
      }

      const { difference } = await compareRewound({
        lookaheadMs: 60 + Math.floor(next() * 3) * 30,
        load: { grid: LIVE_GRID },
        prepare: LIVE_TARGETS,
        presses,
        runMs: 1400,
      });

      expect(difference).toBeNull();
    });
  }
});

/**
 * Taps on Insid3-out, whose note starts fall every 12 frames (from 5) at a frame every 10 ms, and
 * whose frame `f` delivers the position `f + 1`. A tap names the position it means to mark, and
 * sends the host time that frame fell due at, which the press reads off the rewound deck.
 */
const TAP_TUNE = 'insid3-out';
/** The grid a tapped deck starts on: the straight deck is sent the live loop up front, which a deck with no grid refuses. */
const TAP_GRID = { beatFrames: 20, beatOneFrame: 0 };
/** Where the tap targets are pressed from: the register record's reach covers all of them. */
const tapOn =
  (position: number, offsetMs = 0) =>
  (deck: DeckId, rig: Rig): DeckCommand => {
    const update = rig.ofKind('update', deck).find((item) => item.position === position);
    if (update === undefined) throw new Error(`no frame delivered position ${position} yet`);
    return { kind: 'tap', deck, atMs: update.dueAtMs + offsetMs };
  };
const tapEnd = (deck: DeckId): DeckCommand => ({ kind: 'tap-end', deck });
/** A `when` that fixes a command `frames` frames past the next frame the sink has not been given. */
const aheadOf = (rig: Rig, frames: number): When => ({
  at: 'frame',
  frame: nextUnsent(rig) + frames,
});
const nudgeZero = (deck: DeckId): DeckCommand => ({ kind: 'nudge', deck, amount: 0 });

/**
 * A press of nothing a few milliseconds after the one before it: it lands on the same frame while
 * that frame is still held, so the rewind re-applies what landed there before it.
 */
const justAfter = (atMs: number): Press[] => [
  press(atMs + 1, nudgeZero),
  press(atMs + 2, nudgeZero),
  press(atMs + 4, nudgeZero),
];

/** Whether a press of nothing landed on the frame of every tap: each was rewound across and applied again. */
function everyTapRewoundAcross(rig: Rig): boolean {
  const nudges = new Set(rig.landed('nudge').map((event) => event.frame));
  return rig.landed('tap').every((event) => nudges.has(event.frame));
}

describe('a deck rewound with taps', () => {
  it('fits a grid from taps landing among held frames, and starts a live loop on it', async () => {
    const presses: Press[] = [
      press(700, tapOn(65)),
      ...justAfter(700),
      press(820, tapOn(77, 3)),
      ...justAfter(820),
      press(940, tapOn(89)),
      ...justAfter(940),
      press(1060, tapOn(101, 2)),
      ...justAfter(1060),
      ...rewindsEvery(1070, 1190, 17),
      press(1200, tapOn(113)),
      ...justAfter(1200),
      ...rewindsEvery(1210, 1290, 19),
      press(1300, liveSize(24)),
      press(1400, liveStart),
      ...rewindsEvery(1410, 1750, 23),
      press(1760, liveEnd),
      ...rewindsEvery(1770, 1950, 23),
    ];
    const { difference, rewound } = await compareRewound({
      tune: TAP_TUNE,
      load: { grid: TAP_GRID },
      presses,
      runMs: 2100,
    });

    expect(difference).toBeNull();
    expect(everyTapRewoundAcross(rewound)).toBe(true);
    const fits = rewound.ofKind('grid-fitted');
    expect(fits.map((event) => event.taps)).toEqual([4, 5]);
    expect(fits[0].grid).toEqual(fits[1].grid);
    expect(rewound.picture().grid).toEqual(fits[0].grid);
    expect(rewound.ofKind('picture').some((picture) => picture.loop?.live === true)).toBe(true);
    expect(rewound.warnings).toEqual([]);
  });

  it('plays on through a second fitted grid, after a run was closed', async () => {
    const { difference, rewound } = await compareRewound({
      tune: TAP_TUNE,
      load: { grid: TAP_GRID },
      presses: [
        press(700, tapOn(65)),
        ...justAfter(700),
        press(820, tapOn(77)),
        ...justAfter(820),
        press(940, tapOn(89)),
        ...justAfter(940),
        press(1060, tapOn(101)),
        ...justAfter(1060),
        ...rewindsEvery(1070, 1200, 17),
        press(1210, tapEnd),
        press(1250, tapOn(65, 1)),
        ...justAfter(1250),
        press(1320, tapOn(89)),
        ...justAfter(1320),
        press(1400, tapOn(113)),
        ...justAfter(1400),
        press(1480, tapOn(137)),
        ...justAfter(1480),
        ...rewindsEvery(1490, 1600, 19),
        press(1620, liveSize(48)),
        press(1700, liveStart),
        ...rewindsEvery(1710, 1950, 23),
      ],
      runMs: 2100,
    });

    expect(difference).toBeNull();
    expect(everyTapRewoundAcross(rewound)).toBe(true);
    const fits = rewound.ofKind('grid-fitted');
    expect(fits.map((event) => event.taps)).toEqual([4, 4]);
    expect(fits[0].grid).not.toEqual(fits[1].grid);
    expect(rewound.picture().grid).toEqual(fits[1].grid);
    expect(rewound.warnings).toEqual([]);
  });
});

describe('a deck rewound across a run that was closed and begun again', () => {
  it('puts the old run back for the tap that lands before the tap-end that closed it', async () => {
    const { difference, rewound, straight } = await compareRewound({
      tune: TAP_TUNE,
      lookaheadMs: 120,
      presses: [
        press(700, tapOn(65)),
        press(780, tapOn(77)),
        press(860, tapOn(89)),
        // The run closes and a new one begins in frames still held, over the old run's marks.
        press(1300, (deck, rig) => ({ ...tapEnd(deck), when: aheadOf(rig, 4) })),
        press(1300, (deck, rig) => ({ ...tapOn(17)(deck, rig), when: aheadOf(rig, 5) })),
        press(1300, (deck, rig) => ({ ...tapOn(29)(deck, rig), when: aheadOf(rig, 6) })),
        // The old run's fourth tap lands before all of them, so the rewind puts three marks back.
        press(1303, tapOn(113)),
        ...rewindsEvery(1310, 1500, 17),
      ],
      runMs: 1700,
    });

    expect(difference).toBeNull();
    const fits = rewound.ofKind('grid-fitted');
    expect(fits.map((event) => event.taps)).toEqual([4]);
    expect(fits[0].grid.beatOneFrame).toBeGreaterThan(60);
    expect(fits).toEqual(straight.ofKind('grid-fitted'));
  });
});

describe('a deck rewound across a tap that lands before one it has already applied', () => {
  it('fits the later tap again from the run it now follows', async () => {
    const { difference, rewound, straight } = await compareRewound({
      tune: TAP_TUNE,
      lookaheadMs: 120,
      load: { grid: TAP_GRID },
      presses: [
        press(700, tapOn(65)),
        press(820, tapOn(77)),
        press(940, tapOn(89)),
        press(1060, tapOn(101)),
        // The fifth mark fits the grid in use, so nothing is rebuilt and a tap can still land ahead of it.
        press(1300, (deck, rig) => ({ ...tapOn(113)(deck, rig), when: aheadOf(rig, 8) })),
        // The sixth mark lands before it, so the rewind applies the fifth tap again after six marks.
        press(1302, tapOn(29)),
        ...rewindsEvery(1310, 1500, 17),
        press(1520, liveSize(24)),
        press(1600, liveStart),
        ...rewindsEvery(1610, 1900, 23),
      ],
      runMs: 2100,
    });

    expect(difference).toBeNull();
    const fits = rewound.ofKind('grid-fitted');
    expect(fits.map((event) => event.taps)).toEqual([4, 5, 6]);
    expect(fits[1].grid).not.toEqual(fits[0].grid);
    expect(fits[2].grid).toEqual(fits[1].grid);
    expect(fits).toEqual(straight.ofKind('grid-fitted'));
    expect(rewound.picture().grid).toEqual(straight.picture().grid);
    expect(rewound.ofKind('picture').some((picture) => picture.loop?.live === true)).toBe(true);
  });
});

/** A tap on the position nearest a note start that lies a `fraction` of the way through what the deck has delivered, `jitter` frames off it. */
const tapNearBeat =
  (fraction: number, jitter: number) =>
  (deck: DeckId, rig: Rig): DeckCommand => {
    const updates = rig.ofKind('update', deck);
    const newest = updates[updates.length - 1].position;
    const position = 5 + 12 * Math.round((newest * fraction - 5) / 12) + jitter;
    const update = updates.find((item) => item.position === position);
    return { kind: 'tap', deck, atMs: update === undefined ? rig.time.ms : update.dueAtMs };
  };

describe('a deck rewound by taps at random moments', () => {
  for (let seed = 1; seed <= 12; seed++) {
    it(`reports and plays on what a straight deck does (seed ${seed})`, async () => {
      const next = random(seed * 32452843);
      const presses: Press[] = [];
      for (let i = 0, count = 14 + Math.floor(next() * 10); i < count; i++) {
        const atMs = 800 + Math.floor(next() * 1000);
        const kind = Math.floor(next() * 10);
        const fraction = 0.4 + next() * 0.6;
        const jitter = Math.floor(next() * 5) - 2;
        const ahead = next() < 0.3 ? Math.floor(next() * 5) : -1;
        const rewoundAfter = next() < 0.6;
        presses.push(
          press(atMs, (deck, rig): DeckCommand => {
            const when =
              ahead < 0 ? {} : { when: { at: 'frame' as const, frame: nextUnsent(rig) + ahead } };
            if (kind < 6) return { ...tapNearBeat(fraction, jitter)(deck, rig), ...when };
            if (kind === 6) return { ...tapEnd(deck), ...when };
            return { ...nudgeZero(deck), ...when };
          }),
        );
        if (rewoundAfter) presses.push(...justAfter(atMs));
      }

      const { difference, rewound, straight } = await compareRewound({
        tune: TAP_TUNE,
        lookaheadMs: 60 + Math.floor(next() * 3) * 30,
        presses,
        runMs: 2000,
      });

      expect(difference).toBeNull();
      // What a tap reports and leaves behind is what a deck that was never rewound reports and leaves.
      expect(rewound.ofKind('grid-fitted')).toEqual(straight.ofKind('grid-fitted'));
      expect(rewound.picture().grid).toEqual(straight.picture().grid);
    });
  }
});
