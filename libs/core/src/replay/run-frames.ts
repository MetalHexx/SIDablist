import type { C64Machine, FrameResult } from '../cpu/c64-machine.js';
import type { Frames } from '../units.js';

/** Thrown by `runFramesTo` when a frame's play routine does not return inside its cycle budget.
 *  Distinct from a thrown emulation error because it is a result the emulator returned, not an
 *  exception it raised, so a caller reports the two differently. */
export class FrameBudgetExceededError extends Error {
  constructor(readonly frame: number) {
    super(`frame ${frame} exceeded its cycle budget`);
  }
}

/**
 * Runs `machine` forward one frame at a time from `frame` up to (but not including)
 * `targetFrame`, calling `onFrame` once after each frame that completes inside its cycle budget.
 *
 * The "run frames forward, checking the budget, until the target" loop a silent replay, a marker
 * nudge and a loop audition all need — extracted here so the three share one implementation
 * instead of drifting apart. A thrown error from `machine.runFrame()` propagates to the caller
 * untouched; a frame that exceeds its cycle budget is a return value rather than an exception, so
 * it is reported by throwing `FrameBudgetExceededError` instead.
 */
export function runFramesTo(
  machine: C64Machine,
  frame: Frames,
  targetFrame: Frames,
  onFrame: () => void,
): void {
  for (let i: number = frame; i < targetFrame; i++) {
    const result: FrameResult = machine.runFrame();
    if (!result.completed) {
      throw new FrameBudgetExceededError(i);
    }
    onFrame();
  }
}
