import {
  parseSidFile,
  NTSC_FRAME_INTERVAL_US,
  PAL_FRAME_INTERVAL_US,
  DEFAULT_TIMING_MODE,
  playCallsPerSecond,
} from '@sidablist/core';
import type { PlayRate } from '@sidablist/core';
import { buildFeatureMatrix } from './frame-features.js';
import {
  computeNovelty,
  candidatesAbove,
  DEFAULT_CANDIDATE_THRESHOLD,
  DEFAULT_FEATURE_WEIGHTS,
} from './novelty.js';
import { computeStructure } from './structure.js';
import { computePulse, impliedTempo } from './pulse.js';
import { detectKey } from './key.js';
import { segmentNotes } from './notes.js';
import { detectLoop, IDLE_PERIOD_SECONDS, MIN_TAIL_SECONDS } from './loop-detect.js';
import type { LoopDetection } from './loop-detect.js';
import type { ScanOutput } from './scan-tune.js';
import type { AnalysisScanner, ScanRequest, ScanResult } from './scanner.js';
import { TUNE_INDEX_FORMAT_VERSION } from './tune-index.model.js';
import type { TuneIndexRecord } from './tune-index.model.js';

export interface TuneIndexIdentity {
  readonly sidHash: string;
  readonly subtune: number;
}

export class ScanFailedError extends Error {}

/** Seconds of music per rung — the depths the measured baseline was produced at. */
export const SCAN_DEPTH_SECONDS: readonly number[] = [90, 210, 450, 750];

// Session and request ids only need to be unique across the process, never persisted or compared
// across one — a module counter is the whole requirement.
let nextSessionId = 0;
let nextRequestId = 0;

/**
 * Runs the scan ladder over one tune and produces its persisted index record.
 *
 * A zero-frame probe opens the ladder to read the tune's real play rate off the worker rather than
 * guessing it — every subsequent rung deepens that same session. Rung depth is sized off the
 * *rounded* rate the probe measured, the same simplification the POC's ladder made: a loop guard a
 * few frames either way changes nothing about telling a real repeat from a played-out buffer. The
 * ladder stops at the first rung whose loop detector answers; exhausting every rung without one is
 * still a completed answer, not a failure. The full detector pipeline then runs once, against
 * whichever rung the ladder stopped on.
 */
export async function indexTune(
  scanner: AnalysisScanner,
  bytes: Uint8Array,
  identity: TuneIndexIdentity,
): Promise<TuneIndexRecord> {
  const file = parseSidFile(bytes);
  const nominalIntervalUs = file.clock === 'ntsc' ? NTSC_FRAME_INTERVAL_US : PAL_FRAME_INTERVAL_US;
  const session = ++nextSessionId;

  const probe = await requestScan(scanner, {
    session,
    file,
    subtune: identity.subtune,
    maxFrames: 0,
  });

  const rate: PlayRate = {
    callsPerFrame: probe.callsPerFrame,
    exactCallsPerFrame: probe.exactCallsPerFrame,
    roundedCallsPerFrame: probe.callsPerFrame,
    mode: 'rounded',
  };
  const perSecond = playCallsPerSecond(nominalIntervalUs, rate);
  const loopOptions = {
    minTailFrames: Math.round(MIN_TAIL_SECONDS * perSecond),
    idlePeriodFrames: Math.round(IDLE_PERIOD_SECONDS * perSecond),
  };

  let output: ScanOutput = probe;
  let loop: LoopDetection = { kind: 'none' };
  for (const seconds of SCAN_DEPTH_SECONDS) {
    const maxFrames = Math.round(seconds * perSecond);
    output = await requestScan(scanner, { session, file, subtune: identity.subtune, maxFrames });
    loop = detectLoop(output, loopOptions);
    if (loop.kind !== 'none') {
      break;
    }
  }

  const matrix = buildFeatureMatrix(output);
  const novelty = computeNovelty(matrix, DEFAULT_FEATURE_WEIGHTS);
  const structure = computeStructure(matrix, DEFAULT_FEATURE_WEIGHTS);
  const pulse = computePulse(novelty.candidates, output.exactCallsPerFrame);
  const key = detectKey(segmentNotes(output, file.clock));
  // Duration-facing, unlike the ladder's rung sizing above: the exact rate, not the rounded one — see
  // `C64Machine.exactCallsPerFrame`'s own doc for why rounding here would mis-tempo a multispeed tune.
  const tempo = impliedTempo(
    pulse.dominantInterval,
    nominalIntervalUs,
    output.exactCallsPerFrame,
    1,
  );

  return {
    sidHash: identity.sidHash,
    subtune: identity.subtune,

    loopStartFrame: loop.kind === 'loop' ? loop.startFrame : null,
    loopPeriodFrames: loop.kind === 'loop' ? loop.periodFrames : null,
    endedAtFrame: loop.kind === 'ended' ? loop.endFrame : null,
    sectionBoundaries: structure.sectionBoundaries,
    detectedMoments: candidatesAbove(novelty, DEFAULT_CANDIDATE_THRESHOLD).map((candidate) => ({
      frame: candidate.frame,
      strength: candidate.strength,
    })),

    tonic: key.tonic,
    mode: key.mode,
    camelot: key.camelot,
    tuningReferenceHz: key.tuning?.referenceHz ?? null,
    tuningCents: key.tuning?.cents ?? null,
    keyConfidence: key.confidence,
    scalePitchClasses: key.scalePitchClasses,

    dominantIntervalFrames: pulse.dominantInterval,
    pulseConfidence: pulse.confidence,
    nativeTempo: tempo.native,

    callsPerFrame: output.callsPerFrame,
    exactCallsPerFrame: output.exactCallsPerFrame,
    timingMode: DEFAULT_TIMING_MODE,
    formatVersion: TUNE_INDEX_FORMAT_VERSION,
    computedAt: new Date().toISOString(),
  };
}

async function requestScan(
  scanner: AnalysisScanner,
  rung: Omit<ScanRequest, 'id'>,
): Promise<ScanOutput> {
  const result: ScanResult = await scanner.scan({ id: ++nextRequestId, ...rung });
  if (result.kind === 'failed') {
    throw new ScanFailedError(result.error);
  }
  return result.output;
}
