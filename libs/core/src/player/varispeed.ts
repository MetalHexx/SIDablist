import { clamp } from '../common/math.js';
import type { SidWriteSink } from '../cpu/c64-machine.js';
import type { RegisterRecord } from '../registers/register-record.js';
import { SID_REGISTER_COUNT } from '../registers/sid-constants.js';

/** `lastEntry` before anything has been fed: the next feed writes the whole entry. */
const NOTHING_FED = -1;

/**
 * The record-driven half of varispeed: the playhead, the record it reads, and the routine that turns
 * the entry under the playhead into writes. The coordinator decides when a tick happens and what
 * the rate is; this decides what the chip has to be told.
 *
 * Everything the feed touches is preallocated, because it runs on the tick.
 */
export interface Varispeed {
  /** The record the playhead reads, or null. */
  readonly record: RegisterRecord | null;
  /** The playhead in play calls, fractional, within 0…`record.frames`. */
  readonly position: number;
  /** Replaces the record. The next feed writes a whole entry, since nothing fed describes the new
   *  one. */
  setRecord(record: RegisterRecord | null): void;
  /** Puts the playhead at `position` (clamped to the record) and forgets what was fed, so the next
   *  feed writes all 25 registers of its entry. */
  begin(position: number): void;
  /** Moves the playhead by `rate` play calls, clamped to the record. */
  moveBy(rate: number): void;
  /** Puts the playhead at `position`, clamped to the record. What was fed is kept: the next feed
   *  writes only what differs from it. */
  moveTo(position: number): void;
  /**
   * Writes the entry under the playhead into `sink`, if it is not the entry fed last.
   *
   * The chip state at integer position P is entry P − 1, and entry 0 at P = 0. What is written is
   * measured against the bytes this has fed — the chip's state, not the register shadow: after a
   * doubled control write the shadow keeps the first byte while the chip holds the second, so a
   * later write of that first byte would be skipped against the shadow and leave a note hanging.
   * The first feed after `begin` writes all 25. A retrigger at the entry sends its first byte and
   * then the entry's own, whatever was fed.
   */
  feed(sink: SidWriteSink): void;
}

export function createVarispeed(): Varispeed {
  return new VarispeedImpl();
}

class VarispeedImpl implements Varispeed {
  private recordHeld: RegisterRecord | null = null;
  private playhead = 0;
  private lastEntry = NOTHING_FED;
  /** Index of the first retrigger at or after the entry last fed; walked either way, so sequential
   *  play costs a step a tick and a jump costs the retriggers it crosses. */
  private cursor = 0;
  /** The record bytes fed so far, by register — what the chip holds. */
  private readonly fed = new Uint8Array(SID_REGISTER_COUNT);
  /** The registers retriggering at the entry being fed, and the first byte each one sends. */
  private readonly retriggering = new Uint8Array(SID_REGISTER_COUNT);
  private readonly retriggerFirst = new Uint8Array(SID_REGISTER_COUNT);

  get record(): RegisterRecord | null {
    return this.recordHeld;
  }

  get position(): number {
    return this.playhead;
  }

  setRecord(record: RegisterRecord | null): void {
    this.recordHeld = record;
    this.playhead = 0;
    this.lastEntry = NOTHING_FED;
    this.cursor = 0;
  }

  begin(position: number): void {
    this.moveTo(position);
    this.lastEntry = NOTHING_FED;
  }

  moveBy(rate: number): void {
    this.moveTo(this.playhead + rate);
  }

  moveTo(position: number): void {
    this.playhead = this.recordHeld === null ? 0 : clamp(position, 0, this.recordHeld.frames);
  }

  feed(sink: SidWriteSink): void {
    const record = this.recordHeld;
    if (record === null) return;
    const entry = Math.max(0, Math.floor(this.playhead) - 1);
    if (entry === this.lastEntry) return;
    const wholeEntry = this.lastEntry === NOTHING_FED;
    this.lastEntry = entry;

    const entries = record.retriggerEntries;
    let cursor = this.cursor;
    while (cursor > 0 && entries[cursor - 1] >= entry) cursor--;
    while (cursor < entries.length && entries[cursor] < entry) cursor++;
    this.cursor = cursor;
    for (let at = cursor; at < entries.length && entries[at] === entry; at++) {
      const register = record.retriggerRegisters[at];
      this.retriggering[register] = 1;
      this.retriggerFirst[register] = record.retriggerValues[at];
    }

    const row = entry * SID_REGISTER_COUNT;
    for (let register = 0; register < SID_REGISTER_COUNT; register++) {
      const value = record.values[row + register];
      if (this.retriggering[register]) {
        this.retriggering[register] = 0;
        sink.onSidWrite(register, this.retriggerFirst[register]);
      } else if (!wholeEntry && value === this.fed[register]) {
        continue;
      }
      sink.onSidWrite(register, value);
      this.fed[register] = value;
    }
  }
}
