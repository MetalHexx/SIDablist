import {
  copyMachineImage,
  createMachineImage,
  type WritableMachineSnapshot,
} from '../cpu/c64-machine.js';
import { SID_REGISTER_COUNT } from '../registers/sid-constants.js';
import { frames, type Frames } from '../units.js';

/** Lines the player saves the live machine at as the playhead reaches them: frame
 *  `Math.round(originFrame + k × periodFrames)` for every integer k with that frame ≥ 0. */
export interface CrossingLines {
  readonly originFrame: number;
  /** ≥ 1; may be fractional. */
  readonly periodFrames: number;
  /** How many of the most recent crossings of these lines stay held, ≥ 1. */
  readonly keep: number;
}

/**
 * One machine image and its register values, owned by whoever allocated it and refilled in place.
 * Structurally a `PositionAnchor`, so a holder can hand it to anything that restores from one.
 *
 * `frame` is only meaningful while the holder says the buffer is filled.
 */
export interface ImageBuffer {
  frame: Frames;
  readonly machine: WritableMachineSnapshot;
  readonly registers: { readonly values: Uint8Array };
}

/** An empty buffer. Allocates 64 KB: call it off the frame path and keep what it returns. */
export function createImageBuffer(): ImageBuffer {
  return {
    frame: frames(0),
    machine: createMachineImage(),
    registers: { values: new Uint8Array(SID_REGISTER_COUNT) },
  };
}

/** Copies `from` over `to`, frame included. Not for the frame path. */
export function copyImageBuffer(from: ImageBuffer, to: ImageBuffer): void {
  copyMachineImage(from.machine, to.machine);
  to.registers.values.set(from.registers.values);
  to.frame = from.frame;
}

/**
 * The pool of images the player saves as the playhead crosses declared lines, and the check that
 * says when to save one.
 *
 * Every buffer is allocated by `declare`, so nothing here allocates once a tick is running.
 */
export interface CrossingCaptures {
  /**
   * Replaces the lines. The pool is sized to the sum of every set's `keep`, plus one so a free
   * buffer always exists for the next crossing; buffers already allocated are reused, and an image
   * already held stays held by each new set it lies on. `[]` frees them all.
   */
  declare(lines: readonly CrossingLines[]): void;
  /**
   * Files a crossing at `position` and returns the buffer to fill with the machine as it stands —
   * the one already holding that frame, else a free one — or null when `position` lies on none of
   * the declared lines. A frame on several sets of lines is one buffer, held by each. A set keeps its
   * `keep` most recent crossings and lets go of the oldest.
   *
   * The check is arithmetic over the declared sets and allocates nothing.
   */
  take(position: number): ImageBuffer | null;
  /** The buffer holding an image saved for `frame`, or null. */
  imageAt(frame: number): ImageBuffer | null;
  /** Lets go of every image. The lines stay declared and the buffers stay allocated. */
  clearImages(): void;
}

/** Whether `Math.round(origin + k × period)` is `position` for some integer k. The unrounded index
 *  is within one of an integer that does, so its rounding and both neighbours are checked. */
function isOnLine(origin: number, period: number, position: number): boolean {
  const nearest = Math.round((position - origin) / period);
  for (let k = nearest - 1; k <= nearest + 1; k++) {
    if (Math.round(origin + k * period) === position) return true;
  }
  return false;
}

export function createCrossingCaptures(): CrossingCaptures {
  // Typed arrays and indices rather than objects: `take` runs on every tick, and a check that reads
  // numbers out of preallocated arrays cannot allocate. Sets are parallel to each other, buffers
  // parallel to each other.
  let origins = new Float64Array(0);
  let periods = new Float64Array(0);
  let keeps = new Int32Array(0);
  /** How many of a set's `helds` entries are live. */
  let counts = new Int32Array(0);
  /** Per set, the buffers it holds as indices into `buffers`, oldest first. */
  let helds: Int32Array[] = [];

  let buffers: ImageBuffer[] = [];
  /** How many sets hold a buffer's image; 0 is free. */
  let refs = new Int32Array(0);
  /** When a buffer was last filled, so a re-declare can tell which images are the newest. */
  let stamps = new Float64Array(0);
  let stamp = 0;

  /** Puts buffer `slot` in `set` as its newest crossing, letting go of the oldest when it is full. */
  function file(set: number, slot: number): void {
    const held = helds[set];
    let count = counts[set];
    let at = -1;
    for (let index = 0; index < count; index++) {
      if (held[index] === slot) {
        at = index;
        break;
      }
    }
    if (at >= 0) {
      for (let index = at; index < count - 1; index++) held[index] = held[index + 1];
      held[count - 1] = slot;
      return;
    }
    if (count === keeps[set]) {
      refs[held[0]]--;
      for (let index = 0; index < count - 1; index++) held[index] = held[index + 1];
      count--;
    }
    refs[slot]++;
    held[count] = slot;
    counts[set] = count + 1;
  }

  return {
    declare(lines: readonly CrossingLines[]): void {
      const nextOrigins = Float64Array.from(lines, (line) => line.originFrame);
      const nextPeriods = Float64Array.from(lines, (line) => line.periodFrames);
      const nextKeeps = Int32Array.from(lines, (line) => line.keep);
      const nextCounts = new Int32Array(lines.length);
      const nextHelds = Array.from(nextKeeps, (keep) => new Int32Array(keep));
      const size = lines.length === 0 ? 0 : nextKeeps.reduce((total, keep) => total + keep, 0) + 1;

      // Images already saved stay held by every new set whose lines they lie on, newest first up to
      // that set's keep, so re-declaring the same lines costs nothing already captured. `kept[set]`
      // lists old buffer indices newest first.
      const saved = Array.from(refs.keys())
        .filter((old) => refs[old] > 0)
        .sort((a, b) => stamps[b] - stamps[a]);
      const kept = Array.from(nextKeeps, (keep, set) =>
        saved
          .filter((old) => isOnLine(nextOrigins[set], nextPeriods[set], buffers[old].frame))
          .slice(0, keep),
      );
      const retained = saved.filter((old) => kept.some((forSet) => forSet.includes(old)));

      // The retained buffers lead, then the spare ones already allocated, then new ones.
      const nextBuffers = retained.map((old) => buffers[old]);
      for (let old = 0; old < buffers.length && nextBuffers.length < size; old++) {
        if (!retained.includes(old)) nextBuffers.push(buffers[old]);
      }
      while (nextBuffers.length < size) nextBuffers.push(createImageBuffer());

      const nextRefs = new Int32Array(size);
      const nextStamps = new Float64Array(size);
      retained.forEach((old, index) => {
        nextStamps[index] = stamps[old];
      });
      kept.forEach((forSet, set) => {
        for (let index = forSet.length - 1; index >= 0; index--) {
          const slot = retained.indexOf(forSet[index]);
          nextHelds[set][nextCounts[set]++] = slot;
          nextRefs[slot]++;
        }
      });

      origins = nextOrigins;
      periods = nextPeriods;
      keeps = nextKeeps;
      counts = nextCounts;
      helds = nextHelds;
      buffers = nextBuffers;
      refs = nextRefs;
      stamps = nextStamps;
    },

    take(position: number): ImageBuffer | null {
      let onLine = false;
      for (let set = 0; set < origins.length; set++) {
        if (isOnLine(origins[set], periods[set], position)) {
          onLine = true;
          break;
        }
      }
      if (!onLine) return null;

      let slot = -1;
      let free = -1;
      for (let index = 0; index < refs.length; index++) {
        if (refs[index] > 0) {
          if (buffers[index].frame === position) slot = index;
        } else if (free < 0) {
          free = index;
        }
      }
      if (slot < 0) slot = free;
      if (slot < 0) return null;

      for (let set = 0; set < origins.length; set++) {
        if (isOnLine(origins[set], periods[set], position)) file(set, slot);
      }
      buffers[slot].frame = frames(position);
      stamps[slot] = ++stamp;
      return buffers[slot];
    },

    imageAt(frame: number): ImageBuffer | null {
      for (let index = 0; index < refs.length; index++) {
        if (refs[index] > 0 && buffers[index].frame === frame) return buffers[index];
      }
      return null;
    },

    clearImages(): void {
      refs.fill(0);
      counts.fill(0);
    },
  };
}
