/** How many events a deck queues before it drops the newest. */
const EVENT_CAPACITY = 256;

export const KIND_LANDED = 0;
export const KIND_LOADED = 1;
export const KIND_LOAD_FAILED = 2;
export const KIND_JUMP_LANDED = 3;
export const KIND_CAPTURED = 4;
export const KIND_GRID_FITTED = 5;

/** An event waiting to go out, as plain fields: the report object is built when it is sent. */
export interface QueuedEvent {
  kind: number;
  /** The stream frame it happened on. */
  frame: number;
  /** The log entry a `landed` event reports (by index, with its sequence number), or -1. */
  entry: number;
  seq: number;
  /**
   * An event the render cannot make again, which a rewind never discards: `loaded` and
   * `load-failed` report a load that finished off the frame path.
   */
  sticky: boolean;
  /** The due time of the frame it happened on, which `waitMs` is measured to. */
  dueMs: number;
  a: number;
  b: number;
  c: number;
  text: string;
  reason: string;
}

/**
 * The deck's bounded queue of events not yet reported, oldest first, in preallocated records.
 * Events are queued in the order frames render, tagged with their frame, so a rewind can discard
 * the tail it is about to re-render and an event goes out only once its frame cannot be rewound.
 */
export class EventQueue {
  private readonly events: QueuedEvent[];
  private count = 0;

  constructor() {
    this.events = Array.from({ length: EVENT_CAPACITY }, () => ({
      kind: KIND_LANDED,
      frame: 0,
      entry: -1,
      seq: 0,
      sticky: false,
      dueMs: 0,
      a: 0,
      b: 0,
      c: 0,
      text: '',
      reason: '',
    }));
  }

  get size(): number {
    return this.count;
  }

  at(i: number): QueuedEvent {
    return this.events[i];
  }

  /** Queues an event on `frame`, or returns null when the queue is full. */
  push(kind: number, frame: number): QueuedEvent | null {
    if (this.count === EVENT_CAPACITY) return null;
    const event = this.events[this.count++];
    event.kind = kind;
    event.frame = frame;
    event.entry = -1;
    event.seq = 0;
    event.sticky = false;
    event.dueMs = 0;
    event.a = 0;
    event.b = 0;
    event.c = 0;
    event.text = '';
    event.reason = '';
    return event;
  }

  /** Removes the oldest event, keeping the records in order. */
  shift(): void {
    if (this.count === 0) return;
    const first = this.events[0];
    for (let i = 1; i < this.count; i++) this.events[i - 1] = this.events[i];
    this.events[--this.count] = first;
  }

  /** Drops every event `retain` refuses, for a rewind; the survivors keep their order. */
  compact(retain: (event: QueuedEvent) => boolean): void {
    let kept = 0;
    for (let i = 0; i < this.count; i++) {
      const event = this.events[i];
      if (!retain(event)) continue;
      this.events[i] = this.events[kept];
      this.events[kept++] = event;
    }
    this.count = kept;
  }
}
