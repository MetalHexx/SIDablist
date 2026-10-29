import { SID_REGISTER_COUNT, VOICE_CONTROL_REGISTERS } from './sid-constants.js';

/** A tune's register stream as data: the 25 SID registers as the chip holds them after each play
 *  call, raw, plus the first byte of every play call that wrote a voice control register twice.
 *  Plain typed arrays, so it crosses a worker boundary by structured clone. */
export interface RegisterRecord {
  /** Play calls covered. Entry i is the state after play call i + 1. */
  readonly frames: number;
  /** frames × SID_REGISTER_COUNT, frame-major: entry i's register r at i * SID_REGISTER_COUNT + r.
   *  What a sink that received every frame would have set — unmuted, before any multiplier,
   *  offset or hold. For a voice control register written twice in a play call this is the
   *  second byte, held until the tune writes that register again; the shadow
   *  (`snapshotValues()`) keeps the first, so the two differ there and only there. */
  readonly values: Uint8Array;
  /** Retriggers, ascending by entry, as three parallel arrays: the entry, the voice control
   *  register (4, 11 or 18), and the first byte written to it in that play call — sent just
   *  before the entry's own value. */
  readonly retriggerEntries: Uint32Array;
  readonly retriggerRegisters: Uint8Array;
  readonly retriggerValues: Uint8Array;
}

/**
 * Whether `record` has the shape varispeed reads without checking again on the tick: at least one
 * entry, a row of 25 bytes per entry, three retrigger arrays of one length, each retrigger on a
 * voice control register inside the record, and the entries in ascending order — the cursor that
 * walks them relies on it.
 */
export function isUsableRegisterRecord(record: RegisterRecord): boolean {
  const { frames, values, retriggerEntries, retriggerRegisters, retriggerValues } = record;
  if (!Number.isInteger(frames) || frames < 1) return false;
  if (!(values instanceof Uint8Array) || values.length !== frames * SID_REGISTER_COUNT)
    return false;
  if (
    !(retriggerEntries instanceof Uint32Array) ||
    !(retriggerRegisters instanceof Uint8Array) ||
    !(retriggerValues instanceof Uint8Array)
  ) {
    return false;
  }
  const count = retriggerEntries.length;
  if (retriggerRegisters.length !== count || retriggerValues.length !== count) return false;

  let previous = 0;
  for (let index = 0; index < count; index++) {
    const entry = retriggerEntries[index];
    if (entry >= frames || entry < previous) return false;
    if (!VOICE_CONTROL_REGISTERS.includes(retriggerRegisters[index])) return false;
    previous = entry;
  }
  return true;
}
