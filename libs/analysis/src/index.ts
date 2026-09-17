export { formatCents, formatDuration } from './format.js';
export {
  readFrameFeatures,
  buildFeatureMatrix,
  FEATURE_DIMENSIONS,
  FEATURE_DIMENSION_COUNT,
  type VoiceFeatures,
  type FrameFeatures,
  type FeatureMatrix,
} from './frame-features.js';
export {
  recoverTuning,
  detectKey,
  detectKeyPerSection,
  soundingKey,
  keyName,
  camelotFor,
  scaleFor,
  isOutOfScale,
  PITCH_CLASS_NAMES,
  type TuningResult,
  type KeyResult,
} from './key.js';
export {
  detectLoop,
  MIN_TAIL_SECONDS,
  IDLE_PERIOD_SECONDS,
  type LoopDetection,
  type LoopDetectOptions,
} from './loop-detect.js';
export { reachableMomentOffsets, nextMomentOffset } from './marker-moments.js';
export {
  segmentNotes,
  cpuClockHzFor,
  registerToHz,
  PAL_CPU_CLOCK_HZ,
  NTSC_CPU_CLOCK_HZ,
  type Note,
} from './notes.js';
export {
  computeNovelty,
  candidatesAbove,
  dimensionWeightsFor,
  rowDistance,
  DEFAULT_FEATURE_WEIGHTS,
  DEFAULT_CANDIDATE_THRESHOLD,
  type FeatureWeights,
  type Candidate,
  type NoveltyResult,
} from './novelty.js';
export { computePulse, impliedTempo, type PulseResult } from './pulse.js';
export { TuneScan, scanTune, type ScanOutput } from './scan-tune.js';
export { computeStructure, type StructureResult } from './structure.js';
export {
  tuneIndexLengthLabel,
  tuneIndexLoopStartLabel,
  tuneIndexLoopPeriodLabel,
  tuneIndexLoopIsImplausible,
  tuneIndexKeyLabel,
  tuneIndexKeyConfidenceLabel,
  TUNE_INDEX_ANALYZING_LABEL,
  TUNE_INDEX_UNKNOWN_LABEL,
  TUNE_INDEX_NOT_FOUND_LABEL,
  TUNE_INDEX_ENDED_LABEL,
  type TuneIndexRate,
} from './tune-index-readouts.js';
export {
  TUNE_INDEX_FORMAT_VERSION,
  type DetectorConfidence,
  type DetectedMoment,
  type TuneIndexRecord,
} from './tune-index.model.js';
export { positionBasisFor, timelineBasisFor, type DetectedLoopFrames } from './tune-length.js';
export {
  type ScanRequest,
  type ScanMessage,
  type ScanResult,
  type AnalysisScanner,
} from './scanner.js';
export { handleScanRequest } from './scan-worker-handler.js';
export {
  indexTune,
  ScanFailedError,
  SCAN_DEPTH_SECONDS,
  type TuneIndexIdentity,
} from './index-tune.js';
