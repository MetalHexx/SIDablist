import { frames, type Frames } from '../units.js';
import {
  REENTRY_GATE_OFF_FRAMES,
  lapLength,
  lapPhaseAfter,
  lapSpan,
  lapsWithin,
  reduceLapPhase,
  wrapDueFrame,
} from './active-loop.js';
import type { ActiveLoop } from './active-loop.js';
import type { TrackStructure } from './track-structure.js';

/**
 * A count's exact place: its frame (`getPosition()`'s unit), and whether its next tick holds it
 * there, as the tick after a wrap or a landing does (a gate-off is pending). The two reads of a
 * lap's start differ only in `held`.
 */
export interface ShadowCount {
  readonly frame: Frames;
  readonly held: boolean;
  /**
   * The reduced phase of the lap the count is in, when it laps a loop whose length is not a whole
   * number of frames (see `ActiveLoop`): which of the alternating lap lengths it is counting.
   * Absent otherwise. A count handed in without it, on such a loop, is in the lap at the loop's
   * own `lapPhase`.
   */
  readonly lapPhase?: number;
}

/** A loop as `countAfter` reads it. */
export interface CountedLoop {
  readonly startFrame: Frames;
  readonly endFrame: Frames;
  readonly lapPhase?: number;
}

/** Whether a length laps in alternating whole-frame lengths: finite and not whole. */
function alternates(lengthFrames: number): boolean {
  return Number.isFinite(lengthFrames) && !Number.isInteger(lengthFrames);
}

/** The ticks a lap of two frames or fewer takes from its start, held: the gate-off tick and the
 *  start frame, which a wrap never gives up. */
const SHORTEST_LAP_TICKS = 2;

/**
 * The count a shadow started at `from`, lapping `loop`, would have after `ticks` ticks. Pure: it
 * counts the way the player's own position does, so a host can keep a count of its own and fold it
 * with the same arithmetic.
 *
 * `null` means no wrap at all, unlike a shadow started with no loop, which wraps at the track's end:
 * a pure helper has no track. A host that wants the track's wrap passes the track's loop.
 *
 * A loop whose length is not whole laps in alternating lengths, as the player laps it; the count
 * comes back with the `lapPhase` of the lap it is in, and `from` is read in the lap its own
 * `lapPhase` names, else in the loop's. O(1) however many laps the ticks span.
 */
export function countAfter(
  from: ShadowCount,
  ticks: number,
  loop: CountedLoop | null,
): ShadowCount {
  if (loop !== null && alternates(loop.endFrame - loop.startFrame)) {
    return countAlternating(from, ticks, loop);
  }
  let remaining = Math.floor(ticks);
  if (!(remaining > 0)) return from;
  const frame: number = from.frame;
  if (from.held) remaining--;

  if (loop === null) return { frame: frames(frame + remaining), held: false };

  const { startFrame } = loop;
  const dueAt = wrapDueFrame(startFrame, loop.endFrame, REENTRY_GATE_OFF_FRAMES);
  // A lap from its start: the gate-off tick, then the ticks that carry the count up to where the
  // next wrap falls due.
  const lap = 1 + (dueAt - startFrame);

  const untilWrap = Math.max(1, dueAt - frame);
  if (remaining < untilWrap) return { frame: frames(frame + remaining), held: false };
  remaining = (remaining - untilWrap) % lap;
  if (remaining === 0) return { frame: frames(startFrame), held: true };
  return { frame: frames(startFrame + remaining - 1), held: false };
}

/** `countAfter` over a loop of alternating lap lengths. */
function countAlternating(from: ShadowCount, ticks: number, loop: CountedLoop): ShadowCount {
  const { startFrame } = loop;
  const length = loop.endFrame - startFrame;
  const startPhase = reduceLapPhase(from.lapPhase ?? loop.lapPhase ?? 0);
  let remaining = Math.floor(ticks);
  if (!(remaining > 0)) return { frame: from.frame, held: from.held, lapPhase: startPhase };
  const frame: number = from.frame;
  if (from.held) remaining--;

  const dueAt = wrapDueFrame(
    startFrame,
    startFrame + lapLength(startPhase, length),
    REENTRY_GATE_OFF_FRAMES,
  );
  const untilWrap = Math.max(1, dueAt - frame);
  if (remaining < untilWrap) {
    return { frame: frames(frame + remaining), held: false, lapPhase: startPhase };
  }
  remaining -= untilWrap;

  // At the start, held, in the next lap. Whole laps from here take their own lengths in ticks —
  // every lap is at least two frames — so the ticks they take telescope like their frames do. A
  // length under two frames, which the player refuses, laps in two ticks whatever its frames.
  const phase = lapPhaseAfter(startPhase, length, 1);
  let laps: number;
  if (length >= SHORTEST_LAP_TICKS) {
    laps = lapsWithin(phase, length, remaining);
    remaining -= lapSpan(phase, length, laps);
  } else {
    laps = Math.floor(remaining / SHORTEST_LAP_TICKS);
    remaining -= laps * SHORTEST_LAP_TICKS;
  }
  const lapPhase = lapPhaseAfter(phase, length, laps);
  if (remaining === 0) return { frame: frames(startFrame), held: true, lapPhase };
  return { frame: frames(startFrame + remaining - 1), held: false, lapPhase };
}

/** What a shadow reads of the track it wraps at when it has no loop of its own. */
export type ShadowTrack = Pick<TrackStructure, 'trackEndFrame' | 'loopStartFrame'>;

/**
 * The counter behind `SidPlayer.startShadow`: a frame, a phase and a tick count, moved one tick at a
 * time by the coordinator while the transport is playing. Allocates nothing on `tick`, which runs on
 * the frame path.
 */
export class ShadowPosition {
  private running = false;
  private frame = 0;
  private held = false;
  private ticks = 0;
  private lapped = false;
  private lapStart = 0;
  private lapEnd = 0;
  /** The loop's length when it laps in alternating lengths, else 0. */
  private alternatingLength = 0;
  /** The reduced phase of the lap counted now, for a loop of alternating lap lengths. */
  private lapPhase = 0;

  /** Starts counting from `from`, lapping `loop` or, with none, wrapping where the track does. A
   *  loop of alternating lap lengths is counted in the lap `from.lapPhase` names, else in the lap
   *  at the loop's own `lapPhase`. */
  start(loop: ActiveLoop, from: ShadowCount): void {
    this.running = true;
    this.frame = from.frame;
    this.held = from.held;
    this.ticks = 0;
    this.lapped = loop !== null;
    this.lapStart = loop?.startFrame ?? 0;
    this.lapEnd = loop?.endFrame ?? 0;
    this.alternatingLength = 0;
    this.lapPhase = 0;
    if (loop !== null && alternates(loop.endFrame - loop.startFrame)) {
      this.alternatingLength = loop.endFrame - loop.startFrame;
      this.lapPhase = reduceLapPhase(from.lapPhase ?? loop.lapPhase ?? 0);
      this.lapEnd = this.lapStart + lapLength(this.lapPhase, this.alternatingLength);
    }
  }

  stop(): void {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** The frame counted now, or null when stopped. */
  position(): Frames | null {
    return this.running ? frames(this.frame) : null;
  }

  /** The exact count, or null when stopped. Carries the lap's phase only on a loop of alternating
   *  lap lengths. */
  count(): ShadowCount | null {
    if (!this.running) return null;
    return this.alternatingLength === 0
      ? { frame: frames(this.frame), held: this.held }
      : { frame: frames(this.frame), held: this.held, lapPhase: this.lapPhase };
  }

  /** Ticks counted since the last start, or null when stopped. */
  tickCount(): number | null {
    return this.running ? this.ticks : null;
  }

  /** Counts one clock tick, as the player's own position would move on it. */
  tick(track: ShadowTrack): void {
    if (!this.running) return;
    this.ticks++;
    if (this.held) {
      this.held = false;
      return;
    }
    this.frame++;

    let start = this.lapStart;
    let end = this.lapEnd;
    if (!this.lapped) {
      const trackEnd = track.trackEndFrame();
      if (trackEnd === null) return;
      end = trackEnd;
      start = track.loopStartFrame() ?? 0;
    }
    if (this.frame >= wrapDueFrame(start, end, REENTRY_GATE_OFF_FRAMES)) {
      this.frame = start;
      this.held = true;
      if (this.alternatingLength !== 0) {
        this.lapPhase = reduceLapPhase(this.lapPhase + this.alternatingLength);
        this.lapEnd = start + lapLength(this.lapPhase, this.alternatingLength);
      }
    }
  }
}
