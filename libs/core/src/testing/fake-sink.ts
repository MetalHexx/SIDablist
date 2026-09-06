import type { FarEndConsumption, SidSink, SinkCapabilities } from '../ports/sink.js';
import type { SidFrame } from '../registers/sid-frame.js';
import type { Frames, Microseconds, Milliseconds } from '../units.js';
import type { SidModel } from '../sid/sid-file.model.js';

const DEFAULT_CAPABILITIES: SinkCapabilities = {
  perWriteOffsets: false,
  cancellation: false,
  scheduleAheadMs: null,
};

/** One call to `deliver`, recorded with the frame copied out of its reused buffers. */
export interface DeliveredFrame {
  readonly frame: SidFrame;
  readonly frameNumber: Frames;
  readonly dueAtMs: Milliseconds;
  readonly catchUpClamped: boolean;
}

function copyFrame(frame: SidFrame): SidFrame {
  return {
    count: frame.count,
    registers: frame.registers.slice(),
    values: frame.values.slice(),
    offsetsUs: frame.offsetsUs.slice(),
  };
}

/**
 * Records what it was handed instead of driving a far end. `deliver` and `deliverNow` copy the
 * frame's buffers before storing them — the contract reuses them between calls, so a test
 * asserting on frame *n* after frame *n+1* has been delivered would otherwise see frame *n+1*'s
 * contents under frame *n*'s name.
 */
export class FakeSink implements SidSink {
  private currentCapabilities: SinkCapabilities;
  private readonly deliveredFramesRecorded: DeliveredFrame[] = [];
  private readonly deliveredNowFramesRecorded: SidFrame[] = [];
  private readonly beginCallsRecorded: { readonly chipModel: SidModel }[] = [];
  private endCallsRecorded = 0;
  private readonly retimeCallsRecorded: Microseconds[] = [];
  private resetCallsRecorded = 0;
  private consumption: FarEndConsumption = { kind: 'unknown', inFlight: 0 };

  constructor(capabilities: SinkCapabilities = DEFAULT_CAPABILITIES) {
    this.currentCapabilities = capabilities;
  }

  get capabilities(): SinkCapabilities {
    return this.currentCapabilities;
  }

  /** Lets a test change what `capabilities` reports mid-run, since the real contract treats it
   *  as live rather than fixed at construction. */
  setCapabilities(capabilities: SinkCapabilities): void {
    this.currentCapabilities = capabilities;
  }

  begin(tune: { readonly chipModel: SidModel }): void {
    this.beginCallsRecorded.push(tune);
  }

  end(): void {
    this.endCallsRecorded++;
  }

  deliver(
    frame: SidFrame,
    frameNumber: Frames,
    dueAtMs: Milliseconds,
    catchUpClamped: boolean,
  ): void {
    this.deliveredFramesRecorded.push({
      frame: copyFrame(frame),
      frameNumber,
      dueAtMs,
      catchUpClamped,
    });
  }

  deliverNow(frame: SidFrame): void {
    this.deliveredNowFramesRecorded.push(copyFrame(frame));
  }

  retime(intervalUs: Microseconds): void {
    this.retimeCallsRecorded.push(intervalUs);
  }

  reset(): void {
    this.resetCallsRecorded++;
  }

  readAt(): FarEndConsumption {
    return this.consumption;
  }

  /** Lets a test script what `readAt` answers next, since a fake has no far end of its own to
   *  measure. */
  setConsumption(consumption: FarEndConsumption): void {
    this.consumption = consumption;
  }

  get deliveredFrames(): readonly DeliveredFrame[] {
    return this.deliveredFramesRecorded;
  }

  get deliveredNowFrames(): readonly SidFrame[] {
    return this.deliveredNowFramesRecorded;
  }

  get beginCalls(): readonly { readonly chipModel: SidModel }[] {
    return this.beginCallsRecorded;
  }

  get endCallCount(): number {
    return this.endCallsRecorded;
  }

  get retimeCalls(): readonly Microseconds[] {
    return this.retimeCallsRecorded;
  }

  get resetCallCount(): number {
    return this.resetCallsRecorded;
  }
}
