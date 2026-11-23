import type { PlayerSnapshot } from '@sidablist/core';
import { VOICE_COUNT } from './settings.js';

/**
 * A part that keeps everything deciding what it does next in storage made ahead of time and can
 * take it back, so a deck saves and restores its own state beside the engine's. Core's `Saveable`
 * in the package's own terms (core does not export it): `createState` allocates, off the tick;
 * `saveInto` and `restoreFrom` allocate nothing and call nothing.
 */
export interface Saveable<S> {
  createState(): S;
  saveInto(target: S): void;
  restoreFrom(source: S): void;
}

/** Slots in `DeckState.cells`: every double the deck keeps, in one typed array so a store never boxes. */
export const CLOCK_DUE_MS = 0;
export const CLOCK_INTERVAL_US = 1;
export const CLOCK_TICKS = 2;
export const SPEED = 3;
export const NUDGE = 4;
export const JUMP = 5;
export const LAST_POSITION = 6;
const CELL_COUNT = 7;

/** Slots in `DeckState.ints`. */
const STREAM = 0;
const MUTES = 1;
const WAITING_FRAME = MUTES + VOICE_COUNT;
const WAITING_SEQ = WAITING_FRAME + 1;
const LAST_HAND_OFFS = WAITING_SEQ + 1;
const INT_COUNT = LAST_HAND_OFFS + 1;

/** `waitingFrame` and `waitingSeq` while no seek waits for its target. */
export const NOT_WAITING = -1;

/** One saved `DeckState`: storage only, filled by `saveInto` and read by `restoreFrom`. */
export interface DeckStateImage {
  readonly cells: Float64Array;
  readonly ints: Int32Array;
  snapshot: PlayerSnapshot | null;
  varispeed: boolean;
}

/**
 * Everything the package keeps that decides a deck's next frames, saved beside the engine's own
 * state in every restore point so a rewind puts both back together:
 *
 * - the driven clock's due time, interval and tick count (`cells`, shared with the clock itself), so
 *   a re-render is due when the original was;
 * - the stream frame, which a rewind takes back to the frame it re-renders from;
 * - the tempo layers (speed, nudge, jump) and the main settings (the voice mutes);
 * - the waiting seek: the tune frame it waits for and the log entry that asked, which is what lets
 *   a re-render find its fixed landing and nothing else;
 * - what the between-tick logic compares against: the engine snapshot last read (by identity), the
 *   hand-offs landed, the playhead last seen;
 * - whether the slot was saved in varispeed, which decides whether a restore into a paused engine
 *   is allowed.
 *
 * Out on purpose, because a rewind must not undo it: `timing`, the command log, the fixed ready
 * landings, the events queued and the targets the host declared. A field added here later joins
 * `cells`/`ints` and both copy methods; one left out restores almost exactly and breaks one
 * playing state much later.
 */
export class DeckState implements Saveable<DeckStateImage> {
  readonly cells = new Float64Array(CELL_COUNT);
  readonly ints = new Int32Array(INT_COUNT);
  /** The engine snapshot the between-tick logic last read. */
  snapshot: PlayerSnapshot | null = null;
  varispeed = false;

  constructor() {
    this.cells[SPEED] = 1;
    this.ints[WAITING_FRAME] = NOT_WAITING;
    this.ints[WAITING_SEQ] = NOT_WAITING;
  }

  /** The frames the deck has delivered since it was added: the next frame to render. */
  get stream(): number {
    return this.ints[STREAM];
  }
  set stream(frame: number) {
    this.ints[STREAM] = frame;
  }

  get speed(): number {
    return this.cells[SPEED];
  }
  get nudge(): number {
    return this.cells[NUDGE];
  }
  get jump(): number {
    return this.cells[JUMP];
  }

  /** Whether `voice` is muted by the main settings. */
  muted(voice: number): boolean {
    return this.ints[MUTES + voice] === 1;
  }
  /** Mutes or unmutes `voice` in the main settings. */
  setMuted(voice: number, muted: boolean): void {
    this.ints[MUTES + voice] = muted ? 1 : 0;
  }
  /** The main settings' mutes as a 0/1 view that `settings.ts` reads and writes. */
  get mutes(): Int32Array {
    return this.ints.subarray(MUTES, MUTES + VOICE_COUNT);
  }

  get waitingFrame(): number {
    return this.ints[WAITING_FRAME];
  }
  get waitingSeq(): number {
    return this.ints[WAITING_SEQ];
  }
  wait(tuneFrame: number, seq: number): void {
    this.ints[WAITING_FRAME] = tuneFrame;
    this.ints[WAITING_SEQ] = seq;
  }
  stopWaiting(): void {
    this.ints[WAITING_FRAME] = NOT_WAITING;
    this.ints[WAITING_SEQ] = NOT_WAITING;
  }

  get lastHandOffs(): number {
    return this.ints[LAST_HAND_OFFS];
  }
  set lastHandOffs(count: number) {
    this.ints[LAST_HAND_OFFS] = count;
  }

  createState(): DeckStateImage {
    return {
      cells: new Float64Array(CELL_COUNT),
      ints: new Int32Array(INT_COUNT),
      snapshot: null,
      varispeed: false,
    };
  }

  saveInto(target: DeckStateImage): void {
    target.cells.set(this.cells);
    target.ints.set(this.ints);
    target.snapshot = this.snapshot;
    target.varispeed = this.varispeed;
  }

  restoreFrom(source: DeckStateImage): void {
    this.cells.set(source.cells);
    this.ints.set(source.ints);
    this.snapshot = source.snapshot;
    this.varispeed = source.varispeed;
  }
}
