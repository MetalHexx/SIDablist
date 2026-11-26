import { describe, expect, it } from 'vitest';
import type { DeckCommand, JumpTarget } from '../messages/commands.js';
import type { DeckPicture } from '../messages/reports.js';
import { Rig, type RigOptions } from '../testing/harness.js';
import type { Deck } from './deck.js';

/**
 * Spec-only. The hand on Still Time, whose delivered frame number is the playhead. The decks here
 * are the package's own class (`openDeck`), so the specs can watch the engine they own.
 */

/** Presses a command on a deck of the package's own class and lets the flush it scheduled run. */
async function send(rig: Rig, deck: Deck, command: DeckCommand): Promise<void> {
  expect(deck.refusal(command)).toBeNull();
  deck.receive(command);
  await rig.microtasks();
}

interface Fixture {
  readonly rig: Rig;
  readonly deck: Deck;
}

/** A deck on `tune` in the transport `ends`, with `targets` declared, after a few frames. */
async function deckOn(
  ends: 'playing' | 'paused' | 'stopped',
  options: { rig?: RigOptions; targets?: readonly number[]; tune?: string } = {},
): Promise<Fixture> {
  const rig = new Rig(options.rig);
  const { deck } = rig.openDeck('a', 60);
  await send(rig, deck, {
    kind: 'load',
    deck: 'a',
    tune: options.tune ?? 'still-time',
    subtune: 1,
    ends,
  });
  await rig.settle();
  if (options.targets !== undefined) {
    await send(rig, deck, { kind: 'targets', deck: 'a', frames: [...options.targets] });
    await rig.settle();
  }
  rig.advance(400);
  return { rig, deck };
}

const touch = (rig: Rig, deck: Deck): Promise<void> =>
  send(rig, deck, { kind: 'hand-touch', deck: 'a', atMs: rig.time.ms });
const move = (rig: Rig, deck: Deck, travelFrames: number, atMs = rig.time.ms): Promise<void> =>
  send(rig, deck, { kind: 'hand-move', deck: 'a', travelFrames, atMs });
const lift = (rig: Rig, deck: Deck, gripSeconds = 0.5, atMs = rig.time.ms): Promise<void> =>
  send(rig, deck, { kind: 'hand-lift', deck: 'a', atMs, gripSeconds });

/** The playhead each stream frame showed, the latest render of a frame winning over a rewound one. */
function playheads(rig: Rig): Map<number, number> {
  const seen = new Map<number, number>();
  for (const update of rig.ofKind('update', 'a')) seen.set(update.streamFrame, update.position);
  return seen;
}

function pictureOf(rig: Rig, deck: Deck): DeckPicture {
  deck.request({ kind: 'describe', deck: 'a' });
  const picture = rig.ofKind('picture', 'a').at(-1);
  if (picture === undefined) throw new Error('no picture');
  return picture;
}

/** Whether the engine is in varispeed. */
const inVarispeed = (deck: Deck): boolean => deck.player.getSnapshot().tempo.varispeed;

interface Watched {
  /** Entries into varispeed. */
  enters: number;
  /** Each exit: whether it was made from inside the rate source, and how many rates had been asked for. */
  leaves: { inSource: boolean; rates: number }[];
  /** Every rate the engine was given, in the order it asked. A rewind asks again for the frames it re-renders. */
  rates: number[];
}

/**
 * Watches the engine the deck owns, calling through to it: the entries into varispeed, the rates
 * the source gave and, for each exit, whether it was made from inside the rate source (which the
 * engine asks inside its tick).
 */
function watchVarispeed(deck: Deck): Watched {
  const player = deck.player;
  const watched: Watched = { enters: 0, leaves: [], rates: [] };
  let inSource = false;
  const enter = player.enterVarispeed.bind(player);
  const leave = player.leaveVarispeed.bind(player);
  player.enterVarispeed = (source) => {
    watched.enters++;
    return enter((position, intervalUs) => {
      inSource = true;
      try {
        const rate = source(position, intervalUs);
        watched.rates.push(rate);
        return rate;
      } finally {
        inSource = false;
      }
    });
  };
  player.leaveVarispeed = () => {
    watched.leaves.push({ inSource, rates: watched.rates.length });
    leave();
  };
  return watched;
}

describe('the hand on a record that plays', () => {
  it('puts the position on the anchor plus the travel while it is down, with no smoothing', async () => {
    const { rig, deck } = await deckOn('playing');
    await touch(rig, deck);
    rig.advance(100);
    const touched = rig.landed('hand-touch')[0].frame;
    const anchor = playheads(rig).get(touched)!;
    expect(pictureOf(rig, deck).hand).toBe('down');

    const landings: number[] = [];
    for (const travel of [-12.5, 30, 7.25, 0]) {
      await move(rig, deck, travel);
      rig.advance(100);
      landings.push(rig.landed('hand-move').at(-1)!.frame);
      expect(playheads(rig).get(landings.at(-1)! + 2)).toBe(Math.floor(anchor + travel));
    }
    expect(new Set(landings).size).toBe(4);
    expect(inVarispeed(deck)).toBe(true);
    rig.dispose();
  });

  it('keeps every move of a touch whose moves land on the same frame', async () => {
    const { rig, deck } = await deckOn('playing');
    await send(rig, deck, { kind: 'hand-touch', deck: 'a', atMs: 0 });
    rig.advance(100);
    const anchor = playheads(rig).get(rig.landed('hand-touch')[0].frame)!;

    deck.receive({ kind: 'hand-move', deck: 'a', travelFrames: 10, atMs: 1 });
    deck.receive({ kind: 'hand-move', deck: 'a', travelFrames: 25, atMs: 2 });
    deck.receive({ kind: 'hand-move', deck: 'a', travelFrames: 40, atMs: 3 });
    await rig.microtasks();
    rig.advance(100);

    const moves = rig.landed('hand-move');
    expect(moves).toHaveLength(3);
    expect(new Set(moves.map((event) => event.frame)).size).toBe(1);
    expect(playheads(rig).get(moves[0].frame + 2)).toBe(anchor + 40);
    rig.dispose();
  });

  it('carries on from where a seek put it, the hand holding the distance it moved', async () => {
    const { rig, deck } = await deckOn('playing', { targets: [300] });
    await touch(rig, deck);
    rig.advance(100);
    await move(rig, deck, 10);
    rig.advance(100);

    await send(rig, deck, { kind: 'seek', deck: 'a', frame: 300 });
    rig.advance(100);
    const seeked = rig.landed('seek')[0].frame;
    expect(playheads(rig).get(seeked + 3)).toBe(300);
    await move(rig, deck, 35);
    rig.advance(100);
    expect(playheads(rig).get(rig.landed('hand-move').at(-1)!.frame + 2)).toBe(325);
    rig.dispose();
  });

  describe('the release speed it throws with', () => {
    /**
     * Touches, moves through `samples` (travel, host time) and lifts at `liftAtMs`; the first throw
     * tick's advance, in whole frames: the playhead the deck reports is the frame the record is in.
     */
    async function firstThrownAdvance(
      samples: readonly (readonly [number, number])[],
      liftAtMs: number,
    ): Promise<{ advance: number; intervalMs: number }> {
      const { rig, deck } = await deckOn('playing');
      await touch(rig, deck);
      rig.advance(100);
      for (const [travel, atMs] of samples) {
        deck.receive({ kind: 'hand-move', deck: 'a', travelFrames: travel, atMs });
      }
      await rig.microtasks();
      rig.advance(100);
      await lift(rig, deck, 0.5, liftAtMs);
      rig.advance(100);
      const thrown = rig.landed('hand-lift')[0].frame;
      const heads = playheads(rig);
      const advance = heads.get(thrown)! - heads.get(thrown - 1)!;
      const intervalMs =
        rig.ofKind('update', 'a').find((u) => u.streamFrame === thrown)!.intervalUs / 1000;
      rig.dispose();
      return { advance, intervalMs };
    }

    it.each([
      ['fewer than two samples', [[40, 100]], 105, 0],
      [
        'a newest sample older than the window at the lift',
        [
          [0, 100],
          [10, 110],
        ],
        151,
        0,
      ],
      [
        'a newest sample just inside the window at the lift',
        [
          [0, 100],
          [10, 110],
        ],
        150,
        1,
      ],
      [
        'samples at one instant',
        [
          [0, 100],
          [50, 100],
        ],
        105,
        0,
      ],
      [
        'the oldest sample within 40 ms of the newest',
        [
          [0, 100],
          [30, 130],
          [60, 150],
          [100, 170],
        ],
        175,
        1.75,
      ],
      [
        'the newest eight of ten samples, across the ring wrapping',
        Array.from({ length: 10 }, (_, i) => [i * 20, i * 10] as const),
        95,
        2,
      ],
    ] as const)('takes %s', async (_name, samples, liftAtMs, speed) => {
      const { advance, intervalMs } = await firstThrownAdvance(samples, liftAtMs);
      expect(advance).toBe(Math.floor(speed * intervalMs));
    });
  });

  it('slows to 1x in steps of constant friction, then leaves varispeed once the tick is over', async () => {
    const { rig, deck } = await deckOn('playing');
    const watched = watchVarispeed(deck);
    await touch(rig, deck);
    rig.advance(100);
    // Landed on a frame not yet rendered, so no rewind asks the source again for a frame it gave.
    const ahead = rig.ofKind('update', 'a').at(-1)!.streamFrame + 3;
    await send(rig, deck, {
      kind: 'hand-lift',
      deck: 'a',
      atMs: rig.time.ms,
      gripSeconds: 0.5,
      when: { at: 'frame', frame: ahead },
    });
    rig.advance(1000);

    const step = rig.ofKind('update', 'a').at(-1)!.intervalUs / 1e6 / 0.5;
    const ramp = watched.rates.slice(watched.rates.findIndex((rate) => rate !== 0));
    expect(ramp.length).toBeGreaterThan(20);
    for (let i = 0; i < ramp.length - 1; i++) expect(ramp[i]).toBeCloseTo((i + 1) * step, 9);
    expect(ramp[ramp.length - 2]).toBeLessThan(1);
    expect(ramp[ramp.length - 1]).toBe(1);

    // The record plays on at 1x while the machine's image is made ahead, then the machine takes over.
    expect(pictureOf(rig, deck).hand).toBe('up');
    await rig.settle();
    rig.advance(2500);
    expect(inVarispeed(deck)).toBe(false);
    expect(watched.leaves).toEqual([{ inSource: false, rates: watched.rates.length }]);
    expect(rig.warnings).toEqual([]);
    rig.dispose();
  });

  it('grabs a thrown record again without entering varispeed again', async () => {
    const { rig, deck } = await deckOn('playing');
    const watched = watchVarispeed(deck);
    await touch(rig, deck);
    rig.advance(100);
    await lift(rig, deck, 5);
    rig.advance(100);
    expect(pictureOf(rig, deck).hand).toBe('thrown');

    await touch(rig, deck);
    rig.advance(100);
    const regrabbed = rig.landed('hand-touch')[1].frame;
    const anchor = playheads(rig).get(regrabbed)!;
    await move(rig, deck, 15);
    rig.advance(100);

    expect(pictureOf(rig, deck).hand).toBe('down');
    expect(playheads(rig).get(rig.landed('hand-move').at(-1)!.frame + 2)).toBeCloseTo(
      anchor + 15,
      6,
    );
    expect(watched.enters).toBe(1);
    rig.dispose();
  });

  it('changes nothing for a lift after a stop or a load, and its moves', async () => {
    for (const letGo of ['stop', 'load'] as const) {
      const { rig, deck } = await deckOn('playing');
      await touch(rig, deck);
      rig.advance(100);
      await move(rig, deck, 20);
      if (letGo === 'stop') await send(rig, deck, { kind: 'stop', deck: 'a' });
      else await send(rig, deck, { kind: 'load', deck: 'a', tune: 'still-time', subtune: 1 });
      await rig.settle();
      rig.advance(100);
      expect(pictureOf(rig, deck).hand).toBe('up');
      expect(inVarispeed(deck)).toBe(false);

      const watched = watchVarispeed(deck);
      await move(rig, deck, 60);
      await lift(rig, deck, 0.5);
      rig.advance(200);
      expect(pictureOf(rig, deck).hand).toBe('up');
      expect(inVarispeed(deck)).toBe(false);
      expect(watched).toEqual({ enters: 0, leaves: [], rates: [] });
      expect(rig.warnings).toEqual([]);
      rig.dispose();
    }
  });

  it('is not taken by a deck that is loading, or one whose register record has not arrived', async () => {
    const loading = await deckOn('playing');
    const held = loading.rig.holdFetch('insid3-out');
    // Sent in one turn, so the touch is taken at the door and lands after the load has begun.
    const load: DeckCommand = { kind: 'load', deck: 'a', tune: 'insid3-out', subtune: 1 };
    loading.deck.receive(load);
    loading.deck.receive({ kind: 'hand-touch', deck: 'a', atMs: 0 });
    await loading.rig.microtasks();
    // The load waits for the frames before it to pass, then begins and waits on its tune.
    loading.rig.advance(100);
    expect(pictureOf(loading.rig, loading.deck).hand).toBe('up');
    expect(inVarispeed(loading.deck)).toBe(false);
    expect(loading.deck.refusal({ kind: 'hand-touch', deck: 'a', atMs: 0 })).toMatch(/loading/);
    held.release();
    await loading.rig.settle();
    loading.rig.advance(100);
    expect(pictureOf(loading.rig, loading.deck).hand).toBe('up');
    expect(inVarispeed(loading.deck)).toBe(false);
    loading.rig.dispose();

    const bare = await deckOn('playing', { rig: { scan: 'held' } });
    await touch(bare.rig, bare.deck);
    await move(bare.rig, bare.deck, 10);
    bare.rig.advance(100);
    expect(pictureOf(bare.rig, bare.deck).hand).toBe('up');
    expect(inVarispeed(bare.deck)).toBe(false);

    bare.rig.releaseScans();
    await bare.rig.settle();
    await touch(bare.rig, bare.deck);
    bare.rig.advance(100);
    expect(pictureOf(bare.rig, bare.deck).hand).toBe('down');
    bare.rig.dispose();
  });
});

describe('the hand on a deck that is not ready', () => {
  it('refuses a touch on an empty deck, and takes the moves and the lift as releases that change nothing', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    rig.send({ kind: 'hand-touch', deck: 'a', atMs: 0 });
    rig.send({ kind: 'hand-move', deck: 'a', travelFrames: 10, atMs: 1 });
    rig.send({ kind: 'hand-lift', deck: 'a', atMs: 2, gripSeconds: 0.5 });
    await rig.microtasks();

    expect(rig.warnings).toEqual(['dj: refused hand-touch: hand-touch on a deck that is empty']);
    expect(rig.picture('a')).toMatchObject({ hand: 'up', transport: 'empty' });
    rig.dispose();
  });
});

describe('the hand on a record that is paused or stopped', () => {
  it('lands a move in held frames with a rewind, not a frontier landing, on a paused record', async () => {
    const { rig, deck } = await deckOn('paused');
    await touch(rig, deck);
    rig.advance(100);
    expect(inVarispeed(deck)).toBe(true);
    const before = pictureOf(rig, deck).timing;

    await move(rig, deck, 25);
    const after = pictureOf(rig, deck).timing;
    rig.advance(100);

    expect(after.rewinds).toBeGreaterThan(before.rewinds);
    expect(after.frontierLandings).toBe(0);
    expect(playheads(rig).get(rig.landed('hand-move')[0].frame + 2)).toBeCloseTo(25, 6);
    expect(deck.player.getSnapshot().transport).toBe('paused');
    rig.dispose();
  });

  it('lands every command at the frontier on a stopped record, and counts it', async () => {
    const { rig, deck } = await deckOn('stopped');
    await touch(rig, deck);
    rig.advance(100);
    expect(inVarispeed(deck)).toBe(true);
    const before = pictureOf(rig, deck).timing;

    await move(rig, deck, 25);
    const after = pictureOf(rig, deck).timing;
    rig.advance(100);

    expect(after.frontierLandings).toBe(before.frontierLandings + 1);
    expect(after.rewinds).toBe(before.rewinds);
    expect(playheads(rig).get(rig.landed('hand-move')[0].frame + 2)).toBeCloseTo(25, 6);
    expect(deck.player.getSnapshot().transport).toBe('stopped');
    rig.dispose();
  });

  it('settles at the position when the throw arrives, and a play sent meanwhile resumes exactly there', async () => {
    const { rig, deck } = await deckOn('paused');
    await touch(rig, deck);
    rig.advance(100);
    await move(rig, deck, 30);
    rig.advance(100);

    const player = deck.player;
    const calls: string[] = [];
    let seeking = 0;
    const seek = player.seek.bind(player);
    const play = player.play.bind(player);
    player.seek = (frame, settings) => {
      const done = seek(frame, settings);
      seeking++;
      calls.push(`seek ${frame}`);
      void done.finally(() => seeking--);
      return done;
    };
    player.play = () => {
      calls.push(`play, ${seeking} seeks outstanding`);
      return play();
    };

    // Landed on a frame not yet rendered, so the arrival happens in the ticks that follow.
    const ahead = rig.ofKind('update', 'a').at(-1)!.streamFrame + 3;
    await send(rig, deck, {
      kind: 'hand-lift',
      deck: 'a',
      atMs: rig.time.ms,
      gripSeconds: 0.5,
      when: { at: 'frame', frame: ahead },
    });
    // The throw's first tick has a rate of 0, the deck's own: it arrives, and its landing is awaited.
    while (inVarispeed(deck)) rig.advance(5);
    expect(seeking).toBe(1);
    deck.receive({ kind: 'play', deck: 'a' });
    await rig.settle();
    rig.advance(200);

    expect(calls).toEqual(['seek 30', 'play, 0 seeks outstanding']);
    expect(deck.player.getSnapshot().transport).toBe('playing');
    const played = rig.frames('a').map((frame) => frame.frameNumber);
    const from = played.lastIndexOf(30);
    expect(played.slice(from, from + 10)).toEqual(Array.from({ length: 10 }, (_, i) => 30 + i));
    expect(rig.warnings).toEqual([]);
    rig.dispose();
  });
});

describe('the hand inside a loop', () => {
  const STOPS: JumpTarget = { startFrame: 100, endFrame: 140 };
  const WRAPS: JumpTarget = { startFrame: 100, endFrame: 140, wraps: true };

  async function inLoop(loop: JumpTarget): Promise<Fixture> {
    const fixture = await deckOn('playing', { targets: [100] });
    await send(fixture.rig, fixture.deck, { kind: 'hot-cue', deck: 'a', target: loop });
    fixture.rig.advance(200);
    expect(pictureOf(fixture.rig, fixture.deck).loop).toMatchObject({ startFrame: 100 });
    return fixture;
  }

  it('stops a record thrown backward at the start of a loop that stops, and climbs from standstill', async () => {
    const { rig, deck } = await inLoop(STOPS);
    await touch(rig, deck);
    rig.advance(100);
    const anchor = playheads(rig).get(rig.landed('hand-touch')[0].frame)!;
    // Backward at 1 frame/ms, from inside the loop to well past its start.
    for (let i = 0; i < 6; i++) {
      await move(rig, deck, -(i + 1) * 20, 100 + i * 20);
      rig.advance(20);
    }
    await lift(rig, deck, 0.5, 220);
    rig.advance(1500);

    const heads = [...playheads(rig).values()].slice(-60);
    const thrown = rig.landed('hand-lift')[0].frame;
    const during = [...playheads(rig)].filter(([frame]) => frame >= thrown).map(([, head]) => head);
    expect(anchor).toBeGreaterThanOrEqual(100);
    expect(Math.min(...during)).toBe(100);
    expect(heads.every((head) => head >= 100 && head < 140)).toBe(true);
    expect(pictureOf(rig, deck).hand).toBe('up');
    expect(rig.warnings).toEqual([]);
    rig.dispose();
  });

  it('wraps a record thrown backward round a loop that wraps', async () => {
    const { rig, deck } = await inLoop(WRAPS);
    await touch(rig, deck);
    rig.advance(100);
    for (let i = 0; i < 6; i++) {
      await move(rig, deck, -(i + 1) * 20, 100 + i * 20);
      rig.advance(20);
    }
    await lift(rig, deck, 0.5, 220);
    rig.advance(300);

    const thrown = rig.landed('hand-lift')[0].frame;
    const during = [...playheads(rig)].filter(([frame]) => frame >= thrown).map(([, head]) => head);
    expect(Math.max(...during.slice(1))).toBeGreaterThan(130);
    expect(during.some((head, i) => i > 0 && head - during[i - 1] > 20)).toBe(true);
    expect(during.every((head) => head >= 100 && head < 140)).toBe(true);
    rig.dispose();
  });
});
