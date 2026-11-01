import { SID_REGISTER_COUNT, VOICE_CONTROL_REGISTERS } from '@sidablist/core';
import type { RegisterRecord } from '@sidablist/core';
import type { DetectorConfidence } from './tune-index.model.js';

/** Where beats fall: every frame beatOneFrame + k × beatFrames (k any integer) that is ≥ 0. */
export interface BeatGrid {
  /** Whole play calls per beat, ≥ 1. */
  readonly beatFrames: number;
  /** A frame a beat falls on, ≥ 0. */
  readonly beatOneFrame: number;
}

/** A grid as the scan found it, with the span of frames it holds over. */
export interface DetectedBeatGrid extends BeatGrid {
  /** 0 when the grid holds from the top. */
  readonly startFrame: number;
  /** Exclusive; null while the grid holds to the end of the stream. */
  readonly endFrame: number | null;
}

/** Frames where at least one voice starts a note, ascending and unique, with how many voices did. */
export interface NoteStarts {
  readonly frames: Uint32Array;
  /** 1–3, parallel to `frames`. */
  readonly voices: Uint8Array;
}

export interface BeatGridDetection {
  readonly grid: DetectedBeatGrid | null;
  /** `'none'` exactly when `grid` is null. */
  readonly confidence: DetectorConfidence;
}

const DECLINED: BeatGridDetection = { grid: null, confidence: 'none' };

const GATE_BIT = 0x01;
const VOICE_COUNT = VOICE_CONTROL_REGISTERS.length;

/** Register number -> voice index for the voice control registers, -1 for every other. */
const VOICE_OF_REGISTER = new Int8Array(SID_REGISTER_COUNT).fill(-1);
VOICE_CONTROL_REGISTERS.forEach((register, voice) => {
  VOICE_OF_REGISTER[register] = voice;
});

/** How many voices a three-bit started-voice mask names. */
const VOICES_IN_MASK = new Uint8Array([0, 1, 1, 2, 1, 2, 2, 3]);

/** Slowest tempo of the searched band. A starting value, to be judged on real tunes at the bench. */
const MIN_BPM = 50;
/** Fastest tempo of the searched band. A starting value, to be judged on real tunes at the bench. */
const MAX_BPM = 220;
/** Lower edge of the usual tempo range; slower tempos are searched but disfavoured. A starting value,
 *  to be judged on real tunes at the bench. */
const USUAL_MIN_BPM = 80;
/** Upper edge of the usual tempo range; faster tempos are searched but disfavoured. A starting value,
 *  to be judged on real tunes at the bench. */
const USUAL_MAX_BPM = 170;
/** Binary orders of magnitude of score lost per octave of tempo outside the usual range, which
 *  settles the beat-versus-bar and beat-versus-step ambiguity between candidates that align equally
 *  well. A starting value, to be judged on real tunes at the bench. */
const OUT_OF_RANGE_PENALTY_PER_OCTAVE = 2;
/** A grid of one frame cannot be told from no grid at all. */
const MIN_BEAT_FRAMES = 2;
/** Fewer note starts than this give no grid worth the name. A starting value, to be judged on real
 *  tunes at the bench. */
const MIN_NOTE_STARTS = 32;
/** The stream, and the span the grid holds over, must each cover this many beats. A starting value,
 *  to be judged on real tunes at the bench. */
const MIN_BEATS = 8;
/** How many times more weighted note starts than chance the best phase of a candidate must hold. A
 *  starting value, to be judged on real tunes at the bench. */
const MIN_LIFT = 2;
/** How many standard deviations above chance the best phase's weight must stand, so that a long
 *  stream of free time does not pass on the strength of searching every candidate. A starting value,
 *  to be judged on real tunes at the bench. */
const MIN_SIGNIFICANCE = 6;
/** The winner's lift over the best unrelated candidate's from which the answer is `'strong'`. A
 *  starting value, to be judged on real tunes at the bench. */
const STRONG_MARGIN = 1.3;
/** Two beat lengths are related when each is a whole number of some shared step, no more than this
 *  many (b and 2b, 3b, 3b/2 and so on): the same pulse read at another subdivision, which a lattice
 *  of note starts aligns to just as well. A starting value, to be judged on real tunes at the bench. */
const RELATED_MAX_TERM = 6;
/** Candidates scoring within this fraction of the best are taken to align equally well, and the one
 *  nearest the centre of the usual tempo range among them wins. A starting value, to be judged on
 *  real tunes at the bench. */
const NEAR_BEST_FRACTION = 0.05;
/** Phases of the winning beat length weighing within this fraction of the heaviest are taken to align
 *  equally well, and the one holding the strongest accents among them is the grid's phase. That is
 *  what tells a beat from the off-beat half a beat after it, whose many single-voice steps can
 *  outweigh the fewer, heavier hits the beat carries. A starting value, to be judged on real tunes
 *  at the bench. */
const NEAR_PHASE_FRACTION = 0.1;
/** Cap on the on-grid share used to price a note start, keeping a perfect grid's price finite. */
const MAX_ON_GRID_SHARE = 0.99;
/** Beats at either end of the stream a span may stop short of and still count as holding to that end.
 *  A starting value, to be judged on real tunes at the bench. */
const EDGE_SLACK_BEATS = 4;
/** Geometric centre of the usual range, which settles which of the equally aligned lengths wins. */
const USUAL_CENTER_BPM = Math.sqrt(USUAL_MIN_BPM * USUAL_MAX_BPM);

/** How far, as a fraction of the median gap, a fitted length may stray from it. A starting value, to
 *  be judged on real tunes at the bench. */
const FIT_LENGTH_TOLERANCE = 0.1;
/** How far from an approximate beat frame, as a fraction of a beat, a note start may sit and anchor
 *  the fit. A starting value, to be judged on real tunes at the bench. */
const FIT_ANCHOR_BEATS = 0.25;

/**
 * The frames at which a voice starts a note, read from a register record.
 *
 * A voice starts a note at entry `i` when its control byte's gate bit is set at `i` and was clear at
 * `i - 1` (clear before entry 0), or when entry `i` retriggers that voice's control register with a
 * first byte whose gate was clear and a final byte whose gate is set: a gate dropped and raised
 * inside one play call. Every voice and waveform counts; noise drums are the strongest beat cue.
 *
 * Frames are entry indices of `record`, the same basis as the other frame fields of a tune's index.
 */
export function noteStarts(record: RegisterRecord): NoteStarts {
  const { frames: entries, values, retriggerEntries, retriggerRegisters, retriggerValues } = record;
  const startFrames = new Uint32Array(entries);
  const startVoices = new Uint8Array(entries);
  let count = 0;
  let retrigger = 0;

  for (let entry = 0; entry < entries; entry++) {
    const base = entry * SID_REGISTER_COUNT;
    let started = 0;

    for (let voice = 0; voice < VOICE_COUNT; voice++) {
      const register = VOICE_CONTROL_REGISTERS[voice];
      const gateNow = values[base + register] & GATE_BIT;
      const gateBefore = entry > 0 ? values[base - SID_REGISTER_COUNT + register] & GATE_BIT : 0;
      if (gateNow !== 0 && gateBefore === 0) {
        started |= 1 << voice;
      }
    }

    while (retrigger < retriggerEntries.length && retriggerEntries[retrigger] <= entry) {
      if (retriggerEntries[retrigger] === entry) {
        const register = retriggerRegisters[retrigger];
        const voice = VOICE_OF_REGISTER[register];
        if (
          voice >= 0 &&
          (retriggerValues[retrigger] & GATE_BIT) === 0 &&
          (values[base + register] & GATE_BIT) !== 0
        ) {
          started |= 1 << voice;
        }
      }
      retrigger++;
    }

    if (started !== 0) {
      startFrames[count] = entry;
      startVoices[count] = VOICES_IN_MASK[started];
      count++;
    }
  }

  return { frames: startFrames.slice(0, count), voices: startVoices.slice(0, count) };
}

/** How strongly a tempo is expected: 1 inside the usual range, falling off per octave outside it. */
function tempoPrior(bpm: number): number {
  const octavesOutside =
    bpm < USUAL_MIN_BPM
      ? Math.log2(USUAL_MIN_BPM / bpm)
      : bpm > USUAL_MAX_BPM
        ? Math.log2(bpm / USUAL_MAX_BPM)
        : 0;
  return 2 ** (-OUT_OF_RANGE_PENALTY_PER_OCTAVE * octavesOutside);
}

/** True when `a` and `b` are small whole numbers of some shared step (see `RELATED_MAX_TERM`). */
function areRelated(a: number, b: number): boolean {
  for (let n = 1; n <= RELATED_MAX_TERM; n++) {
    for (let m = 1; m <= RELATED_MAX_TERM; m++) {
      if (a * n === b * m) return true;
    }
  }
  return false;
}

/**
 * Which residue of `frame % beat` the beats fall on, and the weight of note starts it holds.
 *
 * A beat's note starts and the off-beat's (half a beat on) often weigh almost the same, and by weight
 * alone the off-beat can win on many single-voice steps over fewer, heavier hits. So the phases
 * weighing within `NEAR_PHASE_FRACTION` of the heaviest are taken to align equally well, and the one
 * whose starts hold the most weight squared, which counts an accent for more, wins among them; the
 * lowest phase breaks a remaining tie. A phase clearly ahead of the rest is chosen as it stands.
 */
function settlePhase(starts: NoteStarts, beat: number): { phase: number; weight: number } {
  const weights = new Float64Array(beat);
  const accents = new Float64Array(beat);
  for (let i = 0; i < starts.frames.length; i++) {
    const residue = starts.frames[i] % beat;
    weights[residue] += starts.voices[i];
    accents[residue] += starts.voices[i] * starts.voices[i];
  }
  let heaviest = 0;
  for (let phase = 0; phase < beat; phase++) {
    heaviest = Math.max(heaviest, weights[phase]);
  }
  const floor = heaviest * (1 - NEAR_PHASE_FRACTION);
  let chosen = -1;
  for (let phase = 0; phase < beat; phase++) {
    if (weights[phase] < floor) continue;
    if (chosen < 0 || accents[phase] > accents[chosen]) chosen = phase;
  }
  return { phase: chosen, weight: weights[chosen] };
}

/**
 * Finds a tune's beat grid from where its voices start notes.
 *
 * The beat is a whole number of frames (SID tempo is counted in play calls), so what shows a grid is
 * exact modular alignment: for a candidate length `b`, the note starts that fall on one residue of
 * `frame % b`, weighted by how many voices started. A candidate's lift is that weight's share
 * multiplied by `b`, so a candidate that gathers no more than chance scores 1. Lengths are searched
 * across a wide tempo band, converted through `callsPerSecond` so a multispeed tune searches in its
 * own frames; among candidates that align equally well the one nearest the usual tempo range wins,
 * which is what settles a beat against its steps and its bars. Taking a step or a bar for the beat
 * is this detector's known failure mode, which `fitBeatGrid` corrects from a few approximate beats.
 *
 * The span is the stretch of the stream where the winner's note starts keep agreeing: the maximum
 * sum of a score that pays for each on-grid start and charges for each off-grid one, so a quiet
 * stretch costs nothing and a tempo change ends the span. A tune that changes tempo gets its main
 * part's grid and that part's span.
 *
 * Declines, with confidence `'none'`, when there are too few note starts, when the stream or the
 * span covers fewer than a handful of beats (a sound-effect subtune), or when no candidate aligns
 * well enough (ambient, free time). Otherwise the confidence is `'strong'` or `'weak'` from how
 * clearly the winner stands above the best candidate unrelated to it.
 *
 * @param starts the tune's note starts, from `noteStarts`
 * @param frames the length of the stream the starts were read from, in play calls
 * @param callsPerSecond the play-call rate; the exact rate for a multispeed tune
 */
export function detectBeatGrid(
  starts: NoteStarts,
  frames: number,
  callsPerSecond: number,
): BeatGridDetection {
  const startFrames = starts.frames;
  const startVoices = starts.voices;
  const count = startFrames.length;
  if (count < MIN_NOTE_STARTS || !(callsPerSecond > 0)) return DECLINED;

  const minBeat = Math.max(MIN_BEAT_FRAMES, Math.ceil((60 * callsPerSecond) / MAX_BPM));
  const maxBeat = Math.floor((60 * callsPerSecond) / MIN_BPM);
  if (maxBeat < minBeat || frames < MIN_BEATS * minBeat) return DECLINED;

  let totalWeight = 0;
  let totalSquares = 0;
  for (let i = 0; i < count; i++) {
    totalWeight += startVoices[i];
    totalSquares += startVoices[i] * startVoices[i];
  }

  const lifts = new Float64Array(maxBeat + 1);
  const eligible = new Uint8Array(maxBeat + 1);
  const residueWeights = new Float64Array(maxBeat);

  for (let beat = minBeat; beat <= maxBeat; beat++) {
    residueWeights.fill(0, 0, beat);
    for (let i = 0; i < count; i++) {
      residueWeights[startFrames[i] % beat] += startVoices[i];
    }
    let bestWeight = 0;
    for (let phase = 0; phase < beat; phase++) {
      if (residueWeights[phase] > bestWeight) {
        bestWeight = residueWeights[phase];
      }
    }
    const expected = totalWeight / beat;
    const deviation = Math.sqrt((totalSquares / beat) * (1 - 1 / beat));
    lifts[beat] = bestWeight / expected;
    eligible[beat] =
      lifts[beat] >= MIN_LIFT && (bestWeight - expected) / deviation >= MIN_SIGNIFICANCE ? 1 : 0;
  }

  const bpmOf = (beat: number): number => (60 * callsPerSecond) / beat;
  const centerDistance = (beat: number): number =>
    Math.abs(Math.log2(bpmOf(beat) / USUAL_CENTER_BPM));

  const scores = new Float64Array(maxBeat + 1);
  let bestScore = 0;
  for (let beat = minBeat; beat <= maxBeat; beat++) {
    if (eligible[beat] === 0) continue;
    scores[beat] = lifts[beat] * tempoPrior(bpmOf(beat));
    bestScore = Math.max(bestScore, scores[beat]);
  }
  if (bestScore === 0) return DECLINED;

  let winner = 0;
  for (let beat = minBeat; beat <= maxBeat; beat++) {
    if (scores[beat] < bestScore * (1 - NEAR_BEST_FRACTION)) continue;
    if (winner === 0 || centerDistance(beat) < centerDistance(winner)) winner = beat;
  }
  if (frames < MIN_BEATS * winner) return DECLINED;

  let rivalLift = 0;
  for (let beat = minBeat; beat <= maxBeat; beat++) {
    if (!areRelated(beat, winner)) rivalLift = Math.max(rivalLift, lifts[beat]);
  }
  const confidence: DetectorConfidence =
    rivalLift === 0 || lifts[winner] / rivalLift >= STRONG_MARGIN ? 'strong' : 'weak';

  const { phase, weight: phaseWeight } = settlePhase(starts, winner);
  const onGridShare = Math.min(MAX_ON_GRID_SHARE, phaseWeight / totalWeight);
  const hitScore = Math.log(onGridShare * winner);
  const missScore = -Math.log((1 - 1 / winner) / (1 - onGridShare));

  let runStart = 0;
  let runSum = 0;
  let bestSum = -Infinity;
  let spanFirst = 0;
  let spanLast = 0;
  for (let i = 0; i < count; i++) {
    const gain = startVoices[i] * (startFrames[i] % winner === phase ? hitScore : missScore);
    if (runSum <= 0) {
      runStart = i;
      runSum = gain;
    } else {
      runSum += gain;
    }
    if (runSum > bestSum) {
      bestSum = runSum;
      spanFirst = runStart;
      spanLast = i;
    }
  }

  const slack = EDGE_SLACK_BEATS * winner;
  const startFrame =
    spanFirst === 0 || startFrames[spanFirst - 1] < slack ? 0 : startFrames[spanFirst];
  const endFrame =
    spanLast === count - 1 || startFrames[spanLast + 1] >= frames - slack
      ? null
      : startFrames[spanLast] + 1;
  if ((endFrame ?? frames) - startFrame < MIN_BEATS * winner) return DECLINED;

  let beatOneFrame = startFrames[spanFirst];
  for (let i = 0; i < spanFirst; i++) {
    if (startFrames[i] >= startFrame && startFrames[i] % winner === phase) {
      beatOneFrame = startFrames[i];
      break;
    }
  }

  return { grid: { beatFrames: winner, beatOneFrame, startFrame, endFrame }, confidence };
}

/** Index of the first of the ascending `frames` that is ≥ `frame`. */
function lowerBound(frames: Uint32Array, frame: number): number {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (frames[middle] < frame) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Voices that start a note at exactly `frame`, 0 when none does. */
function voicesAt(starts: NoteStarts, frame: number): number {
  const index = lowerBound(starts.frames, frame);
  return index < starts.frames.length && starts.frames[index] === frame ? starts.voices[index] : 0;
}

function median(sorted: Float64Array): number {
  const middle = sorted.length >>> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Fits an exact grid to approximate beat frames, snapping it onto note starts.
 *
 * The median gap between consecutive approximate frames picks the length, searched across whole
 * lengths within about 10% of it. The length must land on note starts: the grid is anchored on the
 * earliest approximate frame with a note start within about a quarter beat. Among the lengths and
 * anchors tried, the grid that puts each approximate frame closest to a grid point carrying a note
 * start wins, with the most note starts under the grid as the tiebreak.
 *
 * Where the approximate frames fall within a beat says which of its repeated hits the operator
 * tapped, which is not which hit is the beat: a tune with a note every few frames puts a hit within
 * a quarter beat of any tap. So the anchor fixes only the length, and the grid's phase is the one
 * the tune's accents settle on (`settlePhase`), as in `detectBeatGrid`. Beat one is the grid point
 * nearest the first approximate frame, kept ≥ 0.
 *
 * @param approxBeatFrames approximate frames of beats, ascending (sorted here if not)
 * @param starts the tune's note starts, from `noteStarts`
 * @returns the grid, or null with fewer than 2 approximate frames, a non-positive median gap, or no
 *  approximate frame near any note start
 */
export function fitBeatGrid(
  approxBeatFrames: readonly number[],
  starts: NoteStarts,
): BeatGrid | null {
  if (approxBeatFrames.length < 2) return null;
  const approx = Float64Array.from(approxBeatFrames).sort();
  const gaps = new Float64Array(approx.length - 1);
  for (let i = 0; i < gaps.length; i++) {
    gaps[i] = approx[i + 1] - approx[i];
  }
  const medianGap = median(gaps.sort());
  if (!(medianGap > 0)) return null;

  const shortest = Math.max(1, Math.ceil(medianGap * (1 - FIT_LENGTH_TOLERANCE)));
  const longest = Math.max(shortest, Math.floor(medianGap * (1 + FIT_LENGTH_TOLERANCE)));
  const first = approx[0];
  const last = approx[approx.length - 1];

  let best: { beatFrames: number; anchor: number; cost: number; support: number } | null = null;
  for (let beatFrames = shortest; beatFrames <= longest; beatFrames++) {
    const reach = beatFrames * FIT_ANCHOR_BEATS;
    let anchorFirst = -1;
    let anchorLast = -1;
    for (const frame of approx) {
      const low = lowerBound(starts.frames, Math.ceil(frame - reach));
      if (low < starts.frames.length && starts.frames[low] <= frame + reach) {
        anchorFirst = low;
        anchorLast = low;
        while (
          anchorLast + 1 < starts.frames.length &&
          starts.frames[anchorLast + 1] <= frame + reach
        ) {
          anchorLast++;
        }
        break;
      }
    }
    if (anchorFirst < 0) continue;

    for (let a = anchorFirst; a <= anchorLast; a++) {
      const anchor = starts.frames[a];

      let cost = 0;
      for (const frame of approx) {
        let point = anchor + Math.round((frame - anchor) / beatFrames) * beatFrames;
        if (point < 0) point += beatFrames;
        cost += Math.abs(frame - point) + (voicesAt(starts, point) > 0 ? 0 : beatFrames);
      }

      let support = 0;
      for (
        let point = anchor + Math.ceil((first - anchor) / beatFrames) * beatFrames;
        point <= last;
        point += beatFrames
      ) {
        if (point >= 0) support += voicesAt(starts, point);
      }

      if (best === null || cost < best.cost || (cost === best.cost && support > best.support)) {
        best = { beatFrames, anchor, cost, support };
      }
    }
  }
  if (best === null) return null;

  const { phase } = settlePhase(starts, best.beatFrames);
  let beatOneFrame = phase + Math.round((first - phase) / best.beatFrames) * best.beatFrames;
  while (beatOneFrame < 0) beatOneFrame += best.beatFrames;
  return { beatFrames: best.beatFrames, beatOneFrame };
}
