import { createRegisterFrame } from '../registers/register-frame.js';
import type { RegisterValuesSnapshot } from '../registers/register-frame.js';
import { createC64Machine } from '../cpu/c64-machine.js';
import type { MachineSnapshot } from '../cpu/c64-machine.js';
import type { SidFile } from '../sid/sid-file.model.js';
import { describeError } from '../common/errors.js';
import { frames, type Frames } from '../units.js';
import { runFramesTo, FrameBudgetExceededError } from './run-frames.js';

/** Where a silent replay ended up: the machine and register state at `frame`. */
export interface ReplayResult {
  readonly machine: MachineSnapshot;
  readonly registers: RegisterValuesSnapshot;
  readonly frame: Frames;
}

/**
 * Rebuilds a tune from a clean `init` and runs it forward to `targetFrame` with every packet
 * discarded, returning the state it arrived in.
 *
 * Free of Angular and of the engine on purpose: it is the body of a jump, and it has to produce the
 * same answer whether it runs on a worker or on the thread that asked for it.
 *
 * Builds its own `C64Machine`/`RegisterFrame` pair rather than touching a live one — RAM from
 * wherever playback currently is would otherwise bleed into the replay and the answer would depend
 * on when the jump was asked for.
 *
 * @param mutes the effective mute per voice, seeded onto the replay frame so a muted voice's control
 *   register stays 0 through the whole replay exactly as it would live.
 * @param start an image of this same file, subtune and mutes to continue from instead of running
 *   from the top. Every frame is a single `runFrame` call whose whole state the image carries, so
 *   the result is identical to a replay from `init` — the saving is the frames before `start`.
 * @throws when `init` or a replayed frame fails, a frame exceeds its cycle budget, or `start` lies
 *   past `targetFrame`. The message is the one the diagnostics readout shows verbatim.
 */
export function replayToFrame(
  file: SidFile,
  subtune: number,
  targetFrame: Frames,
  mutes: readonly boolean[],
  start?: ReplayResult,
): ReplayResult {
  const target = frames(Math.max(0, Math.round(targetFrame)));
  if (start !== undefined && start.frame > target) {
    throw new Error(
      `jump to frame ${target} failed during replay — the starting image is at frame ${start.frame}, past the target`,
    );
  }

  const frame = createRegisterFrame();
  mutes.forEach((muted, voice) => frame.setVoiceMuted(voice, muted));
  const machine = createC64Machine(file, frame);

  try {
    machine.initSubtune(subtune);
  } catch (error) {
    throw new Error(`jump to frame ${target} failed during init — ${describeError(error)}`);
  }

  if (start !== undefined) {
    machine.restore(start.machine);
    frame.restoreValues(start.registers);
  }

  try {
    runFramesTo(machine, start?.frame ?? frames(0), target, () => {
      frame.takeSnapshot(); // discarded — resets per-frame duplicate-write tracking only;
      // the accumulated register values persist across the call regardless
    });
  } catch (error) {
    if (error instanceof FrameBudgetExceededError) {
      throw new Error(`jump to frame ${target} exceeded its cycle budget during replay`);
    }
    throw new Error(`jump to frame ${target} failed during replay — ${describeError(error)}`);
  }

  return { machine: machine.snapshot(), registers: frame.snapshotValues(), frame: target };
}
