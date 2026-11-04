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
 *
 * The length `endFrame - startFrame` need not be a whole number of frames. A loop whose length is
 * not plays laps of alternating whole-frame lengths: lap k lasts `lapLength(lapPhase, length, k)`
 * frames, so its ends fall on the frames the grid's own lines round to and any run of laps adds up
 * to the length times the laps, give or take the rounding — it never drifts. Such a loop must be at
 * least `MIN_FRACTIONAL_LOOP_FRAMES` long, so no lap is shorter than a play call and its gate-off.
 */
export type ActiveLoop = {
  readonly startFrame: Frames;
  /** Where the loop ends: for a length that is not whole, its average end, never the end of any
   *  one lap. */
  readonly endFrame: Frames;
  /** Holds varispeed inside this loop once the playhead is in it: a move past the end wraps to
   *  the start, and a move back past the start stops at the start ('stop') or wraps to the end
   *  ('wrap'). Absent: varispeed moves through the loop freely. */
  readonly varispeedStart?: VarispeedLoopStart;
  /**
   * The unrounded grid position of the loop's start line — `beatOneFrame + i × period` — which
   * says how the laps of a length that is not whole alternate. Only its fractional part matters.
   * Absent: 0, the phase of a whole-frame start. Means nothing for a whole length.
   *
   * It is the phase of the lap that begins when the loop is set: a host that sets a loop mid-way
   * through some later lap may pass that lap's phase instead (`lapPhaseAfter`). A queued loop
   * landing at a running loop's wrap laps from that loop's clock instead (see
   * `ActiveLoopTracker.queue`), and still reads back with the phase it was queued with.
   */
  readonly lapPhase?: number;
} | null;

/** The shortest length, in frames, a loop whose length is not a whole number of frames may take:
 *  every lap is then at least two frames, one play call and the gate-off its re-entry owes. */
export const MIN_FRACTIONAL_LOOP_FRAMES = 2;

/** A lap phase reduced to its fractional part, in [0, 1); 0 for one that is not a finite number. */
export function reduceLapPhase(phase: number): number {
  if (!Number.isFinite(phase)) return 0;
  // `+ 0` turns a -0 into 0.
  return phase - Math.floor(phase) + 0;
}

/**
 * The whole frames `laps` laps of a loop `lengthFrames` long take, counting from a lap at `phase`:
 * `Math.round(phase + laps × length) - Math.round(phase)`, the rounding `gridLine` uses. It
 * telescopes, so the laps between any two counts add up exactly and nothing drifts. A whole length
 * gives `laps × length`, whatever the phase.
 */
export function lapSpan(phase: number, lengthFrames: number, laps: number): number {
  return Math.round(phase + laps * lengthFrames) - Math.round(phase);
}

/** The whole frames lap `lap` lasts, the lap at `phase` being lap 0:
 *  `Math.round(phase + (lap + 1) × length) - Math.round(phase + lap × length)`. */
export function lapLength(phase: number, lengthFrames: number, lap = 0): number {
  return Math.round(phase + (lap + 1) * lengthFrames) - Math.round(phase + lap * lengthFrames);
}

/** The reduced phase of the lap `laps` laps on from a lap at `phase`. */
export function lapPhaseAfter(phase: number, lengthFrames: number, laps: number): number {
  return reduceLapPhase(phase + laps * lengthFrames);
}

/**
 * How many whole laps, from a lap at `phase`, fit in `spanFrames` frames: the largest k ≥ 0 with
 * `lapSpan(phase, length, k) <= spanFrames`. O(1): the estimate is off by at most a lap, since the
 * span of k laps is within a frame of k × length. 0 for a length that is not positive.
 */
export function lapsWithin(phase: number, lengthFrames: number, spanFrames: number): number {
  if (!(lengthFrames > 0) || !(spanFrames > 0)) return 0;
  let laps = Math.max(0, Math.floor(spanFrames / lengthFrames));
  while (lapSpan(phase, lengthFrames, laps + 1) <= spanFrames) laps++;
  while (laps > 0 && lapSpan(phase, lengthFrames, laps) > spanFrames) laps--;
  return laps;
}

/** Whether a length is a whole number of frames — or not a finite number at all, which the
 *  tracker treats as it always has, as one lap that never alternates. */
function isWholeLength(lengthFrames: number): boolean {
  return !Number.isFinite(lengthFrames) || Number.isInteger(lengthFrames);
}

/** Whether a loop of these bounds can run: false only for a length that is not a whole number of
 *  frames and is shorter than `MIN_FRACTIONAL_LOOP_FRAMES`. Every whole length runs as it always
 *  has, a one-frame loop stretched to two ticks a lap among them. */
export function isUsableLoopLength(startFrame: number, endFrame: number): boolean {
  const length = endFrame - startFrame;
  return isWholeLength(length) || length >= MIN_FRACTIONAL_LOOP_FRAMES;
}

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
  /**
   * Replaces the loop presently enforced, dropping a queued jump and a change named. Leaves the
   * entry image untouched — set or clear it separately through `setEntryImage`, since the two do
   * not always change together (arming the track's own loop inside `advance` keeps whatever image
   * is already held for it).
   *
   * The lap in progress becomes lap 0 of `loop`, at its `lapPhase` — unless `loop` is the loop
   * already running (the one before a change named), with the same start, end and reduced
   * `lapPhase`: then the lap in progress carries on, as re-setting a whole-length loop always has.
   *
   * Returns false, changing nothing, for a loop `isUsableLoopLength` refuses.
   */
  set(loop: ActiveLoop): boolean;
  /**
   * Makes the running loop end at `atFrame` and run `loop` from the wrap that ends there: that
   * wrap re-enters through `image` — the image of `loop`'s start frame — instead of the running
   * loop's own start, reports `looped` like any lap, and makes `loop` the active one at lap 0 of its
   * `lapPhase`. Replaces a change already named. Leaves the entry image and a queued jump alone,
   * which `set` would clear: a queued jump that lands at that wrap lands in the change's place and
   * drops it.
   *
   * The running loop reads, until then, as itself ending at `atFrame`, with no `lapPhase`. When its
   * length is not whole and `atFrame` lies past the end of the lap in progress, the change lands at
   * that lap's end instead, and `atFrame` reads as that end: the host cannot tell where a lap of
   * alternating length ends. A whole-length loop is never clamped.
   *
   * A change named at or behind the wrap point lands on the next `advance`. Returns false, changing
   * nothing, when no loop is running or `isUsableLoopLength` refuses `loop`.
   */
  changeAt(atFrame: Frames, loop: Exclude<ActiveLoop, null>, image: PositionAnchor): boolean;
  /** The change named and not yet landed, or null. */
  pendingChange(): LoopChange | null;
  /** Drops the change named, if any, and gives the running loop back the end it had before, and
   *  the lap it was in. */
  cancelChange(): void;
  /**
   * The reduced phase of the running loop's lap in progress — `lapPhaseAfter(lapPhase, length, k)`
   * in lap k, counting from the phase lap 0 took, which for a loop a queued jump landed is the one
   * carried on (see `queue`) rather than its own — or null with no loop running. With a change
   * named, the lap of the loop it changes.
   */
  lapPhase(): number | null;
  /** `lapPhase()` when `loop` has the running loop's start and end — the end before a change named
   *  — else null: whether a count lapping `loop` is counting the laps the player takes. */
  lapPhaseOf(loop: ActiveLoop): number | null;
  /**
   * Puts the running loop's lap in progress at `phase` — what a landing does, since the lap it
   * lands in is the count's, not the one the playhead left. A change named keeps the end it was
   * named for. Ignored with no loop running, and for a phase that is not a finite number.
   */
  setLapPhase(phase: number): void;
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
   *
   * The queued loop lands at the wrap ending the lap in progress, and its lap 0 takes the phase of
   * the lap that wrap would have begun: the running loop's next lap, `lapPhaseAfter(lapPhase(),
   * length, 1)` (for a whole length, the phase it is in), or with a change named, the change's lap 0
   * at the change's `lapPhase`, since the hand-off lands in the change's place. The music's clock
   * carries on across the hand-off that way, so landing after landing adds up to the laps taken,
   * give or take one rounding, and never drifts. Restarting each landed loop at its own `lapPhase`
   * would make each landing's rounding permanent, and `Math.round` rounds halves up, so it would
   * build up in one direction. The track's own loop, armed by `advance`, laps no grid and has no
   * phase to pass on: a jump landing from it starts at lap 0 of its own `lapPhase`.
   *
   * Only the lap state takes that phase. `get()` reports the queued loop exactly as it was handed
   * in, its own `lapPhase` included, and `lapPhase()` the phase it laps at, so `set` of that same
   * loop carries the lap in progress on as it would any running loop's.
   *
   * Returns false, changing nothing, for a queued loop `isUsableLoopLength` refuses.
   */
  queue(next: QueuedNext | null): boolean;
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
   * give up a frame still plays one. The end a lap wraps at is the loop's own for a whole length,
   * else the lap's whole-frame end, `startFrame + lapLength(phase, length)`; each lap the loop
   * itself takes (`looped` from its start, `due-unheld`) moves the phase on by the length, with
   * nothing allocated.
   *
   * A wrap of the active loop re-enters its start — through the entry image if one is held, else by
   * seeking along the anchor path — and reports the frame landed on. With a jump queued and its
   * image held, it calls the queued jump's `beforeLanding`, restores that image instead, makes the
   * queued loop (or none, for a cue) the active one, lapping from the phase `queue` describes,
   * empties the queue and reports `handed-off` at the frame landed on. With no jump landing and a
   * change named by `changeAt`, the wrap restores
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
   * of the loop's last frame instead, and a lap takes exactly `endFrame - startFrame` ticks — or,
   * for a length that is not whole, exactly the whole frames of that lap.
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
  /** The reduced phase of the lap in progress, of the running loop (the one before a change). */
  let phase = 0;
  /** The end the lap in progress wraps at: the loop's own for a whole length, else the lap's own
   *  whole-frame end, or the end a change was named for. Kept here so a tick reads one number. */
  let lapEnd = 0;
  /** Whether the running loop (the one before a change) is the track's own, armed by `advance`
   *  rather than handed in: it laps no grid, so its phase means nothing to a loop landing from it. */
  let trackOwn = false;

  /** The end lap `atPhase` of `of` wraps at. */
  function lapEndOf(of: Exclude<ActiveLoop, null>, atPhase: number): number {
    const length = of.endFrame - of.startFrame;
    return isWholeLength(length) ? of.endFrame : of.startFrame + lapLength(atPhase, length);
  }

  /** The lap in progress becomes lap 0 of `loop`, at its own phase. */
  function rebase(): void {
    phase = loop === null ? 0 : reduceLapPhase(loop.lapPhase ?? 0);
    lapEnd = loop === null ? 0 : lapEndOf(loop, phase);
  }

  /**
   * The phase of the lap the wrap now due would begin, which a queued loop landing there laps from
   * (see `queue`), or NaN when there is none to pass on. Read before the landing changes anything.
   * Numbers only, since it runs on the tick.
   *
   * With a change named, the lap has ended early (or, for a whole length, late) at the frame the
   * change names, off the running loop's own lap ends, and the simplest bounded choice is the
   * change's lap 0 at its own `lapPhase`, which the hand-off lands in place of: the phase the host
   * named for the lap beginning at that frame — the clock there, for a host that counts it from
   * `lapPhase()`. Whatever it named, the landed loop is within a frame of the clock for that one
   * landing, and the next landing carries on from it rather than adding to it. A change named past
   * a lap end and clamped there would have landed at that phase too. Else the running loop's next
   * lap, as `nextLap` moves to it; NaN for the track's own loop.
   */
  function phaseAfterWrap(): number {
    if (change !== null) return reduceLapPhase(change.loop.lapPhase ?? 0);
    if (loop === null || trackOwn) return Number.NaN;
    const length = loop.endFrame - loop.startFrame;
    return isWholeLength(length) ? phase : reduceLapPhase(phase + length);
  }

  /** The loop has taken a lap of its own: the next is the one a length on. Numbers only, since it
   *  runs on the tick. */
  function nextLap(running: Exclude<ActiveLoop, null>): void {
    const length = running.endFrame - running.startFrame;
    if (isWholeLength(length)) return;
    phase = reduceLapPhase(phase + length);
    lapEnd = running.startFrame + lapLength(phase, length);
  }

  /** Whether `next` is `running` set again: the same span and the same reduced phase. */
  function sameLap(running: ActiveLoop, next: ActiveLoop): boolean {
    return (
      running !== null &&
      next !== null &&
      running.startFrame === next.startFrame &&
      running.endFrame === next.endFrame &&
      reduceLapPhase(running.lapPhase ?? 0) === reduceLapPhase(next.lapPhase ?? 0)
    );
  }

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

  const wrapDueAt = (startFrame: number, endFrame: number): number =>
    wrapDueFrame(startFrame, endFrame, lead);

  return {
    get: (): ActiveLoop => loop,

    set(next: ActiveLoop): boolean {
      if (next !== null && !isUsableLoopLength(next.startFrame, next.endFrame)) return false;
      const carriesOn = sameLap(change === null ? loop : unchanged, next);
      loop = next;
      trackOwn = false;
      queued = null;
      queuedImage = null;
      change = null;
      changeImage = null;
      if (carriesOn && next !== null) {
        lapEnd = lapEndOf(next, phase);
      } else {
        rebase();
      }
      return true;
    },

    changeAt(atFrame, next, image): boolean {
      if (loop === null) return false;
      if (!isUsableLoopLength(next.startFrame, next.endFrame)) return false;
      if (change === null) unchanged = loop;
      const running = unchanged ?? loop;
      const ownEnd = lapEndOf(running, phase);
      const end =
        !isWholeLength(running.endFrame - running.startFrame) && atFrame > ownEnd
          ? frames(ownEnd)
          : atFrame;
      loop = {
        startFrame: running.startFrame,
        endFrame: end,
        ...(running.varispeedStart === undefined ? {} : { varispeedStart: running.varispeedStart }),
      };
      change = { atFrame: end, loop: next };
      changeImage = image;
      lapEnd = end;
      return true;
    },

    pendingChange: (): LoopChange | null => change,

    cancelChange(): void {
      if (change === null) return;
      loop = unchanged;
      change = null;
      changeImage = null;
      if (loop !== null) lapEnd = lapEndOf(loop, phase);
    },

    lapPhase: (): number | null => (loop === null ? null : phase),

    lapPhaseOf(of: ActiveLoop): number | null {
      const running = change === null ? loop : unchanged;
      return of !== null &&
        running !== null &&
        of.startFrame === running.startFrame &&
        of.endFrame === running.endFrame
        ? phase
        : null;
    },

    setLapPhase(next: number): void {
      if (loop === null || !Number.isFinite(next)) return;
      phase = reduceLapPhase(next);
      if (change === null) lapEnd = lapEndOf(loop, phase);
    },

    setEntryImage(entry: PositionAnchor | null): void {
      entryImage = entry;
    },

    entryImage: (): PositionAnchor | null => entryImage,

    queue(next: QueuedNext | null): boolean {
      const loopQueued = next === null ? null : next.loop;
      if (loopQueued !== null && !isUsableLoopLength(loopQueued.startFrame, loopQueued.endFrame)) {
        return false;
      }
      queued = next;
      queuedImage = null;
      return true;
    },

    setQueuedImage(entry: PositionAnchor | null): void {
      queuedImage = entry;
    },

    advance(machine, frame, ring, track, framesRendered): AdvanceResult {
      if (loop !== null) {
        if (framesRendered < wrapDueAt(loop.startFrame, lapEnd)) return { action: 'none' };
        if (queued !== null && queuedImage !== null) {
          const image = queuedImage;
          const carried = phaseAfterWrap();
          queued.beforeLanding?.();
          machine.restore(image.machine);
          frame.restoreValues(image.registers);
          // The loop as it was queued, its own `lapPhase` included: only the lap state below takes
          // the phase carried on, so a host comparing it with what it queued sees no change.
          loop = queued.loop;
          trackOwn = false;
          if (queued.loop !== null) entryImage = image;
          queued = null;
          queuedImage = null;
          change = null;
          changeImage = null;
          if (loop !== null && !Number.isNaN(carried)) {
            phase = carried;
            lapEnd = lapEndOf(loop, phase);
          } else {
            rebase();
          }
          return { action: 'handed-off', frame: image.frame };
        }
        if (change !== null && changeImage !== null) {
          const image = changeImage;
          machine.restore(image.machine);
          frame.restoreValues(image.registers);
          loop = change.loop;
          trackOwn = false;
          entryImage = image;
          change = null;
          changeImage = null;
          rebase();
          return { action: 'looped', frame: image.frame };
        }
        const landed = enter(machine, frame, ring, loop.startFrame);
        if (landed === null) return { action: 'none' };
        nextLap(loop);
        if (landed === 'unheld') return { action: 'due-unheld', frame: loop.startFrame };
        return { action: 'looped', frame: landed };
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
      trackOwn = true;
      rebase();
      if (landed === 'unheld') return { action: 'due-unheld', frame: start };
      return { action: 'looped', frame: landed };
    },
  };
}
