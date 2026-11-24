import { countAfter, frames } from '@sidablist/core';
import type { CountedLoop, ShadowCount, SidPlayer } from '@sidablist/core';
import {
  SLIP_CELLS_AT,
  SLIP_CELL_STRIDE,
  SLIP_INTS_AT,
  SLIP_INT_STRIDE,
  type DeckState,
} from './deck-state.js';

/** What starts a departure from the line. */
type SlipKind = 'live-loop' | 'loop' | 'hand';

/** A departure's kind as `DeckState` holds it. */
const NONE = 0;
const LIVE_LOOP = 1;
const LOOP = 2;
const HAND = 3;

const CODES: Readonly<Record<SlipKind, number>> = {
  'live-loop': LIVE_LOOP,
  loop: LOOP,
  hand: HAND,
};

/** The two places a departure is kept: the one running, and the one it nests inside. */
const RUN = 0;
const OUTER = 1;

/** Fields of a departure in `DeckState.ints`, and in `DeckState.cells`. */
const KIND = 0;
const QUEUED = 1;
const HAS_LAP = 2;
const COUNT_HELD = 3;
const LAP_START = 0;
const LAP_END = 1;
const LAP_PHASE = 2;
const COUNT_FRAME = 3;
const COUNT_PHASE = 4;

/**
 * Slip: a second count that moves as the tune would have while a loop, a live loop or the hand holds
 * the deck somewhere else, and the landing back on it.
 *
 * A departure begins, with slip on, when the deck is taken off the line, always before the engine
 * call that moves the playhead, so the shadow starts from the frame that was sounding. Its end
 * lands the deck on the shadow's count, frame and phase. A landing that cannot be made (not
 * playing, no record, the count past it) abandons the departure, and the caller carries on as with
 * slip off.
 *
 * One departure runs at a time, and one level of nesting is kept: a live loop, or the hand, begun
 * inside a running departure keeps that one and its count as the outer line, which resumes (the
 * count folded through the ticks the inner ran) when the inner ends. A third level replaces the
 * outer one. A loop begun inside a running departure begins nothing: the count carries on.
 *
 * Every departure lives in `DeckState` as numbers (the running one and the outer one, each with
 * the lap it returns into and, for the outer, its count), so a rewind puts slip back with the
 * engine and a save builds nothing. Its calls are made between ticks, from commands that land
 * through the log or from what a tick showed.
 */
export class DeckSlip {
  /**
   * Where the tune's own loop starts: what a count with no lap of its own laps (with the track's
   * end). Set with each load and never changed by a rewind, so it is not in `DeckState`.
   */
  trackLoopStart: number | null = null;

  constructor(
    private readonly player: SidPlayer,
    private readonly state: DeckState,
  ) {}

  get on(): boolean {
    return this.state.slipOn;
  }

  /** Turns slip on or off; off abandons a departure with no landing. */
  setOn(on: boolean): void {
    this.state.slipOn = on;
    if (!on) this.abandon();
  }

  /** Whether a departure is running. */
  get departed(): boolean {
    return this.state.ints[intAt(RUN, KIND)] !== NONE;
  }

  /** Where slip would land the deck now: the shadow's frame while a departure runs, else null. */
  position(): number | null {
    return this.departed ? this.player.getShadowPosition() : null;
  }

  /**
   * Begins a departure of `kind`, when slip is on. With none running the shadow starts from the
   * player's own position, phase and lap, in the loop running now (`queued`: a loop that waits for
   * its landing). Inside a running departure a loop begins nothing, and a live loop or the hand
   * nests: the outer line is the running departure with its count at this moment.
   */
  begin(kind: SlipKind, queued = false): void {
    if (!this.state.slipOn) return;
    this.forgetStopped();
    const player = this.player;
    const lap = this.loopRunning();
    if (this.kindOf(RUN) === NONE) {
      if (player.startShadow(lap)) this.setRun(CODES[kind], queued, lap);
      return;
    }
    if (kind === 'loop') return;
    const count = player.getShadowCount();
    if (count !== null && player.startShadow(lap)) {
      this.copy(RUN, OUTER);
      this.storeCount(count);
      this.setRun(CODES[kind], queued, lap);
    }
  }

  /**
   * The end of the departure of `kind`, landing the deck on the shadow's count: the departure
   * ends, or the outer line resumes when there is one. True when the deck landed. False when it
   * did not: the departure running is of another kind (which retires the outer one of this kind),
   * or the landing could not be made, which abandons the departure.
   */
  land(kind: SlipKind): boolean {
    this.forgetStopped();
    if (this.kindOf(RUN) !== CODES[kind]) {
      this.retireOuter(kind);
      return false;
    }
    if (!this.player.landOnShadow()) {
      this.abandon();
      return false;
    }
    this.endRun();
    return true;
  }

  /** The end of the departure of `kind` with no landing. */
  release(kind: SlipKind): void {
    this.forgetStopped();
    if (this.kindOf(RUN) !== CODES[kind]) {
      this.retireOuter(kind);
      return;
    }
    this.endRun();
  }

  /**
   * A loop landed, from the queue or at once, and is the departure now: the count carries on with
   * no landing. The loop the count was lapping is replaced and nothing returns into it, so the
   * count moves back to the line without that lap: the outer line resumed through the ticks the
   * inner ran, else the same count with no lap. The hand is left to its own lift.
   */
  loopLanded(): void {
    this.forgetStopped();
    const kind = this.kindOf(RUN);
    if (kind === NONE || kind === HAND) return;
    this.resumeOuter();
    if (this.kindOf(RUN) === HAND) return;
    if (this.state.ints[intAt(RUN, HAS_LAP)] === 1) {
      const count = this.player.getShadowCount();
      if (count !== null) this.player.startShadow(null, count);
    }
    this.setRun(LOOP, false, null);
  }

  /** A cue landed. It is a jump, so the departure is over and the line starts again where the deck is. */
  cueLanded(): void {
    this.abandon();
  }

  /** A queued loop was cancelled: a departure that began with it and has not landed is over, or the outer one is dropped. */
  cancelQueued(): void {
    this.forgetStopped();
    const ints = this.state.ints;
    if (ints[intAt(RUN, KIND)] !== NONE && ints[intAt(RUN, QUEUED)] === 1) {
      this.abandon();
    } else if (ints[intAt(OUTER, KIND)] !== NONE && ints[intAt(OUTER, QUEUED)] === 1) {
      this.clear(OUTER);
    }
  }

  /**
   * Lands on the outermost departure's line (the outer one resumed through the ticks the inner ran,
   * else the shadow) and ends every departure. Nothing when none runs, and nothing when the
   * outermost is the hand, which lands at its lift.
   */
  landOutermost(): void {
    this.forgetStopped();
    const outermost = this.kindOf(OUTER) !== NONE ? this.kindOf(OUTER) : this.kindOf(RUN);
    if (outermost === NONE || outermost === HAND) return;
    this.resumeOuter();
    this.player.landOnShadow();
    this.abandon();
  }

  /** Ends every departure with no landing: a stop, a load, a subtune change, a seek, or slip turned off. */
  abandon(): void {
    if (this.kindOf(RUN) === NONE && this.kindOf(OUTER) === NONE) return;
    this.clear(RUN);
    this.clear(OUTER);
    this.player.stopShadow();
  }

  /** The running departure ends: the outer one resumes when there is one, else the shadow stops. */
  private endRun(): void {
    if (this.kindOf(OUTER) === NONE) this.abandon();
    else this.resumeOuter();
  }

  /** The engine has stopped its shadow: the departure is forgotten. */
  private forgetStopped(): void {
    if (this.kindOf(RUN) !== NONE && this.player.getShadowPosition() === null) {
      this.clear(RUN);
      this.clear(OUTER);
    }
  }

  /**
   * The end of the departure of `kind` while a newer one nested inside it still runs: the older is
   * over with no landing, as the deck is not where it would land. The newer takes over its line,
   * the shadow re-based to the older count through the ticks the newer ran and lapping what the
   * older lapped, so the newer one's own end still lands where the tune would be. Nothing when
   * `kind` is not the outer departure.
   */
  private retireOuter(kind: SlipKind): void {
    if (this.kindOf(RUN) === NONE || this.kindOf(OUTER) !== CODES[kind]) return;
    const ints = this.state.ints;
    const innerKind = ints[intAt(RUN, KIND)];
    const innerQueued = ints[intAt(RUN, QUEUED)];
    this.resumeOuter();
    ints[intAt(RUN, KIND)] = innerKind;
    ints[intAt(RUN, QUEUED)] = innerQueued;
  }

  /**
   * Resumes the outer line: the shadow re-based to its lap at the count it has reached, the ticks
   * the inner departure ran later. The count carries the lap it is in on a loop of alternating lap
   * lengths, which `countAfter` and the re-based shadow read before the loop's own phase, so the
   * alternation carries on exactly. Nothing without an outer line.
   */
  private resumeOuter(): void {
    if (this.kindOf(OUTER) === NONE) return;
    const lap = this.readLap(OUTER);
    const count = countAfter(
      this.readCount(),
      this.player.getShadowTicks() ?? 0,
      lap ?? this.trackLoop(),
    );
    this.copy(OUTER, RUN);
    this.clear(OUTER);
    this.player.startShadow(lap, count);
  }

  /** The loop running now, with the lap phase the engine's loop was set with; null on the line. */
  private loopRunning(): CountedLoop | null {
    const loop = this.player.getSnapshot().loop;
    if (loop === null) return null;
    return {
      startFrame: loop.startFrame,
      endFrame: loop.endFrame,
      ...(loop.lapPhase === undefined ? {} : { lapPhase: loop.lapPhase }),
    };
  }

  /** The loop the track wraps at, which a count with no lap of its own follows; null when it has no end. */
  private trackLoop(): CountedLoop | null {
    const end = this.player.getSnapshot().basis.trackEndFrame;
    return end === null ? null : { startFrame: frames(this.trackLoopStart ?? 0), endFrame: end };
  }

  private kindOf(departure: number): number {
    return this.state.ints[intAt(departure, KIND)];
  }

  private setRun(kind: number, queued: boolean, lap: CountedLoop | null): void {
    const ints = this.state.ints;
    const cells = this.state.cells;
    ints[intAt(RUN, KIND)] = kind;
    ints[intAt(RUN, QUEUED)] = queued ? 1 : 0;
    ints[intAt(RUN, HAS_LAP)] = lap === null ? 0 : 1;
    if (lap !== null) {
      cells[cellAt(RUN, LAP_START)] = lap.startFrame;
      cells[cellAt(RUN, LAP_END)] = lap.endFrame;
      cells[cellAt(RUN, LAP_PHASE)] = lap.lapPhase ?? Number.NaN;
    }
  }

  private clear(departure: number): void {
    this.state.ints[intAt(departure, KIND)] = NONE;
  }

  private copy(from: number, to: number): void {
    const ints = this.state.ints;
    const cells = this.state.cells;
    for (let field = 0; field < SLIP_INT_STRIDE; field++) {
      ints[intAt(to, field)] = ints[intAt(from, field)];
    }
    for (let field = 0; field < SLIP_CELL_STRIDE; field++) {
      cells[cellAt(to, field)] = cells[cellAt(from, field)];
    }
  }

  /** The count the outer line left, from the shadow, which `copy` carried with it. */
  private storeCount(count: ShadowCount): void {
    const cells = this.state.cells;
    this.state.ints[intAt(OUTER, COUNT_HELD)] = count.held ? 1 : 0;
    cells[cellAt(OUTER, COUNT_FRAME)] = count.frame;
    cells[cellAt(OUTER, COUNT_PHASE)] = count.lapPhase ?? Number.NaN;
  }

  private readCount(): ShadowCount {
    const cells = this.state.cells;
    const lapPhase = cells[cellAt(OUTER, COUNT_PHASE)];
    return {
      frame: frames(cells[cellAt(OUTER, COUNT_FRAME)]),
      held: this.state.ints[intAt(OUTER, COUNT_HELD)] === 1,
      ...(Number.isNaN(lapPhase) ? {} : { lapPhase }),
    };
  }

  private readLap(departure: number): CountedLoop | null {
    if (this.state.ints[intAt(departure, HAS_LAP)] !== 1) return null;
    const cells = this.state.cells;
    const lapPhase = cells[cellAt(departure, LAP_PHASE)];
    return {
      startFrame: frames(cells[cellAt(departure, LAP_START)]),
      endFrame: frames(cells[cellAt(departure, LAP_END)]),
      ...(Number.isNaN(lapPhase) ? {} : { lapPhase }),
    };
  }
}

function intAt(departure: number, field: number): number {
  return SLIP_INTS_AT + departure * SLIP_INT_STRIDE + field;
}

function cellAt(departure: number, field: number): number {
  return SLIP_CELLS_AT + departure * SLIP_CELL_STRIDE + field;
}
