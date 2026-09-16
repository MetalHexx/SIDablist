import { describe, it, expect } from 'vitest';
import { SID_REGISTER_COUNT } from '@sidablist/core';
import { indexTune, ScanFailedError } from './index-tune.js';
import type { TuneIndexIdentity } from './index-tune.js';
import { TuneScan } from './scan-tune.js';
import type { ScanOutput } from './scan-tune.js';
import type { AnalysisScanner, ScanRequest, ScanResult } from './scanner.js';
import { decodeBundledTune, STILL_TIME_BASE64 } from './__fixtures__/index.js';

/** Emulating deep into a real tune's ladder runs well past the suite's default timeout — the same
 *  budget `scan-pipeline.spec.ts` gives the same tune at a comparable depth. */
const SCAN_TIMEOUT_MS = 60_000;

const BUNDLED_BYTES = decodeBundledTune(STILL_TIME_BASE64);
const IDENTITY: TuneIndexIdentity = { sidHash: 'test-sid-hash', subtune: 1 };

/** `Omit` merges a union's members before subtracting `id`, which would erase the
 *  `'done' | 'failed'` discriminant the scripted responses below rely on. Distributing over the
 *  union first keeps each member's own shape. */
type ScriptedResponse<T> = T extends unknown ? Omit<T, 'id'> : never;

/** Answers each `scan()` call from a scripted table, in order, and records every request it was
 *  handed — the seam these tests read the ladder's own behaviour through. */
class ScriptedScanner implements AnalysisScanner {
  readonly requests: ScanRequest[] = [];
  private cursor = 0;

  constructor(private readonly responses: readonly ScriptedResponse<ScanResult>[]) {}

  async scan(request: ScanRequest): Promise<ScanResult> {
    this.requests.push(request);
    const response = this.responses[this.cursor];
    this.cursor += 1;
    if (response === undefined) {
      throw new Error(`scripted scanner ran out of responses after ${this.cursor - 1} calls`);
    }
    return { ...response, id: request.id };
  }

  dispose(): void {
    // Nothing held.
  }
}

/** A zero-frame probe answer at a given play rate. */
function probeOutput(callsPerFrame = 1, exactCallsPerFrame = callsPerFrame): ScanOutput {
  return {
    registerValues: new Uint8Array(0),
    writeCounts: new Uint8Array(0),
    frames: 0,
    callsPerFrame,
    exactCallsPerFrame,
  };
}

/** Too few frames for any period to satisfy `minTailFrames`, so `detectLoop` always answers `none`
 *  regardless of content — the loop guard's own short-circuit, not a property of this data. */
function noLoopOutput(
  frames = 5,
  callsPerFrame = 1,
  exactCallsPerFrame = callsPerFrame,
): ScanOutput {
  return {
    registerValues: new Uint8Array(frames * SID_REGISTER_COUNT),
    writeCounts: new Uint8Array(frames),
    frames,
    callsPerFrame,
    exactCallsPerFrame,
  };
}

/** A register stream that repeats from frame 0 with the given period, long enough past the period
 *  for `detectLoop` to verify it against the PAL-1× `loopOptions` these tests probe at. */
function loopingOutput(frames: number, period: number): ScanOutput {
  const registerValues = new Uint8Array(frames * SID_REGISTER_COUNT);
  for (let f = 0; f < frames; f++) {
    const base = f * SID_REGISTER_COUNT;
    const cycle = f % period;
    for (let r = 0; r < SID_REGISTER_COUNT; r++) {
      registerValues[base + r] = (cycle + r * 13) & 0xff;
    }
  }
  return {
    registerValues,
    writeCounts: new Uint8Array(frames),
    frames,
    callsPerFrame: 1,
    exactCallsPerFrame: 1,
  };
}

/** Voice 0's gate toggling every 120 frames at a multispeed rate (`callsPerFrame: 2`,
 *  `exactCallsPerFrame: 2.4`) — the reviewer's own example: a 2.4-calls/frame tune with a 60 BPM
 *  pulse. Frequency stays 0 throughout, so `segmentNotes` never opens a note and key detection stays
 *  out of this fixture's way; `frames` is short enough that `detectLoop` never verifies it (its tail
 *  always undershoots `minTailFrames`, computed off the rounded rate), so the ladder runs to
 *  exhaustion and `pulse`/`nativeTempo` are computed from this same data every rung. */
function multispeedPulseOutput(): ScanOutput {
  const halfPeriodFrames = 120;
  const frames = halfPeriodFrames * 6;
  const registerValues = new Uint8Array(frames * SID_REGISTER_COUNT);
  for (let f = 0; f < frames; f++) {
    const gateOn = Math.floor(f / halfPeriodFrames) % 2 === 0;
    // Voice 0's control register: triangle waveform, gate bit toggling.
    registerValues[f * SID_REGISTER_COUNT + 4] = gateOn ? 0x11 : 0x10;
  }
  return {
    registerValues,
    writeCounts: new Uint8Array(frames),
    frames,
    callsPerFrame: 2,
    exactCallsPerFrame: 2.4,
  };
}

describe('indexTune — the ladder', () => {
  it('opens with a zero-frame probe, and every rung after it shares that session', async () => {
    const scanner = new ScriptedScanner([
      { kind: 'done', output: probeOutput() },
      { kind: 'done', output: noLoopOutput() },
      { kind: 'done', output: noLoopOutput() },
      { kind: 'done', output: noLoopOutput() },
      { kind: 'done', output: noLoopOutput() },
    ]);

    await indexTune(scanner, BUNDLED_BYTES, IDENTITY);

    expect(scanner.requests).toHaveLength(5);
    expect(scanner.requests[0].maxFrames).toBe(0);
    const session = scanner.requests[0].session;
    expect(scanner.requests.every((request) => request.session === session)).toBe(true);
  });

  it('sizes the first rung off the probe-measured PAL rate', async () => {
    const scanner = new ScriptedScanner([
      { kind: 'done', output: probeOutput() },
      { kind: 'done', output: noLoopOutput() },
      { kind: 'done', output: noLoopOutput() },
      { kind: 'done', output: noLoopOutput() },
      { kind: 'done', output: noLoopOutput() },
    ]);

    await indexTune(scanner, BUNDLED_BYTES, IDENTITY);

    expect(scanner.requests[1].maxFrames).toBe(Math.round((90 * 1_000_000) / 19_950));
  });

  it('doubles the first rung when the probe reports a multispeed tune', async () => {
    const scanner = new ScriptedScanner([
      { kind: 'done', output: probeOutput(2, 2) },
      { kind: 'done', output: noLoopOutput(5, 2, 2) },
      { kind: 'done', output: noLoopOutput(5, 2, 2) },
      { kind: 'done', output: noLoopOutput(5, 2, 2) },
      { kind: 'done', output: noLoopOutput(5, 2, 2) },
    ]);

    await indexTune(scanner, BUNDLED_BYTES, IDENTITY);

    const perSecond = 1_000_000 / (19_950 / 2); // doubled callsPerFrame doubles the play-call rate
    expect(scanner.requests[1].maxFrames).toBe(Math.round(90 * perSecond));
  });

  it('stops deepening at the first rung whose loop verifies', async () => {
    const scanner = new ScriptedScanner([
      { kind: 'done', output: probeOutput() },
      { kind: 'done', output: loopingOutput(1000, 200) },
      { kind: 'done', output: noLoopOutput() },
      { kind: 'done', output: noLoopOutput() },
      { kind: 'done', output: noLoopOutput() },
    ]);

    const record = await indexTune(scanner, BUNDLED_BYTES, IDENTITY);

    expect(scanner.requests).toHaveLength(2); // probe + the one verifying rung
    expect(record.loopStartFrame).toBe(0);
    expect(record.loopPeriodFrames).toBe(200);
    expect(record.endedAtFrame).toBeNull();
  });

  it('runs all four rungs when none of them verify a loop, and that is still a completed answer', async () => {
    const scanner = new ScriptedScanner([
      { kind: 'done', output: probeOutput() },
      { kind: 'done', output: noLoopOutput() },
      { kind: 'done', output: noLoopOutput() },
      { kind: 'done', output: noLoopOutput() },
      { kind: 'done', output: noLoopOutput() },
    ]);

    const record = await indexTune(scanner, BUNDLED_BYTES, IDENTITY);

    expect(scanner.requests).toHaveLength(5); // probe + all four rungs
    expect(record.loopStartFrame).toBeNull();
    expect(record.loopPeriodFrames).toBeNull();
    expect(record.endedAtFrame).toBeNull();
  });

  it('rejects with ScanFailedError and produces no record when a rung fails', async () => {
    const scanner = new ScriptedScanner([
      { kind: 'done', output: probeOutput() },
      { kind: 'failed', error: 'the worker blew its cycle budget' },
    ]);

    await expect(indexTune(scanner, BUNDLED_BYTES, IDENTITY)).rejects.toThrow(ScanFailedError);
  });

  it('rejects with ScanFailedError when the probe itself fails', async () => {
    const scanner = new ScriptedScanner([{ kind: 'failed', error: 'no such subtune' }]);

    await expect(indexTune(scanner, BUNDLED_BYTES, IDENTITY)).rejects.toThrow(ScanFailedError);
  });

  it("fills the record with the identity, the current format version, and the final rung's exact rate", async () => {
    const scanner = new ScriptedScanner([
      { kind: 'done', output: probeOutput(1, 1.03) },
      { kind: 'done', output: noLoopOutput(5, 1, 1.03) },
      { kind: 'done', output: noLoopOutput(5, 1, 1.03) },
      { kind: 'done', output: noLoopOutput(5, 1, 1.03) },
      { kind: 'done', output: noLoopOutput(5, 1, 1.03) },
    ]);

    const record = await indexTune(scanner, BUNDLED_BYTES, { sidHash: 'my-hash', subtune: 3 });

    expect(record.sidHash).toBe('my-hash');
    expect(record.subtune).toBe(3);
    expect(record.formatVersion).toBe(5);
    expect(record.callsPerFrame).toBe(1);
    expect(record.exactCallsPerFrame).toBe(1.03);
  });

  it('finds a multispeed pulse the nominal 1× histogram cap would discard, and computes nativeTempo off the exact rate', async () => {
    const pulseOutput = multispeedPulseOutput();
    const scanner = new ScriptedScanner([
      { kind: 'done', output: probeOutput(2, 2.4) },
      { kind: 'done', output: pulseOutput },
      { kind: 'done', output: pulseOutput },
      { kind: 'done', output: pulseOutput },
      { kind: 'done', output: pulseOutput },
    ]);

    const record = await indexTune(scanner, BUNDLED_BYTES, IDENTITY);

    // A 120-frame interval is past the ~101-frame cap a nominal-PAL-1× histogram would use — it only
    // survives because the ladder now sizes that cap off `exactCallsPerFrame` (2.4), not 1.
    expect(record.dominantIntervalFrames).toBe(120);
    expect(record.pulseConfidence).toBe('strong');
    // 120 frames at 19,950 µs / 2.4 calls-per-frame is ~0.9975s of music, ~60.15 BPM. Computed off the
    // rounded rate (2) instead, the same interval reads about 20% slower.
    expect(record.nativeTempo).not.toBeNull();
    expect(record.nativeTempo ?? 0).toBeCloseTo(60.15, 1);
  });
});

describe('indexTune — end to end', () => {
  /** Runs `scanTune`'s stateful ladder synchronously, deepening the same `TuneScan` per session
   *  exactly as the worker handler does — a real emulation, not a script. */
  class TuneScanScanner implements AnalysisScanner {
    private readonly scans = new Map<number, TuneScan>();

    async scan(request: ScanRequest): Promise<ScanResult> {
      let scan = this.scans.get(request.session);
      if (scan === undefined) {
        scan = new TuneScan(request.file, request.subtune);
        this.scans.set(request.session, scan);
      }
      try {
        scan.advanceTo(request.maxFrames);
        return { id: request.id, kind: 'done', output: scan.output() };
      } catch (error) {
        return {
          id: request.id,
          kind: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    dispose(): void {
      this.scans.clear();
    }
  }

  it(
    'reproduces a looping record for a real tune, over a synchronous scanner',
    async () => {
      const record = await indexTune(new TuneScanScanner(), BUNDLED_BYTES, IDENTITY);

      // scan-pipeline.spec.ts already proves the detectors' exact values on this tune; here it is
      // enough that the ladder reaches a verified loop rather than exhausting itself.
      expect(record.loopStartFrame).not.toBeNull();
      expect(record.loopPeriodFrames).not.toBeNull();
      expect(record.endedAtFrame).toBeNull();
    },
    SCAN_TIMEOUT_MS,
  );
});
