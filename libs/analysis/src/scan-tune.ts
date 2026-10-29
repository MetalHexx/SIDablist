import {
  createC64Machine,
  createRegisterFrame,
  SID_REGISTER_COUNT,
  VOICE_CONTROL_REGISTERS,
} from '@sidablist/core';
import type { C64Machine, FrameResult, SidFile, SidFrame } from '@sidablist/core';

/** A postMessage per scanned frame would cost more than the emulation itself. */
const PROGRESS_INTERVAL_FRAMES = 256;

export interface ScanOutput {
  /** Accumulated register values per frame, flat and indexed by SID register number: frame f's
   *  register r is at `f * SID_REGISTER_COUNT + r`. */
  readonly registerValues: Uint8Array;
  /** Registers written during each frame — the density signal. One entry per frame. */
  readonly writeCounts: Uint8Array;
  readonly frames: number;
  /** Play-routine calls per video frame, read off the machine. 1 for most tunes, 2+ for multispeed. */
  readonly callsPerFrame: number;
  /** The un-rounded rate the machine's timer actually measured — the ladder's zero-frame probe reads
   *  this to size its rungs precisely, rather than off the rounded integer above. */
  readonly exactCallsPerFrame: number;
  /** The chip's voice control bytes after each frame: frame f's voice v at f * 3 + v. Unlike
   *  `registerValues`, which keeps the first byte of a doubled write, this is the byte the chip
   *  holds. */
  readonly controlBytes?: Uint8Array;
  /** The frames in which a voice control register was written twice, ascending by frame, as three
   *  parallel arrays. */
  readonly retriggers?: {
    readonly entries: Uint32Array;
    /** 4, 11 or 18. */
    readonly registers: Uint8Array;
    /** The first byte, sent before the frame's own. */
    readonly values: Uint8Array;
  };
}

const VOICE_COUNT = VOICE_CONTROL_REGISTERS.length;
const INITIAL_RETRIGGER_CAPACITY = 64;

/** Register number -> voice index for the three voice control registers, -1 for every other. */
const VOICE_OF_REGISTER = new Int8Array(SID_REGISTER_COUNT).fill(-1);
VOICE_CONTROL_REGISTERS.forEach((register, voice) => {
  VOICE_OF_REGISTER[register] = voice;
});

/**
 * A replay of one tune that can be deepened, recording every frame's register values and write
 * density rather than discarding them.
 *
 * Owns its own `C64Machine`/`RegisterFrame` pair from a clean `init` and keeps them live between
 * calls, so a later, deeper request only pays for the frames it has not already emulated. Continuing
 * on the same objects — rather than restoring a serialised snapshot — is what makes a deepened scan
 * bit-identical to one that never stopped.
 *
 * Free of Angular and of the player for the same reason core's `replayToFrame` is — it must produce the same
 * answer whether it runs on a worker or on the calling thread.
 *
 * There is deliberately no tune-end detection: `advanceTo` runs exactly the frames it is asked for,
 * and distinguishing "ceiling reached" from "tune ended" belongs to `detectLoop`, which reads this
 * output, not to this loop.
 */
export class TuneScan {
  private readonly frame = createRegisterFrame();
  private readonly machine: C64Machine;
  private registerValues = new Uint8Array(0);
  private writeCounts = new Uint8Array(0);
  private controlBytes = new Uint8Array(0);
  private retriggerEntries = new Uint32Array(INITIAL_RETRIGGER_CAPACITY);
  private retriggerRegisters = new Uint8Array(INITIAL_RETRIGGER_CAPACITY);
  private retriggerValues = new Uint8Array(INITIAL_RETRIGGER_CAPACITY);
  private retriggerCount = 0;
  /** Per-frame scratch, reused: whether each voice's control register has been written yet this
   *  frame, and the first byte it was written with. */
  private readonly controlSeen = new Uint8Array(VOICE_COUNT);
  private readonly controlFirst = new Uint8Array(VOICE_COUNT);
  private recorded = 0;

  constructor(file: SidFile, subtune: number) {
    // Voices are never muted during a scan — a muted voice's control register would be forced to 0
    // and its writes dropped, erasing it from the analysis.
    this.machine = createC64Machine(file, this.frame);
    this.machine.initSubtune(subtune);
  }

  /** How many frames have been emulated and recorded so far. */
  get frames(): number {
    return this.recorded;
  }

  /**
   * Emulates forward until `frames` reaches `toFrames`; a no-op when already at or past it.
   *
   * @param onProgress called at a coarse interval, not per frame, against the absolute frame index.
   * @throws when a frame exceeds its cycle budget. The message names the frame it failed at, and the
   *  scan must not be deepened afterwards — it is left holding a machine that never finished a frame.
   */
  advanceTo(toFrames: number, onProgress?: (frame: number) => void): void {
    if (toFrames <= this.recorded) {
      return;
    }
    this.reserve(toFrames);

    for (let i = this.recorded; i < toFrames; i++) {
      const result: FrameResult = this.machine.runFrame();
      if (!result.completed) {
        throw new Error(`analysis scan exceeded its cycle budget at frame ${i}`);
      }

      // Must run every frame: it is also what resets the per-frame duplicate-write tracking the next
      // frame's count depends on.
      const snapshot = this.frame.takeSnapshot();
      this.writeCounts[i] = snapshot.count;
      this.recordControls(i, snapshot);

      this.registerValues.set(this.frame.snapshotValues().values, i * SID_REGISTER_COUNT);
      this.recorded = i + 1;

      if (onProgress !== undefined && i % PROGRESS_INTERVAL_FRAMES === 0) {
        onProgress(i);
      }
    }
  }

  /**
   * The frames recorded so far, in the shape the detectors read.
   *
   * Every array is a copy sized exactly to what was recorded, never views over the working buffers: a caller
   * posting this across a thread boundary would otherwise ship the spare capacity too, and would see
   * its output rewritten by the next `advanceTo`.
   */
  output(): ScanOutput {
    return {
      registerValues: this.registerValues.slice(0, this.recorded * SID_REGISTER_COUNT),
      writeCounts: this.writeCounts.slice(0, this.recorded),
      frames: this.recorded,
      callsPerFrame: this.machine.callsPerFrame,
      exactCallsPerFrame: this.machine.exactCallsPerFrame,
      controlBytes: this.controlBytes.slice(0, this.recorded * VOICE_COUNT),
      retriggers: {
        entries: this.retriggerEntries.slice(0, this.retriggerCount),
        registers: this.retriggerRegisters.slice(0, this.retriggerCount),
        values: this.retriggerValues.slice(0, this.retriggerCount),
      },
    };
  }

  /**
   * Reads frame `i`'s voice control writes off its snapshot. The chip's byte after the frame is the
   * last entry for the register, or the previous frame's when the frame wrote none; the frame's
   * retrigger is the first entry, noted when the register appears a second time. The first frame
   * starts from zero, which is where the shadow starts too.
   */
  private recordControls(i: number, snapshot: SidFrame): void {
    const base = i * VOICE_COUNT;
    if (i > 0) {
      this.controlBytes.copyWithin(base, base - VOICE_COUNT, base);
    }
    this.controlSeen.fill(0);
    for (let index = 0; index < snapshot.count; index++) {
      const register = snapshot.registers[index];
      const voice = VOICE_OF_REGISTER[register];
      if (voice < 0) {
        continue;
      }
      const value = snapshot.values[index];
      if (this.controlSeen[voice] === 0) {
        this.controlSeen[voice] = 1;
        this.controlFirst[voice] = value;
      } else {
        this.pushRetrigger(i, register, this.controlFirst[voice]);
      }
      this.controlBytes[base + voice] = value;
    }
  }

  private pushRetrigger(frame: number, register: number, value: number): void {
    if (this.retriggerCount === this.retriggerEntries.length) {
      const capacity = this.retriggerCount * 2;
      const entries = new Uint32Array(capacity);
      entries.set(this.retriggerEntries);
      const registers = new Uint8Array(capacity);
      registers.set(this.retriggerRegisters);
      const values = new Uint8Array(capacity);
      values.set(this.retriggerValues);
      this.retriggerEntries = entries;
      this.retriggerRegisters = registers;
      this.retriggerValues = values;
    }
    this.retriggerEntries[this.retriggerCount] = frame;
    this.retriggerRegisters[this.retriggerCount] = register;
    this.retriggerValues[this.retriggerCount] = value;
    this.retriggerCount++;
  }

  /** Regrows the per-frame buffers to `frames`, carrying the recorded prefix over. O(recorded bytes) against
   *  the O(frames × cycles) of the emulation it saves. */
  private reserve(frames: number): void {
    if (frames <= this.writeCounts.length) {
      return;
    }
    const registerValues = new Uint8Array(frames * SID_REGISTER_COUNT);
    registerValues.set(this.registerValues.subarray(0, this.recorded * SID_REGISTER_COUNT));
    const writeCounts = new Uint8Array(frames);
    writeCounts.set(this.writeCounts.subarray(0, this.recorded));
    const controlBytes = new Uint8Array(frames * VOICE_COUNT);
    controlBytes.set(this.controlBytes.subarray(0, this.recorded * VOICE_COUNT));
    this.registerValues = registerValues;
    this.writeCounts = writeCounts;
    this.controlBytes = controlBytes;
  }
}

/**
 * Replays a tune from a clean `init` for exactly `maxFrames` play-routine calls, recording every
 * frame's register values and write density rather than discarding them.
 *
 * A thin wrapper over `TuneScan`, so the one-shot and the deepenable path share one emulation loop
 * rather than two that could drift apart.
 *
 * @param onProgress called at a coarse interval, not per frame.
 * @throws when a frame exceeds its cycle budget. The message names the frame it failed at.
 */
export function scanTune(
  file: SidFile,
  subtune: number,
  maxFrames: number,
  onProgress?: (frame: number) => void,
): ScanOutput {
  const scan = new TuneScan(file, subtune);
  scan.advanceTo(maxFrames, onProgress);
  return scan.output();
}
