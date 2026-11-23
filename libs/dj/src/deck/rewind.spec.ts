import { describe, expect, it } from 'vitest';
import type { DeckCommand, DeckId, JumpTarget } from '../messages/commands.js';
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
    expect(rewound.picture().settings.main).toEqual([
      { setting: 1, value: 0 },
      { setting: 2, value: 0 },
      { setting: 3, value: 0 },
    ]);
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
        const kind = Math.floor(next() * 8);
        const ahead = next() < 0.3 ? Math.floor(next() * 5) : -1;
        const value = 0.6 + Math.floor(next() * 12) / 10;
        const voice = 1 + Math.floor(next() * 3);
        const on = next() < 0.5;
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
        press(150, (deck) => ({ kind: 'key', deck, target: LOOP_A })),
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
        press(150, (deck) => ({ kind: 'key', deck, target: LOOP_A })),
        press(250, (deck) => ({ kind: 'key', deck, target: LOOP_B })),
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
        press(150, (deck) => ({ kind: 'key', deck, target: LOOP_A })),
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
        press(150, (deck) => ({ kind: 'key', deck, target: LOOP_A })),
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
        press(150, (deck) => ({ kind: 'key', deck, target: LOOP_A })),
        press(250, (deck) => ({ kind: 'loop-bounds', deck, startFrame: 500, endFrame: 510 })),
        press(300, (deck) => ({ kind: 'loop-wraps', deck, wraps: true })),
        ...rewindsEvery(310, 600, 21),
        press(620, (deck) => ({ kind: 'key', deck, target: CUE })),
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
        press(150, (deck) => ({ kind: 'key', deck, target: own })),
        press(260, (deck) => ({ kind: 'setting', deck, setting: 1, value: 1 })),
        press(330, (deck) => ({ kind: 'key', deck, target: shared })),
        press(360, (deck) => ({ kind: 'loop-wraps', deck, wraps: true })),
        ...rewindsEvery(370, 800, 19),
        press(850, (deck) => ({ kind: 'key', deck, target: own })),
        press(1000, (deck) => ({ kind: 'let-go', deck })),
      ],
      runMs: 1200,
    });

    expect(difference).toBeNull();
    expect(landings(rewound)).toEqual(landings(straight));
    expect(rewound.picture()).toMatchObject({ settingsInPlay: 'main', loop: null });
    expect(rewound.picture().settings.main[0]).toEqual({ setting: 1, value: 0 });
    expect(rewound.warnings).toEqual([]);
  });
});

describe('a deck rewound by loop presses at random moments', () => {
  const OWN: JumpTarget = { startFrame: 200, endFrame: 230, settings: [{ setting: 2, value: 1 }] };
  const SHARED: JumpTarget = { startFrame: 300, endFrame: 330 };
  const OWN_WRAPS: JumpTarget = { startFrame: 1000, endFrame: 1020, wraps: true, settings: [] };
  const TARGET_LIST = [LOOP_A, LOOP_B, CUE, OWN, SHARED, OWN_WRAPS];

  for (let seed = 1; seed <= 16; seed++) {
    it(`gives what a straight deck gives (seed ${seed})`, async () => {
      const next = random(seed * 7919);
      const presses: Press[] = [];
      for (let i = 0, count = 6 + Math.floor(next() * 8); i < count; i++) {
        const atMs = 100 + Math.floor(next() * 800);
        const kind = Math.floor(next() * 12);
        const target = TARGET_LIST[Math.floor(next() * TARGET_LIST.length)];
        const ahead = next() < 0.3 ? Math.floor(next() * 5) : -1;
        const on = next() < 0.5;
        presses.push(
          press(atMs, (deck, rig): DeckCommand => {
            const when =
              ahead < 0 ? {} : { when: { at: 'frame' as const, frame: nextUnsent(rig) + ahead } };
            switch (kind) {
              case 0:
              case 1:
              case 2:
                return { kind: 'key', deck, target, ...when };
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
