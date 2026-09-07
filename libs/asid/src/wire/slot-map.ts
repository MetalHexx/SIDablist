import type { SidFrame } from '@sidablist/core';
import { SID_REGISTER_COUNT, VOICE_CONTROL_REGISTERS } from '@sidablist/core';
import { ASID_SLOT_COUNT, ASID_SLOT_TO_REGISTER } from './asid-constants.js';

/**
 * `ASID_SLOT_TO_REGISTER` inverted over its first `SID_REGISTER_COUNT` (non-duplicate) entries:
 * register -> its primary slot. Exported as the single decode point for this mapping.
 */
export const PRIMARY_SLOT_FOR_REGISTER = buildPrimarySlotTable();
const SECONDARY_SLOT_FOR_REGISTER = buildSecondarySlotTable();

function buildPrimarySlotTable(): readonly number[] {
  const table = new Array<number>(SID_REGISTER_COUNT).fill(-1);
  for (let slot = 0; slot < SID_REGISTER_COUNT; slot++) {
    table[ASID_SLOT_TO_REGISTER[slot]] = slot;
  }
  return table;
}

/** Registers 4, 11 and 18 -> their secondary slots 25, 26 and 27, in `VOICE_CONTROL_REGISTERS`
 *  order — the order the firmware's slot table lists them in past its 25 primary entries. */
function buildSecondarySlotTable(): ReadonlyMap<number, number> {
  const table = new Map<number, number>();
  VOICE_CONTROL_REGISTERS.forEach((register, voice) => {
    table.set(register, SID_REGISTER_COUNT + voice);
  });
  return table;
}

/** Maps one frame's ordered writes onto the 28 ASID slots.
 *  The nth write to a gate register (4, 11 or 18) beyond the first takes that register's
 *  secondary slot; any other repeat write overwrites its primary slot. */
export function packFrame(frame: SidFrame): {
  readonly presentMask: number[];
  readonly msbMask: number[];
  readonly values: number[];
} {
  const present = new Uint8Array(ASID_SLOT_COUNT);
  const slotValues = new Uint8Array(ASID_SLOT_COUNT);
  const writtenThisFrame = new Uint8Array(SID_REGISTER_COUNT);

  for (let index = 0; index < frame.count; index++) {
    const register = frame.registers[index];
    const value = frame.values[index];
    const primarySlot = PRIMARY_SLOT_FOR_REGISTER[register];

    if (!writtenThisFrame[register]) {
      writtenThisFrame[register] = 1;
      present[primarySlot] = 1;
      slotValues[primarySlot] = value;
      continue;
    }

    const secondarySlot = SECONDARY_SLOT_FOR_REGISTER.get(register);
    if (secondarySlot !== undefined) {
      present[secondarySlot] = 1;
      slotValues[secondarySlot] = value;
      continue;
    }

    slotValues[primarySlot] = value;
  }

  const presentMask = [0, 0, 0, 0];
  const msbMask = [0, 0, 0, 0];
  const values: number[] = [];

  for (let slot = 0; slot < ASID_SLOT_COUNT; slot++) {
    if (!present[slot]) continue;

    const byteIndex = (slot / 7) | 0;
    const bit = 1 << (slot % 7);
    presentMask[byteIndex] |= bit;

    const value = slotValues[slot];
    if (value & 0x80) {
      msbMask[byteIndex] |= bit;
    }
    values.push(value & 0x7f);
  }

  return { presentMask, msbMask, values };
}
