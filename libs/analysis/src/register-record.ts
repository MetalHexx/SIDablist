import { parseSidFile, SID_REGISTER_COUNT, VOICE_CONTROL_REGISTERS } from '@sidablist/core';
import type { RegisterRecord } from '@sidablist/core';
import { ScanFailedError } from './index-tune.js';
import { nextRequestId, nextSessionId } from './scan-ids.js';
import type { ScanOutput } from './scan-tune.js';
import type { AnalysisScanner } from './scanner.js';

/**
 * The scan's output as core's record: `registerValues` copied, with columns 4, 11 and 18 taken from
 * `controlBytes`, and the retrigger arrays as they are. Entry i is the chip after play call i + 1.
 *
 * Only as raw as the scan: a scan whose frame was muted, multiplied, offset or held would write those
 * shaped bytes into the record, and the player would shape them again.
 *
 * @throws when `controlBytes` or `retriggers` is absent — a `ScanOutput` built by hand, not a scan's.
 */
export function toRegisterRecord(output: ScanOutput): RegisterRecord {
  const { controlBytes, retriggers } = output;
  if (controlBytes === undefined || retriggers === undefined) {
    throw new Error('scan output carries no control bytes or retriggers to record');
  }
  const voices = VOICE_CONTROL_REGISTERS.length;
  const values = output.registerValues.slice();
  for (let frame = 0; frame < output.frames; frame++) {
    for (let voice = 0; voice < voices; voice++) {
      values[frame * SID_REGISTER_COUNT + VOICE_CONTROL_REGISTERS[voice]] =
        controlBytes[frame * voices + voice];
    }
  }
  return {
    frames: output.frames,
    values,
    retriggerEntries: retriggers.entries,
    retriggerRegisters: retriggers.registers,
    retriggerValues: retriggers.values,
  };
}

/**
 * Scans `bytes`' `subtune` for exactly `frames` play calls on `scanner` and returns its record.
 * A session of its own, so it never deepens an index ladder's held scan, and `keep: false`, so the
 * scanner does not hold a second copy of the whole scan until the next load.
 *
 * @throws ScanFailedError when the scan fails.
 */
export async function recordRegisters(
  scanner: AnalysisScanner,
  bytes: Uint8Array,
  subtune: number,
  frames: number,
): Promise<RegisterRecord> {
  const result = await scanner.scan({
    id: nextRequestId(),
    session: nextSessionId(),
    file: parseSidFile(bytes),
    subtune,
    maxFrames: frames,
    keep: false,
  });
  if (result.kind === 'failed') {
    throw new ScanFailedError(result.error);
  }
  return toRegisterRecord(result.output);
}
