import type { RegisterRecord } from '@sidablist/core';
import type { DeckCommand } from '../messages/commands.js';

/** How many entries a deck's log holds; a command past it is refused. */
export const LOG_CAPACITY = 256;

/** `LogEntry.frame` of a `pass-end` entry whose pass has not ended yet. */
export const UNRESOLVED = -1;

/** Whether an entry's `landed` event is still to be made, waits in the event queue, or has gone out. */
export const EVENT_NONE = 0;
export const EVENT_QUEUED = 1;
export const EVENT_SENT = 2;

/** Whether a loop runs at a `pass-end` entry's `from` frame: not yet known, yes, or no. */
export const LOOP_UNKNOWN = 0;
export const LOOP_YES = 1;
export const LOOP_NO = 2;

/** What the engine said the first time an entry was applied: not yet asked, no, or yes. */
export const ANSWER_UNASKED = 0;
export const ANSWER_NO = 1;
export const ANSWER_YES = 2;

/**
 * One command a deck took, kept outside the deck's saved state so a rewind cannot lose it. The
 * entries are preallocated and reused: nothing here is built per command.
 *
 * A host command carries its `command`. The register record, which lands through the same path as
 * a command, carries `record` instead and makes no `landed` event.
 */
export interface LogEntry {
  /** Where the entry lives in the log's storage; stable while the entry is. */
  readonly index: number;
  /** Arrival order. A later command always has a larger one. */
  seq: number;
  command: DeckCommand | null;
  record: RegisterRecord | null;
  /** Host time the press happened, or NaN when the command carried none. */
  pressedAtMs: number;
  passEnd: boolean;
  /** The stream frame the command's `When` was fixed to; for `pass-end`, where the search for the pass's end starts. */
  from: number;
  /** The stream frame it applies on, or `UNRESOLVED` while a `pass-end` entry waits for the end of its pass. */
  frame: number;
  loopAtFrom: number;
  /** The sequence number of the command that ended the loop and applied this entry right after itself, or 0. */
  cascadedBy: number;
  /** Seen by a flush, which has fixed its landing. */
  flushed: boolean;
  /** Flushed by the flush in progress. */
  fresh: boolean;
  /** Applied at least once; a rewind may apply it again. */
  applied: boolean;
  eventState: number;
  /** The first answer to "is the target ready", for a seek: re-applying reuses it. */
  ready: number;
}

/**
 * The deck's log of commands, in arrival order, in a preallocated array. An entry is dropped once
 * no restore point can still lack it, and a deck whose clock is stopped drops an entry as soon as
 * it is applied.
 */
export class CommandLog {
  private readonly entries: LogEntry[];
  /** Indices of the live entries, in arrival order. */
  private readonly order = new Int16Array(LOG_CAPACITY);
  private readonly free = new Int16Array(LOG_CAPACITY);
  private freeCount = LOG_CAPACITY;
  private count = 0;
  private nextSeq = 1;

  constructor() {
    this.entries = Array.from({ length: LOG_CAPACITY }, (_, index) => ({
      index,
      seq: 0,
      command: null,
      record: null,
      pressedAtMs: Number.NaN,
      passEnd: false,
      from: 0,
      frame: UNRESOLVED,
      loopAtFrom: LOOP_UNKNOWN,
      cascadedBy: 0,
      flushed: false,
      fresh: false,
      applied: false,
      eventState: EVENT_NONE,
      ready: ANSWER_UNASKED,
    }));
    for (let i = 0; i < LOG_CAPACITY; i++) this.free[i] = LOG_CAPACITY - 1 - i;
  }

  /** How many entries are live. */
  get size(): number {
    return this.count;
  }

  /** The `i`-th live entry, oldest first. */
  at(i: number): LogEntry {
    return this.entries[this.order[i]];
  }

  /** The entry stored at `index`, whether live or not: a queued event names its entry by index. */
  byIndex(index: number): LogEntry {
    return this.entries[index];
  }

  /** Adds an entry for `command` (or a record), or returns null when the log is full. */
  push(command: DeckCommand | null, record: RegisterRecord | null): LogEntry | null {
    if (this.freeCount === 0) return null;
    const entry = this.entries[this.free[--this.freeCount]];
    entry.seq = this.nextSeq++;
    entry.command = command;
    entry.record = record;
    entry.pressedAtMs = Number.NaN;
    entry.passEnd = false;
    entry.from = 0;
    entry.frame = UNRESOLVED;
    entry.loopAtFrom = LOOP_UNKNOWN;
    entry.cascadedBy = 0;
    entry.flushed = false;
    entry.fresh = false;
    entry.applied = false;
    entry.eventState = EVENT_NONE;
    entry.ready = ANSWER_UNASKED;
    this.order[this.count++] = entry.index;
    return entry;
  }

  /**
   * Drops every entry that is applied, has landed on a frame before `horizon` and has no event
   * still waiting in the queue. `horizon` is the earliest frame a rewind could restore to, so no
   * restore point lacks what is dropped.
   */
  dropBefore(horizon: number): void {
    let kept = 0;
    for (let i = 0; i < this.count; i++) {
      const index = this.order[i];
      const entry = this.entries[index];
      const droppable =
        entry.applied &&
        entry.frame !== UNRESOLVED &&
        entry.frame < horizon &&
        entry.eventState !== EVENT_QUEUED;
      if (droppable) {
        entry.command = null;
        entry.record = null;
        this.free[this.freeCount++] = index;
      } else {
        this.order[kept++] = index;
      }
    }
    this.count = kept;
  }

  /** Drops every entry: a deck that is gone has nothing to rewind. */
  clear(): void {
    for (let i = 0; i < this.count; i++) {
      const entry = this.entries[this.order[i]];
      entry.command = null;
      entry.record = null;
      this.free[this.freeCount++] = entry.index;
    }
    this.count = 0;
  }
}
