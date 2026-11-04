import { frames, type Frames } from '../units.js';
import { REENTRY_GATE_OFF_FRAMES, wrapDueFrame } from './active-loop.js';
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
}

/**
 * The count a shadow started at `from`, lapping `loop`, would have after `ticks` ticks. Pure: it
 * counts the way the player's own position does, so a host can keep a count of its own and fold it
 * with the same arithmetic.
 *
 * `null` means no wrap at all, unlike a shadow started with no loop, which wraps at the track's end:
 * a pure helper has no track. A host that wants the track's wrap passes the track's loop.
 */
export function countAfter(
  from: ShadowCount,
  ticks: number,
  loop: { readonly startFrame: Frames; readonly endFrame: Frames } | null,
): ShadowCount {
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

  /** Starts counting from `from`, lapping `loop` or, with none, wrapping where the track does. */
  start(loop: ActiveLoop, from: ShadowCount): void {
    this.running = true;
    this.frame = from.frame;
    this.held = from.held;
    this.ticks = 0;
    this.lapped = loop !== null;
    this.lapStart = loop?.startFrame ?? 0;
    this.lapEnd = loop?.endFrame ?? 0;
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

  /** The exact count, or null when stopped. */
  count(): ShadowCount | null {
    return this.running ? { frame: frames(this.frame), held: this.held } : null;
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
    }
  }
}
