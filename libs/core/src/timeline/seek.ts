import type { C64Machine } from '../cpu/c64-machine.js';
import type { RegisterFrame } from '../registers/register-frame.js';
import { runFramesTo } from '../replay/run-frames.js';
import { frames, type Frames } from '../units.js';
import type { AnchorRing, PositionAnchor } from './anchor-ring.js';

/**
 * Moves `machine`/`frame` to `targetFrame`: takes the newest usable anchor from `ring`, restores it
 * onto the pair, and runs forward from there to the target.
 *
 * The one path a cue trigger, a scrub and a loop lap all take. The application remembers a frame
 * number and hands it back here; nothing above core has to hold a machine image to return to a
 * position. The cost is the one a nudge has always paid — a replay bounded by the anchor spacing,
 * not by how deep the position sits in the tune.
 *
 * The pair is left standing at the target, and every frame replayed on the way is discarded: the
 * register values arrive restored wholesale rather than written, so a caller seeking the live pair
 * owes the far end a resend of the register state before streaming resumes.
 *
 * A target before the start of the tune resolves to frame 0 rather than erroring — a scrub dragged
 * off the left end of the bar is a gesture, not a fault.
 *
 * @returns the anchor the replay ran from, or null when `ring` holds nothing at or before the
 *   target — nothing loaded, or a ring reset and not yet reseeded. The pair is untouched then.
 * @throws {FrameBudgetExceededError} when a replayed frame does not return inside its cycle budget.
 *   A thrown emulation error propagates untouched, as it does from `runFramesTo`.
 */
export function seekToFrame(
  machine: C64Machine,
  frame: RegisterFrame,
  ring: AnchorRing,
  targetFrame: Frames,
): PositionAnchor | null {
  const target = frames(Math.max(0, Math.round(targetFrame)));
  const anchor = ring.select(target);
  if (anchor === null) return null;

  machine.restore(anchor.machine);
  frame.restoreValues(anchor.registers);

  runFramesTo(machine, anchor.frame, target, () => {
    frame.takeSnapshot(); // discarded — resets per-frame duplicate-write tracking only;
    // the accumulated register values persist across the call regardless
  });

  return anchor;
}
