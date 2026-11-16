import type { C64Machine, MachineSnapshot } from '../cpu/c64-machine.js';
import type { RegisterFrame, RegisterValuesSnapshot } from '../registers/register-frame.js';
import type { Frames } from '../units.js';
import { createImageBuffer, type ImageBuffer } from './crossing-captures.js';

/**
 * Anchor images kept at once: three recent ones plus the frame-0 seed that never leaves index 0.
 * Each is a 64 KB memory image, allocated once with the ring, so this is a memory-against-replay-distance
 * trade — but not a free one to re-make: `anchorIntervalFrames` spaces the ring against this number, so changing it moves
 * how far back a seek can reach as well as what the ring costs.
 */
const ANCHOR_RING_SIZE = 4;

/**
 * Where the machine stood at a frame — an image, not a bookmark.
 *
 * A machine can only be run forward, so reaching a frame means starting from something at or before
 * it and replaying: this is that something.
 */
export interface PositionAnchor {
  readonly frame: Frames;
  readonly machine: MachineSnapshot;
  readonly registers: RegisterValuesSnapshot;
}

/**
 * The recent machine images a seek replays forward from.
 *
 * Core keeps this rather than the application because it has to be maintained every frame, and it
 * is what bounds a seek's cost: without it, reaching a remembered frame replays from the start of
 * the tune and stalls for as long as that takes.
 */
export interface AnchorRing {
  /** Copies the live machine into the ring's oldest non-seed slot once it is full, allocating
   *  nothing. */
  record(machine: C64Machine, frame: RegisterFrame, framesRendered: Frames): void;
  /** Records only every `interval` frames — what a tick loop calls every frame so the spacing check
   *  lives beside the ring it gates. */
  maybeRecord(machine: C64Machine, frame: RegisterFrame, framesRendered: Frames): void;
  /** The newest entry far enough back that a seek to `frame` still lands after it. The anchor is the
   *  ring's own image, refilled by a later `record`: use it before the next one and never keep it. */
  select(frame: Frames): PositionAnchor | null;
  /** Drops every anchor, seed included — each describes a machine that no longer exists. */
  reset(): void;
}

/**
 * Frames between the images `maybeRecord` retains.
 *
 * Derived from the nudge range rather than fixed, to hold the ring's actual reach: eviction keeps
 * the seed plus the `ANCHOR_RING_SIZE − 1` newest recordings, i.e. `ANCHOR_RING_SIZE − 2` gaps of
 * this interval between the oldest kept non-seed anchor and the newest. A query can land right on
 * the newest recording (nothing rounds that away), so the guarantee needs
 * `(ANCHOR_RING_SIZE − 2) × interval ≥ nudgeRangeFrames` — one fewer factor than
 * `(ANCHOR_RING_SIZE − 1)` would suggest, since the seed is not part of this evenly-spaced run. A
 * wider range on a multispeed tune widens the spacing accordingly, or the ring falls short of it and
 * every seek that deep replays from the frame-0 seed instead of a recent anchor — the
 * O(distance-from-start) stall this ring exists to avoid.
 */
function anchorIntervalFrames(nudgeRangeFrames: Frames): number {
  return Math.max(1, Math.ceil(nudgeRangeFrames / (ANCHOR_RING_SIZE - 2)));
}

/**
 * A ring of recent machine images, oldest first.
 *
 * Index 0 is never evicted: the application seeds it at frame 0 on load, and it is the only anchor
 * guaranteed to sit before every later position, so it is what a seek into the opening seconds of a
 * tune falls back to.
 *
 * @param nudgeRangeFrames the widest backward walk a seek target can carry, in frames. Read on each
 *   call rather than captured, so a tune whose rate — and therefore whose range — differs re-spaces
 *   the ring instead of needing a new one built around it.
 */
export function createAnchorRing(nudgeRangeFrames: () => Frames): AnchorRing {
  const images: ImageBuffer[] = Array.from({ length: ANCHOR_RING_SIZE }, createImageBuffer);
  /** Indices into `images` of the live anchors, oldest first; `order[0]` is always the seed. */
  const order = new Int32Array(ANCHOR_RING_SIZE);
  let count = 0;

  function record(machine: C64Machine, frame: RegisterFrame, framesRendered: Frames): void {
    let slot: number;
    if (count < ANCHOR_RING_SIZE) {
      slot = count++;
    } else {
      slot = order[1];
      for (let i = 1; i < count - 1; i++) order[i] = order[i + 1];
    }
    order[count - 1] = slot;
    const image = images[slot];
    machine.snapshotInto(image.machine);
    frame.snapshotValuesInto(image.registers);
    image.frame = framesRendered;
  }

  return {
    record,

    maybeRecord(machine: C64Machine, frame: RegisterFrame, framesRendered: Frames): void {
      if (framesRendered % anchorIntervalFrames(nudgeRangeFrames()) === 0) {
        record(machine, frame, framesRendered);
      }
    },

    /**
     * The newest entry a full backward nudge from `frame` still lands after, falling back to the
     * seed at index 0.
     *
     * The fallback is still held to sitting at or before `frame`: an anchor after the target would
     * have a seek run the machine backwards, which it cannot do, and the symptom is a jump that
     * lands in the wrong place rather than an error. Null means the ring has nothing to seek from
     * at all.
     */
    select(frame: Frames): PositionAnchor | null {
      const latestUsable = frame - nudgeRangeFrames();
      for (let i = count - 1; i >= 0; i--) {
        const image = images[order[i]];
        if (image.frame <= latestUsable) {
          return image;
        }
      }
      if (count === 0) return null;
      const seed = images[order[0]];
      return seed.frame <= frame ? seed : null;
    },

    reset(): void {
      count = 0;
    },
  };
}
