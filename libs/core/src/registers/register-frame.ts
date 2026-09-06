import type { SidWriteSink } from '../cpu/c64-machine.js';
import { clamp } from '../common/math.js';
import type { SidFrame } from './sid-frame.js';
import {
  REGISTERS_PER_VOICE,
  SID_FILTER_CUTOFF_HIGH_REGISTER,
  SID_FILTER_CUTOFF_LOW_REGISTER,
  SID_FILTER_MODE_BAND_PASS,
  SID_FILTER_MODE_HIGH_PASS,
  SID_FILTER_MODE_LOW_PASS,
  SID_FILTER_MODE_MASK,
  SID_FILTER_MODE_OFF,
  SID_FILTER_MODE_SHIFT,
  SID_FILTER_RESONANCE_REGISTER,
  SID_REGISTER_COUNT,
  SID_VOLUME_REGISTER,
  VOICE_CONTROL_REGISTERS,
  VOICE_COUNT,
  VOICE_FREQUENCY_HIGH_OFFSET,
  VOICE_FREQUENCY_LOW_OFFSET,
  VOICE_PULSE_WIDTH_HIGH_OFFSET,
  VOICE_PULSE_WIDTH_LOW_OFFSET,
} from './sid-constants.js';

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

/**
 * The register groups a deck's controls scale on the way out. `volume` is the deck-gain path this
 * mechanism was generalized from.
 */
export type ScaledRegisterGroup = 'volume' | 'cutoff' | 'resonance' | 'pulseWidth' | 'frequency';

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
  'frequency',
];

const FILTER_MODE_BITS: Readonly<Record<SidFilterMode, number>> = {
  lowPass: SID_FILTER_MODE_LOW_PASS,
  bandPass: SID_FILTER_MODE_BAND_PASS,
  highPass: SID_FILTER_MODE_HIGH_PASS,
  off: SID_FILTER_MODE_OFF,
};

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
  frequency: voiceRegisters(VOICE_FREQUENCY_LOW_OFFSET, VOICE_FREQUENCY_HIGH_OFFSET),
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
 * Accumulates one frame's SID writes and hands them out as a `SidFrame` — the registers the tune
 * wrote, carrying the bytes a deck's controls scaled them to, in the order the tune wrote them.
 *
 * A second write in the same frame to register 4, 11 or 18 (the voice gate registers) is a
 * deliberate retrigger and survives as its own entry alongside the first. A second write to any
 * other register overwrites the first where it already stands and is counted as suppressed. Either
 * way the frame is never flushed early: one frame is one call of the tune's play routine.
 */
export class RegisterFrame implements SidWriteSink {
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
    frequency: 1,
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
    frequency: false,
  };

  private forcedFilterMode: SidFilterMode | null = null;
  private restoreFilterModeOnNextSnapshot = false;

  /** Per-frame scratch, cleared and refilled in `takeSnapshot()` — scaling runs inside frame
   *  delivery, so nothing on this path may allocate. */
  private readonly overrideValues = new Uint8Array(SID_REGISTER_COUNT);
  private readonly overrideApplies = new Uint8Array(SID_REGISTER_COUNT);

  /** Refilled and handed back by every `takeSnapshot()`, so rendering a frame allocates nothing. */
  private readonly frame: MutableSidFrame = {
    count: 0,
    registers: new Uint8Array(MAX_FRAME_WRITES),
    values: new Uint8Array(MAX_FRAME_WRITES),
    offsetsUs: new Int32Array(MAX_FRAME_WRITES),
  };

  /** Voice 0/1/2. Muting forces that voice's control register to 0 once, then drops every further
   * write the tune's code makes to it until unmuted — every other register for that voice keeps
   * updating live throughout — the hardware-mute technique the TeensyROM firmware uses.
   *
   * The zeroing is not a write the tune made, so it lands with the forced registers rather than in
   * write order. */
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

  /**
   * Multiplies a register group by `coefficient`, full resolution, applied in `takeSnapshot()` and
   * never at the write — scaling on the way out rather than in `onSidWrite` is what keeps
   * `snapshotValues()`/`restoreValues()` raw (so a cue re-entered at a different knob position never
   * double-applies a coefficient), keeps quantization to a single rounding per field, and keeps this
   * stage out of `suppressedWrites` entirely, since none of these registers routes through a scaling
   * branch in the write path.
   *
   * A coefficient of exactly 1 is home, not a multiplication by one: the group's raw bytes pass
   * through untouched. `pulseWidth` and `frequency` hold one coefficient shared by all three voices,
   * so scaling them preserves the tune's internal balance between its voices.
   *
   * A no-op call (the coefficient already held) leaves the one-shot restore untouched, so repeatedly
   * setting the same value can never manufacture a spurious extra write.
   */
  setRegisterScale(group: ScaledRegisterGroup, coefficient: number): void {
    if (coefficient === this.coefficients[group]) return;
    if (this.coefficients[group] !== 1 && coefficient === 1) {
      this.restoreOnNextSnapshot[group] = true;
    }
    this.coefficients[group] = coefficient;
  }

  /**
   * Replaces `$D418`'s filter-mode bits in every emitted volume byte until deselected. This is an
   * override rather than a scale — the tune's own mode bits are discarded while one is held, and
   * `null` hands them back. Selecting forces the volume register out the same way an off-home
   * coefficient does; deselecting arms the same one-shot restore.
   */
  setFilterMode(mode: SidFilterMode | null): void {
    if (mode === this.forcedFilterMode) return;
    if (this.forcedFilterMode !== null && mode === null) {
      this.restoreFilterModeOnNextSnapshot = true;
    }
    this.forcedFilterMode = mode;
  }

  /** 0…1, full resolution — the deck-gain entry point onto `$D418`'s low nibble, and one group of
   *  the same scaling stage as every other control. */
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

  /**
   * Forces every one of the 25 registers into the next frame at its current value (0 if never
   * written) — called once after init so the chip starts a session from a known state instead of
   * carrying over silence.
   *
   * A resync frame is not a fixed layout: the tune's own writes still come first and the forced ones
   * fill in around them, so a caller reaching for a particular register must find it by register
   * number rather than by position.
   */
  markAllDirty(): void {
    this.forcedRegisters.fill(1);
  }

  /**
   * Second writes folded into a register's existing entry instead of becoming a retrigger, counted
   * across this object's lifetime rather than per frame — the data point for how often it matters
   * in practice.
   */
  get suppressedWriteCount(): number {
    return this.suppressedWrites;
  }

  /**
   * Fills the reused `SidFrame` with this frame's writes and clears the per-frame state — including
   * the second-write tracking — so the next frame starts empty.
   *
   * The order is: what the tune wrote, as it wrote it; then whatever a resync, an off-home
   * coefficient or a mute forces out, ascending by register and only for registers the tune left
   * alone. An override replaces the byte of the write it applies to and never adds one.
   *
   * Forcing a group out is a standing condition re-checked live on every call, so a frame a caller
   * discards can never swallow a knob move on a tune that does not keep rewriting those registers
   * itself. Scaled bytes are computed once per frame, before the fill, because a two-register group
   * read per write would combine and round twice.
   */
  takeSnapshot(): SidFrame {
    this.forceScaledGroups();
    this.buildScaledOverrides();

    const frame = this.frame;
    let count = 0;

    for (let index = 0; index < this.writeCount; index++) {
      const register = this.writeOrder[index];
      frame.registers[count] = register;
      frame.values[count] = this.writeIsRetrigger[index]
        ? this.retriggerValues[register]
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

  /** An override stands in for the shadow byte wherever one applies this frame. */
  private emittedValue(register: number): number {
    return this.overrideApplies[register] ? this.overrideValues[register] : this.values[register];
  }

  /** Self-emission: every register of every off-home group, plus the volume register while a filter
   *  mode is held, and one further frame for whichever of them has just come home. */
  private forceScaledGroups(): void {
    for (const group of SCALED_REGISTER_GROUPS) {
      if (this.coefficients[group] !== 1 || this.restoreOnNextSnapshot[group]) {
        this.forceGroup(group);
      }
      this.restoreOnNextSnapshot[group] = false;
    }

    if (this.forcedFilterMode !== null || this.restoreFilterModeOnNextSnapshot) {
      this.forceGroup('volume');
    }
    this.restoreFilterModeOnNextSnapshot = false;
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
      this.scaleVoiceFrequency(voice, this.coefficients.frequency);
    }
  }

  /** `$D418` composes two controls at once: gain owns the low nibble, the forced filter mode owns
   *  bits 4-6, and bit 7 (voice-3 mute) belongs to neither and always passes through raw. */
  private composeVolumeByte(): void {
    const gain = this.coefficients.volume;
    if (gain === 1 && this.forcedFilterMode === null) return;

    const raw = this.values[SID_VOLUME_REGISTER];
    const volume = gain === 1 ? raw & 0x0f : scaleField(raw & 0x0f, gain, NIBBLE_CEILING);
    const mode =
      this.forcedFilterMode === null
        ? (raw >> SID_FILTER_MODE_SHIFT) & SID_FILTER_MODE_MASK
        : FILTER_MODE_BITS[this.forcedFilterMode];

    this.setOverride(SID_VOLUME_REGISTER, (raw & 0x80) | (mode << SID_FILTER_MODE_SHIFT) | volume);
  }

  /** 11 bits across registers 21 and 22, register 21's upper five bits belonging to nothing here. */
  private scaleCutoff(coefficient: number): void {
    if (coefficient === 1) return;

    const rawLow = this.values[SID_FILTER_CUTOFF_LOW_REGISTER];
    const rawHigh = this.values[SID_FILTER_CUTOFF_HIGH_REGISTER];
    const scaled = scaleField((rawHigh << 3) | (rawLow & 0x07), coefficient, CUTOFF_CEILING);

    this.setOverride(SID_FILTER_CUTOFF_LOW_REGISTER, (rawLow & 0xf8) | (scaled & 0x07));
    this.setOverride(SID_FILTER_CUTOFF_HIGH_REGISTER, (scaled >> 3) & 0xff);
  }

  /** Register 23's high nibble only — the low nibble routes voices through the filter and is the
   *  tune's alone. */
  private scaleResonance(coefficient: number): void {
    if (coefficient === 1) return;

    const raw = this.values[SID_FILTER_RESONANCE_REGISTER];
    const scaled = scaleField((raw >> 4) & 0x0f, coefficient, NIBBLE_CEILING);

    this.setOverride(SID_FILTER_RESONANCE_REGISTER, (raw & 0x0f) | (scaled << 4));
  }

  /** 12 bits across the voice's register pair, the high register's upper nibble unused. */
  private scaleVoicePulseWidth(voice: number, coefficient: number): void {
    if (coefficient === 1) return;

    const base = voice * REGISTERS_PER_VOICE;
    const lowRegister = base + VOICE_PULSE_WIDTH_LOW_OFFSET;
    const highRegister = base + VOICE_PULSE_WIDTH_HIGH_OFFSET;
    const rawLow = this.values[lowRegister];
    const rawHigh = this.values[highRegister];
    const scaled = scaleField(((rawHigh & 0x0f) << 8) | rawLow, coefficient, PULSE_WIDTH_CEILING);

    this.setOverride(lowRegister, scaled & 0xff);
    this.setOverride(highRegister, (rawHigh & 0xf0) | ((scaled >> 8) & 0x0f));
  }

  /** A full 16 bits across the voice's register pair — no shared fields to preserve. */
  private scaleVoiceFrequency(voice: number, coefficient: number): void {
    if (coefficient === 1) return;

    const base = voice * REGISTERS_PER_VOICE;
    const lowRegister = base + VOICE_FREQUENCY_LOW_OFFSET;
    const highRegister = base + VOICE_FREQUENCY_HIGH_OFFSET;
    const scaled = scaleField(
      (this.values[highRegister] << 8) | this.values[lowRegister],
      coefficient,
      FREQUENCY_CEILING,
    );

    this.setOverride(lowRegister, scaled & 0xff);
    this.setOverride(highRegister, (scaled >> 8) & 0xff);
  }

  private setOverride(register: number, value: number): void {
    this.overrideValues[register] = value;
    this.overrideApplies[register] = 1;
  }

  /**
   * Copies the accumulated register values, leaving this frame untouched.
   *
   * Per-frame state is excluded on purpose — a cue records where the chip stood, not which registers
   * happened to be mid-flight when it was captured.
   */
  snapshotValues(): RegisterValuesSnapshot {
    return { values: this.values.slice() };
  }

  /**
   * Replaces the accumulated register values wholesale and drops any half-built frame.
   *
   * Mute is not part of the snapshot: whichever voices are muted *now* stay muted, so returning to a
   * cue captured before a mute does not un-mute it on the way back in.
   */
  restoreValues(snapshot: RegisterValuesSnapshot): void {
    this.values.set(snapshot.values);
    this.writtenThisFrame.fill(0);
    this.forcedRegisters.fill(0);
    this.writeCount = 0;
    for (const voice of this.mutedVoices) {
      this.values[VOICE_CONTROL_REGISTERS[voice]] = 0;
    }
  }
}
