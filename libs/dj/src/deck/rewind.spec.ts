import { describe, expect, it } from 'vitest';
import type { DeckCommand, DeckId } from '../messages/commands.js';
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
