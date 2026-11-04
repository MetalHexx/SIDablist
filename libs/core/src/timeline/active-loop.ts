import type { C64Machine } from '../cpu/c64-machine.js';
import type { RegisterFrame } from '../registers/register-frame.js';
import { frames, type Frames } from '../units.js';
import type { AnchorRing, PositionAnchor } from './anchor-ring.js';
import { seekToFrame } from './seek.js';
import type { TrackStructure } from './track-structure.js';

/** What varispeed does at a held loop's start. */
export type VarispeedLoopStart = 'stop' | 'wrap';

/**
 * The loop core enforces on every frame: a start and an end, or null when nothing is looping.
 *
 * One value rather than a collection — the set of loops a performer has saved lives in the
 * application, moved there in an earlier task. This is only ever the one presently running,
 * whichever saved loop it came from, or the track's own loop armed by `advance` below, or none.
 */
export type ActiveLoop = {
  readonly startFrame: Frames;
  readonly endFrame: Frames;
  /** Holds varispeed inside this loop once the playhead is in it: a move past the end wraps to
   *  the start, and a move back past the start stops at the start ('stop') or wraps to the end
   *  ('wrap'). Absent: varispeed moves through the loop freely. */
  readonly varispeedStart?: VarispeedLoopStart;
} | null;

/**
 * The frame slots a re-entry's resync takes before its start frame plays while playing: the one
 * gate-off frame a landed jump owes the stream in a tick of its own. The player hands the tracker this
 * many frames of lead (`wrapLeadFrames`) so the gate-off takes the place of the loop's last frame
 * rather than being added after it. Without that, every lap ran one tick longer than the loop, and a
 * short loop drifted behind a long one at the same tempo, by one tick per lap of the short one.
 *
 * Lives here because the shadow position counts laps by the same lead.
 */
export const REENTRY_GATE_OFF_FRAMES = 1;

/** What `advance` did on a given frame. */
export type AdvanceResult =
  | { readonly action: 'none' }
  | { readonly action: 'looped'; readonly frame: Frames }
  /** A wrap is due, no entry image is held for the loop's start, and re-entering it would replay
   *  frames on the calling thread. The machine is untouched; the loop is armed if it was the
   *  track's own. `frame` is the loop's start. The caller re-enters it some other way — on the
   *  register record — or runs `seekToFrame` itself. */
  | { readonly action: 'due-unheld'; readonly frame: Frames }
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

/** A running loop's replacement, named for the wrap that ends the lap ending at `atFrame`. */
export interface LoopChange {
  readonly atFrame: Frames;
  readonly loop: Exclude<ActiveLoop, null>;
}

/** Holds the loop presently running and enforces it, frame by frame, against the track it plays
 *  over. */
export interface ActiveLoopTracker {
  /** The loop presently enforced, or null. */
  get(): ActiveLoop;
  /** Replaces the loop presently enforced, dropping a queued jump and a change named. Leaves the
   *  entry image untouched — set or clear it separately through `setEntryImage`, since the two do
   *  not always change together (arming the track's own loop inside `advance` keeps whatever image
   *  is already held for it). */
  set(loop: ActiveLoop): void;
  /**
   * Makes the running loop end at `atFrame` and run `loop` from the wrap that ends there: that
   * wrap re-enters through `image` — the image of `loop`'s start frame — instead of the running
   * loop's own start, reports `looped` like any lap, and makes `loop` the active one. Replaces a
   * change already named. Leaves the entry image and a queued jump alone, which `set` would clear:
   * a queued jump that lands at that wrap lands in the change's place and drops it.
   *
   * A change named at or behind the wrap point lands on the next `advance`. Returns false, changing
   * nothing, when no loop is running.
   */
  changeAt(atFrame: Frames, loop: Exclude<ActiveLoop, null>, image: PositionAnchor): boolean;
  /** The change named and not yet landed, or null. */
  pendingChange(): LoopChange | null;
  /** Drops the change named, if any, and gives the running loop back the end it had before. */
  cancelChange(): void;
  /**
   * The image a lap re-enters through in place of a replay along the anchor path — a snapshot
   * taken exactly at the presently active loop's start frame, whichever loop that is: the track's
   * own or a performer's marker loop alike, this tracker enforces either one identically once it
   * holds an image for it. Null falls back to the anchor ring: a wrap that would replay frames from it is
   * reported as `due-unheld` for the caller to re-enter.
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
   * A wrap falls due `wrapLeadFrames` (see `ActiveLoopTrackerOptions`) before the end it wraps at,
   * so the frames the re-entry owes the stream take the lap's last slots instead of being added
   * after them — but never before the start frame itself has been rendered, so a loop too short to
   * give up a frame still plays one.
   *
   * A wrap of the active loop re-enters its start — through the entry image if one is held, else by
   * seeking along the anchor path — and reports the frame landed on. With a jump queued and its
   * image held, it calls the queued jump's `beforeLanding`, restores that image instead, makes the
   * queued loop (or none, for a cue) the active one, empties the queue and reports `handed-off` at
   * the frame landed on. With no jump landing and a change named by `changeAt`, the wrap restores
   * the change's image instead, makes its loop the active one and reports `looped` at the frame
   * landed on.
   *
   * With no active loop set, the track's end decides between replaying and stopping per
   * `track.repeatEnabled()`: off stops on reaching the true end, with no lead, since a stop owes the
   * stream nothing — leaving the pair exactly where it stands, because what stopping means for
   * playback is the caller's call, not core's. On wraps like any loop, lead included: it arms the
   * track's own loop as the active loop — its start defaulting to 0, whether because the track
   * repeats from the top or because it only ever ended and repeating it means replaying the whole
   * thing — and enters it immediately, so every later lap over the same track is the ordinary case
   * above.
   *
   * A wrap with no entry image held whose start lies past the anchor `ring` would restore replays
   * frames: the tracker leaves the machine untouched and reports `due-unheld` at the start (arming
   * the track's own loop first, when that is what wrapped) instead of seeking. A start the ring's
   * anchor already sits at, such as the track's wrap to frame 0, is still restored here.
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

/** The frame count at which a wrap of `startFrame`..`endFrame` falls due: `lead` frames before the
 *  end, but no earlier than one frame past the start, so the start frame is always rendered. */
export function wrapDueFrame(startFrame: number, endFrame: number, lead: number): number {
  return Math.max(startFrame + 1, endFrame - lead);
}

/** How a tracker times its wraps. */
export interface ActiveLoopTrackerOptions {
  /**
   * How many frames before the end a wrap falls due: the frame slots a re-entry's resync takes
   * before its start frame plays. Default 0, for a host that sends nothing between a loop's last
   * frame and its start.
   *
   * The player passes 1: every re-entry owes the stream a gate-off frame in a tick of its own, and
   * without a lead that tick is added after the loop's last frame, so a lap takes one tick more than
   * the loop has frames. A short loop pays that more often than a long one, so two loops at the same
   * tempo whose lengths are exact multiples drift apart. With the lead the gate-off takes the place
   * of the loop's last frame instead, and a lap takes exactly `endFrame - startFrame` ticks.
   */
  readonly wrapLeadFrames?: number;
}

export function createActiveLoopTracker(options: ActiveLoopTrackerOptions = {}): ActiveLoopTracker {
  const lead = options.wrapLeadFrames ?? 0;
  let loop: ActiveLoop = null;
  let entryImage: PositionAnchor | null = null;
  let queued: QueuedNext | null = null;
  let queuedImage: PositionAnchor | null = null;
  let change: LoopChange | null = null;
  let changeImage: PositionAnchor | null = null;
  /** The running loop as it stood before the first change was named. */
  let unchanged: ActiveLoop = null;

  /** Re-enters `startFrame`, preferring the held entry image over a seek. Returns the frame landed
   *  on; `'unheld'` when neither an image nor a replay-free anchor is at hand, leaving the pair
   *  untouched; or null when there is nothing to seek from at all. */
  function enter(
    machine: C64Machine,
    frame: RegisterFrame,
    ring: AnchorRing,
    startFrame: Frames,
  ): Frames | 'unheld' | null {
    if (entryImage !== null) {
      machine.restore(entryImage.machine);
      frame.restoreValues(entryImage.registers);
      return entryImage.frame;
    }
    const anchor = ring.select(startFrame);
    if (anchor !== null && anchor.frame < startFrame) return 'unheld';
    return seekToFrame(machine, frame, ring, startFrame) === null ? null : startFrame;
  }

  const wrapDueAt = (startFrame: Frames, endFrame: Frames): number =>
    wrapDueFrame(startFrame, endFrame, lead);

  return {
    get: (): ActiveLoop => loop,

    set(next: ActiveLoop): void {
      loop = next;
      queued = null;
      queuedImage = null;
      change = null;
      changeImage = null;
    },

    changeAt(atFrame, next, image): boolean {
      if (loop === null) return false;
      if (change === null) unchanged = loop;
      loop = { ...loop, endFrame: atFrame };
      change = { atFrame, loop: next };
      changeImage = image;
      return true;
    },

    pendingChange: (): LoopChange | null => change,

    cancelChange(): void {
      if (change === null) return;
      loop = unchanged;
      change = null;
      changeImage = null;
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
        if (framesRendered < wrapDueAt(loop.startFrame, loop.endFrame)) return { action: 'none' };
        if (queued !== null && queuedImage !== null) {
          const image = queuedImage;
          queued.beforeLanding?.();
          machine.restore(image.machine);
          frame.restoreValues(image.registers);
          loop = queued.loop;
          if (queued.loop !== null) entryImage = image;
          queued = null;
          queuedImage = null;
          change = null;
          changeImage = null;
          return { action: 'handed-off', frame: image.frame };
        }
        if (change !== null && changeImage !== null) {
          const image = changeImage;
          machine.restore(image.machine);
          frame.restoreValues(image.registers);
          loop = change.loop;
          entryImage = image;
          change = null;
          changeImage = null;
          return { action: 'looped', frame: image.frame };
        }
        const landed = enter(machine, frame, ring, loop.startFrame);
        if (landed === 'unheld') return { action: 'due-unheld', frame: loop.startFrame };
        return landed === null ? { action: 'none' } : { action: 'looped', frame: landed };
      }

      const trackEnd = track.trackEndFrame();
      if (trackEnd === null) return { action: 'none' };
      if (!track.repeatEnabled()) {
        return framesRendered < trackEnd ? { action: 'none' } : { action: 'stopped' };
      }

      const start = track.loopStartFrame() ?? frames(0);
      if (framesRendered < wrapDueAt(start, trackEnd)) return { action: 'none' };
      const landed = enter(machine, frame, ring, start);
      if (landed === null) return { action: 'none' };
      loop = { startFrame: start, endFrame: trackEnd };
      if (landed === 'unheld') return { action: 'due-unheld', frame: start };
      return { action: 'looped', frame: landed };
    },
  };
}
