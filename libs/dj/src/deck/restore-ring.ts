import type { SavedPlayerState } from '@sidablist/core';
import type { DeckStateImage } from './deck-state.js';
import { MAX_TEMPO } from './tempo.js';

/** The memory one slot holds: about 136 KB, the engine's machine image and loop-entry image. */
const SLOT_BYTES = 136 * 1024;

/** `appliedThrough` of a slot saved before any command ran at its next frame. */
export const NOTHING_APPLIED = -1;

/** `RestoreSlot.frame` of a slot that holds nothing: no frame number equals it. */
const NO_FRAME = -2;

/**
 * One restore point: the engine's saved state and the deck's own, taken after a frame rendered
 * and after that frame's between-tick logic.
 */
export interface RestoreSlot {
  readonly engine: SavedPlayerState;
  readonly deck: DeckStateImage;
  /** The stream frame this point follows; a rewind to `frame + 1` restores it. */
  frame: number;
  /**
   * The sequence number of the last log entry applied at the slot's next frame before it was saved
   * (`NOTHING_APPLIED` for an ordinary slot, which is saved before the next frame's commands run).
   * A restore re-applies only the entries after it at that frame; entries at later frames are all
   * still to come. It is a mark within one frame, not a high-water mark over the log: entries land
   * on frames out of arrival order.
   */
  appliedThrough: number;
}

/**
 * The deck's restore points: one slot per frame it can hold ahead, kept by frame number so each is
 * overwritten by the frame one ring-length later, plus one for the state before the first frame of
 * a run (after a `begin`), which no frame's slot can hold since that frame has not rendered.
 *
 * Making a ring allocates every slot, so it is built off the frame path and rebuilt when what
 * sizes it changes; saving into a slot allocates nothing.
 */
export class RestoreRing {
  private readonly slots: RestoreSlot[];
  private readonly start: RestoreSlot;
  private runStart = -1;

  /** `makeSlot` builds one empty slot: a saved engine state and a saved deck state. */
  constructor(
    readonly capacity: number,
    makeSlot: () => RestoreSlot,
  ) {
    this.slots = Array.from({ length: capacity }, makeSlot);
    this.start = makeSlot();
    for (const slot of [...this.slots, this.start]) slot.frame = NO_FRAME;
  }

  /**
   * How many slots a deck holding `lookaheadMs` of frames needs: one per frame it can hold at the
   * fastest tempo, two more for the frame being rendered and for margin.
   */
  static slotsFor(lookaheadMs: number, tuneIntervalUs: number): number {
    return Math.ceil((lookaheadMs * 1000) / (tuneIntervalUs / MAX_TEMPO)) + 2;
  }

  /** The memory the ring holds, an estimate: every slot and the one before the run's first frame. */
  get bytes(): number {
    return (this.capacity + 1) * SLOT_BYTES;
  }

  /**
   * Starts a run whose first frame carries `frame`: slots from an earlier run no longer count, and
   * the begin slot, returned for the caller to fill and mark with `frame - 1`, is invalid until it
   * has been. A run that is already under way (the ring was rebuilt) leaves it unfilled.
   */
  startRun(frame: number): RestoreSlot {
    this.runStart = frame;
    this.start.frame = NO_FRAME;
    return this.start;
  }

  /** Where to save the state after `frame` rendered; the caller sets the slot's `frame` once it has. */
  slotAfter(frame: number): RestoreSlot {
    return this.slots[frame % this.capacity];
  }

  /**
   * The restore point for a rewind that re-renders from `landing`: the state after frame
   * `landing - 1`, or the begin slot for a run's first frame. Null when it was never saved, was
   * overwritten by a later frame, or belongs to an earlier run.
   */
  slotFor(landing: number): RestoreSlot | null {
    if (this.runStart < 0 || landing < this.runStart) return null;
    const slot = landing === this.runStart ? this.start : this.slots[(landing - 1) % this.capacity];
    return slot.frame === landing - 1 ? slot : null;
  }
}
