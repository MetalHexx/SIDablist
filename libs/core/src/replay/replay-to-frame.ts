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
 * @throws when `init` or a replayed frame fails, or a frame exceeds its cycle budget. The message is
 *   the one the diagnostics readout shows verbatim.
 */
export function replayToFrame(
  file: SidFile,
  subtune: number,
  targetFrame: Frames,
  mutes: readonly boolean[],
): ReplayResult {
  const target = frames(Math.max(0, Math.round(targetFrame)));

  const frame = createRegisterFrame();
  mutes.forEach((muted, voice) => frame.setVoiceMuted(voice, muted));
  const machine = createC64Machine(file, frame);

  try {
    machine.initSubtune(subtune);
  } catch (error) {
    throw new Error(`jump to frame ${target} failed during init — ${describeError(error)}`);
  }

  try {
    runFramesTo(machine, frames(0), target, () => {
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
