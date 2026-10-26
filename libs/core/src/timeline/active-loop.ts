import type { C64Machine } from '../cpu/c64-machine.js';
import type { RegisterFrame } from '../registers/register-frame.js';
import { frames, type Frames } from '../units.js';
import type { AnchorRing, PositionAnchor } from './anchor-ring.js';
import { seekToFrame } from './seek.js';
import type { TrackStructure } from './track-structure.js';

/**
 * The loop core enforces on every frame: a start and an end, or null when nothing is looping.
 *
 * One value rather than a collection — the set of loops a performer has saved lives in the
 * application, moved there in an earlier task. This is only ever the one presently running,
 * whichever saved loop it came from, or the track's own loop armed by `advance` below, or none.
 */
export type ActiveLoop = { readonly startFrame: Frames; readonly endFrame: Frames } | null;

/** What `advance` did on a given frame. */
export type AdvanceResult =
  | { readonly action: 'none' }
  | { readonly action: 'looped'; readonly frame: Frames }
  | { readonly action: 'handed-off'; readonly frame: Frames }
  | { readonly action: 'stopped' };

/** A jump queued for the end of the running loop's lap: the frame it starts at, and the loop it
 *  runs from there — null for a cue, which plays on with no loop. */
export interface QueuedNext {
  readonly startFrame: Frames;
  readonly loop: ActiveLoop;
  /** Called once, on the hand-off frame, immediately before the queued image is restored —
   *  never on a lap, a cancel, a replace or a clear. Built by the caller when it queues, so the
   *  hand-off allocates nothing for it. */
  readonly beforeLanding?: () => void;
}

/** Holds the loop presently running and enforces it, frame by frame, against the track it plays
 *  over. */
export interface ActiveLoopTracker {
  /** The loop presently enforced, or null. */
  get(): ActiveLoop;
  /** Replaces the loop presently enforced. Leaves the entry image untouched — set or clear it
   *  separately through `setEntryImage`, since the two do not always change together (arming the
   *  track's own loop inside `advance` keeps whatever image is already held for it). */
  set(loop: ActiveLoop): void;
  /**
   * The image a lap re-enters through in place of a replay along the anchor path — a snapshot
   * taken exactly at the presently active loop's start frame, whichever loop that is: the track's
   * own or a performer's marker loop alike, this tracker enforces either one identically once it
   * holds an image for it. Null falls back to `seekToFrame`.
   *
   * Invalidated by a subtune re-init or a new detection landing — both machine-level events core
   * has no other signal of here, so the caller owns clearing it when either happens. Dropping it at
   * the wrong moment costs a click at the loop point; holding it past either event restores a
   * machine that no longer exists. The caller also owns re-capturing it when the active loop itself
   * changes — this tracker only ever holds the one image it was handed, never fetches its own.
   */
  setEntryImage(entry: PositionAnchor | null): void;
  /** The image presently held, or null. Read so a caller can take the same instant way in that a
   *  lap takes — a deliberate jump to the frame this was taken at is the very restore `advance`
   *  would do, and paying a replay for it instead is the cost this image exists to avoid. */
  entryImage(): PositionAnchor | null;
  /**
   * Queues the jump the next wrap of the running loop makes instead of re-entering that loop,
   * replacing any already queued; null cancels. Holds the object it is given, so the wrap allocates
   * nothing for it. Drops the queued image — the caller hands over the new target's through
   * `setQueuedImage`.
   */
  queue(next: QueuedNext | null): void;
  /** The image of the queued jump's start frame. A queued jump lands only while one is held, so a
   *  wrap with none re-enters the running loop and the queue waits another lap. */
  setQueuedImage(entry: PositionAnchor | null): void;
  /**
   * Enforces whatever is running against `framesRendered`: the active loop if one is set, else the
   * track's own end.
   *
   * Reaching the active loop's end re-enters its start — through the entry image if one is held,
   * else by seeking along the anchor path — and reports the frame landed on. With a jump queued and
   * its image held, it calls the queued jump's `beforeLanding`, restores that image instead, makes
   * the queued loop (or none, for a cue) the active one, empties the queue and reports `handed-off`
   * at the frame landed on.
   *
   * Reaching the track's end with no active loop set decides between replaying and stopping per
   * `track.repeatEnabled()`: off stops, leaving the pair exactly where it stands — what stopping
   * means for playback is the caller's call, not core's. On arms the track's own loop as the active
   * loop — its start defaulting to 0, whether because the track repeats from the top or because it
   * only ever ended and repeating it means replaying the whole thing — and enters it immediately, so
   * every later lap over the same track is the ordinary case above.
   *
   * A seek that comes back with nothing to seek from (the ring holds no usable anchor) leaves the
   * pair and the active loop untouched and reports `none` rather than claim a lap that did not
   * happen; the same check runs again next frame.
   */
  advance(
    machine: C64Machine,
    frame: RegisterFrame,
    ring: AnchorRing,
    track: TrackStructure,
    framesRendered: Frames,
  ): AdvanceResult;
}

export function createActiveLoopTracker(): ActiveLoopTracker {
  let loop: ActiveLoop = null;
  let entryImage: PositionAnchor | null = null;
  let queued: QueuedNext | null = null;
  let queuedImage: PositionAnchor | null = null;

  /** Re-enters `startFrame`, preferring the held entry image over a seek. Returns the frame landed
   *  on, or null when neither is possible and the pair was left untouched. */
  function enter(
    machine: C64Machine,
    frame: RegisterFrame,
    ring: AnchorRing,
    startFrame: Frames,
  ): Frames | null {
    if (entryImage !== null) {
      machine.restore(entryImage.machine);
      frame.restoreValues(entryImage.registers);
      return entryImage.frame;
    }
    return seekToFrame(machine, frame, ring, startFrame) === null ? null : startFrame;
  }

  return {
    get: (): ActiveLoop => loop,

    set(next: ActiveLoop): void {
      loop = next;
      queued = null;
      queuedImage = null;
    },

    setEntryImage(entry: PositionAnchor | null): void {
      entryImage = entry;
    },

    entryImage: (): PositionAnchor | null => entryImage,

    queue(next: QueuedNext | null): void {
      queued = next;
      queuedImage = null;
    },

    setQueuedImage(entry: PositionAnchor | null): void {
      queuedImage = entry;
    },

    advance(machine, frame, ring, track, framesRendered): AdvanceResult {
      if (loop !== null) {
        if (framesRendered < loop.endFrame) return { action: 'none' };
        if (queued !== null && queuedImage !== null) {
          const image = queuedImage;
          queued.beforeLanding?.();
          machine.restore(image.machine);
          frame.restoreValues(image.registers);
          loop = queued.loop;
          if (queued.loop !== null) entryImage = image;
          queued = null;
          queuedImage = null;
          return { action: 'handed-off', frame: image.frame };
        }
        const landed = enter(machine, frame, ring, loop.startFrame);
        return landed === null ? { action: 'none' } : { action: 'looped', frame: landed };
      }

      const trackEnd = track.trackEndFrame();
      if (trackEnd === null || framesRendered < trackEnd) return { action: 'none' };
      if (!track.repeatEnabled()) return { action: 'stopped' };

      const start = track.loopStartFrame() ?? frames(0);
      const landed = enter(machine, frame, ring, start);
      if (landed === null) return { action: 'none' };
      loop = { startFrame: start, endFrame: trackEnd };
      return { action: 'looped', frame: landed };
    },
  };
}
