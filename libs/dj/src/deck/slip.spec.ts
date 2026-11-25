import { frames } from '@sidablist/core';
import { describe, expect, it } from 'vitest';
import type { DeckCommand, DeckId, JumpTarget } from '../messages/commands.js';
import { Rig } from '../testing/harness.js';
import { DeckState } from './deck-state.js';
import type { Deck } from './deck.js';
import { DeckSlip } from './slip.js';

/**
 * Spec-only. Slip on Still Time, whose delivered frame number is the playhead. A deck that slips is
 * played beside decks that do not: a plain one, which is where the tune is, and one with the same
 * loop running and no slip, which is where the loop is. Landing is exact when the slipping deck's
 * playhead then equals theirs on every frame.
 */

const FRACTIONAL: JumpTarget = { startFrame: 100, endFrame: 117.4 };
const WHOLE: JumpTarget = { startFrame: 200, endFrame: 210 };
const CUE: JumpTarget = { startFrame: 300, endFrame: null };

/** Decks on Still Time playing together from the same moment, each with the same targets ready. */
async function playing(ids: readonly DeckId[]): Promise<Rig> {
  const rig = new Rig();
  for (const id of ids) {
    rig.addDeck(id, { lookaheadMs: 60 });
    await rig.load(id, 'still-time', { ends: 'playing' });
    rig.send({ kind: 'targets', deck: id, frames: [100, 200, 300] });
  }
  await rig.settle();
  rig.advance(100);
  return rig;
}

/** Sends one command to each of `ids` in the same turn, so each lands on the same frame. */
async function sendTo(
  rig: Rig,
  ids: readonly DeckId[],
  command: (deck: DeckId) => DeckCommand,
): Promise<void> {
  for (const id of ids) rig.send(command(id));
  await rig.microtasks();
}

/** The playhead each stream frame showed, the latest render of a frame winning over a rewound one. */
function playheads(rig: Rig, id: DeckId): Map<number, number> {
  const seen = new Map<number, number>();
  for (const update of rig.ofKind('update', id)) seen.set(update.streamFrame, update.position);
  return seen;
}

/** Where slip said it would land on each stream frame, the latest render winning. */
function slipPositions(rig: Rig, id: DeckId): Map<number, number | null> {
  const seen = new Map<number, number | null>();
  for (const update of rig.ofKind('update', id)) seen.set(update.streamFrame, update.slipPosition);
  return seen;
}

/** The frames from `from` on, up to `count` of them, at which `id` and `other` show different playheads. */
function differences(rig: Rig, id: DeckId, other: DeckId, from: number, count = 15): number[] {
  const mine = playheads(rig, id);
  const theirs = playheads(rig, other);
  const found: number[] = [];
  for (let frame = from; frame < from + count; frame++) {
    if (mine.get(frame) !== theirs.get(frame)) found.push(frame);
  }
  return found;
}

const departed = (rig: Rig, id: DeckId): boolean => rig.picture(id).slip.departed;

describe('slip with a loop', () => {
  it('lands the deck on the count it would have reached when the loop is let go, whose length is not whole', async () => {
    const rig = await playing(['a', 'b', 'c']);
    await sendTo(rig, ['a'], (deck) => ({ kind: 'slip', deck, on: true }));
    rig.advance(20);
    expect(rig.picture('a').slip).toEqual({ on: true, departed: false });

    await sendTo(rig, ['a', 'c'], (deck) => ({ kind: 'hot-cue', deck, target: FRACTIONAL }));
    rig.advance(300);
    expect(rig.picture('a')).toMatchObject({ slip: { on: true, departed: true } });
    expect(rig.picture('a').loop).toMatchObject({ startFrame: 100, endFrame: 117.4 });
    const pressed = rig.landed('hot-cue').find((event) => event.deck === 'a')!.frame;
    expect(differences(rig, 'a', 'c', pressed + 1, 12)).toEqual([]);
    // While it runs, slip reports the frame it would land on: the plain deck's.
    const latest = rig.ofKind('update', 'a').at(-1)!;
    expect(latest.slipPosition).toBe(playheads(rig, 'b').get(latest.streamFrame));

    await sendTo(rig, ['a', 'b', 'c'], (deck) => ({ kind: 'let-go', deck }));
    rig.advance(200);
    const letGo = rig.landed('let-go').find((event) => event.deck === 'a')!.frame;
    expect(differences(rig, 'a', 'b', letGo)).toEqual([]);
    expect(differences(rig, 'c', 'b', letGo, 5).length).toBeGreaterThan(0);
    expect(rig.picture('a')).toMatchObject({ slip: { on: true, departed: false }, loop: null });
    expect(slipPositions(rig, 'a').get(letGo + 5)).toBeNull();
    expect(rig.warnings).toEqual([]);
    rig.dispose();
  });

  it('plays on from where the loop was with slip off', async () => {
    const rig = await playing(['a', 'b']);
    await sendTo(rig, ['a'], (deck) => ({ kind: 'hot-cue', deck, target: FRACTIONAL }));
    rig.advance(300);
    expect(rig.picture('a').slip).toEqual({ on: false, departed: false });

    await sendTo(rig, ['a'], (deck) => ({ kind: 'let-go', deck }));
    rig.advance(100);
    const letGo = rig.landed('let-go')[0].frame;
    expect(differences(rig, 'a', 'b', letGo, 5).length).toBeGreaterThan(0);
    rig.dispose();
  });

  it('lands on the line when the loop is stopped', async () => {
    const rig = await playing(['a', 'b']);
    await sendTo(rig, ['a'], (deck) => ({ kind: 'slip', deck, on: true }));
    rig.advance(20);
    await sendTo(rig, ['a'], (deck) => ({ kind: 'hot-cue', deck, target: FRACTIONAL }));
    rig.advance(300);

    await sendTo(rig, ['a'], (deck) => ({ kind: 'stop-loop', deck }));
    rig.advance(200);
    const stopped = rig.landed('stop-loop')[0].frame;
    expect(differences(rig, 'a', 'b', stopped)).toEqual([]);
    expect(rig.picture('a')).toMatchObject({ slip: { departed: false }, loop: null });
    rig.dispose();
  });

  it('keeps the departure through a queued loop landing at the wrap, and lands on the line from either', async () => {
    const rig = await playing(['a', 'b']);
    await sendTo(rig, ['a'], (deck) => ({ kind: 'slip', deck, on: true }));
    rig.advance(20);
    await sendTo(rig, ['a'], (deck) => ({ kind: 'hot-cue', deck, target: FRACTIONAL }));
    rig.advance(100);
    await sendTo(rig, ['a'], (deck) => ({ kind: 'hot-cue', deck, target: WHOLE }));
    rig.advance(600);
    expect(rig.ofKind('jump-landed', 'a')).toHaveLength(1);
    expect(rig.picture('a')).toMatchObject({ slip: { departed: true }, loop: { startFrame: 200 } });

    await sendTo(rig, ['a'], (deck) => ({ kind: 'let-go', deck }));
    rig.advance(200);
    expect(differences(rig, 'a', 'b', rig.landed('let-go')[0].frame)).toEqual([]);
    rig.dispose();
  });

  it('counts a loop queued behind one slip did not begin with as the line from the landing on, and drops a cancelled queue', async () => {
    const rig = await playing(['a']);
    await sendTo(rig, ['a'], (deck) => ({ kind: 'hot-cue', deck, target: FRACTIONAL }));
    rig.advance(100);
    await sendTo(rig, ['a'], (deck) => ({ kind: 'slip', deck, on: true }));
    rig.advance(20);
    expect(departed(rig, 'a')).toBe(false);

    // Queued: the departure begins, counting laps of the loop the deck is in.
    await sendTo(rig, ['a'], (deck) => ({ kind: 'hot-cue', deck, target: WHOLE }));
    await sendTo(rig, ['a'], (deck) => ({ kind: 'cancel-queued', deck }));
    rig.advance(100);
    expect(departed(rig, 'a')).toBe(false);
    expect(rig.picture('a').loop).toMatchObject({ startFrame: 100 });

    await sendTo(rig, ['a'], (deck) => ({ kind: 'hot-cue', deck, target: WHOLE }));
    rig.advance(20);
    expect(departed(rig, 'a')).toBe(true);
    const counted = [...slipPositions(rig, 'a').values()].filter((p): p is number => p !== null);
    expect(counted.every((position) => position >= 100 && position < 117.4)).toBe(true);

    rig.advance(1000);
    expect(rig.picture('a').loop).toMatchObject({ startFrame: 200 });
    // The loop it was lapping is replaced, so the count carries on past its end, up the line.
    const after = rig.landed('hot-cue')[2].frame + 40;
    const line = slipPositions(rig, 'a').get(after)!;
    expect(line).toBeGreaterThan(117.4);
    expect(slipPositions(rig, 'a').get(after + 1)).toBe(line + 1);
    rig.dispose();
  });

  it('is over for a cue landing, which is a jump', async () => {
    const rig = await playing(['a', 'b']);
    await sendTo(rig, ['a'], (deck) => ({ kind: 'slip', deck, on: true }));
    rig.advance(20);
    await sendTo(rig, ['a'], (deck) => ({ kind: 'hot-cue', deck, target: FRACTIONAL }));
    rig.advance(100);
    expect(departed(rig, 'a')).toBe(true);

    await sendTo(rig, ['a'], (deck) => ({ kind: 'jump', deck, target: CUE }));
    rig.advance(100);
    expect(departed(rig, 'a')).toBe(false);
    expect(rig.picture('a').loop).toBeNull();
    expect(
      playheads(rig, 'a').get(rig.ofKind('update', 'a').at(-1)!.streamFrame),
    ).toBeGreaterThanOrEqual(300);
    rig.dispose();
  });

  it('is begun by a stab at the running loop, and lands on the count at the let-go', async () => {
    const rig = await playing(['a', 'b']);
    await sendTo(rig, ['a'], (deck) => ({ kind: 'hot-cue', deck, target: FRACTIONAL }));
    rig.advance(100);
    await sendTo(rig, ['a'], (deck) => ({ kind: 'slip', deck, on: true }));
    rig.advance(20);
    expect(departed(rig, 'a')).toBe(false);

    await sendTo(rig, ['a'], (deck) => ({ kind: 'jump', deck, target: FRACTIONAL }));
    rig.advance(100);
    expect(departed(rig, 'a')).toBe(true);
    const stab = rig.landed('jump')[0].frame;
    expect(playheads(rig, 'a').get(stab)).toBe(100);

    // The departure counts laps of the loop it stabbed, so the count is where the loop would have been.
    const counted = slipPositions(rig, 'a').get(stab + 3)!;
    expect(counted).toBeGreaterThanOrEqual(100);
    expect(counted).toBeLessThan(117.4);
    rig.dispose();
  });

  it.each([
    ['a seek', { kind: 'seek', frame: 300 }, true],
    ['a stop', { kind: 'stop' }, true],
    ['slip turned off', { kind: 'slip', on: false }, false],
    ['a load', { kind: 'load', tune: 'still-time', subtune: 1 }, true],
  ] as const)('is abandoned with no landing by %s', async (_name, command, stillOn) => {
    const rig = await playing(['a']);
    await sendTo(rig, ['a'], (deck) => ({ kind: 'slip', deck, on: true }));
    rig.advance(20);
    await sendTo(rig, ['a'], (deck) => ({ kind: 'hot-cue', deck, target: FRACTIONAL }));
    rig.advance(100);
    expect(departed(rig, 'a')).toBe(true);

    await sendTo(rig, ['a'], (deck) => ({ ...command, deck }));
    await rig.settle();
    rig.advance(200);
    expect(departed(rig, 'a')).toBe(false);
    expect(rig.picture('a').slip.on).toBe(stillOn);
    // With slip off the loop goes on, and nothing landed the deck on the line.
    expect(rig.picture('a').loop !== null).toBe(command.kind === 'slip');
    rig.dispose();
  });
});

describe('slip with the hand', () => {
  const touch = (rig: Rig, ids: readonly DeckId[]): Promise<void> =>
    sendTo(rig, ids, (deck) => ({ kind: 'hand-touch', deck, atMs: rig.time.ms }));
  const move = (rig: Rig, ids: readonly DeckId[], travelFrames: number): Promise<void> =>
    sendTo(rig, ids, (deck) => ({ kind: 'hand-move', deck, travelFrames, atMs: rig.time.ms }));
  const lift = (rig: Rig, ids: readonly DeckId[]): Promise<void> =>
    sendTo(rig, ids, (deck) => ({ kind: 'hand-lift', deck, atMs: rig.time.ms, gripSeconds: 0.5 }));

  it('lands the deck on the count it would have reached when the hand lifts, with no throw', async () => {
    const rig = await playing(['a', 'b']);
    rig.advance(500);
    await sendTo(rig, ['a'], (deck) => ({ kind: 'slip', deck, on: true }));
    rig.advance(20);

    await touch(rig, ['a']);
    rig.advance(60);
    expect(rig.picture('a')).toMatchObject({ hand: 'down', slip: { departed: true } });
    await move(rig, ['a'], -15);
    rig.advance(60);
    await move(rig, ['a'], 40);
    rig.advance(100);
    const displaced = rig.ofKind('update', 'a').at(-1)!;
    expect(displaced.position).not.toBe(playheads(rig, 'b').get(displaced.streamFrame));
    expect(displaced.slipPosition).toBe(playheads(rig, 'b').get(displaced.streamFrame));

    await lift(rig, ['a']);
    rig.advance(200);
    const lifted = rig.landed('hand-lift')[0].frame;
    expect(differences(rig, 'a', 'b', lifted)).toEqual([]);
    expect(rig.picture('a')).toMatchObject({ hand: 'up', slip: { departed: false } });
    expect(rig.warnings).toEqual([]);
    rig.dispose();
  });

  it('counts a touch made on the frame of a jump from the phase the jump left', async () => {
    const rig = await playing(['a', 'b']);
    rig.advance(300);
    await sendTo(rig, ['a'], (deck) => ({ kind: 'slip', deck, on: true }));
    rig.advance(20);

    // The jump owes a gate-off, which holds the count for a tick: slip starts from that phase, not
    // from the one entering varispeed leaves.
    rig.send({ kind: 'jump', deck: 'a', target: CUE });
    await touch(rig, ['a']);
    await sendTo(rig, ['b'], (deck) => ({ kind: 'jump', deck, target: CUE }));
    rig.advance(100);
    await lift(rig, ['a']);
    rig.advance(200);

    const lifted = rig.landed('hand-lift')[0].frame;
    expect(playheads(rig, 'a').get(lifted)).toBeGreaterThanOrEqual(300);
    expect(differences(rig, 'a', 'b', lifted)).toEqual([]);
    rig.dispose();
  });

  it('begins no departure when the engine will not enter varispeed, past the end of the record', async () => {
    const rig = new Rig();
    rig.addDeck('a', { lookaheadMs: 60 });
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.send({ kind: 'targets', deck: 'a', frames: [3000] });
    await rig.settle();
    rig.advance(100);
    await sendTo(rig, ['a'], (deck) => ({ kind: 'slip', deck, on: true }));
    await sendTo(rig, ['a'], (deck) => ({
      kind: 'jump',
      deck,
      target: { startFrame: 3000, endFrame: null },
    }));
    rig.advance(100);
    expect(playheads(rig, 'a').get(rig.ofKind('update', 'a').at(-1)!.streamFrame)).toBeGreaterThan(
      2000,
    );

    await touch(rig, ['a']);
    rig.advance(100);
    expect(rig.picture('a')).toMatchObject({ hand: 'up', slip: { on: true, departed: false } });
    rig.dispose();
  });

  it('throws the record when the landing cannot be made, as with slip off', async () => {
    const rig = new Rig();
    rig.addDeck('a', { lookaheadMs: 60 });
    await rig.load('a', 'still-time', { ends: 'paused' });
    await sendTo(rig, ['a'], (deck) => ({ kind: 'slip', deck, on: true }));
    rig.advance(100);

    await touch(rig, ['a']);
    rig.advance(100);
    expect(rig.picture('a')).toMatchObject({ hand: 'down', slip: { departed: true } });
    await lift(rig, ['a']);
    rig.advance(100);

    // A paused deck cannot land: the departure is dropped and the lift throws.
    expect(rig.picture('a')).toMatchObject({ slip: { on: true, departed: false } });
    expect(rig.picture('a').hand).not.toBe('down');
    rig.dispose();
  });

  it('nests in a loop departure, lands the loop at the lift, and resumes the count of the line for the let-go', async () => {
    const rig = await playing(['a', 'b', 'c']);
    await sendTo(rig, ['a'], (deck) => ({ kind: 'slip', deck, on: true }));
    rig.advance(20);
    await sendTo(rig, ['a', 'c'], (deck) => ({ kind: 'hot-cue', deck, target: FRACTIONAL }));
    rig.advance(300);

    await touch(rig, ['a']);
    rig.advance(60);
    await move(rig, ['a'], 25);
    rig.advance(100);
    expect(rig.picture('a')).toMatchObject({ hand: 'down', slip: { departed: true } });

    // The hand's departure lapped the loop: its landing is where the loop is, to the frame.
    await lift(rig, ['a']);
    rig.advance(300);
    const lifted = rig.landed('hand-lift')[0].frame;
    expect(differences(rig, 'a', 'c', lifted, 25)).toEqual([]);
    expect(rig.picture('a')).toMatchObject({ hand: 'up', slip: { departed: true } });

    // The loop's own departure is back, and still counting the line the loop began from.
    await sendTo(rig, ['a'], (deck) => ({ kind: 'let-go', deck }));
    rig.advance(200);
    const letGo = rig.landed('let-go')[0].frame;
    expect(differences(rig, 'a', 'b', letGo)).toEqual([]);
    expect(rig.picture('a')).toMatchObject({ slip: { departed: false }, loop: null });
    expect(rig.warnings).toEqual([]);
    rig.dispose();
  });
});

describe('the departures slip keeps', () => {
  /**
   * Slip over the engine of a deck that plays on its own, beside decks that play on and a deck
   * that loops with no slip. Nothing is pressed on these decks after they start, so no rewind
   * takes back what slip asks of an engine it does not own. Every deck is ticked together, so the
   * playheads compare frame for frame.
   */
  interface Line {
    readonly rig: Rig;
    readonly slip: DeckSlip;
    readonly state: DeckState;
    readonly slipping: Deck;
    /** The tune, played straight. */
    readonly straight: Deck;
    /** The loop alone, with no slip. */
    readonly looping: Deck;
  }

  async function line(): Promise<Line> {
    const rig = new Rig();
    const decks = ['s', 'p', 'l'].map((id) => rig.openDeck(id, 60).deck);
    for (const deck of decks) {
      deck.receive({
        kind: 'load',
        deck: deck.id,
        tune: 'still-time',
        subtune: 1,
        ends: 'playing',
      });
    }
    await rig.settle();
    rig.advance(200);
    const [slipping, straight, looping] = decks;
    const state = new DeckState();
    state.slipOn = true;
    return { rig, slip: new DeckSlip(slipping.player, state), state, slipping, straight, looping };
  }

  const at = (deck: Deck): number => deck.player.getPosition();

  /** Sets a loop ahead of the playhead, to be armed as it reaches its start. */
  function loopAhead(deck: Deck, startsIn: number, length: number): void {
    deck.player.setActiveLoop({
      startFrame: frames(at(deck) + startsIn),
      endFrame: frames(at(deck) + startsIn + length),
    });
  }

  it('resumes the count of the line a live loop nested inside, folded through the ticks it ran, for every lap of a loop that is not whole', async () => {
    const l = await line();
    // The line begins here, with the loop yet to come: its count is the tune's own.
    l.slip.begin('loop');
    loopAhead(l.slipping, 40, 17.4);
    loopAhead(l.looping, 40, 17.4);
    l.rig.advance(1500);
    expect(at(l.slipping)).toBe(at(l.looping));
    expect(at(l.slipping)).not.toBe(at(l.straight));
    expect(l.slip.position()).toBe(at(l.straight));

    // A live loop starts inside the loop's departure: it nests, and keeps the line's count.
    l.slip.begin('live-loop');
    expect(l.slip.departed).toBe(true);
    l.rig.advance(450);
    expect(l.slip.position()).not.toBe(at(l.straight));

    // It ends: the playhead lands on where the loop is, and the line carries on from its count
    // plus the ticks the live loop ran.
    expect(l.slip.land('live-loop')).toBe(true);
    expect(at(l.slipping)).toBe(at(l.looping));
    expect(l.slip.position()).toBe(at(l.straight));
    l.rig.advance(100);
    expect(l.slip.position()).toBe(at(l.straight));
    expect(at(l.slipping)).toBe(at(l.looping));

    // The loop's departure ends: the deck lands on the line.
    l.slipping.player.setActiveLoop(null);
    expect(l.slip.land('loop')).toBe(true);
    l.rig.advance(100);
    expect(at(l.slipping)).toBe(at(l.straight));
    expect(l.slip.departed).toBe(false);
    l.rig.dispose();
  });

  it('resumes an outer departure that lapped the loop the deck was in, lap by lap', async () => {
    const l = await line();
    loopAhead(l.slipping, 40, 17.4);
    loopAhead(l.looping, 40, 17.4);
    l.rig.advance(1500);
    expect(at(l.slipping)).not.toBe(at(l.straight));

    // The departure begins inside the loop, so its count laps the loop and is where the loop is.
    l.slip.begin('loop');
    l.rig.advance(200);
    expect(l.slip.position()).toBe(at(l.looping));

    l.slip.begin('live-loop');
    l.rig.advance(450);
    expect(l.slip.land('live-loop')).toBe(true);
    expect(l.slip.position()).toBe(at(l.looping));
    l.rig.advance(300);
    expect(l.slip.position()).toBe(at(l.looping));
    expect(at(l.slipping)).toBe(at(l.looping));
    l.rig.dispose();
  });

  it('keeps one level of nesting: a third departure takes the outer one’s place', async () => {
    const l = await line();
    l.slip.begin('loop');
    l.slip.begin('live-loop');
    l.slip.begin('hand');
    l.rig.advance(100);

    // The hand ends and the live loop resumes under it; the loop's own departure is gone.
    expect(l.slip.land('hand')).toBe(true);
    expect(l.slip.departed).toBe(true);
    expect(l.slip.land('live-loop')).toBe(true);
    expect(l.slip.departed).toBe(false);
    expect(l.slip.land('loop')).toBe(false);
    expect(l.slipping.player.getShadowPosition()).toBeNull();
    l.rig.dispose();
  });

  it('retires the outer departure when the inner one is of another kind, and the inner then lands on its line', async () => {
    const l = await line();
    l.slip.begin('loop');
    l.rig.advance(100);
    l.slip.begin('live-loop');
    l.rig.advance(100);

    // The loop is let go while a live loop is nested inside it: no landing, and the live loop's
    // own end still lands where the tune would be, the deck having looped away from it meanwhile.
    expect(l.slip.land('loop')).toBe(false);
    expect(l.slip.departed).toBe(true);
    loopAhead(l.slipping, 20, 11);
    l.rig.advance(1500);
    expect(at(l.slipping)).not.toBe(at(l.straight));
    expect(l.slip.position()).toBe(at(l.straight));
    l.slipping.player.setActiveLoop(null);
    expect(l.slip.land('live-loop')).toBe(true);
    l.rig.advance(100);
    expect(at(l.slipping)).toBe(at(l.straight));
    expect(l.slip.departed).toBe(false);
    l.rig.dispose();
  });

  it('begins nothing for a loop inside a running departure, and ends a departure with no landing on release', async () => {
    const l = await line();
    l.slip.begin('hand');
    l.slip.begin('loop');
    // A loop inside a departure nests nothing: the hand's end leaves no outer one.
    expect(l.slip.land('hand')).toBe(true);
    expect(l.slip.departed).toBe(false);

    l.slip.begin('loop');
    l.slip.begin('hand');
    const before = at(l.slipping);
    l.slip.release('hand');
    // The loop's departure resumes and the deck has not moved.
    expect(l.slip.departed).toBe(true);
    expect(at(l.slipping)).toBe(before);
    l.slip.release('loop');
    expect(l.slip.departed).toBe(false);
    expect(l.slipping.player.getShadowPosition()).toBeNull();

    // Released while a newer one is nested inside: the nested one takes over its line.
    l.slip.begin('loop');
    l.slip.begin('live-loop');
    l.slip.release('loop');
    expect(l.slip.departed).toBe(true);
    l.slip.release('live-loop');
    expect(l.slip.departed).toBe(false);
    l.rig.dispose();
  });

  it('drops a queued departure when its queue is cancelled, and a queued outer one beneath another', async () => {
    const l = await line();
    l.slip.begin('loop', true);
    expect(l.slip.departed).toBe(true);
    l.slip.cancelQueued();
    expect(l.slip.departed).toBe(false);
    expect(l.slipping.player.getShadowPosition()).toBeNull();

    l.slip.begin('loop', true);
    l.slip.begin('hand');
    l.slip.cancelQueued();
    expect(l.slip.departed).toBe(true);
    // Nothing outside the hand is left: its end leaves no departure.
    expect(l.slip.land('hand')).toBe(true);
    expect(l.slip.departed).toBe(false);
    l.rig.dispose();
  });

  it('lands the outermost departure, not the hand, and does nothing with only a hand', async () => {
    const l = await line();
    l.slip.begin('hand');
    l.slip.landOutermost();
    expect(l.slip.departed).toBe(true);
    l.slip.abandon();

    l.slip.begin('loop');
    l.rig.advance(100);
    l.slip.begin('live-loop');
    l.rig.advance(100);
    l.slip.landOutermost();
    expect(l.slip.departed).toBe(false);
    l.rig.advance(100);
    expect(at(l.slipping)).toBe(at(l.straight));
    l.rig.dispose();
  });

  it('abandons a departure whose landing cannot be made, and forgets one the engine stopped', async () => {
    const l = await line();
    l.slip.begin('loop');
    l.slipping.player.stopShadow();
    expect(l.slip.land('loop')).toBe(false);
    expect(l.slip.departed).toBe(false);

    l.slip.begin('hand');
    l.slipping.player.pause();
    l.rig.advance(100);
    expect(l.slip.land('hand')).toBe(false);
    expect(l.slip.departed).toBe(false);
    expect(l.slipping.player.getShadowPosition()).toBeNull();
    l.rig.dispose();
  });

  it('begins nothing with slip off', async () => {
    const l = await line();
    l.slip.setOn(false);
    l.slip.begin('loop');
    l.slip.begin('hand');
    expect(l.slip.departed).toBe(false);
    expect(l.slip.position()).toBeNull();
    l.rig.dispose();
  });
});
