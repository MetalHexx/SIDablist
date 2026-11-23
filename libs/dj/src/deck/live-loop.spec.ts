import { loopStartAtOrBefore } from '@sidablist/analysis';
import type { ActiveLoop } from '@sidablist/core';
import { describe, expect, it } from 'vitest';
import type { DeckCommand, DeckId, Grid, JumpTarget } from '../messages/commands.js';
import type { DeckPicture } from '../messages/reports.js';
import { Rig, type RigOptions } from '../testing/harness.js';
import type { Deck } from './deck.js';

/**
 * Spec-only. The live looper on Still Time, whose delivered frame number is the playhead. The decks
 * are the package's own class (`openDeck`), so the specs can watch the calls the engine takes and
 * the position each is made at; a run is deterministic, so a probe run can name the position a
 * later run will have when it presses the same commands at the same moments.
 */

const GRID: Grid = { beatFrames: 20, beatOneFrame: 0 };
const UNDER: JumpTarget = { startFrame: 100, endFrame: 140 };
const QUEUED: JumpTarget = { startFrame: 300, endFrame: 320 };
const TARGETS = [100, 300];

type RunningLoop = Exclude<ActiveLoop, null>;

interface Seen {
  /** Every engine call of interest, in order: its name. */
  readonly order: string[];
  /** Each `setActiveLoop`, the playhead it was made at. */
  readonly loops: { loop: RunningLoop | null; position: number }[];
  readonly changes: { at: number; loop: RunningLoop; position: number }[];
  readonly lands: { at: unknown }[];
  readonly captures: unknown[];
}

/** Watches the engine the deck owns, calling through to it. */
function watch(deck: Deck): Seen {
  const player = deck.player;
  const seen: Seen = { order: [], loops: [], changes: [], lands: [], captures: [] };
  const setActiveLoop = player.setActiveLoop.bind(player);
  player.setActiveLoop = (loop) => {
    seen.order.push('setActiveLoop');
    seen.loops.push({ loop, position: player.getPosition() });
    setActiveLoop(loop);
  };
  const changeLoopAt = player.changeLoopAt.bind(player);
  player.changeLoopAt = (at, loop) => {
    seen.changes.push({ at, loop, position: player.getPosition() });
    return changeLoopAt(at, loop);
  };
  const land = player.land.bind(player);
  player.land = (at, settings) => {
    seen.order.push('land');
    seen.lands.push({ at });
    return land(at, settings);
  };
  const landOnShadow = player.landOnShadow.bind(player);
  player.landOnShadow = (settings) => {
    seen.order.push('landOnShadow');
    return landOnShadow(settings);
  };
  const setCrossingCaptures = player.setCrossingCaptures.bind(player);
  player.setCrossingCaptures = (lines) => {
    seen.captures.push(lines);
    setCrossingCaptures(lines);
  };
  return seen;
}

/**
 * Presses a command and lets one frame pass: a deck takes a second command in the same turn only
 * after the next wake, so each press gets its own.
 */
async function send(rig: Rig, deck: Deck, command: DeckCommand): Promise<void> {
  deck.receive(command);
  await rig.microtasks();
  rig.advance(20);
}

interface Options {
  readonly grid?: Grid | null;
  readonly rig?: RigOptions;
  readonly slip?: boolean;
  /** How long the deck plays before anything is pressed, in milliseconds. */
  readonly playMs?: number;
}

interface Fixture {
  readonly rig: Rig;
  readonly deck: Deck;
  readonly seen: Seen;
}

/** A deck playing Still Time with `grid` (the default one unless null), the targets declared and the engine watched. */
async function playing(options: Options = {}): Promise<Fixture> {
  const rig = new Rig(options.rig);
  const { deck } = rig.openDeck('a', 60);
  const seen = watch(deck);
  const grid = options.grid === undefined ? GRID : options.grid;
  await send(rig, deck, {
    kind: 'load',
    deck: 'a',
    tune: 'still-time',
    subtune: 1,
    ends: 'playing',
    ...(grid === null ? {} : { grid }),
  });
  await rig.settle();
  await send(rig, deck, { kind: 'targets', deck: 'a', frames: TARGETS });
  await rig.settle();
  if (options.slip === true) await send(rig, deck, { kind: 'slip', deck: 'a', on: true });
  rig.advance(options.playMs ?? 800);
  return { rig, deck, seen };
}

const sizeOf = (lengthFrames: number): DeckCommand => ({
  kind: 'live-loop-size',
  deck: 'a',
  lengthFrames,
});
const LIVE: DeckCommand = { kind: 'live-loop', deck: 'a' };
const END: DeckCommand = { kind: 'live-loop-end', deck: 'a' };

function pictureOf(rig: Rig, deck: Deck): DeckPicture {
  deck.request({ kind: 'describe', deck: 'a' });
  const picture = rig.ofKind('picture', 'a').at(-1);
  if (picture === undefined) throw new Error('no picture');
  return picture;
}

/** The playhead each stream frame showed, the latest render of a frame winning over a rewound one. */
function playheads(rig: Rig, id: DeckId = 'a'): Map<number, number> {
  const seen = new Map<number, number>();
  for (const update of rig.ofKind('update', id)) seen.set(update.streamFrame, update.position);
  return seen;
}

/** The frame a live loop starts on and the playhead it was pushed at: `ahead` is one frame past it. */
function pushedAt(seen: Seen): { start: number; ahead: number } {
  const call = seen.loops.find((item) => item.loop?.varispeedStart === 'wrap');
  if (call === undefined || call.loop === null) throw new Error('no live loop was set');
  return { start: call.loop.startFrame, ahead: Math.floor(call.position) + 1 };
}

/**
 * Sends the size and a push in one turn, so both land on one frame, the same way every time: a probe
 * run's playhead is the run's. The lines a size declares are then declared at the playhead, with
 * none of the lines behind it crossed since.
 */
async function push(fixture: Fixture, lengthFrames: number): Promise<void> {
  fixture.deck.receive(sizeOf(lengthFrames));
  fixture.deck.receive(LIVE);
  await fixture.rig.microtasks();
  fixture.rig.advance(60);
}

/** A deck with `UNDER` running, so a live loop can be pushed over it. */
async function overLoop(options: Options = {}): Promise<Fixture> {
  const fixture = await playing(options);
  await send(fixture.rig, fixture.deck, { kind: 'key', deck: 'a', target: UNDER });
  fixture.rig.advance(200);
  expect(pictureOf(fixture.rig, fixture.deck).loop).toMatchObject({ startFrame: 100 });
  return fixture;
}

describe('where a live loop starts', () => {
  it('starts on the last line at or behind the frame one past the playhead', async () => {
    const probe = await playing();
    await push(probe, 20);
    const { ahead } = pushedAt(probe.seen);
    probe.rig.dispose();

    // A line on the frame one past the playhead is the start: a playhead search would take the line before.
    const cases: { beatOneFrame: number; expected: number }[] = [
      { beatOneFrame: ahead, expected: ahead },
      { beatOneFrame: ahead - 1, expected: ahead - 1 },
      { beatOneFrame: ahead - 7, expected: ahead - 7 },
    ];
    for (const { beatOneFrame, expected } of cases) {
      const run = await playing({ grid: { beatFrames: 20, beatOneFrame } });
      await push(run, 20);
      expect(pushedAt(run.seen)).toEqual({ start: expected, ahead });
      expect(pictureOf(run.rig, run.deck).loop).toMatchObject({
        startFrame: expected,
        endFrame: expected + 20,
        wraps: true,
        live: true,
      });
      run.rig.dispose();
    }
  });

  it('starts on a line of its own size below a beat', async () => {
    const probe = await playing();
    await push(probe, 10);
    const { ahead } = pushedAt(probe.seen);
    probe.rig.dispose();

    const run = await playing({ grid: { beatFrames: 20, beatOneFrame: ahead - 4 } });
    await push(run, 10);
    expect(pushedAt(run.seen).start).toBe(
      loopStartAtOrBefore({ beatFrames: 20, beatOneFrame: ahead - 4 }, 10, ahead),
    );
    expect(pushedAt(run.seen).start).toBe(ahead - 4);
    run.rig.dispose();
  });

  it('moves to the next line when the line behind has no image and no record can land on it', async () => {
    // The line of the size behind the playhead is crossed before they are declared, and is no beat line,
    // which the load declared.
    const probe = await playing({ rig: { scan: 'held' } });
    await push(probe, 10);
    const { ahead } = pushedAt(probe.seen);
    probe.rig.dispose();
    const grid = { beatFrames: 20, beatOneFrame: ahead - 13 };

    const held = await playing({ grid, rig: { scan: 'held' } });
    await push(held, 10);
    expect(pushedAt(held.seen).start).toBe(ahead + 7);
    expect(pictureOf(held.rig, held.deck).loop).toMatchObject({ startFrame: ahead + 7 });
    held.rig.dispose();

    const recorded = await playing({ grid });
    await push(recorded, 10);
    expect(pushedAt(recorded.seen).start).toBe(ahead - 3);
    recorded.rig.dispose();
  });
});

describe('resizing a live loop', () => {
  it('grows at once and drops a shrink that waits', async () => {
    const { rig, deck, seen } = await playing();
    await push({ rig, deck, seen }, 40);
    const { start } = pushedAt(seen);
    rig.advance(300);
    await send(rig, deck, sizeOf(10));
    expect(pictureOf(rig, deck).liveLoop?.pendingEndFrame).toBe(start + 10);

    await send(rig, deck, sizeOf(60));
    const grown = pictureOf(rig, deck);
    expect(grown.loop).toMatchObject({ startFrame: start, endFrame: start + 60, live: true });
    expect(grown.liveLoop).toEqual({ lengthFrames: 60, pendingEndFrame: null, overLoop: false });
    expect(deck.player.getSnapshot().tune?.loopChange).toBeNull();
    rig.dispose();
  });

  it('applies a shrink at once up to two frames short of the lap it would end, and waits past it', async () => {
    const probe = await playing();
    await push(probe, 60);
    await send(probe.rig, probe.deck, sizeOf(10));
    const probed = probe.seen.changes.at(-1) ?? probe.seen.loops.at(-1)!;
    const { start } = pushedAt(probe.seen);
    probe.rig.dispose();

    // With the playhead at `probed.position`, a size of `position - start + 2` is the last that applies at once.
    const lastAtOnce = Math.floor(probed.position) - start + 2;
    expect(lastAtOnce).toBeGreaterThanOrEqual(3);
    for (const [length, waits] of [
      [lastAtOnce, false],
      [lastAtOnce - 1, true],
    ] as const) {
      const run = await playing();
      await push(run, 60);
      const before = run.seen.changes.length;
      const loopsBefore = run.seen.loops.length;
      await send(run.rig, run.deck, sizeOf(length));
      expect(run.seen.changes.length - before).toBe(waits ? 1 : 0);
      expect(run.seen.loops.length - loopsBefore).toBe(waits ? 0 : 1);
      if (!waits) {
        expect(pictureOf(run.rig, run.deck).loop?.endFrame).toBe(start + length);
      }
      run.rig.dispose();
    }
  });

  it('shows the shrink as pending until the engine has taken it, ending the lap that holds the playhead', async () => {
    const { rig, deck, seen } = await playing();
    await push({ rig, deck, seen }, 60);
    const { start } = pushedAt(seen);
    rig.advance(300);
    await send(rig, deck, sizeOf(10));
    const named = seen.changes.at(-1)!;
    expect(named.loop).toMatchObject({ startFrame: start, endFrame: start + 10 });
    // A whole frame, a lap end of the new size at or after the frame past the playhead.
    expect((named.at - start) % 10).toBe(0);
    expect(named.at).toBeGreaterThan(Math.floor(named.position) + 1);
    expect(named.at).toBeLessThanOrEqual(Math.floor(named.position) + 11);
    expect(pictureOf(rig, deck).liveLoop?.pendingEndFrame).toBe(start + 10);

    rig.advance(1000);
    const landed = pictureOf(rig, deck);
    expect(landed.liveLoop).toEqual({ lengthFrames: 10, pendingEndFrame: null, overLoop: false });
    expect(landed.loop).toMatchObject({ startFrame: start, endFrame: start + 10 });
    rig.dispose();
  });

  it('replaces a waiting shrink with a newer size', async () => {
    const { rig, deck, seen } = await playing();
    await push({ rig, deck, seen }, 60);
    const { start } = pushedAt(seen);
    rig.advance(700);
    deck.receive(sizeOf(10));
    deck.receive(sizeOf(30));
    await rig.microtasks();
    rig.advance(20);
    expect(seen.changes.map((change) => change.loop.endFrame)).toEqual([start + 10, start + 30]);
    expect(pictureOf(rig, deck).liveLoop?.pendingEndFrame).toBe(start + 30);
    rig.dispose();
  });

  it('keeps a size that is not whole, lapping in the alternating whole lengths from the line it started on', async () => {
    const grid = { beatFrames: 50, beatOneFrame: 0 };
    const { rig, deck, seen } = await playing({ grid });
    await push({ rig, deck, seen }, 31.5);
    const { start } = pushedAt(seen);
    const picture = pictureOf(rig, deck);
    expect(picture.loop).toMatchObject({ startFrame: start, endFrame: start + 31.5, live: true });
    expect(picture.liveLoop?.lengthFrames).toBe(31.5);
    expect(picture.liveLoopSize).toBe(31.5);

    rig.advance(4500);
    const heads = [...playheads(rig)].sort((a, b) => a[0] - b[0]).map(([, position]) => position);
    const wraps: number[] = [];
    for (let i = 1; i < heads.length; i++) if (heads[i] < heads[i - 1]) wraps.push(i);
    const laps = wraps.slice(1).map((wrap, i) => wrap - wraps[i]);
    expect(laps.length).toBeGreaterThanOrEqual(4);
    expect(new Set(laps)).toEqual(new Set([31, 32]));
    for (let i = 1; i < laps.length; i++) expect(laps[i] + laps[i - 1]).toBe(63);
    rig.dispose();
  });
});

describe('ending a live loop with none underneath', () => {
  it('leaves the loop and plays on from where the playhead is with slip off', async () => {
    const { rig, deck, seen } = await playing();
    await push({ rig, deck, seen }, 20);
    await send(rig, deck, END);
    rig.advance(100);
    const picture = pictureOf(rig, deck);
    expect(picture.loop).toBeNull();
    expect(picture.liveLoop).toBeNull();
    expect(picture.liveLoopSize).toBe(20);
    expect(seen.lands).toEqual([]);
    expect(seen.loops.at(-1)?.loop).toBeNull();
    rig.dispose();
  });

  it('lands on the count slip kept with slip on, and engages a loop queued over it at once', async () => {
    const { rig, deck, seen } = await playing({ slip: true });
    await push({ rig, deck, seen }, 20);
    expect(pictureOf(rig, deck).slip).toEqual({ on: true, departed: true });
    await send(rig, deck, { kind: 'key', deck: 'a', target: QUEUED });
    expect(pictureOf(rig, deck).queued).toEqual(QUEUED);
    seen.order.length = 0;

    await send(rig, deck, END);
    rig.advance(100);
    expect(seen.order.slice(0, 2)).toEqual(['landOnShadow', 'setActiveLoop']);
    const picture = pictureOf(rig, deck);
    expect(picture.liveLoop).toBeNull();
    expect(picture.queued).toBeNull();
    expect(picture.loop).toMatchObject({ startFrame: 300, endFrame: 320, live: false });
    rig.dispose();
  });
});

describe('ending a live loop over a loop', () => {
  /** The frames the deck is on: slip on, `UNDER` lapped and a live loop pushed over it; a control deck laps it alone. */
  async function twoDecks(): Promise<Rig> {
    const rig = new Rig();
    for (const id of ['a', 'c']) {
      rig.addDeck(id, { lookaheadMs: 60 });
      await rig.load(id, 'still-time', { ends: 'playing', ...(id === 'a' ? { grid: GRID } : {}) });
      rig.send({ kind: 'targets', deck: id, frames: TARGETS });
    }
    await rig.settle();
    rig.send({ kind: 'slip', deck: 'a', on: true });
    rig.advance(300);
    for (const id of ['a', 'c']) rig.send({ kind: 'key', deck: id, target: UNDER });
    await rig.microtasks();
    rig.advance(200);
    return rig;
  }

  it('lands on slip’s count with slip on, which is where the loop underneath would be', async () => {
    const rig = await twoDecks();
    rig.send({ kind: 'live-loop-size', deck: 'a', lengthFrames: 60 });
    rig.send({ kind: 'live-loop', deck: 'a' });
    await rig.microtasks();
    rig.advance(300);
    expect(rig.picture('a')).toMatchObject({
      liveLoop: { overLoop: true },
      slip: { departed: true },
    });
    expect(rig.picture('a').loop).toMatchObject({ live: true });

    rig.send({ kind: 'live-loop-end', deck: 'a' });
    await rig.microtasks();
    rig.advance(300);
    const ended = rig.landed('live-loop-end')[0].frame;
    const mine = playheads(rig, 'a');
    const theirs = playheads(rig, 'c');
    for (let frame = ended + 1; frame < ended + 16; frame++) {
      expect(mine.get(frame)).toBe(theirs.get(frame));
    }
    expect(rig.picture('a')).toMatchObject({
      liveLoop: null,
      loop: { startFrame: 100, endFrame: 140, live: false },
    });
    expect(rig.warnings).toEqual([]);
    rig.dispose();
  });

  it('puts the loop underneath back before slip lands, with slip on or off', async () => {
    for (const slip of [true, false]) {
      const { rig, deck, seen } = await overLoop({ slip });
      await push({ rig, deck, seen }, 60);
      seen.order.length = 0;
      await send(rig, deck, END);
      expect(seen.order[0]).toBe('setActiveLoop');
      expect(seen.loops.at(-1)?.loop).toMatchObject({ startFrame: 100, endFrame: 140 });
      if (slip) expect(seen.order[1]).toBe('landOnShadow');
      rig.dispose();
    }
  });

  it('folds the playhead into the loop with slip off, on the gate-off frame or off it', async () => {
    const folds = new Set<string>();
    for (let waitMs = 0; waitMs < 700; waitMs += 20) {
      const { rig, deck, seen } = await overLoop();
      await send(rig, deck, sizeOf(60));
      await send(rig, deck, LIVE);
      rig.advance(100 + waitMs);
      seen.order.length = 0;
      seen.lands.length = 0;
      const loopsBefore = seen.loops.length;
      await send(rig, deck, END);

      const position = Math.floor(seen.loops[loopsBefore].position);
      expect(seen.loops[loopsBefore].loop).toMatchObject({ startFrame: 100, endFrame: 140 });
      if (position < 100 + 40 - 1) {
        expect(seen.lands).toEqual([]);
        folds.add('inside');
      } else {
        const folded = 100 + ((position - 100) % 40);
        const gateOff = folded === 100 + 40 - 1;
        expect(seen.lands).toEqual([
          { at: gateOff ? { frame: 100, held: true } : { frame: folded, held: false } },
        ]);
        folds.add(gateOff ? 'gate-off' : 'fold');
      }
      expect(pictureOf(rig, deck)).toMatchObject({
        liveLoop: null,
        loop: { startFrame: 100, endFrame: 140, live: false },
      });
      rig.dispose();
    }
    expect([...folds].sort()).toEqual(['fold', 'gate-off', 'inside']);
  });

  it('folds a length that is not whole carrying the lap phase of the lap it lands in', async () => {
    const fractional: JumpTarget = { startFrame: 100, endFrame: 117.4 };
    const { rig, deck, seen } = await playing();
    await send(rig, deck, { kind: 'key', deck: 'a', target: fractional });
    rig.advance(200);
    await send(rig, deck, sizeOf(60));
    await send(rig, deck, LIVE);
    rig.advance(400);
    seen.lands.length = 0;
    await send(rig, deck, END);

    expect(seen.lands).toHaveLength(1);
    const at = seen.lands[0].at as { frame: number; held: boolean; lapPhase?: number };
    expect(at.frame).toBeGreaterThanOrEqual(100);
    expect(at.frame).toBeLessThanOrEqual(117);
    expect(at.lapPhase).toBeDefined();
    expect(pictureOf(rig, deck).loop).toMatchObject({ startFrame: 100, endFrame: 117.4 });
    rig.dispose();
  });

  it('plays on with no loop until the folded frame can be landed on, then puts the loop and its queue back', async () => {
    let waited = 0;
    for (let waitMs = 0; waitMs < 700 && waited === 0; waitMs += 20) {
      const { rig, deck, seen } = await overLoop({ rig: { scan: 'held' } });
      await send(rig, deck, sizeOf(60));
      await send(rig, deck, LIVE);
      await send(rig, deck, { kind: 'key', deck: 'a', target: QUEUED });
      rig.advance(100 + waitMs);
      seen.lands.length = 0;
      const loopsBefore = seen.loops.length;
      await send(rig, deck, END);
      if (seen.lands.length === 0) {
        rig.dispose();
        continue;
      }
      waited++;
      const position = Math.floor(seen.loops[loopsBefore].position);
      const folded = 100 + ((position - 100) % 40);
      expect(seen.lands).toHaveLength(1);
      // The loop goes back, the deck plays on with none while the folded frame is declared and
      // waited for, and the loop is set again as that frame is seeked: with the loop queued behind it.
      const bounds = { startFrame: 100, endFrame: 140 };
      expect(seen.loops.slice(loopsBefore).map((item) => item.loop)).toEqual([
        expect.objectContaining(bounds),
        null,
        expect.objectContaining(bounds),
      ]);
      expect(rig.landed().some((event) => event.command.kind === 'seek')).toBe(false);
      expect(pictureOf(rig, deck)).toMatchObject({
        queued: QUEUED,
        loop: { ...bounds, live: false },
        liveLoop: null,
      });
      rig.advance(100);
      const landed = rig.ofKind('jump-landed', 'a').filter((event) => event.via === 'ready');
      expect(landed.map((event) => event.startFrame)).toEqual([folded]);
      expect(rig.ofKind('jump-landed', 'a').at(-1)).toMatchObject({
        via: 'pass-end',
        startFrame: 300,
      });
      rig.dispose();
    }
    expect(waited).toBe(1);
  });
});

describe('a loop that lands over a live loop', () => {
  it('queued by a key lands at the live loop’s end of pass and ends it', async () => {
    const { rig, deck, seen } = await overLoop();
    await push({ rig, deck, seen }, 20);
    await send(rig, deck, { kind: 'key', deck: 'a', target: QUEUED });
    expect(pictureOf(rig, deck)).toMatchObject({ queued: QUEUED, liveLoop: { overLoop: true } });
    rig.advance(400);
    const picture = pictureOf(rig, deck);
    expect(picture.liveLoop).toBeNull();
    expect(picture.queued).toBeNull();
    expect(picture.loop).toMatchObject({ startFrame: 300, endFrame: 320, live: false });
    expect(rig.ofKind('jump-landed', 'a').at(-1)).toMatchObject({
      via: 'pass-end',
      startFrame: 300,
    });
    rig.dispose();
  });

  it('queued by a jump at the end of the pass lands there, and a jump now ends it at once', async () => {
    const { rig, deck, seen } = await playing();
    await push({ rig, deck, seen }, 20);
    await send(rig, deck, { kind: 'jump', deck: 'a', target: QUEUED, when: { at: 'pass-end' } });
    rig.advance(400);
    expect(pictureOf(rig, deck)).toMatchObject({
      liveLoop: null,
      loop: { startFrame: 300, endFrame: 320, live: false },
    });

    await push({ rig, deck, seen }, 20);
    expect(pictureOf(rig, deck).liveLoop).not.toBeNull();
    await send(rig, deck, { kind: 'jump', deck: 'a', target: UNDER });
    rig.advance(100);
    expect(pictureOf(rig, deck)).toMatchObject({
      liveLoop: null,
      loop: { startFrame: 100, endFrame: 140, live: false },
    });
    rig.dispose();
  });
});

describe('dropping a live loop', () => {
  const drops: [string, DeckCommand][] = [
    ['stop-loop', { kind: 'stop-loop', deck: 'a' }],
    ['a seek', { kind: 'seek', deck: 'a', frame: 300 }],
    ['stop', { kind: 'stop', deck: 'a' }],
  ];
  for (const [name, command] of drops) {
    it(`leaves nothing looping on ${name}, the loop underneath with it`, async () => {
      const { rig, deck, seen } = await overLoop({ slip: true });
      await push({ rig, deck, seen }, 20);
      await send(rig, deck, command);
      rig.advance(300);
      const picture = pictureOf(rig, deck);
      expect(picture.loop).toBeNull();
      expect(picture.liveLoop).toBeNull();
      expect(picture.slip.departed).toBe(false);
      await send(rig, deck, END);
      expect(pictureOf(rig, deck).loop).toBeNull();
      rig.dispose();
    });
  }

  it('lands on slip’s count on stop-loop when the live loop is its only departure, as the end does', async () => {
    for (const command of ['stop-loop', 'live-loop-end'] as const) {
      const rig = new Rig();
      for (const id of ['a', 'c']) {
        rig.addDeck(id, { lookaheadMs: 60 });
        await rig.load(id, 'still-time', {
          ends: 'playing',
          ...(id === 'a' ? { grid: GRID } : {}),
        });
      }
      await rig.settle();
      rig.send({ kind: 'slip', deck: 'a', on: true });
      rig.advance(300);
      rig.send({ kind: 'live-loop-size', deck: 'a', lengthFrames: 20 });
      rig.send({ kind: 'live-loop', deck: 'a' });
      await rig.microtasks();
      rig.advance(600);
      expect(rig.picture('a')).toMatchObject({
        liveLoop: { overLoop: false },
        slip: { departed: true },
      });

      rig.send({ kind: command, deck: 'a' });
      await rig.microtasks();
      rig.advance(300);
      const landed = rig.landed(command)[0].frame;
      const mine = playheads(rig, 'a');
      const theirs = playheads(rig, 'c');
      for (let frame = landed + 1; frame < landed + 16; frame++) {
        expect(mine.get(frame)).toBe(theirs.get(frame));
      }
      expect(rig.picture('a').slip.departed).toBe(false);
      rig.dispose();
    }
  });

  it('drops with the load that has no grid', async () => {
    const { rig, deck, seen } = await playing();
    await push({ rig, deck, seen }, 20);
    await send(rig, deck, { kind: 'load', deck: 'a', tune: 'still-time', subtune: 1 });
    await rig.settle();
    expect(pictureOf(rig, deck)).toMatchObject({ loop: null, liveLoop: null, grid: null });
    expect(deck.refusal(LIVE)).toContain('no grid');
    expect(seen.captures.at(-1)).toEqual([]);
    rig.dispose();
  });

  it('ends when the engine’s loop is gone', async () => {
    const { rig, deck, seen } = await playing();
    await push({ rig, deck, seen }, 20);
    deck.player.setActiveLoop(null);
    rig.advance(60);
    expect(pictureOf(rig, deck).liveLoop).toBeNull();
    rig.dispose();
  });
});

describe('adopting a live loop', () => {
  it('makes it the running loop with no return and changes nothing in the engine', async () => {
    const { rig, deck, seen } = await overLoop();
    await push({ rig, deck, seen }, 20);
    const calls = seen.order.length;
    await send(rig, deck, { kind: 'live-loop-adopt', deck: 'a' });
    rig.advance(100);
    const picture = pictureOf(rig, deck);
    expect(picture.liveLoop).toBeNull();
    expect(picture.loop).toMatchObject({ live: false, endFrame: pushedAt(seen).start + 20 });
    expect(seen.order.length).toBe(calls);

    await send(rig, deck, END);
    expect(pictureOf(rig, deck).loop).not.toBeNull();
    await send(rig, deck, { kind: 'let-go', deck: 'a' });
    expect(pictureOf(rig, deck).loop).toBeNull();
    rig.dispose();
  });
});

describe('the loop underneath a live loop', () => {
  it('waits for an edit until the live loop ends, then names it from the end of its lap', async () => {
    const { rig, deck, seen } = await overLoop();
    await push({ rig, deck, seen }, 20);
    const loopsBefore = seen.loops.length;
    const changesBefore = seen.changes.length;
    await send(rig, deck, { kind: 'loop-bounds', deck: 'a', startFrame: 100, endFrame: 120 });
    expect(seen.loops.length).toBe(loopsBefore);
    expect(seen.changes.length).toBe(changesBefore);
    expect(pictureOf(rig, deck).pendingBounds).toEqual({ startFrame: 100, endFrame: 120 });

    await send(rig, deck, END);
    expect(seen.changes.length).toBe(changesBefore + 1);
    expect(seen.changes.at(-1)).toMatchObject({
      at: 140,
      loop: { startFrame: 100, endFrame: 120 },
    });
    expect(pictureOf(rig, deck).pendingBounds).toEqual({ startFrame: 100, endFrame: 120 });
    rig.dispose();
  });

  it('keeps a loop queued before it, and puts the queue back when the live loop ends', async () => {
    const { rig, deck, seen } = await overLoop();
    await send(rig, deck, { kind: 'key', deck: 'a', target: QUEUED });
    await push({ rig, deck, seen }, 60);
    expect(pictureOf(rig, deck).queued).toEqual(QUEUED);
    await send(rig, deck, END);
    expect(pictureOf(rig, deck)).toMatchObject({ queued: QUEUED, liveLoop: null });
    rig.dispose();
  });
});

describe('what the live looper refuses', () => {
  it('refuses a push with no kept size, while paused and while one runs, with a line in the log', async () => {
    const { rig, deck, seen } = await playing();
    await send(rig, deck, LIVE);
    expect(rig.warnings.at(-1)).toContain('no grid and size');
    expect(pictureOf(rig, deck).liveLoop).toBeNull();

    await send(rig, deck, sizeOf(20));
    await send(rig, deck, LIVE);
    await send(rig, deck, LIVE);
    expect(rig.warnings.at(-1)).toContain('already running');
    expect(seen.loops.filter((item) => item.loop?.varispeedStart === 'wrap')).toHaveLength(1);

    await send(rig, deck, END);
    await send(rig, deck, { kind: 'pause', deck: 'a' });
    rig.advance(100);
    await send(rig, deck, LIVE);
    expect(rig.warnings.at(-1)).toContain('not playing');
    expect(pictureOf(rig, deck).liveLoop).toBeNull();
    rig.dispose();
  });
});

describe('the images kept at grid crossings', () => {
  it('declares the beat lines with the grid, and the lines of a size shorter than a beat with it', async () => {
    const { rig, deck, seen } = await playing();
    expect(seen.captures).toEqual([[{ originFrame: 0, periodFrames: 20, keep: 2 }]]);

    await send(rig, deck, sizeOf(10));
    expect(seen.captures.at(-1)).toEqual([
      { originFrame: 0, periodFrames: 20, keep: 2 },
      { originFrame: 0, periodFrames: 10, keep: 2 },
    ]);
    await send(rig, deck, sizeOf(40));
    expect(seen.captures.at(-1)).toEqual([{ originFrame: 0, periodFrames: 20, keep: 2 }]);
    const declared = seen.captures.length;
    await send(rig, deck, sizeOf(40));
    expect(seen.captures.length).toBe(declared);
    rig.dispose();
  });

  it('declares none with no grid', async () => {
    const { rig, seen } = await playing({ grid: null });
    expect(seen.captures).toEqual([]);
    rig.dispose();
  });
});
