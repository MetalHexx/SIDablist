import type { SidWriteSink } from '../cpu/c64-machine.js';
import { clamp } from '../common/math.js';
import { clockRatio } from './clock-ratio.js';
import type { SidFrame } from './sid-frame.js';
import {
  REGISTERS_PER_VOICE,
  SID_FILTER_MODE_BAND_PASS,
  SID_FILTER_MODE_HIGH_PASS,
  SID_FILTER_MODE_LOW_PASS,
  SID_FILTER_MODE_OFF,
  SID_REGISTER_COUNT,
  VOICE_ATTACK_DECAY_OFFSET,
  VOICE_CONTROL_REGISTERS,
  VOICE_COUNT,
  VOICE_FREQUENCY_HIGH_OFFSET,
  VOICE_FREQUENCY_LOW_OFFSET,
  VOICE_SUSTAIN_RELEASE_OFFSET,
} from './sid-constants.js';
import {
  SID_FIELD_TABLE,
  isUsableHold,
  isUsableOffset,
  readFieldEntry,
  resolveSidField,
  splitFieldEntry,
} from './sid-fields.js';
import type { SidChipFieldName, SidField, SidFieldEntry, SidVoiceFieldName } from './sid-fields.js';

/**
 * The accumulated register values alone, detached from any per-frame state.
 *
 * Deliberately not a `SidFrame`: that type is the writes leaving for a sink this frame, this one is
 * chip state — where every register stood at a moment, regardless of which of them were about to be
 * sent.
 */
export interface RegisterValuesSnapshot {
  readonly values: Uint8Array;
}

/** A voice's own registers, decoded — raw, not scaled: what the tune itself put there, the same
 *  bytes `emittedValues().written` carries for these registers. */
export interface VoiceRegisterState {
  readonly gate: boolean;
  readonly waveform: number;
  readonly frequency: number;
  readonly envelope: number;
}

/**
 * The register groups an application's control scales on the way out, by one multiplier each. A
 * group is a run of `SID_FIELD_TABLE` entries: the multiplier lives on each entry, and `pulseWidth`
 * sets all three voices' entries together. `volume` is the output-gain path this mechanism was
 * generalized from.
 *
 * Frequency is deliberately absent: it carries a multiplier per voice rather than one shared, so it
 * is driven by `setTargetClock` and `setVoicePitch` instead.
 */
export type ScaledRegisterGroup = 'volume' | 'cutoff' | 'resonance' | 'pulseWidth';

/** Bits 4-6 of `$D418`. `null` is not a mode — it means the tune's own bits pass through. */
export type SidFilterMode = 'lowPass' | 'bandPass' | 'highPass' | 'off';

/** `VOICE_CONTROL_REGISTERS` inverted: register -> its voice index, for the per-write hot path. It
 *  doubles as the retrigger test, because the registers a player writes twice to retrigger a note
 *  are exactly the voice control registers. */
const VOICE_INDEX_FOR_REGISTER = buildVoiceIndexTable();

function buildVoiceIndexTable(): ReadonlyMap<number, number> {
  const table = new Map<number, number>();
  VOICE_CONTROL_REGISTERS.forEach((register, voice) => table.set(register, voice));
  return table;
}

/** The `filterType` field's value for each mode — what `setFilterMode` holds it at. */
export const FILTER_MODE_BITS: Readonly<Record<SidFilterMode, number>> = {
  lowPass: SID_FILTER_MODE_LOW_PASS,
  bandPass: SID_FILTER_MODE_BAND_PASS,
  highPass: SID_FILTER_MODE_HIGH_PASS,
  off: SID_FILTER_MODE_OFF,
};

const FILTER_TYPE_FIELD: SidField = { name: 'filterType' };

function chipEntries(name: SidChipFieldName): readonly number[] {
  return [resolveSidField({ name })];
}

function voiceEntries(name: SidVoiceFieldName): readonly number[] {
  const entries: number[] = [];
  for (let voice = 0; voice < VOICE_COUNT; voice++) {
    entries.push(resolveSidField({ name, voice }));
  }
  return entries;
}

/** The table entries each scaled group multiplies, resolved once when the module loads. */
const ENTRIES_FOR_GROUP: Readonly<Record<ScaledRegisterGroup, readonly number[]>> = {
  volume: chipEntries('volume'),
  cutoff: chipEntries('cutoff'),
  resonance: chipEntries('resonance'),
  pulseWidth: voiceEntries('pulseWidth'),
};

/** Each voice's `frequency` entry, indexed by voice. */
const FREQUENCY_ENTRIES = voiceEntries('frequency');

/** Every register contributes at most one write to a frame, and the three voice control registers a
 *  second one for a retrigger — a third write to one of those replaces the retrigger in place. */
const MAX_FRAME_WRITES = SID_REGISTER_COUNT + VOICE_COUNT;

/** `writtenThisFrame` states. */
const WRITTEN = 1;
const RETRIGGERED = 2;

/** The frame under construction: a `SidFrame` whose count this class still moves. */
interface MutableSidFrame extends Omit<SidFrame, 'count'> {
  count: number;
}

/**
 * One multiplication and exactly one rounding, applied to a field at its true width and clamped to
 * its ceiling — scaling a multi-register field a byte at a time would round twice and could split
 * back inconsistently across the pair.
 */
function scaleField(value: number, coefficient: number, ceiling: number): number {
  return clamp(Math.round(value * coefficient), 0, ceiling);
}

/**
 * What a held numeric field sends this frame: `amount` of the way from the tune's own value to the
 * held one, rounded once at the field's full width — never byte by byte, which could split back
 * inconsistently across a register pair.
 */
function blendedValue(entry: SidFieldEntry, tune: number, held: number, amount: number): number {
  return clamp(Math.round(tune + amount * (held - tune)), 0, entry.ceiling);
}

/**
 * A register's final byte: `base` with every bit a mask covers replaced by the layer's own. Applied
 * twice on the way out — first the multiplier and offset layer, then the holds, which are the last
 * layer over whatever the tune or the output stage put there. Pure and shared by the frame path
 * (shadow and retrigger bytes alike) and `readRegisters`, so a stats read can never drift from what
 * a real frame would actually emit.
 */
function heldByte(base: number, holdMask: number, holdBits: number): number {
  return (base & ~holdMask) | holdBits;
}

/**
 * Accumulates one frame's SID writes and hands them out as a `SidFrame` — the registers the tune
 * wrote, carrying the bytes an application's multipliers, offsets and holds shaped them to, in the
 * order the tune wrote them.
 *
 * A second write in the same frame to register 4, 11 or 18 (the voice gate registers) is a
 * deliberate retrigger and survives as its own entry alongside the first. A second write to any
 * other register overwrites the first where it already stands and is counted as suppressed. Either
 * way the frame is never flushed early: one frame is one call of the tune's play routine.
 */
export interface RegisterFrame extends SidWriteSink {
  /** Voice 0/1/2. Muting forces that voice's control register to 0 once, then drops every further
   * write the tune's code makes to it until unmuted — every other register for that voice keeps
   * updating live throughout — the hardware-mute technique the TeensyROM firmware uses.
   *
   * The zeroing is not a write the tune made, so it lands with the forced registers rather than in
   * write order. */
  setVoiceMuted(voice: number, muted: boolean): void;

  /**
   * Multiplies a register group by `coefficient`, full resolution, applied in `takeSnapshot()` and
   * never at the write — scaling on the way out rather than in `onSidWrite` is what keeps
   * `snapshotValues()`/`restoreValues()` raw (so a cue re-entered at a different multiplier never
   * double-applies it), keeps quantization to a single rounding per field, and keeps this stage out
   * of `suppressedWrites` entirely, since none of these registers routes through a scaling branch
   * in the write path.
   *
   * A coefficient of exactly 1 is home, not a multiplication by one: the group's raw bytes pass
   * through untouched. `pulseWidth` holds one coefficient shared by all three voices, so scaling it
   * preserves the tune's internal balance between them. The multiplier applies before any offset
   * (`setFieldOffset`) and before any hold.
   *
   * A no-op call (the coefficient already held) leaves the one-shot restore untouched, so repeatedly
   * setting the same value can never manufacture a spurious extra write.
   */
  setRegisterScale(group: ScaledRegisterGroup, coefficient: number): void;

  /**
   * The pitch correction for a tune written for a machine clocked at `sourceHz` and played on one
   * clocked at `targetHz` — the frequency registers alone, since the filter is analog, duty cycle is
   * a fraction of the accumulator period and an envelope rate is a lookup index.
   *
   * The machine clock, not the chip model — 6581 versus 8580 is a separate value the sink forwards
   * in its own packet.
   *
   * Tempo is not in this equation. The oscillator is a free-running phase accumulator inside the
   * chip, so how often the play routine runs moves the tune's sequencer and nothing else; that half
   * belongs to the play rate.
   *
   * A pair that is not two usable clock frequencies is ignored rather than allowed to become a
   * coefficient.
   */
  setTargetClock(sourceHz: number, targetHz: number): void;

  /**
   * Voice 0/1/2's own pitch coefficient, which multiplies the clock correction rather than replacing
   * it: the two compose, and neither can move the other. Ganging voices together is the
   * application's decision — this accepts three independent values.
   *
   * A non-finite coefficient is ignored: it would scale every frequency to silence while never
   * comparing equal to itself, so nothing could ever set it back.
   */
  setVoicePitch(voice: number, coefficient: number): void;

  /**
   * Holds `field` at `value` instead of whatever the tune puts there, `amount` of the way (0…1, 1 if
   * omitted): a numeric field sends `amount` of the way from the tune's own value to `value`, rounded
   * once at the field's full width, so it keeps following the tune while held; a switch sends
   * `value` only at exactly 1 and the tune's own below it.
   *
   * A hold is the last layer on the way out. Its bits replace whatever the tune, a multiplier or an
   * offset put there, and every other bit of the same register keeps its own source — so
   * `filterType` sits beside a gain-scaled volume nibble and `resonance` beside the tune's routing.
   * A numeric hold blends from the tune's own value, never from the multiplied or offset one. It is
   * never written into the shadow: `snapshotValues()`, `voiceState()` and `emittedValues().written`
   * stay the tune's own, a cue restore leaves current holds in place, and holds are not part of a
   * cue.
   *
   * While held, every register the field touches goes out on every frame — a standing condition
   * re-checked in `takeSnapshot()`, like an off-home field — so a tune that never writes that
   * register still carries the held value, and a changed value or amount reaches the very next
   * frame. When a tune writes a voice control register twice in a frame, the hold applies to both
   * bytes. Holds on a muted voice's control-register fields (`waveform`, `test`, `ringMod`, `sync`,
   * `gate`) wait until it is unmuted, so the mute's 0 stands.
   *
   * An unknown field, a voice that is not an integer 0…2, a value that is not an integer within the
   * field's width, or an amount that is not finite within 0…1 is ignored and leaves any hold already
   * in place alone. Holding the value and amount already held changes nothing.
   */
  holdField(field: SidField, value: number, amount?: number): void;

  /**
   * Hands `field` back to the tune. The field's registers are forced out once on the next frame,
   * carrying the byte composed from the tune's own bits, any multiplier, offset and any other hold
   * — the restoring write the standing condition can no longer produce. Releasing a field that is
   * not held arms nothing.
   */
  releaseField(field: SidField): void;

  /**
   * Adds `amount` — a signed integer in the field's own units — to the tune's live value of a
   * numeric field on the way out, after any multiplier and clamped to 0…ceiling, where the ceiling
   * is `2^width − 1`. Because it adds to the tune's live value it keeps following the tune, and a
   * frequency offset recombines both register bytes, so it can carry across the high byte.
   *
   * An offset is a standing condition like a hold: while one is in place every register the field
   * touches goes out on every frame, so a tune that never writes those registers still carries it
   * and a changed amount reaches the very next frame. A hold, when present, is the last layer and
   * wins over it. It is never written into the shadow: `snapshotValues()`, `voiceState()` and
   * `emittedValues().written` stay the tune's own, a cue restore applies the current offset once
   * rather than twice, and offsets are not part of a cue.
   *
   * An amount of exactly 0 is home, the same as `clearFieldOffset`. An unknown field, a voice that
   * is not an integer 0…2, a switch field, a non-integer amount or one whose magnitude exceeds the
   * ceiling is ignored and leaves any offset already in place alone. Setting the amount already set
   * changes nothing.
   */
  setFieldOffset(field: SidField, amount: number): void;

  /** Hands the field's value back to the multiplier and the tune; one restoring write follows. */
  clearFieldOffset(field: SidField): void;

  /**
   * Holds `$D418`'s filter-mode bits at `mode` until `null`: a hold of `filterType`, so the tune's
   * own mode bits are discarded while one is held and `null` hands them back. The volume register
   * goes out every frame meanwhile, with gain still applied to its low nibble; clearing sends one
   * restoring write.
   */
  setFilterMode(mode: SidFilterMode | null): void;

  /** 0…1, full resolution — the output-gain entry point onto `$D418`'s low nibble, the same as
   *  `setRegisterScale('volume', gain)`. */
  setOutputGain(gain: number): void;

  /**
   * Forces every one of the 25 registers into the next frame at its current value (0 if never
   * written) — called once after init so the chip starts a session from a known state instead of
   * carrying over silence.
   *
   * A resync frame is not a fixed layout: the tune's own writes still come first and the forced ones
   * fill in around them, so a caller reaching for a particular register must find it by register
   * number rather than by position.
   */
  markAllDirty(): void;

  /**
   * Second writes folded into a register's existing entry instead of becoming a retrigger, counted
   * across this object's lifetime rather than per frame — the data point for how often it matters
   * in practice.
   */
  readonly suppressedWriteCount: number;

  /**
   * Fills the reused `SidFrame` with this frame's writes and clears the per-frame state — including
   * the second-write tracking — so the next frame starts empty.
   *
   * The order is: what the tune wrote, as it wrote it; then whatever a resync, an off-home field, a
   * held field or a mute forces out, ascending by register and only for registers the tune left
   * alone. An override or a hold replaces the byte of the write it applies to and never adds one.
   *
   * Forcing an off-home or held field out is a standing condition re-checked live on every call, so
   * a frame a caller discards can never swallow a change of multiplier, offset or hold on a tune
   * that does not keep rewriting those registers itself. Composed values are computed once per
   * frame, before the fill, because a two-register field read per write would combine and round
   * twice.
   */
  takeSnapshot(): SidFrame;

  /**
   * Copies the accumulated register values, leaving this frame untouched.
   *
   * Per-frame state is excluded on purpose — a cue records where the chip stood, not which registers
   * happened to be mid-flight when it was captured.
   */
  snapshotValues(): RegisterValuesSnapshot;

  /**
   * Replaces the accumulated register values wholesale and drops any half-built frame.
   *
   * Mute is not part of the snapshot: whichever voices are muted *now* stay muted, so returning to a
   * cue captured before a mute does not un-mute it on the way back in.
   */
  restoreValues(snapshot: RegisterValuesSnapshot): void;

  /**
   * Voice `voice`'s gate, waveform, frequency and envelope, decoded from the shadow on every call —
   * the same decode teensyrom-web's `frame-features.ts` runs offline against a recorded scan, run
   * here against the live register values instead so a visualiser can read it every animation frame
   * without waiting on a capture. Raw, like the shadow itself: a pitch correction, a scale or an
   * offset shows up in `readRegisters`/`emittedValues()`, not here.
   */
  voiceState(voice: number): VoiceRegisterState;

  /**
   * The 25 registers as the tune wrote them (`written`) and as multipliers, offsets and holds would
   * emit them if a frame went out this instant (`sent`) — computed fresh from the shadow, the live
   * multipliers, offsets and the held fields on every call rather than read off the last real
   * frame: `takeSnapshot()` only ever carries the registers that frame actually wrote, and discards
   * its own override scratch the moment it returns, so there is nothing per-frame left lying around
   * for a pull to reuse. A pull never consumes a pending restore.
   *
   * Allocates its two arrays on every call, so it is for diagnostics; a reader that polls reaches
   * for `readRegisters`.
   */
  emittedValues(): { readonly written: Uint8Array; readonly sent: Uint8Array };

  /** Copies the 25 registers as the tune wrote them into `written`, and as multiply, offset and
   *  hold would send them this instant into `sent` — both caller-owned, at least
   *  SID_REGISTER_COUNT long. Allocates nothing; arms and consumes no one-shot write. */
  readRegisters(written: Uint8Array, sent: Uint8Array): void;
}

/** Builds a fresh `RegisterFrame`, its multipliers, offsets and mutes all at home. */
export function createRegisterFrame(): RegisterFrame {
  return new RegisterFrameImpl();
}

class RegisterFrameImpl implements RegisterFrame {
  private readonly values = new Uint8Array(SID_REGISTER_COUNT);
  private readonly writtenThisFrame = new Uint8Array(SID_REGISTER_COUNT);
  /** The retrigger write to a voice control register, held apart from the shadow so both bytes of a
   *  double-write survive the frame. */
  private readonly retriggerValues = new Uint8Array(SID_REGISTER_COUNT);
  /** The registers the tune wrote this frame, in the order it wrote them. */
  private readonly writeOrder = new Uint8Array(MAX_FRAME_WRITES);
  /** Whether `writeOrder[i]` reads its byte from `retriggerValues` rather than the shadow. */
  private readonly writeIsRetrigger = new Uint8Array(MAX_FRAME_WRITES);
  private writeCount = 0;
  /** Registers something other than the tune puts into this frame — a resync, an off-home field, a
   *  mute engaging. They follow the tune's own writes, ascending. */
  private readonly forcedRegisters = new Uint8Array(SID_REGISTER_COUNT);
  private suppressedWrites = 0;
  private readonly mutedVoices = new Set<number>(); // voice index 0..2

  /** The output stage, one slot per `SID_FIELD_TABLE` entry and sized once so nothing on the frame
   *  path allocates. An entry is off home while its multiplier is not exactly 1 or its offset is
   *  not exactly 0; home leaves the tune's own bits untouched. */
  private readonly fieldMultiplier = new Float64Array(SID_FIELD_TABLE.length).fill(1);
  private readonly fieldOffset = new Int32Array(SID_FIELD_TABLE.length);
  /** One-shot per entry: the standing off-home check stops covering an entry's registers the
   *  instant it returns home, so this forces one more write on that transition — the restoring
   *  write the standing condition can no longer produce. Without it the last composed value stands
   *  on the chip forever on a tune that never rewrites those registers. */
  private readonly restoreOnNextSnapshot = new Uint8Array(SID_FIELD_TABLE.length);

  /** The clock correction: derived, session-lifetime and invisible to the performer. Held apart from
   *  `voicePitch` so moving a pitch control can never disturb it, and so an interface can report how
   *  much correction is in force whatever a pitch control is doing. */
  private clockRatio = 1;
  /** The live, user-driven half of the frequency multiplier — one per voice. Any ganging is the
   *  application's; this accepts three independent values. */
  private readonly voicePitch = new Float64Array(VOICE_COUNT).fill(1);

  /** Hold state, one slot per `SID_FIELD_TABLE` entry and sized once so a hold never allocates. */
  private readonly held = new Uint8Array(SID_FIELD_TABLE.length);
  private readonly heldValue = new Uint16Array(SID_FIELD_TABLE.length);
  private readonly heldAmount = new Float64Array(SID_FIELD_TABLE.length);
  /** One-shot per field, `restoreOnNextSnapshot`'s counterpart: the standing check stops covering a
   *  field's registers the instant it is released, so this forces the one restoring write. */
  private readonly releaseOnNextSnapshot = new Uint8Array(SID_FIELD_TABLE.length);

  /** Per-frame scratch, cleared and refilled in `takeSnapshot()` and `readRegisters()` — the output
   *  stage runs inside frame delivery, so nothing on this path may allocate. Per register, the bits
   *  some multiplied or offset field covers and what it sends for them. */
  private readonly overrideMask = new Uint8Array(SID_REGISTER_COUNT);
  private readonly overrideBits = new Uint8Array(SID_REGISTER_COUNT);
  /** Per register, the bits some hold covers and what it sends for them. */
  private readonly holdMask = new Uint8Array(SID_REGISTER_COUNT);
  private readonly holdBits = new Uint8Array(SID_REGISTER_COUNT);

  /** Refilled and handed back by every `takeSnapshot()`, so rendering a frame allocates nothing. */
  private readonly frame: MutableSidFrame = {
    count: 0,
    registers: new Uint8Array(MAX_FRAME_WRITES),
    values: new Uint8Array(MAX_FRAME_WRITES),
    offsetsUs: new Int32Array(MAX_FRAME_WRITES),
  };

  setVoiceMuted(voice: number, muted: boolean): void {
    if (voice < 0 || voice >= VOICE_CONTROL_REGISTERS.length) return;
    if (muted === this.mutedVoices.has(voice)) return;
    if (muted) {
      this.mutedVoices.add(voice);
      const register = VOICE_CONTROL_REGISTERS[voice];
      this.values[register] = 0;
      this.forcedRegisters[register] = 1;
    } else {
      this.mutedVoices.delete(voice);
    }
  }

  setRegisterScale(group: ScaledRegisterGroup, coefficient: number): void {
    for (const index of ENTRIES_FOR_GROUP[group]) {
      this.setFieldMultiplier(index, coefficient);
    }
  }

  setTargetClock(sourceHz: number, targetHz: number): void {
    const ratio = clockRatio(sourceHz, targetHz);
    if (ratio === null || ratio === this.clockRatio) return;
    this.clockRatio = ratio;
    for (let voice = 0; voice < VOICE_COUNT; voice++) {
      this.applyFrequencyMultiplier(voice);
    }
  }

  setVoicePitch(voice: number, coefficient: number): void {
    if (!Number.isInteger(voice) || voice < 0 || voice >= VOICE_COUNT) return;
    if (!Number.isFinite(coefficient) || coefficient === this.voicePitch[voice]) return;
    this.voicePitch[voice] = coefficient;
    this.applyFrequencyMultiplier(voice);
  }

  /** A voice's `frequency` entry multiplies by the two halves composed — exactly 1 is home, as it
   *  is for any other entry. */
  private applyFrequencyMultiplier(voice: number): void {
    this.setFieldMultiplier(FREQUENCY_ENTRIES[voice], this.clockRatio * this.voicePitch[voice]);
  }

  private setFieldMultiplier(index: number, multiplier: number): void {
    this.setFieldOutput(index, multiplier, this.fieldOffset[index]);
  }

  /** Moves an entry's multiplier and offset together, arming the one-shot restore only when that
   *  brings it home from off home — a move between two off-home states, or none at all, arms
   *  nothing, so repeating a call can never manufacture an extra write. */
  private setFieldOutput(index: number, multiplier: number, offset: number): void {
    const wasOffHome = this.fieldMultiplier[index] !== 1 || this.fieldOffset[index] !== 0;
    const isOffHome = multiplier !== 1 || offset !== 0;
    if (wasOffHome && !isOffHome) {
      this.restoreOnNextSnapshot[index] = 1;
    }
    this.fieldMultiplier[index] = multiplier;
    this.fieldOffset[index] = offset;
  }

  holdField(field: SidField, value: number, amount = 1): void {
    const index = resolveSidField(field);
    if (index < 0 || !isUsableHold(index, value, amount)) return;
    if (this.held[index] && this.heldValue[index] === value && this.heldAmount[index] === amount) {
      return;
    }
    this.held[index] = 1;
    this.heldValue[index] = value;
    this.heldAmount[index] = amount;
  }

  releaseField(field: SidField): void {
    const index = resolveSidField(field);
    if (index < 0 || !this.held[index]) return;
    this.held[index] = 0;
    this.releaseOnNextSnapshot[index] = 1;
  }

  setFieldOffset(field: SidField, amount: number): void {
    const index = resolveSidField(field);
    if (index < 0 || !isUsableOffset(index, amount)) return;
    this.setFieldOutput(index, this.fieldMultiplier[index], amount);
  }

  clearFieldOffset(field: SidField): void {
    const index = resolveSidField(field);
    if (index < 0) return;
    this.setFieldOutput(index, this.fieldMultiplier[index], 0);
  }

  setFilterMode(mode: SidFilterMode | null): void {
    if (mode === null) {
      this.releaseField(FILTER_TYPE_FIELD);
    } else {
      this.holdField(FILTER_TYPE_FIELD, FILTER_MODE_BITS[mode]);
    }
  }

  setOutputGain(gain: number): void {
    this.setRegisterScale('volume', gain);
  }

  onSidWrite(register: number, value: number): void {
    const voiceIndex = VOICE_INDEX_FOR_REGISTER.get(register);
    if (voiceIndex !== undefined && this.mutedVoices.has(voiceIndex)) {
      return; // muted — matches the firmware's discard-register redirect
    }

    const state = this.writtenThisFrame[register];
    if (state === 0) {
      this.writtenThisFrame[register] = WRITTEN;
      this.values[register] = value;
      this.recordWrite(register, false);
      return;
    }

    if (voiceIndex !== undefined) {
      this.retriggerValues[register] = value;
      if (state === WRITTEN) {
        this.writtenThisFrame[register] = RETRIGGERED;
        this.recordWrite(register, true);
      }
      return;
    }

    this.values[register] = value;
    this.suppressedWrites++;
  }

  private recordWrite(register: number, retrigger: boolean): void {
    this.writeOrder[this.writeCount] = register;
    this.writeIsRetrigger[this.writeCount] = retrigger ? 1 : 0;
    this.writeCount++;
  }

  markAllDirty(): void {
    this.forcedRegisters.fill(1);
  }

  get suppressedWriteCount(): number {
    return this.suppressedWrites;
  }

  // No closures, arrays, objects or iterator-producing helpers on this path: it runs fifty times a
  // second and everything it touches is a preallocated typed array.
  takeSnapshot(): SidFrame {
    this.forceOffHomeFields();
    this.forceHeldFields();
    this.buildFieldComposition();
    this.buildHoldComposition();

    const frame = this.frame;
    let count = 0;

    for (let index = 0; index < this.writeCount; index++) {
      const register = this.writeOrder[index];
      frame.registers[count] = register;
      frame.values[count] = this.writeIsRetrigger[index]
        ? heldByte(this.retriggerValues[register], this.holdMask[register], this.holdBits[register])
        : this.emittedValue(register);
      count++;
    }

    for (let register = 0; register < SID_REGISTER_COUNT; register++) {
      if (!this.forcedRegisters[register] || this.writtenThisFrame[register]) continue;
      frame.registers[count] = register;
      frame.values[count] = this.emittedValue(register);
      count++;
    }

    frame.count = count;

    this.writeCount = 0;
    this.writtenThisFrame.fill(0);
    this.forcedRegisters.fill(0);

    return frame;
  }

  /** The shadow byte with the multiplier and offset layer over it, then holds over both. */
  private emittedValue(register: number): number {
    const composed = heldByte(
      this.values[register],
      this.overrideMask[register],
      this.overrideBits[register],
    );
    return heldByte(composed, this.holdMask[register], this.holdBits[register]);
  }

  /** A muted voice's control register belongs to the mute, so holds on its fields wait. */
  private isInert(entry: SidFieldEntry): boolean {
    return entry.voiceControl && this.mutedVoices.has(entry.voice);
  }

  /** Self-emission for the output stage: every register of every off-home entry, and one further
   *  frame for whichever has just come home. A numeric entry never touches a voice control
   *  register, so a mute has no say here. */
  private forceOffHomeFields(): void {
    for (let index = 0; index < SID_FIELD_TABLE.length; index++) {
      const offHome = this.fieldMultiplier[index] !== 1 || this.fieldOffset[index] !== 0;
      if (!offHome && !this.restoreOnNextSnapshot[index]) continue;
      this.restoreOnNextSnapshot[index] = 0;

      for (const part of SID_FIELD_TABLE[index].segments) {
        this.forcedRegisters[part.register] = 1;
      }
    }
  }

  /** Self-emission for holds: every register of every held field, and one further frame for
   *  whichever field has just been released. */
  private forceHeldFields(): void {
    for (let index = 0; index < SID_FIELD_TABLE.length; index++) {
      if (!this.held[index] && !this.releaseOnNextSnapshot[index]) continue;
      this.releaseOnNextSnapshot[index] = 0;

      const entry = SID_FIELD_TABLE[index];
      if (this.isInert(entry)) continue;
      for (const part of entry.segments) {
        this.forcedRegisters[part.register] = 1;
      }
    }
  }

  /**
   * Rebuilds, from the shadow and the multipliers and offsets alone, which bits each register's
   * off-home fields cover and what they send for them. Each field is read from the shadow at its
   * full width, multiplied with one rounding, offset, clamped to 0…ceiling at each step, and split
   * back across its registers — so a frequency recombines both bytes and a field sharing a register
   * with another leaves the other's bits, and any unused ones, to the tune. It reads state and arms
   * and consumes nothing, which is what lets `readRegisters` share it without disturbing the next
   * real frame.
   */
  private buildFieldComposition(): void {
    this.overrideMask.fill(0);
    this.overrideBits.fill(0);

    for (let index = 0; index < SID_FIELD_TABLE.length; index++) {
      const multiplier = this.fieldMultiplier[index];
      const offset = this.fieldOffset[index];
      if (multiplier === 1 && offset === 0) continue;

      const entry = SID_FIELD_TABLE[index];
      let value = readFieldEntry(this.values, entry);
      if (multiplier !== 1) value = scaleField(value, multiplier, entry.ceiling);
      if (offset !== 0) value = clamp(value + offset, 0, entry.ceiling);
      splitFieldEntry(entry, value, this.overrideMask, this.overrideBits);
    }
  }

  /**
   * Rebuilds, from the shadow and the held fields alone, which bits each register's holds cover and
   * what they send for them. It reads state and arms and consumes nothing, which is what lets
   * `readRegisters` share it without disturbing the next real frame.
   *
   * A switch held below an amount of 1 covers no bits at all: the tune's own bit goes out, and on a
   * retrigger that means each of the two bytes' own bit rather than the shadow's copy of the first.
   * A numeric hold blends from the tune's own value in the shadow, never from the multiplied or
   * offset one.
   */
  private buildHoldComposition(): void {
    this.holdMask.fill(0);
    this.holdBits.fill(0);

    for (let index = 0; index < SID_FIELD_TABLE.length; index++) {
      if (!this.held[index]) continue;
      const entry = SID_FIELD_TABLE[index];
      const amount = this.heldAmount[index];
      if (this.isInert(entry) || (!entry.numeric && amount !== 1)) continue;

      const sent = entry.numeric
        ? blendedValue(entry, readFieldEntry(this.values, entry), this.heldValue[index], amount)
        : this.heldValue[index];
      splitFieldEntry(entry, sent, this.holdMask, this.holdBits);
    }
  }

  snapshotValues(): RegisterValuesSnapshot {
    return { values: this.values.slice() };
  }

  restoreValues(snapshot: RegisterValuesSnapshot): void {
    this.values.set(snapshot.values);
    this.writtenThisFrame.fill(0);
    this.forcedRegisters.fill(0);
    this.writeCount = 0;
    for (const voice of this.mutedVoices) {
      this.values[VOICE_CONTROL_REGISTERS[voice]] = 0;
    }
  }

  voiceState(voice: number): VoiceRegisterState {
    const base = voice * REGISTERS_PER_VOICE;
    const control = this.values[VOICE_CONTROL_REGISTERS[voice]];
    return {
      gate: (control & 0x01) !== 0,
      waveform: (control >> 4) & 0x0f,
      frequency:
        (this.values[base + VOICE_FREQUENCY_HIGH_OFFSET] << 8) |
        this.values[base + VOICE_FREQUENCY_LOW_OFFSET],
      envelope:
        (this.values[base + VOICE_ATTACK_DECAY_OFFSET] << 8) |
        this.values[base + VOICE_SUSTAIN_RELEASE_OFFSET],
    };
  }

  emittedValues(): { readonly written: Uint8Array; readonly sent: Uint8Array } {
    const written = new Uint8Array(SID_REGISTER_COUNT);
    const sent = new Uint8Array(SID_REGISTER_COUNT);
    this.readRegisters(written, sent);
    return { written, sent };
  }

  // An index loop rather than `set`/`slice`/`subarray`, which would allocate; the scratch buffers
  // are safe to rebuild because `takeSnapshot()` rebuilds them first thing and nothing yields
  // between the two.
  readRegisters(written: Uint8Array, sent: Uint8Array): void {
    this.buildFieldComposition();
    this.buildHoldComposition();
    for (let register = 0; register < SID_REGISTER_COUNT; register++) {
      written[register] = this.values[register];
      sent[register] = this.emittedValue(register);
    }
  }
}
