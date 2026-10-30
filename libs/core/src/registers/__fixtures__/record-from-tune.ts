import { createC64Machine } from '../../cpu/c64-machine.js';
import type { SidFile } from '../../sid/sid-file.model.js';
import { createRegisterFrame } from '../register-frame.js';
import type { RegisterRecord } from '../register-record.js';
import type { SidFrame } from '../sid-frame.js';
import { SID_REGISTER_COUNT, VOICE_CONTROL_REGISTERS } from '../sid-constants.js';

/**
 * Builds a `RegisterRecord` for `frames` play calls of `file`'s `subtune` the way a scanner does:
 * a machine over a plain `RegisterFrame` at home, each frame's entries applied in order to a 25-byte
 * chip image. That image is the record's row for the frame, and the first of a doubled voice control
 * write is its retrigger. Init's own writes ride out in the first frame, as they do live.
 */
export function recordFromTune(file: SidFile, subtune: number, frames: number): RegisterRecord {
  const frame = createRegisterFrame();
  const machine = createC64Machine(file, frame);
  machine.initSubtune(subtune);

  const chip = new Uint8Array(SID_REGISTER_COUNT);
  const values = new Uint8Array(frames * SID_REGISTER_COUNT);
  const entries: number[] = [];
  const registers: number[] = [];
  const firstBytes: number[] = [];

  for (let entry = 0; entry < frames; entry++) {
    machine.runFrame();
    const snapshot = frame.takeSnapshot();
    const firstWrite = new Map<number, number>();
    for (let index = 0; index < snapshot.count; index++) {
      const register = snapshot.registers[index];
      const value = snapshot.values[index];
      if (VOICE_CONTROL_REGISTERS.includes(register)) {
        const first = firstWrite.get(register);
        if (first === undefined) {
          firstWrite.set(register, value);
        } else {
          entries.push(entry);
          registers.push(register);
          firstBytes.push(first);
        }
      }
      chip[register] = value;
    }
    values.set(chip, entry * SID_REGISTER_COUNT);
  }

  return {
    frames,
    values,
    retriggerEntries: Uint32Array.from(entries),
    retriggerRegisters: Uint8Array.from(registers),
    retriggerValues: Uint8Array.from(firstBytes),
  };
}

/** Applies a frame's entries, in order, to a 25-byte chip image — what a sink that received the
 *  frame would have set. */
export function applyFrameToChip(chip: Uint8Array, frame: SidFrame): void {
  for (let index = 0; index < frame.count; index++) {
    chip[frame.registers[index]] = frame.values[index];
  }
}
