import { clamp } from '@sidablist/core';
import type { DeckId, DjInbound } from './messages/commands.js';
import { validateInbound } from './messages/validate.js';
import type { Dj, DjPlugs, DeckOutput } from './plugs.js';
import { Deck } from './deck/deck.js';

/** The wake's period is a third of the shortest lookahead among the decks that render, within these bounds. */
const MIN_WAKE_MS = 1;
const MAX_WAKE_MS = 10;

/**
 * The DJ desk. Decks are made on demand by `add-deck`, kept by id, and driven through `send`; the
 * package assumes no pair, counts no decks and names no other deck.
 *
 * It runs one wake for all decks, started while any deck's driven clock is started and stopped
 * when none is. Each wake renders every such deck in the order the decks were added, so the
 * output does not depend on map order.
 */
export function createDj(plugs: DjPlugs): Dj {
  const decks = new Map<DeckId, Deck>();
  /** Decks in the order they were added. */
  let order: Deck[] = [];
  let disposed = false;
  let wakePeriodUs: number | null = null;

  const refuse = (reason: string): void => plugs.log?.warn(`dj: refused ${reason}`);

  /** Starts, retimes or stops the one wake so it follows the decks that are rendering. */
  const syncWake = (): void => {
    if (disposed) return;
    let shortest = Number.POSITIVE_INFINITY;
    for (const deck of order) {
      if (deck.rendering && deck.lookaheadMs < shortest) shortest = deck.lookaheadMs;
    }
    if (shortest === Number.POSITIVE_INFINITY) {
      if (wakePeriodUs !== null) {
        plugs.wake.stop();
        wakePeriodUs = null;
      }
      return;
    }
    const periodUs = clamp(shortest / 3, MIN_WAKE_MS, MAX_WAKE_MS) * 1000;
    if (periodUs === wakePeriodUs) return;
    if (wakePeriodUs !== null) plugs.wake.stop();
    wakePeriodUs = periodUs;
    plugs.wake.start(periodUs, onWake);
  };

  const onWake = (): void => {
    if (disposed) return;
    const nowMs = plugs.time.now();
    for (const deck of order) deck.wake(nowMs);
    syncWake();
  };

  const host = { syncWake };

  return {
    send(message: DjInbound): void {
      if (disposed) return;
      const verdict = validateInbound(message);
      if (!verdict.ok) {
        refuse(verdict.reason);
        return;
      }
      const inbound = verdict.message;
      if (inbound.kind === 'add-deck') {
        if (decks.has(inbound.deck)) {
          refuse(`add-deck: deck ${inbound.deck} already exists`);
          return;
        }
        const deck = new Deck(inbound.deck, plugs, host);
        decks.set(inbound.deck, deck);
        order = [...order, deck];
        return;
      }
      const deck = decks.get(inbound.deck);
      if (deck === undefined) {
        refuse(`${inbound.kind}: unknown deck ${inbound.deck}`);
        return;
      }
      switch (inbound.kind) {
        case 'remove-deck':
          decks.delete(inbound.deck);
          order = order.filter((other) => other !== deck);
          deck.dispose();
          break;
        case 'describe':
        case 'registers':
        case 'keep-deliveries':
        case 'deliveries':
          deck.request(inbound);
          break;
        default: {
          const reason = deck.refusal(inbound);
          if (reason !== null) refuse(`${inbound.kind}: ${reason}`);
          else deck.receive(inbound);
        }
      }
      syncWake();
    },

    setOutput(deckId: DeckId, output: DeckOutput | null): void {
      if (disposed) return;
      const deck = decks.get(deckId);
      if (deck === undefined) {
        plugs.log?.warn(`dj: setOutput on unknown deck ${deckId} ignored`);
        return;
      }
      deck.setOutput(output);
      syncWake();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      plugs.wake.stop();
      for (const deck of order) deck.dispose();
      decks.clear();
      order = [];
    },
  };
}
