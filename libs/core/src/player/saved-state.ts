import { DEFAULT_TIMING_MODE } from '../clock/play-rate.js';
import type { TimingMode } from '../clock/play-rate.js';
import { createMachineImage } from '../cpu/c64-machine.js';
import type { WritableMachineSnapshot } from '../cpu/c64-machine.js';
import type { RegisterFrameState } from '../registers/register-frame.js';
import { VOICE_COUNT } from '../registers/sid-constants.js';
import { SID_FIELD_TABLE } from '../registers/sid-fields.js';
import type { SidField } from '../registers/sid-fields.js';
import type { ReplayResult } from '../replay/replay-to-frame.js';
import type { SidFile } from '../sid/sid-file.model.js';
import type { ActiveLoopTrackerState } from '../timeline/active-loop.js';
import type { PositionAnchor } from '../timeline/anchor-ring.js';
import { createImageBuffer } from '../timeline/crossing-captures.js';
import type { CrossingCapturesState, ImageBuffer } from '../timeline/crossing-captures.js';
import type { ShadowPositionState } from '../timeline/shadow-position.js';
import type { TrackStructureState } from '../timeline/track-structure.js';
import type { SavedPlayerState, VarispeedRateSource } from './sid-player.js';
import type { QueuedJump } from './snapshot.js';
import type { VarispeedState } from './varispeed.js';

/** A field hold as the coordinator carries it into every tune loaded after. */
export interface FieldHoldRecord {
  readonly field: SidField;
  readonly value: number;
  readonly amount: number;
}

/** A field offset as the coordinator carries it into every tune loaded after. */
export interface FieldOffsetRecord {
  readonly field: SidField;
  readonly amount: number;
}

/**
 * `JumpSettings` resolved at the call that carried them: every entry validated, every field
 * resolved to its table index, and every record the coordinator carries built once. Landing them is
 * then only assignment, which is what keeps it off the allocation budget of the frame it lands on.
 * Nothing mutates one once made, which is what lets a saved state hold it by reference.
 */
export interface PreparedSettings {
  readonly pitches: readonly { readonly voice: number; readonly coefficient: number }[];
  /** An amount of 0 hands the field back. */
  readonly offsets: readonly { readonly index: number; readonly record: FieldOffsetRecord }[];
  /** A null record releases the field. */
  readonly holds: readonly {
    readonly index: number;
    readonly field: SidField;
    readonly record: FieldHoldRecord | null;
  }[];
  readonly mutes: readonly { readonly voice: number; readonly muted: boolean }[];
}

/**
 * The scaled register groups, in the order the coordinator keeps their coefficients. `scaleSlot`
 * takes only a listed group, so a group added to `ScaledRegisterGroup` and not listed here stops
 * compiling where a scale is set, rather than being carried across loads and never saved.
 */
export const SCALED_GROUPS = ['volume', 'cutoff', 'resonance', 'pulseWidth'] as const;

/** Where `group`'s coefficient lives in the carried scales. */
export function scaleSlot(group: (typeof SCALED_GROUPS)[number]): number {
  return SCALED_GROUPS.indexOf(group);
}

/**
 * The layout of a saved player state. A plain record, made once and copied into field by field:
 * everything the coordinator and its parts decide the next frames from, and the identity it was
 * taken under. A nullable number is NaN-encoded here, since a `number | null` field boxes a new
 * number on every store.
 *
 * In, by part: the machine image (`machine`), and the state each saveable part makes for itself
 * (`registers`, `loop`, `track`, `shadow`, `varispeed`, `crossing`).
 *
 * In, held by the coordinator: the position, the tempo and the rate mirror, the mutes, the output
 * settings the next load carries (gain, scales, target clock, pitches, field holds and offsets),
 * the queued jump and the settings it lands with, the hand-offs landed, the track loop's entry image,
 * the hand (`varispeedActive`, `rateSource`, the handback and the gate-off owed).
 *
 * The loop-entry buffer is a mutable image the tracker's state points at without owning, so it is
 * copied here, once per fill rather than once per save: `loopEntryVersion` names the fill the
 * copy holds, and a save or a restore copies only when it differs from the player's own.
 *
 * Out: what only reports (stats, the delivery history, the published snapshot), what the host owns
 * (its clock, sink, rate source's own state and the transport), what the tune alone determines
 * (the prepared jump images, the declared set, the entry-image cache), `runningIntervalUs` (what
 * the clock was handed is the clock's own: a restore derives it from the restored tempo and rate)
 * and the tokens that tell a late answer or a stale copy from a current one (`handbackGeneration`,
 * `varispeedRun`, `clockStarts`, `imageVersions`), which only rise: put back, an answer already in
 * flight would pass for the next request's.
 */
export class SavedState {
  /** The player that made it: another player's pool stamps and buffers mean nothing here. */
  readonly owner: object;

  /** Who it was saved from. A state not yet saved into has no file, and restores nowhere. */
  file: SidFile | null = null;
  subtune = 0;
  loadGeneration = -1;

  framesRendered = 0;
  readonly machine: WritableMachineSnapshot = createMachineImage();
  readonly registers: RegisterFrameState;
  readonly loop: ActiveLoopTrackerState;
  readonly track: TrackStructureState;
  readonly shadow: ShadowPositionState;
  readonly varispeed: VarispeedState;
  readonly crossing: CrossingCapturesState;

  readonly loopEntry: ImageBuffer = createImageBuffer();
  loopEntryVersion = 0;
  loopEntryFilled = false;
  trackLoopEntry: PositionAnchor | null = null;
  queuedJump: QueuedJump | null = null;
  queuedSettings: PreparedSettings | null = null;
  handOffs = 0;

  tempoMultiplier = 1;
  nominalIntervalUs = 0;
  timingMode: TimingMode = DEFAULT_TIMING_MODE;
  machineExactRate = 1;
  machineRoundedRate = 1;

  readonly mutedVoices: boolean[] = new Array<boolean>(VOICE_COUNT).fill(false);
  readonly heldVoices: boolean[] = new Array<boolean>(VOICE_COUNT).fill(false);
  outputGain = 1;
  /** NaN for a group never scaled. */
  readonly registerScales = new Float64Array(SCALED_GROUPS.length).fill(Number.NaN);
  /** NaN while the application has named no far-end clock. */
  targetClockHz = Number.NaN;
  readonly voicePitch = new Float64Array(VOICE_COUNT).fill(1);
  readonly fieldHolds: (FieldHoldRecord | null)[] = new Array<FieldHoldRecord | null>(
    SID_FIELD_TABLE.length,
  ).fill(null);
  readonly fieldOffsets: (FieldOffsetRecord | null)[] = new Array<FieldOffsetRecord | null>(
    SID_FIELD_TABLE.length,
  ).fill(null);

  varispeedActive = false;
  rateSource: VarispeedRateSource | null = null;
  handingBack = false;
  handbackLeadFrames = 0;
  handbackImage: ReplayResult | null = null;
  gateOffOwed = false;
  gateOffAdvances = false;

  constructor(
    owner: object,
    parts: {
      readonly registers: RegisterFrameState;
      readonly loop: ActiveLoopTrackerState;
      readonly track: TrackStructureState;
      readonly shadow: ShadowPositionState;
      readonly varispeed: VarispeedState;
      readonly crossing: CrossingCapturesState;
    },
  ) {
    this.owner = owner;
    this.registers = parts.registers;
    this.loop = parts.loop;
    this.track = parts.track;
    this.shadow = parts.shadow;
    this.varispeed = parts.varispeed;
    this.crossing = parts.crossing;
  }
}

/** The opaque handle a host holds for `state`. The interface's brand is a unique symbol no class can
 *  declare, so this is the one place the layout is handed out under it. */
export function asSavedPlayerState(state: SavedState): SavedPlayerState {
  return state as unknown as SavedPlayerState;
}

/** The layout behind a handle a host passed back, or null for anything this module did not make. */
export function readSavedState(handle: SavedPlayerState): SavedState | null {
  return handle instanceof SavedState ? handle : null;
}
