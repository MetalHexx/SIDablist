import type { SidPlayer, VarispeedRateSource } from '@sidablist/core';
import {
  HAND_ANCHOR,
  HAND_DOWN,
  HAND_EXPECTED,
  HAND_GRIP,
  HAND_RATE,
  HAND_RELEASE_SPEED,
  HAND_SAMPLES,
  HAND_THROWN,
  HAND_TRAVEL,
  HAND_UP,
  type DeckState,
} from './deck-state.js';
import type { DeckSlip } from './slip.js';

/** How far back from the newest sample the release speed reaches, in milliseconds. */
const RELEASE_WINDOW_MS = 40;

/** A position this close to where the last tick left it was not moved by anything else. */
const POSITION_EPSILON = 1e-6;

/**
 * The hand on the record: a touch, the moves and a lift, played as varispeed. While the hand is
 * down the position follows it exactly (each tick the rate puts the position where the hand says,
 * with no smoothing); on a lift the record carries on at the speed the hand left it and slows, at
 * constant friction, to the deck's own speed (to a stop on a deck that is not playing), and the
 * deck then leaves varispeed. With slip on, a touch is a slip departure and a lift lands the deck
 * on the count slip kept instead of throwing.
 *
 * Commands only record what the hand does. The rate is worked out by `rateSource`, which the engine
 * asks inside its tick: it reads and writes nothing but the hand's own numbers in `DeckState` (and
 * pure reads of the engine's snapshot), allocates nothing and issues no engine command, so a rewind
 * that restores those numbers replays it exactly. What a tick makes of the throw reaching the
 * deck's speed is done afterwards, between ticks, by `afterTick`.
 */
export class DeckHand {
  /** The engine's once-a-tick question: how far to move the record. Made once, so a touch builds no closure. */
  private readonly rateSource: VarispeedRateSource = (position, intervalUs) =>
    this.rate(position, intervalUs);

  constructor(
    private readonly player: SidPlayer,
    private readonly state: DeckState,
    private readonly slip: DeckSlip,
  ) {}

  /**
   * The hand lands on the record. Nothing changes without a tune whose register record the engine
   * holds, or when the engine will not enter varispeed. From up, the slip departure for the hand
   * begins first, because varispeed clears the phase the shadow starts from; from thrown the hand
   * grabs the record again, already in varispeed.
   */
  touch(): void {
    const player = this.player;
    const state = this.state;
    const tune = player.getSnapshot().tune;
    if (tune === null || tune.recordedFrames === null) return;
    if (state.handState === HAND_UP) {
      this.slip.begin('hand');
      if (!player.enterVarispeed(this.rateSource)) {
        this.slip.release('hand');
        return;
      }
    }
    state.cells[HAND_TRAVEL] = 0;
    state.handAnchorPending = true;
    state.handSampleCount = 0;
    state.handSampleHead = 0;
    state.handThrowStarted = false;
    state.handState = HAND_DOWN;
  }

  /** The hand moves to `travelFrames` from its touch, at host time `atMs`. Ignored unless the hand is down. */
  move(travelFrames: number, atMs: number): void {
    const state = this.state;
    if (state.handState !== HAND_DOWN) return;
    state.cells[HAND_TRAVEL] = travelFrames;
    const head = state.handSampleHead;
    state.handTravels[head] = travelFrames;
    state.handTimes[head] = atMs;
    state.handSampleHead = (head + 1) % HAND_SAMPLES;
    if (state.handSampleCount < HAND_SAMPLES) state.handSampleCount++;
  }

  /**
   * The hand lifts at host time `atMs`. Slip landing the hand's departure ends it with no throw;
   * otherwise the record is thrown at the release speed and slows with `gripSeconds` of friction
   * per 1x. Ignored unless the hand is down.
   */
  lift(atMs: number, gripSeconds: number): void {
    const state = this.state;
    if (state.handState !== HAND_DOWN) return;
    if (this.slip.land('hand')) {
      state.handState = HAND_UP;
      return;
    }
    state.cells[HAND_RELEASE_SPEED] = this.releaseSpeed(atMs);
    state.cells[HAND_GRIP] = gripSeconds;
    state.handThrowStarted = false;
    state.handState = HAND_THROWN;
  }

  /**
   * Lets go with no throw (a stop, a load, a subtune change): a hand that is down or thrown goes up
   * and the touch's later moves and lift are ignored, the deck leaves varispeed if it is in it, and
   * slip is abandoned.
   */
  letGo(): void {
    this.state.handState = HAND_UP;
    this.slip.abandon();
    if (this.player.getSnapshot().tempo.varispeed) this.player.leaveVarispeed();
  }

  /**
   * Between ticks, after the tick that rendered: a throw whose rate reached the deck's speed hands
   * the record back. On a deck that is not playing, leaving varispeed starts an off-thread jump
   * that returns no promise, so it is replaced at once with an awaited seek to the position, and
   * that promise is returned for the deck to settle on; null otherwise.
   */
  afterTick(): Promise<void> | null {
    const state = this.state;
    if (state.handState !== HAND_THROWN || !state.handThrowStarted) return null;
    const player = this.player;
    const playing = player.getSnapshot().transport === 'playing';
    if (state.cells[HAND_RATE] !== (playing ? 1 : 0)) return null;
    state.handState = HAND_UP;
    player.leaveVarispeed();
    return playing ? null : player.seek(player.getPosition());
  }

  /** Frames per millisecond between the newest sample and the oldest within the window of it; 0 when there is no such pair. */
  private releaseSpeed(atMs: number): number {
    const state = this.state;
    const travels = state.handTravels;
    const times = state.handTimes;
    const count = state.handSampleCount;
    if (count < 2) return 0;
    const newest = (state.handSampleHead + HAND_SAMPLES - 1) % HAND_SAMPLES;
    if (atMs - times[newest] > RELEASE_WINDOW_MS) return 0;
    let oldest = newest;
    for (let back = 1; back < count; back++) {
      const at = (newest + HAND_SAMPLES - back) % HAND_SAMPLES;
      if (times[newest] - times[at] > RELEASE_WINDOW_MS) break;
      oldest = at;
    }
    const span = times[newest] - times[oldest];
    return span > 0 ? (travels[newest] - travels[oldest]) / span : 0;
  }

  /** Runs inside the engine's tick: no allocation, no engine command. */
  private rate(position: number, intervalUs: number): number {
    switch (this.state.handState) {
      case HAND_DOWN:
        return this.downRate(position);
      case HAND_THROWN:
        return this.thrownRate(position, intervalUs);
      default:
        return 0;
    }
  }

  /**
   * The rate that puts the position where the hand says: the anchor plus the travel. The first
   * call after a touch sets the anchor to the position; later, something else moving the position
   * (a seek, the record's end) moves the anchor with it, so the hand carries on from there.
   */
  private downRate(position: number): number {
    const state = this.state;
    const cells = state.cells;
    if (state.handAnchorPending) {
      state.handAnchorPending = false;
      cells[HAND_ANCHOR] = position;
    } else if (Math.abs(position - cells[HAND_EXPECTED]) > POSITION_EPSILON) {
      cells[HAND_ANCHOR] += position - cells[HAND_EXPECTED];
    }
    const rate = cells[HAND_ANCHOR] + cells[HAND_TRAVEL] - position;
    cells[HAND_EXPECTED] = position + rate;
    return rate;
  }

  /**
   * The release speed on the throw's first tick, then constant friction toward the deck's own
   * speed: 1 on a playing deck, 0 on any other. A backward rate with the record at the start of a
   * running loop that stops is forced to 0, so the throw climbs from standstill there; a loop that
   * wraps is the engine's to wrap round.
   */
  private thrownRate(position: number, intervalUs: number): number {
    const state = this.state;
    const cells = state.cells;
    const snapshot = this.player.getSnapshot();
    const target = snapshot.transport === 'playing' ? 1 : 0;
    let rate: number;
    if (!state.handThrowStarted) {
      state.handThrowStarted = true;
      rate = cells[HAND_RELEASE_SPEED] * (intervalUs / 1000);
    } else {
      const step = intervalUs / 1e6 / cells[HAND_GRIP];
      const gap = target - cells[HAND_RATE];
      rate = Math.abs(gap) <= step ? target : cells[HAND_RATE] + Math.sign(gap) * step;
    }
    const loop = snapshot.loop;
    if (
      rate < 0 &&
      loop !== null &&
      loop.varispeedStart === 'stop' &&
      Math.abs(position - loop.startFrame) <= POSITION_EPSILON
    ) {
      rate = 0;
    }
    cells[HAND_RATE] = rate;
    return rate;
  }
}
