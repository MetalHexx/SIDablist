import type { ActiveLoop, JumpSettings, PlayerSnapshot } from '@sidablist/core';
import type { JumpTarget } from '../messages/commands.js';
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
/** The hand's doubles: where it anchors the record, where the last tick left the position, how far it moved, the release speed, the grip, the rate. */
export const HAND_ANCHOR = 7;
export const HAND_EXPECTED = 8;
export const HAND_TRAVEL = 9;
export const HAND_RELEASE_SPEED = 10;
export const HAND_GRIP = 11;
export const HAND_RATE = 12;
/** Where the slip departures' doubles begin: `SLIP_DEPARTURES` runs of `SLIP_CELL_STRIDE`. */
export const SLIP_CELLS_AT = 13;
export const SLIP_DEPARTURES = 2;
export const SLIP_CELL_STRIDE = 5;
const CELL_COUNT = SLIP_CELLS_AT + SLIP_DEPARTURES * SLIP_CELL_STRIDE;

/** Slots in `DeckState.ints`. */
const STREAM = 0;
const MUTES = 1;
const WAITING_FRAME = MUTES + VOICE_COUNT;
const WAITING_SEQ = WAITING_FRAME + 1;
const LAST_HAND_OFFS = WAITING_SEQ + 1;
const LOOP_MUTES = LAST_HAND_OFFS + 1;
const OWN_IN_PLAY = LOOP_MUTES + VOICE_COUNT;
const HAND_STATE = OWN_IN_PLAY + 1;
const HAND_ANCHOR_PENDING = HAND_STATE + 1;
const HAND_SAMPLE_COUNT = HAND_ANCHOR_PENDING + 1;
const HAND_SAMPLE_HEAD = HAND_SAMPLE_COUNT + 1;
const HAND_THROW_STARTED = HAND_SAMPLE_HEAD + 1;
const SLIP_ON = HAND_THROW_STARTED + 1;
/** Where the slip departures' ints begin: `SLIP_DEPARTURES` runs of `SLIP_INT_STRIDE`. */
export const SLIP_INTS_AT = SLIP_ON + 1;
export const SLIP_INT_STRIDE = 4;
const INT_COUNT = SLIP_INTS_AT + SLIP_DEPARTURES * SLIP_INT_STRIDE;

/** The hand's states, as `DeckState.handState` holds them. */
export const HAND_UP = 0;
export const HAND_DOWN = 1;
export const HAND_THROWN = 2;

/** The samples the hand keeps for its release speed. */
export const HAND_SAMPLES = 8;

/** `waitingFrame` and `waitingSeq` while no seek waits for its target. */
export const NOT_WAITING = -1;

/** One saved `DeckState`: storage only, filled by `saveInto` and read by `restoreFrom`. */
export interface DeckStateImage {
  readonly cells: Float64Array;
  readonly ints: Int32Array;
  readonly handTravels: Float64Array;
  readonly handTimes: Float64Array;
  snapshot: PlayerSnapshot | null;
  varispeed: boolean;
  queued: JumpTarget | null;
  queuedSettings: JumpSettings | null;
  waiting: JumpTarget | null;
  waitingSettings: JumpSettings | null;
  pending: Exclude<ActiveLoop, null> | null;
}

/**
 * Everything the package keeps that decides a deck's next frames, saved beside the engine's own
 * state in every restore point so a rewind puts both back together:
 *
 * - the driven clock's due time, interval and tick count (`cells`, shared with the clock itself), so
 *   a re-render is due when the original was;
 * - the stream frame, which a rewind takes back to the frame it re-renders from;
 * - the tempo layers (speed, nudge, jump) and the main settings (the voice mutes);
 * - the waiting seek or jump: the tune frame it waits for and the log entry that asked, which is
 *   what lets a re-render find its fixed landing, and a waiting jump's target and settings;
 * - the loops: the target queued in the engine with the settings it carries, the loop change named
 *   and not yet landed, and the loop's own settings with whether they are in play (the main ones
 *   are then held aside, untouched, in the main mutes). Targets and settings are held by reference:
 *   a command is immutable, and a save allocates nothing;
 * - what the between-tick logic compares against: the engine snapshot last read (by identity), the
 *   hand-offs landed, the playhead last seen;
 * - the hand: its state, anchor, the position it expects, travel, samples with their count and head,
 *   release speed, grip, rate and whether the throw has started. The rate source runs inside the
 *   tick and changes these, so a rewind replays it from the numbers the slot holds;
 * - slip: whether it is on, and the departure running and the one outside it, each held as numbers
 *   (kind, queued, the lap it returns into, the count it left) so a save copies and builds nothing;
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
  /** The hand's samples, travel and host time, as a ring of `HAND_SAMPLES` written from `handSampleHead`. */
  readonly handTravels = new Float64Array(HAND_SAMPLES);
  readonly handTimes = new Float64Array(HAND_SAMPLES);
  /** The engine snapshot the between-tick logic last read. */
  snapshot: PlayerSnapshot | null = null;
  varispeed = false;
  /** The target queued in the engine to land at the end of the running loop's pass. */
  queued: JumpTarget | null = null;
  /** What the queued target carries when it lands: its own settings, or the main ones. */
  queuedSettings: JumpSettings | null = null;
  /** The target waiting for its image to be ready; null while a seek waits, or nothing does. */
  waiting: JumpTarget | null = null;
  waitingSettings: JumpSettings | null = null;
  /** The loop the engine was told to run from the end of the lap in progress, until it does. */
  pending: Exclude<ActiveLoop, null> | null = null;

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
  /** Waits for `tuneFrame` on behalf of log entry `seq`: a seek, or a jump to `target` carrying `settings`. */
  wait(
    tuneFrame: number,
    seq: number,
    target: JumpTarget | null = null,
    settings: JumpSettings | null = null,
  ): void {
    this.ints[WAITING_FRAME] = tuneFrame;
    this.ints[WAITING_SEQ] = seq;
    this.waiting = target;
    this.waitingSettings = settings;
  }
  stopWaiting(): void {
    this.ints[WAITING_FRAME] = NOT_WAITING;
    this.ints[WAITING_SEQ] = NOT_WAITING;
    this.waiting = null;
    this.waitingSettings = null;
  }

  /** Whether a loop's own settings are in play, the main ones held aside. */
  get ownInPlay(): boolean {
    return this.ints[OWN_IN_PLAY] === 1;
  }
  set ownInPlay(inPlay: boolean) {
    this.ints[OWN_IN_PLAY] = inPlay ? 1 : 0;
  }
  /** Whether `voice` is muted by the loop's own settings (meaningful while they are in play). */
  loopMuted(voice: number): boolean {
    return this.ints[LOOP_MUTES + voice] === 1;
  }
  setLoopMuted(voice: number, muted: boolean): void {
    this.ints[LOOP_MUTES + voice] = muted ? 1 : 0;
  }
  /** The loop's own mutes as a 0/1 view that `mutesAsSettings` reads. */
  get loopMutes(): Int32Array {
    return this.ints.subarray(LOOP_MUTES, LOOP_MUTES + VOICE_COUNT);
  }

  /** Where the hand is: `HAND_UP`, `HAND_DOWN` or `HAND_THROWN`. */
  get handState(): number {
    return this.ints[HAND_STATE];
  }
  set handState(state: number) {
    this.ints[HAND_STATE] = state;
  }
  /** Whether the next rate the hand is asked for is the first since its touch, and sets the anchor. */
  get handAnchorPending(): boolean {
    return this.ints[HAND_ANCHOR_PENDING] === 1;
  }
  set handAnchorPending(pending: boolean) {
    this.ints[HAND_ANCHOR_PENDING] = pending ? 1 : 0;
  }
  get handSampleCount(): number {
    return this.ints[HAND_SAMPLE_COUNT];
  }
  set handSampleCount(count: number) {
    this.ints[HAND_SAMPLE_COUNT] = count;
  }
  get handSampleHead(): number {
    return this.ints[HAND_SAMPLE_HEAD];
  }
  set handSampleHead(head: number) {
    this.ints[HAND_SAMPLE_HEAD] = head;
  }
  /** Whether the throw's first rate has been asked for. */
  get handThrowStarted(): boolean {
    return this.ints[HAND_THROW_STARTED] === 1;
  }
  set handThrowStarted(started: boolean) {
    this.ints[HAND_THROW_STARTED] = started ? 1 : 0;
  }

  /** Whether slip mode is on. */
  get slipOn(): boolean {
    return this.ints[SLIP_ON] === 1;
  }
  set slipOn(on: boolean) {
    this.ints[SLIP_ON] = on ? 1 : 0;
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
      handTravels: new Float64Array(HAND_SAMPLES),
      handTimes: new Float64Array(HAND_SAMPLES),
      snapshot: null,
      varispeed: false,
      queued: null,
      queuedSettings: null,
      waiting: null,
      waitingSettings: null,
      pending: null,
    };
  }

  saveInto(target: DeckStateImage): void {
    target.cells.set(this.cells);
    target.ints.set(this.ints);
    target.handTravels.set(this.handTravels);
    target.handTimes.set(this.handTimes);
    target.snapshot = this.snapshot;
    target.varispeed = this.varispeed;
    target.queued = this.queued;
    target.queuedSettings = this.queuedSettings;
    target.waiting = this.waiting;
    target.waitingSettings = this.waitingSettings;
    target.pending = this.pending;
  }

  restoreFrom(source: DeckStateImage): void {
    this.cells.set(source.cells);
    this.ints.set(source.ints);
    this.handTravels.set(source.handTravels);
    this.handTimes.set(source.handTimes);
    this.snapshot = source.snapshot;
    this.varispeed = source.varispeed;
    this.queued = source.queued;
    this.queuedSettings = source.queuedSettings;
    this.waiting = source.waiting;
    this.waitingSettings = source.waitingSettings;
    this.pending = source.pending;
  }
}
