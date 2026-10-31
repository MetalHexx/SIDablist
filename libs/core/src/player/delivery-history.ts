import type { SidFrame } from '../registers/sid-frame.js';
import {
  SID_REGISTER_COUNT,
  VOICE_CONTROL_REGISTERS,
  VOICE_COUNT,
} from '../registers/sid-constants.js';

/** A voice's control register is written at most twice a frame as far as the chip is concerned: a
 *  third write folds into the second before delivery, so two slots hold everything it received. */
const CONTROL_BYTES_PER_VOICE = 2;

/**
 * Where a host drains the player's delivery history to: a set of fixed buffers it allocates once
 * and reuses, so a drain on the host's own schedule allocates nothing. Entry `i` (oldest first,
 * `i < count`) is laid out across the arrays by its index.
 *
 * Size it to the capacity asked of the player: a batch smaller than what is pending takes the newest
 * entries and counts the rest as `dropped`.
 */
export interface DeliveryBatch {
  /** Entries it can hold. */
  readonly capacity: number;
  /** `capacity × SID_REGISTER_COUNT`: the 25 registers the chip holds after each delivery. */
  readonly registers: Uint8Array;
  /** `capacity`: each delivery's time, on the frame clock's `performance.now()` timeline. */
  readonly timesMs: Float64Array;
  /** `capacity × VOICE_COUNT × 2`: per voice, the control bytes the chip received in that delivery,
   *  in order. A voice with fewer than two leaves the rest 0. */
  readonly controlBytes: Uint8Array;
  /** `capacity × VOICE_COUNT`: how many of a voice's control bytes are valid (0, 1 or 2). */
  readonly controlCounts: Uint8Array;
  /** Entries filled by the last drain. */
  count: number;
  /** Entries lost since the previous drain: the history was full, or this batch too small. */
  dropped: number;
  /** The stream broke since the previous drain — a load, a stop, a fresh run, a landing — so the
   *  entries here are a fresh history and the host should not splice them onto older ones. */
  restarted: boolean;
}

/** Builds a batch of `capacity` entries. Throws a `RangeError` for anything but a whole number of
 *  entries, 0 or more. */
export function createDeliveryBatch(capacity: number): DeliveryBatch {
  if (!Number.isInteger(capacity) || capacity < 0) {
    throw new RangeError(`a delivery batch needs a whole, non-negative capacity, got ${capacity}`);
  }
  return {
    capacity,
    registers: new Uint8Array(capacity * SID_REGISTER_COUNT),
    timesMs: new Float64Array(capacity),
    controlBytes: new Uint8Array(capacity * VOICE_COUNT * CONTROL_BYTES_PER_VOICE),
    controlCounts: new Uint8Array(capacity * VOICE_COUNT),
    count: 0,
    dropped: 0,
    restarted: false,
  };
}

/** The voice a register is the control register of, or -1 — built once so the hot path looks it up
 *  rather than searching `VOICE_CONTROL_REGISTERS`. */
const VOICE_OF_REGISTER = new Int8Array(SID_REGISTER_COUNT).fill(-1);
VOICE_CONTROL_REGISTERS.forEach((register, voice) => {
  VOICE_OF_REGISTER[register] = voice;
});

/**
 * A bounded ring of the frames a player delivered, each stored as the chip held it afterwards, so a
 * host that samples slower than the engine builds frames can still see every delivery.
 *
 * Entries come from the frame the sink was handed, never from `RegisterFrame`'s own shadow: the
 * shadow keeps the first byte of a doubled control write while the chip is given the second, so an
 * entry built from it would show the wrong byte on exactly the retrigger frames. Running the
 * delivered writes through a chip image makes `registers[control]` the last byte the chip received
 * and `controlBytes` both, in order. A third write to a control register in one frame folds into the
 * second before delivery, so the chip never receives it and the history, being exactly what the chip
 * was given, never shows it.
 *
 * Everything is allocated in the constructor. `record` and `drain` run on the frame path and touch
 * only preallocated typed arrays: no closures, arrays, objects or iterator helpers, and no
 * `subarray`, which allocates a view.
 */
export class DeliveryHistory {
  readonly capacity: number;

  private readonly registers: Uint8Array;
  private readonly timesMs: Float64Array;
  private readonly controlBytes: Uint8Array;
  private readonly controlCounts: Uint8Array;

  /** What the chip holds right now: every delivered write applied in order. Survives a drain, since
   *  draining changes what the host has seen and not what the chip holds. */
  private readonly image = new Uint8Array(SID_REGISTER_COUNT);
  /** The entry being built: the control bytes this delivery's writes carried, copied into the ring
   *  slot once the frame has been walked. */
  private readonly pendingBytes = new Uint8Array(VOICE_COUNT * CONTROL_BYTES_PER_VOICE);
  private readonly pendingCounts = new Uint8Array(VOICE_COUNT);

  /** Slot of the oldest entry. */
  private head = 0;
  private size = 0;
  private droppedCount = 0;
  private restartedFlag = false;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(
        `a delivery history needs a whole capacity of at least 1, got ${capacity}`,
      );
    }
    this.capacity = capacity;
    this.registers = new Uint8Array(capacity * SID_REGISTER_COUNT);
    this.timesMs = new Float64Array(capacity);
    this.controlBytes = new Uint8Array(capacity * VOICE_COUNT * CONTROL_BYTES_PER_VOICE);
    this.controlCounts = new Uint8Array(capacity * VOICE_COUNT);
  }

  /**
   * Appends one delivery, overwriting the oldest entry and counting a drop once full. Called after
   * the sink has been handed `frame`, so the append never delays the wire.
   */
  record(frame: SidFrame, timeMs: number): void {
    const { count, registers, values } = frame;
    const image = this.image;
    const pendingBytes = this.pendingBytes;
    const pendingCounts = this.pendingCounts;
    pendingBytes.fill(0);
    pendingCounts.fill(0);

    for (let index = 0; index < count; index++) {
      const register = registers[index];
      const value = values[index];
      image[register] = value;

      const voice = VOICE_OF_REGISTER[register];
      if (voice < 0) continue;
      const received = pendingCounts[voice];
      if (received < CONTROL_BYTES_PER_VOICE) {
        pendingBytes[voice * CONTROL_BYTES_PER_VOICE + received] = value;
        pendingCounts[voice] = received + 1;
      } else {
        pendingBytes[voice * CONTROL_BYTES_PER_VOICE + CONTROL_BYTES_PER_VOICE - 1] = value;
      }
    }

    let slot: number;
    if (this.size === this.capacity) {
      slot = this.head;
      this.head = slot + 1 === this.capacity ? 0 : slot + 1;
      this.droppedCount++;
    } else {
      slot = this.head + this.size;
      if (slot >= this.capacity) slot -= this.capacity;
      this.size++;
    }

    this.registers.set(image, slot * SID_REGISTER_COUNT);
    this.timesMs[slot] = timeMs;
    this.controlBytes.set(pendingBytes, slot * VOICE_COUNT * CONTROL_BYTES_PER_VOICE);
    this.controlCounts.set(pendingCounts, slot * VOICE_COUNT);
  }

  /**
   * Moves everything recorded since the last drain into `into`, oldest first, then empties the ring
   * and the drop count. The chip image is left alone: the chip still holds what it holds. A batch
   * smaller than what is pending takes the newest `into.capacity` entries and adds the rest to
   * `dropped`. Allocates nothing.
   */
  drain(into: DeliveryBatch): void {
    const taken = this.size < into.capacity ? this.size : into.capacity;
    const skipped = this.size - taken;

    let slot = this.head + skipped;
    if (slot >= this.capacity) slot -= this.capacity;
    for (let entry = 0; entry < taken; entry++) {
      const registersFrom = slot * SID_REGISTER_COUNT;
      const registersTo = entry * SID_REGISTER_COUNT;
      for (let register = 0; register < SID_REGISTER_COUNT; register++) {
        into.registers[registersTo + register] = this.registers[registersFrom + register];
      }
      into.timesMs[entry] = this.timesMs[slot];

      const bytesFrom = slot * VOICE_COUNT * CONTROL_BYTES_PER_VOICE;
      const bytesTo = entry * VOICE_COUNT * CONTROL_BYTES_PER_VOICE;
      for (let byte = 0; byte < VOICE_COUNT * CONTROL_BYTES_PER_VOICE; byte++) {
        into.controlBytes[bytesTo + byte] = this.controlBytes[bytesFrom + byte];
      }
      for (let voice = 0; voice < VOICE_COUNT; voice++) {
        into.controlCounts[entry * VOICE_COUNT + voice] =
          this.controlCounts[slot * VOICE_COUNT + voice];
      }

      slot = slot + 1 === this.capacity ? 0 : slot + 1;
    }

    into.count = taken;
    into.dropped = this.droppedCount + skipped;
    into.restarted = this.restartedFlag;

    this.head = 0;
    this.size = 0;
    this.droppedCount = 0;
    this.restartedFlag = false;
  }

  /** The stream broke here: empties the ring, zeroes the chip image and the drop count, and raises
   *  `restarted` until the next drain consumes it. */
  restart(): void {
    this.head = 0;
    this.size = 0;
    this.droppedCount = 0;
    this.image.fill(0);
    this.restartedFlag = true;
  }

  /**
   * Sets the chip image to `registers` (the first `SID_REGISTER_COUNT` bytes), for a history built
   * while a tune is already playing: the image only learns a register when a delivery writes it, and
   * a tune writes some — envelope settings, pulse width, a held gate — once.
   *
   * Imprecise in one known case: the shadow `registers` is read from keeps the first byte of a
   * doubled control write while the chip holds the second, so a history switched on in the instant
   * after such a write seeds that control register from the first byte. The next control write
   * corrects it.
   */
  seed(registers: Uint8Array): void {
    for (let register = 0; register < SID_REGISTER_COUNT; register++) {
      this.image[register] = registers[register];
    }
  }
}
