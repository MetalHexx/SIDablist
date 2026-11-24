import type {
  FarEndConsumption,
  Frames,
  Milliseconds,
  SidFrame,
  SidModel,
  SidSink,
  SinkCapabilities,
} from '@sidablist/core';

const HOLDS_NOTHING_CAPABILITIES: SinkCapabilities = {
  perWriteOffsets: false,
  cancellation: false,
  scheduleAheadMs: null,
  preservesWriteOrder: false,
};

const UNKNOWN_CONSUMPTION: FarEndConsumption = { kind: 'unknown', inFlight: 0 };

/**
 * The `SidSink` a deck's engine is given. It forwards every call to the deck's current output, or
 * counts and drops them when there is none (a sink that holds nothing: every frame has passed).
 *
 * It exists to map the sink's own counts onto stream frames. It remembers the deck's stream frame
 * at the last `begin` or `reset` (`base`) and counts the deliveries since, so `firstUnsent()` names
 * the first stream frame the sink has not passed: the frame a command lands on, and where a rewind
 * starts replacing.
 *
 * It swallows `retime`. The package's frames carry exact due times from the driven clock, and a
 * tempo change takes effect from its landing frame by re-rendering, so the frames already held
 * were rightly timed at the old tempo; the engine's retime on a tempo change would re-time them
 * wrongly. It allocates nothing per frame.
 */
export class SinkTap implements SidSink {
  private target: SidSink | null = null;
  private delivered = 0;
  private streamAtMark = 0;
  private begins = 0;

  /** `streamFrame` reads the deck's stream frame: the frame the next delivery will carry. */
  constructor(private readonly streamFrame: () => number) {}

  get capabilities(): SinkCapabilities {
    return this.target === null ? HOLDS_NOTHING_CAPABILITIES : this.target.capabilities;
  }

  /** The stream frame at the last `begin` or `reset`: delivery 0 since then carries it. */
  get base(): number {
    return this.streamAtMark;
  }

  /** How many times the engine has called `begin`. */
  get beginCount(): number {
    return this.begins;
  }

  /** The first stream frame the sink has not passed: the next frame not yet sent. */
  firstUnsent(): number {
    const passed = this.target === null ? this.delivered : this.target.passedCount();
    return this.streamAtMark + passed;
  }

  begin(tune: { readonly chipModel: SidModel }): void {
    this.begins++;
    this.mark();
    this.target?.begin(tune);
  }

  end(): void {
    this.target?.end();
  }

  deliver(
    frame: SidFrame,
    frameNumber: Frames,
    dueAtMs: Milliseconds,
    catchUpClamped: boolean,
  ): void {
    this.delivered++;
    this.target?.deliver(frame, frameNumber, dueAtMs, catchUpClamped);
  }

  deliverNow(frame: SidFrame): void {
    this.target?.deliverNow(frame);
  }

  retime(): void {
    // Swallowed on purpose: see the class comment.
  }

  reset(): void {
    this.mark();
    this.target?.reset();
  }

  readAt(): FarEndConsumption {
    return this.target === null ? UNKNOWN_CONSUMPTION : this.target.readAt();
  }

  passedCount(): number {
    return this.target === null ? this.delivered : this.target.passedCount();
  }

  replaceFrom(fromCount: number): number {
    const target = this.target;
    this.delivered = target === null ? this.delivered : target.replaceFrom(fromCount);
    return this.delivered;
  }

  /**
   * Points the tap at `next`: the old output is reset and ended, and a deck that is rendering
   * (`begun`) starts the new one with the tune's chip model. `base` is the stream frame the new
   * output's first delivery will carry.
   */
  switchTo(next: SidSink | null, base: number, begun: SidModel | null): void {
    const previous = this.target;
    if (previous !== null) {
      previous.reset();
      previous.end();
    }
    this.target = next;
    this.streamAtMark = base;
    this.delivered = 0;
    if (begun !== null) next?.begin({ chipModel: begun });
  }

  private mark(): void {
    this.streamAtMark = this.streamFrame();
    this.delivered = 0;
  }
}
