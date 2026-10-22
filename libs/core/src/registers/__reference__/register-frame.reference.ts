/**
 * A frozen copy of the pre-field-table output stage, used only by the equivalence spec and never
 * exported. It is retired together with that spec when a deliberate change to how scaling composes
 * makes it obsolete.
 */
import type { SidWriteSink } from '../../cpu/c64-machine.js';
import { clamp } from '../../common/math.js';
import { clockRatio } from '../clock-ratio.js';
import type { SidFrame } from '../sid-frame.js';
import {
  REGISTERS_PER_VOICE,
  SID_FILTER_CUTOFF_HIGH_REGISTER,
  SID_FILTER_CUTOFF_LOW_REGISTER,
  SID_FILTER_MODE_BAND_PASS,
  SID_FILTER_MODE_HIGH_PASS,
  SID_FILTER_MODE_LOW_PASS,
  SID_FILTER_MODE_OFF,
  SID_FILTER_RESONANCE_REGISTER,
  SID_REGISTER_COUNT,
  SID_VOLUME_REGISTER,
  VOICE_ATTACK_DECAY_OFFSET,
  VOICE_CONTROL_REGISTERS,
  VOICE_COUNT,
  VOICE_FREQUENCY_HIGH_OFFSET,
  VOICE_FREQUENCY_LOW_OFFSET,
  VOICE_PULSE_WIDTH_HIGH_OFFSET,
  VOICE_PULSE_WIDTH_LOW_OFFSET,
  VOICE_SUSTAIN_RELEASE_OFFSET,
} from '../sid-constants.js';
import {
  SID_FIELD_TABLE,
  isUsableHold,
  readFieldEntry,
  resolveSidField,
  splitFieldEntry,
} from '../sid-fields.js';
import type { SidField, SidFieldEntry } from '../sid-fields.js';

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
 * The register groups an application's controls scale on the way out, by one coefficient each.
 * `volume` is the output-gain path this mechanism was generalized from.
 *
 * Frequency is deliberately absent: it carries a coefficient per voice rather than one shared, so
 * it is driven by `setTargetClock` and `setVoicePitch` instead.
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

const SCALED_REGISTER_GROUPS: readonly ScaledRegisterGroup[] = [
  'volume',
  'cutoff',
  'resonance',
  'pulseWidth',
];

/** The `filterType` field's value for each mode — what `setFilterMode` holds it at. */
export const FILTER_MODE_BITS: Readonly<Record<SidFilterMode, number>> = {
  lowPass: SID_FILTER_MODE_LOW_PASS,
  bandPass: SID_FILTER_MODE_BAND_PASS,
  highPass: SID_FILTER_MODE_HIGH_PASS,
  off: SID_FILTER_MODE_OFF,
};

const FILTER_TYPE_FIELD: SidField = { name: 'filterType' };

const NIBBLE_CEILING = 0x0f;
const CUTOFF_CEILING = 0x07ff;
const PULSE_WIDTH_CEILING = 0x0fff;
const FREQUENCY_CEILING = 0xffff;

/** Every register a group owns, so a group off its home coefficient can force all of them out. */
const REGISTERS_FOR_GROUP: Readonly<Record<ScaledRegisterGroup, readonly number[]>> = {
  volume: [SID_VOLUME_REGISTER],
  cutoff: [SID_FILTER_CUTOFF_LOW_REGISTER, SID_FILTER_CUTOFF_HIGH_REGISTER],
  resonance: [SID_FILTER_RESONANCE_REGISTER],
  pulseWidth: voiceRegisters(VOICE_PULSE_WIDTH_LOW_OFFSET, VOICE_PULSE_WIDTH_HIGH_OFFSET),
};

function voiceRegisters(lowOffset: number, highOffset: number): readonly number[] {
  const registers: number[] = [];
  for (let voice = 0; voice < VOICE_COUNT; voice++) {
    const base = voice * REGISTERS_PER_VOICE;
    registers.push(base + lowOffset, base + highOffset);
  }
  return registers;
}

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
 * `$D418`'s scaled byte: gain owns the low nibble, and the mode bits and bit 7 (voice-3 mute) belong
 * to the tune and pass through raw — a held `filterType` replaces the mode bits afterwards, in
 * `heldByte`. Pure and shared by the per-frame override path and `emittedValues()`'s read-only one,
 * so a stats read can never drift from what a real frame would actually emit.
 */
function scaledVolumeByte(raw: number, gain: number): number {
  const volume = gain === 1 ? raw & 0x0f : scaleField(raw & 0x0f, gain, NIBBLE_CEILING);
  return (raw & 0xf0) | volume;
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
 * A register's final byte: `base` with every bit a hold covers replaced by the hold's own. Holds are
 * the last layer, over whatever scaling or the tune put there. Pure and shared by the frame path
 * (shadow, scaled and retrigger bytes alike) and `emittedValues()`, for the same reason
 * `scaledVolumeByte` is.
 */
function heldByte(base: number, holdMask: number, holdBits: number): number {
  return (base & ~holdMask) | holdBits;
}

/** 11 bits across the cutoff register pair, packed as low byte | (high byte << 8) so a caller can
 *  split the pair back out without this allocating one. */
function scaledCutoffPacked(rawLow: number, rawHigh: number, coefficient: number): number {
  const scaled = scaleField((rawHigh << 3) | (rawLow & 0x07), coefficient, CUTOFF_CEILING);
  const low = (rawLow & 0xf8) | (scaled & 0x07);
  const high = (scaled >> 3) & 0xff;
  return low | (high << 8);
}

/** Register 23's high nibble only — the low nibble routes voices through the filter and is the
 *  tune's alone. */
function scaledResonanceByte(raw: number, coefficient: number): number {
  const scaled = scaleField((raw >> 4) & 0x0f, coefficient, NIBBLE_CEILING);
  return (raw & 0x0f) | (scaled << 4);
}

/** 12 bits across a voice's pulse-width pair, packed the same way `scaledCutoffPacked` is. */
function scaledPulseWidthPacked(rawLow: number, rawHigh: number, coefficient: number): number {
  const scaled = scaleField(((rawHigh & 0x0f) << 8) | rawLow, coefficient, PULSE_WIDTH_CEILING);
  const low = scaled & 0xff;
  const high = (rawHigh & 0xf0) | ((scaled >> 8) & 0x0f);
  return low | (high << 8);
}

/** A full 16 bits across a voice's frequency pair, packed the same way. */
function scaledFrequencyPacked(rawLow: number, rawHigh: number, coefficient: number): number {
  const scaled = scaleField((rawHigh << 8) | rawLow, coefficient, FREQUENCY_CEILING);
  return (scaled & 0xff) | (((scaled >> 8) & 0xff) << 8);
}

/**
 * Accumulates one frame's SID writes and hands them out as a `SidFrame` — the registers the tune
 * wrote, carrying the bytes an application's controls scaled them to, in the order the tune wrote them.
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
   * double-applies a coefficient), keeps quantization to a single rounding per field, and keeps this
   * stage out of `suppressedWrites` entirely, since none of these registers routes through a scaling
   * branch in the write path.
   *
   * A coefficient of exactly 1 is home, not a multiplication by one: the group's raw bytes pass
   * through untouched. `pulseWidth` holds one coefficient shared by all three voices, so scaling it
   * preserves the tune's internal balance between them.
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
   * A hold is the last layer on the way out. Its bits replace whatever the tune or a scale put
   * there, and every other bit of the same register keeps its own source — so `filterType` sits
   * beside a gain-scaled volume nibble and `resonance` beside the tune's routing. It is never
   * written into the shadow: `snapshotValues()`, `voiceState()` and `emittedValues().written` stay
   * the tune's own, a cue restore leaves current holds in place, and holds are not part of a cue.
   *
   * While held, every register the field touches goes out on every frame — a standing condition
   * re-checked in `takeSnapshot()`, like an off-home group — so a tune that never writes that
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
   * carrying the byte composed from the tune's own bits, any scale and any other hold — the
   * restoring write the standing condition can no longer produce. Releasing a field that is not
   * held arms nothing.
   */
  releaseField(field: SidField): void;

  /**
   * Holds `$D418`'s filter-mode bits at `mode` until `null`: a hold of `filterType`, so the tune's
   * own mode bits are discarded while one is held and `null` hands them back. The volume register
   * goes out every frame meanwhile, with gain still applied to its low nibble; clearing sends one
   * restoring write.
   */
  setFilterMode(mode: SidFilterMode | null): void;

  /** 0…1, full resolution — the output-gain entry point onto `$D418`'s low nibble, and one group of
   *  the same scaling stage as every other control. */
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
   * The order is: what the tune wrote, as it wrote it; then whatever a resync, an off-home
   * coefficient, a held field or a mute forces out, ascending by register and only for registers
   * the tune left alone. An override or a hold replaces the byte of the write it applies to and
   * never adds one.
   *
   * Forcing a group or a held field out is a standing condition re-checked live on every call, so a
   * frame a caller discards can never swallow a control move on a tune that does not keep rewriting
   * those registers itself. Scaled bytes are computed once per frame, before the fill, because a
   * two-register group read per write would combine and round twice.
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
   * without waiting on a capture. Raw, like the shadow itself: a pitch correction or a scale
   * shows up in `emittedValues()`, not here.
   */
  voiceState(voice: number): VoiceRegisterState;

  /**
   * The 25 registers as the tune wrote them (`written`) and as scaling and holds would emit them if
   * a frame went out this instant (`sent`) — computed fresh from the shadow, the live coefficients
   * and the held fields on every call rather than read off the last real frame: `takeSnapshot()`
   * only ever carries the registers that frame actually wrote, and discards its own override scratch
   * the moment it returns, so there is nothing per-frame left lying around for a pull to reuse. A
   * pull never consumes a pending restore.
   */
  emittedValues(): { readonly written: Uint8Array; readonly sent: Uint8Array };
}

/** Builds a fresh `RegisterFrame`, its coefficients and mutes all at home. */
export function createReferenceRegisterFrame(): RegisterFrame {
  return new ReferenceRegisterFrameImpl();
}

class ReferenceRegisterFrameImpl implements RegisterFrame {
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
  /** Registers something other than the tune puts into this frame — a resync, an off-home
   *  coefficient, a mute engaging. They follow the tune's own writes, ascending. */
  private readonly forcedRegisters = new Uint8Array(SID_REGISTER_COUNT);
  private suppressedWrites = 0;
  private readonly mutedVoices = new Set<number>(); // voice index 0..2

  /** Home is exactly 1 for every group: the tune's own bytes pass through bit-for-bit. */
  private readonly coefficients: Record<ScaledRegisterGroup, number> = {
    volume: 1,
    cutoff: 1,
    resonance: 1,
    pulseWidth: 1,
  };
  /** One-shot per group: the standing off-home check stops covering a group's registers the instant
   *  its coefficient returns to exactly 1, so this is what forces one more write on that
   *  transition — the restoring write the standing condition can no longer produce. Without it the
   *  last scaled value stands on the chip forever on a tune that never rewrites those registers. */
  private readonly restoreOnNextSnapshot: Record<ScaledRegisterGroup, boolean> = {
    volume: false,
    cutoff: false,
    resonance: false,
    pulseWidth: false,
  };

  /** The clock correction: derived, session-lifetime and invisible to the performer. Held apart from
   *  `voicePitch` so moving a pitch control can never disturb it, and so an interface can report how
   *  much correction is in force whatever a fader is doing. */
  private clockRatio = 1;
  /** The live, user-driven half of the frequency coefficient — one per voice. Any ganging is the
   *  application's; this accepts three independent values. */
  private readonly voicePitch = new Float64Array(VOICE_COUNT).fill(1);
  /** `restoreOnNextSnapshot`, per voice, for the frequency pair. */
  private readonly restoreFrequencyOnNextSnapshot = new Uint8Array(VOICE_COUNT);

  /** Hold state, one slot per `SID_FIELD_TABLE` entry and sized once so a hold never allocates. */
  private readonly held = new Uint8Array(SID_FIELD_TABLE.length);
  private readonly heldValue = new Uint16Array(SID_FIELD_TABLE.length);
  private readonly heldAmount = new Float64Array(SID_FIELD_TABLE.length);
  /** One-shot per field, `restoreOnNextSnapshot`'s counterpart: the standing check stops covering a
   *  field's registers the instant it is released, so this forces the one restoring write. */
  private readonly releaseOnNextSnapshot = new Uint8Array(SID_FIELD_TABLE.length);

  /** Per-frame scratch, cleared and refilled in `takeSnapshot()` — scaling runs inside frame
   *  delivery, so nothing on this path may allocate. */
  private readonly overrideValues = new Uint8Array(SID_REGISTER_COUNT);
  private readonly overrideApplies = new Uint8Array(SID_REGISTER_COUNT);
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
    if (coefficient === this.coefficients[group]) return;
    if (this.coefficients[group] !== 1 && coefficient === 1) {
      this.restoreOnNextSnapshot[group] = true;
    }
    this.coefficients[group] = coefficient;
  }

  setTargetClock(sourceHz: number, targetHz: number): void {
    const ratio = clockRatio(sourceHz, targetHz);
    if (ratio === null || ratio === this.clockRatio) return;
    for (let voice = 0; voice < VOICE_COUNT; voice++) {
      this.armFrequencyRestore(voice, ratio * this.voicePitch[voice]);
    }
    this.clockRatio = ratio;
  }

  setVoicePitch(voice: number, coefficient: number): void {
    if (voice < 0 || voice >= VOICE_COUNT) return;
    if (!Number.isFinite(coefficient) || coefficient === this.voicePitch[voice]) return;
    this.armFrequencyRestore(voice, this.clockRatio * coefficient);
    this.voicePitch[voice] = coefficient;
  }

  /** What the two multipliers compose to for one voice. Exactly 1 is home, as it is for a group. */
  private frequencyCoefficient(voice: number): number {
    return this.clockRatio * this.voicePitch[voice];
  }

  /** Arms the one-shot restore when `next` — the coefficient about to take effect, the current one
   *  still being held — brings a voice home from off it. */
  private armFrequencyRestore(voice: number, next: number): void {
    if (next === 1 && this.frequencyCoefficient(voice) !== 1) {
      this.restoreFrequencyOnNextSnapshot[voice] = 1;
    }
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

  takeSnapshot(): SidFrame {
    this.forceScaledGroups();
    this.forceHeldFields();
    this.buildScaledOverrides();
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

  /** An override stands in for the shadow byte wherever one applies this frame; holds go over
   *  either. */
  private emittedValue(register: number): number {
    const base = this.overrideApplies[register]
      ? this.overrideValues[register]
      : this.values[register];
    return heldByte(base, this.holdMask[register], this.holdBits[register]);
  }

  /** A muted voice's control register belongs to the mute, so holds on its fields wait. */
  private isInert(entry: SidFieldEntry): boolean {
    return entry.voiceControl && this.mutedVoices.has(entry.voice);
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
   * Rebuilds, from the shadow and the held fields alone, which bits each register's holds cover and
   * what they send for them. It reads state and arms and consumes nothing, which is what lets
   * `emittedValues()` share it without disturbing the next real frame.
   *
   * A switch held below an amount of 1 covers no bits at all: the tune's own bit goes out, and on a
   * retrigger that means each of the two bytes' own bit rather than the shadow's copy of the first.
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

  /** Self-emission: every register of every off-home group and the frequency pair of every voice off
   *  its own home coefficient, and one further frame for whichever of them has just come home. */
  private forceScaledGroups(): void {
    for (const group of SCALED_REGISTER_GROUPS) {
      if (this.coefficients[group] !== 1 || this.restoreOnNextSnapshot[group]) {
        this.forceGroup(group);
      }
      this.restoreOnNextSnapshot[group] = false;
    }

    // Per voice rather than per group: frequency carries a coefficient of each voice's own, so a
    // voice at home would otherwise pay for a neighbour's scaling with a write of its own.
    for (let voice = 0; voice < VOICE_COUNT; voice++) {
      if (this.frequencyCoefficient(voice) !== 1 || this.restoreFrequencyOnNextSnapshot[voice]) {
        const base = voice * REGISTERS_PER_VOICE;
        this.forcedRegisters[base + VOICE_FREQUENCY_LOW_OFFSET] = 1;
        this.forcedRegisters[base + VOICE_FREQUENCY_HIGH_OFFSET] = 1;
      }
      this.restoreFrequencyOnNextSnapshot[voice] = 0;
    }
  }

  private forceGroup(group: ScaledRegisterGroup): void {
    for (const register of REGISTERS_FOR_GROUP[group]) {
      this.forcedRegisters[register] = 1;
    }
  }

  /** Rebuilds this frame's overridden bytes into the scratch buffers. A group at home writes none,
   *  leaving its raw bytes to go out untouched. */
  private buildScaledOverrides(): void {
    this.overrideApplies.fill(0);
    this.overrideValues.fill(0);

    this.composeVolumeByte();
    this.scaleCutoff(this.coefficients.cutoff);
    this.scaleResonance(this.coefficients.resonance);
    for (let voice = 0; voice < VOICE_COUNT; voice++) {
      this.scaleVoicePulseWidth(voice, this.coefficients.pulseWidth);
      this.scaleVoiceFrequency(voice, this.frequencyCoefficient(voice));
    }
  }

  /** Off-home guard around `scaledVolumeByte` — see that function for the byte layout. */
  private composeVolumeByte(): void {
    const gain = this.coefficients.volume;
    if (gain === 1) return;

    this.setOverride(SID_VOLUME_REGISTER, scaledVolumeByte(this.values[SID_VOLUME_REGISTER], gain));
  }

  /** Off-home guard around `scaledCutoffPacked` — see that function for the bit layout. */
  private scaleCutoff(coefficient: number): void {
    if (coefficient === 1) return;

    const packed = scaledCutoffPacked(
      this.values[SID_FILTER_CUTOFF_LOW_REGISTER],
      this.values[SID_FILTER_CUTOFF_HIGH_REGISTER],
      coefficient,
    );
    this.setOverride(SID_FILTER_CUTOFF_LOW_REGISTER, packed & 0xff);
    this.setOverride(SID_FILTER_CUTOFF_HIGH_REGISTER, (packed >> 8) & 0xff);
  }

  /** Off-home guard around `scaledResonanceByte` — see that function for the bit layout. */
  private scaleResonance(coefficient: number): void {
    if (coefficient === 1) return;

    this.setOverride(
      SID_FILTER_RESONANCE_REGISTER,
      scaledResonanceByte(this.values[SID_FILTER_RESONANCE_REGISTER], coefficient),
    );
  }

  /** Off-home guard around `scaledPulseWidthPacked` — see that function for the bit layout. */
  private scaleVoicePulseWidth(voice: number, coefficient: number): void {
    if (coefficient === 1) return;

    const base = voice * REGISTERS_PER_VOICE;
    const lowRegister = base + VOICE_PULSE_WIDTH_LOW_OFFSET;
    const highRegister = base + VOICE_PULSE_WIDTH_HIGH_OFFSET;
    const packed = scaledPulseWidthPacked(
      this.values[lowRegister],
      this.values[highRegister],
      coefficient,
    );
    this.setOverride(lowRegister, packed & 0xff);
    this.setOverride(highRegister, (packed >> 8) & 0xff);
  }

  /**
   * Off-home guard around `scaledFrequencyPacked` — see that function for the bit layout.
   *
   * The whole value is recombined from both shadow bytes and rounded once, which is what makes
   * scaling change the *high* byte of a value the tune only wrote the low byte of. The forcing in
   * `forceScaledGroups` is the other half of that: while a voice is off home both its registers go
   * out every frame, so the moved high byte reaches the chip rather than being left behind at the
   * tune's own.
   */
  private scaleVoiceFrequency(voice: number, coefficient: number): void {
    if (coefficient === 1) return;

    const base = voice * REGISTERS_PER_VOICE;
    const lowRegister = base + VOICE_FREQUENCY_LOW_OFFSET;
    const highRegister = base + VOICE_FREQUENCY_HIGH_OFFSET;
    const packed = scaledFrequencyPacked(
      this.values[lowRegister],
      this.values[highRegister],
      coefficient,
    );
    this.setOverride(lowRegister, packed & 0xff);
    this.setOverride(highRegister, (packed >> 8) & 0xff);
  }

  private setOverride(register: number, value: number): void {
    this.overrideValues[register] = value;
    this.overrideApplies[register] = 1;
  }

  /**
   * `target`'s registers wherever scaling is off home this instant — everywhere else `target` is
   * left as its caller filled it, since a group at home writes none of its bytes. Mirrors
   * `forceScaledGroups`/`buildScaledOverrides`'s condition set exactly, but computes into a
   * caller-owned array instead of the per-frame override scratch, so a read can never arm or
   * consume the one-shot restore flags early or perturb what the next real frame emits.
   */
  private applyScaling(target: Uint8Array): void {
    if (this.coefficients.volume !== 1) {
      target[SID_VOLUME_REGISTER] = scaledVolumeByte(
        this.values[SID_VOLUME_REGISTER],
        this.coefficients.volume,
      );
    }
    if (this.coefficients.cutoff !== 1) {
      const packed = scaledCutoffPacked(
        this.values[SID_FILTER_CUTOFF_LOW_REGISTER],
        this.values[SID_FILTER_CUTOFF_HIGH_REGISTER],
        this.coefficients.cutoff,
      );
      target[SID_FILTER_CUTOFF_LOW_REGISTER] = packed & 0xff;
      target[SID_FILTER_CUTOFF_HIGH_REGISTER] = (packed >> 8) & 0xff;
    }
    if (this.coefficients.resonance !== 1) {
      target[SID_FILTER_RESONANCE_REGISTER] = scaledResonanceByte(
        this.values[SID_FILTER_RESONANCE_REGISTER],
        this.coefficients.resonance,
      );
    }
    for (let voice = 0; voice < VOICE_COUNT; voice++) {
      const base = voice * REGISTERS_PER_VOICE;
      if (this.coefficients.pulseWidth !== 1) {
        const packed = scaledPulseWidthPacked(
          this.values[base + VOICE_PULSE_WIDTH_LOW_OFFSET],
          this.values[base + VOICE_PULSE_WIDTH_HIGH_OFFSET],
          this.coefficients.pulseWidth,
        );
        target[base + VOICE_PULSE_WIDTH_LOW_OFFSET] = packed & 0xff;
        target[base + VOICE_PULSE_WIDTH_HIGH_OFFSET] = (packed >> 8) & 0xff;
      }
      const frequencyCoefficient = this.frequencyCoefficient(voice);
      if (frequencyCoefficient !== 1) {
        const packed = scaledFrequencyPacked(
          this.values[base + VOICE_FREQUENCY_LOW_OFFSET],
          this.values[base + VOICE_FREQUENCY_HIGH_OFFSET],
          frequencyCoefficient,
        );
        target[base + VOICE_FREQUENCY_LOW_OFFSET] = packed & 0xff;
        target[base + VOICE_FREQUENCY_HIGH_OFFSET] = (packed >> 8) & 0xff;
      }
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
    const written = this.values.slice();
    const sent = written.slice();
    this.applyScaling(sent);
    this.buildHoldComposition();
    for (let register = 0; register < SID_REGISTER_COUNT; register++) {
      sent[register] = heldByte(sent[register], this.holdMask[register], this.holdBits[register]);
    }
    return { written, sent };
  }
}
