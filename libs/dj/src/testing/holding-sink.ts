import type {
  FarEndConsumption,
  Frames,
  Milliseconds,
  SidFrame,
  SidModel,
  SidSink,
  SinkCapabilities,
} from '@sidablist/core';

/** Spec-only. The most writes one frame can carry: 25 registers, and a control register written twice. */
const MAX_WRITES = 64;

const CAPABILITIES: SinkCapabilities = {
  perWriteOffsets: false,
  cancellation: true,
  scheduleAheadMs: null,
  preservesWriteOrder: true,
};

/** One frame the far end received, copied out of the reused buffers. */
export interface WireFrame {
  readonly kind: 'frame' | 'now';
  /** 0 for a frame sent at once. */
  readonly frameNumber: number;
  readonly dueAtMs: number;
  readonly catchUpClamped: boolean;
  readonly registers: readonly number[];
  readonly values: readonly number[];
}

/** What reached the far end, in order: the run's start and end, and each frame as it passed. */
export type WireEvent =
  { readonly kind: 'begin'; readonly chipModel: SidModel } | { readonly kind: 'end' } | WireFrame;

interface Held {
  count: number;
  frameNumber: number;
  dueAtMs: number;
  catchUpClamped: boolean;
  readonly registers: Uint8Array;
  readonly values: Uint8Array;
}

export interface HoldingSinkOptions {
  /** How many frames it can hold; delivering more throws. Default 256. */
  readonly capacity?: number;
  /** Whether to keep what reached the far end in `wire`. Off, it allocates nothing per frame. Default on. */
  readonly retain?: boolean;
}

/**
 * Spec-only. A sink that holds every delivered frame, copied into buffers made up front, until a
 * test moves its time past the frame's due time (`advanceTo`/`advanceMs`), then passes it to its
 * far end. `passedCount` and `replaceFrom` are honest per core's contract, so a deck can rewind
 * against it exactly as against a sink that really holds frames.
 */
export class HoldingSink implements SidSink {
  readonly wire: WireEvent[] = [];
  private readonly held: Held[];
  private readonly retain: boolean;
  private head = 0;
  private waiting = 0;
  private delivered = 0;
  private passed = 0;
  private nowMs = 0;
  private begins = 0;
  private ends = 0;

  constructor(options: HoldingSinkOptions = {}) {
    this.retain = options.retain ?? true;
    this.held = Array.from({ length: options.capacity ?? 256 }, () => ({
      count: 0,
      frameNumber: 0,
      dueAtMs: 0,
      catchUpClamped: false,
      registers: new Uint8Array(MAX_WRITES),
      values: new Uint8Array(MAX_WRITES),
    }));
  }

  get capabilities(): SinkCapabilities {
    return CAPABILITIES;
  }

  get beginCount(): number {
    return this.begins;
  }

  get endCount(): number {
    return this.ends;
  }

  /** Frames delivered and not yet passed. */
  get holding(): number {
    return this.waiting;
  }

  begin(tune: { readonly chipModel: SidModel }): void {
    this.begins++;
    this.drop();
    if (this.retain) this.wire.push({ kind: 'begin', chipModel: tune.chipModel });
  }

  end(): void {
    this.ends++;
    if (this.retain) this.wire.push({ kind: 'end' });
  }

  deliver(
    frame: SidFrame,
    frameNumber: Frames,
    dueAtMs: Milliseconds,
    catchUpClamped: boolean,
  ): void {
    if (this.waiting === this.held.length) throw new Error('HoldingSink is full');
    const slot = this.held[(this.head + this.waiting) % this.held.length];
    slot.count = frame.count;
    slot.frameNumber = frameNumber;
    slot.dueAtMs = dueAtMs;
    slot.catchUpClamped = catchUpClamped;
    // A loop, not `set(subarray(…))`: a view is an allocation per frame.
    for (let i = 0; i < frame.count; i++) {
      slot.registers[i] = frame.registers[i];
      slot.values[i] = frame.values[i];
    }
    this.waiting++;
    this.delivered++;
    this.release();
  }

  deliverNow(frame: SidFrame): void {
    if (!this.retain) return;
    this.wire.push({
      kind: 'now',
      frameNumber: 0,
      dueAtMs: 0,
      catchUpClamped: false,
      registers: Array.from(frame.registers.subarray(0, frame.count)),
      values: Array.from(frame.values.subarray(0, frame.count)),
    });
  }

  retime(): void {
    // A sink that holds frames by their due times has nothing to re-time.
  }

  reset(): void {
    this.drop();
  }

  readAt(): FarEndConsumption {
    return { kind: 'unknown', inFlight: this.waiting };
  }

  passedCount(): number {
    return this.passed;
  }

  replaceFrom(fromCount: number): number {
    const resume = Math.min(Math.max(fromCount, this.passed), this.delivered);
    this.waiting = resume - this.passed;
    this.delivered = resume;
    return resume;
  }

  /** Moves this sink's time to `ms` (never back) and passes the frames that fell due. */
  advanceTo(ms: number): void {
    if (ms > this.nowMs) this.nowMs = ms;
    this.release();
  }

  advanceMs(ms: number): void {
    this.advanceTo(this.nowMs + ms);
  }

  /** The writes that reached the far end, in order, in the shape the conformance suite reads. */
  emitted(): readonly { readonly register: number; readonly value: number }[] {
    const writes: { register: number; value: number }[] = [];
    for (const item of this.wire) {
      if (item.kind !== 'frame' && item.kind !== 'now') continue;
      item.registers.forEach((register, i) => writes.push({ register, value: item.values[i] }));
    }
    return writes;
  }

  private drop(): void {
    this.waiting = 0;
    this.delivered = 0;
    this.passed = 0;
  }

  private release(): void {
    while (this.waiting > 0 && this.held[this.head].dueAtMs <= this.nowMs) {
      const slot = this.held[this.head];
      if (this.retain) {
        this.wire.push({
          kind: 'frame',
          frameNumber: slot.frameNumber,
          dueAtMs: slot.dueAtMs,
          catchUpClamped: slot.catchUpClamped,
          registers: Array.from(slot.registers.subarray(0, slot.count)),
          values: Array.from(slot.values.subarray(0, slot.count)),
        });
      }
      this.head = (this.head + 1) % this.held.length;
      this.waiting--;
      this.passed++;
    }
  }
}
