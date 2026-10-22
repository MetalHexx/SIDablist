import {
  REGISTERS_PER_VOICE,
  SID_FILTER_CUTOFF_HIGH_REGISTER,
  SID_FILTER_CUTOFF_LOW_REGISTER,
  SID_FILTER_MODE_SHIFT,
  SID_FILTER_RESONANCE_REGISTER,
  SID_VOLUME_REGISTER,
  VOICE_ATTACK_DECAY_OFFSET,
  VOICE_CONTROL_OFFSET,
  VOICE_CONTROL_REGISTERS,
  VOICE_COUNT,
  VOICE_FREQUENCY_HIGH_OFFSET,
  VOICE_FREQUENCY_LOW_OFFSET,
  VOICE_PULSE_WIDTH_HIGH_OFFSET,
  VOICE_PULSE_WIDTH_LOW_OFFSET,
  VOICE_SUSTAIN_RELEASE_OFFSET,
} from './sid-constants.js';

export type SidVoiceFieldName =
  | 'frequency'
  | 'pulseWidth'
  | 'waveform'
  | 'test'
  | 'ringMod'
  | 'sync'
  | 'gate'
  | 'attack'
  | 'decay'
  | 'sustain'
  | 'release'
  | 'filtered';

export type SidChipFieldName =
  'cutoff' | 'resonance' | 'externalFiltered' | 'filterType' | 'voice3Off' | 'volume';

export type SidFieldName = SidVoiceFieldName | SidChipFieldName;

/** A per-voice field names its voice (0…2); a whole-chip field names none. */
export type SidField =
  | { readonly name: SidVoiceFieldName; readonly voice: number }
  | { readonly name: SidChipFieldName };

/**
 * One run of a field's bits inside a single register. A field is a short list of these, the first
 * carrying the value's low bits — which is how a 16-bit frequency, an 11-bit cutoff and a lone gate
 * bit all read, write and split through the same walk with no field special-cased.
 */
export interface SidFieldSegment {
  readonly register: number;
  /** The segment's lowest bit within `register`. */
  readonly shift: number;
  readonly width: number;
  /** The segment's lowest bit within the field's value. */
  readonly valueShift: number;
}

/** One resolvable field: a chip field once, a per-voice field once per voice. */
export interface SidFieldEntry {
  readonly name: SidFieldName;
  /** The voice a per-voice field belongs to, or −1 for a whole-chip field. */
  readonly voice: number;
  readonly width: number;
  /** The largest value the field holds: `2^width − 1`. */
  readonly ceiling: number;
  /** A numeric field blends smoothly toward a held value; a switch is all or nothing. */
  readonly numeric: boolean;
  readonly segments: readonly SidFieldSegment[];
  /** Whether any bit lives in a voice's control register — the register a mute owns. */
  readonly voiceControl: boolean;
}

interface VoiceFieldDefinition {
  readonly name: SidVoiceFieldName;
  readonly numeric: boolean;
  readonly width: number;
  /** `base` is the voice's first register, `voice × REGISTERS_PER_VOICE`. */
  readonly segments: (base: number, voice: number) => readonly SidFieldSegment[];
}

interface ChipFieldDefinition {
  readonly name: SidChipFieldName;
  readonly numeric: boolean;
  readonly width: number;
  readonly segments: readonly SidFieldSegment[];
}

function segment(register: number, shift: number, width: number, valueShift = 0): SidFieldSegment {
  return { register, shift, width, valueShift };
}

/** A switch inside voice control register `b+4`: waveform in bits 7-4, then test, ring mod, sync
 *  and gate from bit 3 down to bit 0. */
function controlBits(name: SidVoiceFieldName, shift: number, width: number): VoiceFieldDefinition {
  return {
    name,
    numeric: false,
    width,
    segments: (base) => [segment(base + VOICE_CONTROL_OFFSET, shift, width)],
  };
}

function envelopeNibble(
  name: SidVoiceFieldName,
  offset: number,
  shift: number,
): VoiceFieldDefinition {
  return {
    name,
    numeric: true,
    width: 4,
    segments: (base) => [segment(base + offset, shift, 4)],
  };
}

const VOICE_FIELD_DEFINITIONS: readonly VoiceFieldDefinition[] = [
  {
    name: 'frequency',
    numeric: true,
    width: 16,
    segments: (base) => [
      segment(base + VOICE_FREQUENCY_LOW_OFFSET, 0, 8),
      segment(base + VOICE_FREQUENCY_HIGH_OFFSET, 0, 8, 8),
    ],
  },
  {
    name: 'pulseWidth',
    numeric: true,
    width: 12,
    segments: (base) => [
      segment(base + VOICE_PULSE_WIDTH_LOW_OFFSET, 0, 8),
      segment(base + VOICE_PULSE_WIDTH_HIGH_OFFSET, 0, 4, 8),
    ],
  },
  controlBits('waveform', 4, 4),
  controlBits('test', 3, 1),
  controlBits('ringMod', 2, 1),
  controlBits('sync', 1, 1),
  controlBits('gate', 0, 1),
  envelopeNibble('attack', VOICE_ATTACK_DECAY_OFFSET, 4),
  envelopeNibble('decay', VOICE_ATTACK_DECAY_OFFSET, 0),
  envelopeNibble('sustain', VOICE_SUSTAIN_RELEASE_OFFSET, 4),
  envelopeNibble('release', VOICE_SUSTAIN_RELEASE_OFFSET, 0),
  {
    // The routing bit for voice v is bit v of the filter register it shares with resonance.
    name: 'filtered',
    numeric: false,
    width: 1,
    segments: (_base, voice) => [segment(SID_FILTER_RESONANCE_REGISTER, voice, 1)],
  },
];

const CHIP_FIELD_DEFINITIONS: readonly ChipFieldDefinition[] = [
  {
    name: 'cutoff',
    numeric: true,
    width: 11,
    segments: [
      segment(SID_FILTER_CUTOFF_LOW_REGISTER, 0, 3),
      segment(SID_FILTER_CUTOFF_HIGH_REGISTER, 0, 8, 3),
    ],
  },
  {
    name: 'resonance',
    numeric: true,
    width: 4,
    segments: [segment(SID_FILTER_RESONANCE_REGISTER, 4, 4)],
  },
  {
    name: 'externalFiltered',
    numeric: false,
    width: 1,
    segments: [segment(SID_FILTER_RESONANCE_REGISTER, 3, 1)],
  },
  {
    name: 'filterType',
    numeric: false,
    width: 3,
    segments: [segment(SID_VOLUME_REGISTER, SID_FILTER_MODE_SHIFT, 3)],
  },
  {
    name: 'voice3Off',
    numeric: false,
    width: 1,
    segments: [segment(SID_VOLUME_REGISTER, 7, 1)],
  },
  {
    name: 'volume',
    numeric: true,
    width: 4,
    segments: [segment(SID_VOLUME_REGISTER, 0, 4)],
  },
];

function buildEntry(
  name: SidFieldName,
  voice: number,
  numeric: boolean,
  width: number,
  segments: readonly SidFieldSegment[],
): SidFieldEntry {
  return {
    name,
    voice,
    width,
    ceiling: (1 << width) - 1,
    numeric,
    segments,
    voiceControl:
      voice >= 0 && segments.some((part) => part.register === VOICE_CONTROL_REGISTERS[voice]),
  };
}

/** The first table index of each field name. A per-voice field owns `VOICE_COUNT` consecutive
 *  indices from there, one per voice. */
const FIRST_INDEX_FOR_NAME = new Map<SidFieldName, number>();
const VOICE_FIELD_NAMES = new Set<SidFieldName>();

function buildFieldTable(): readonly SidFieldEntry[] {
  const table: SidFieldEntry[] = [];
  for (const definition of VOICE_FIELD_DEFINITIONS) {
    FIRST_INDEX_FOR_NAME.set(definition.name, table.length);
    VOICE_FIELD_NAMES.add(definition.name);
    for (let voice = 0; voice < VOICE_COUNT; voice++) {
      const base = voice * REGISTERS_PER_VOICE;
      table.push(
        buildEntry(
          definition.name,
          voice,
          definition.numeric,
          definition.width,
          definition.segments(base, voice),
        ),
      );
    }
  }
  for (const definition of CHIP_FIELD_DEFINITIONS) {
    FIRST_INDEX_FOR_NAME.set(definition.name, table.length);
    table.push(
      buildEntry(definition.name, -1, definition.numeric, definition.width, definition.segments),
    );
  }
  return table;
}

/** Every writable field of the chip, built once when the module loads. A field is resolved to an
 *  index into this table when it is first named, so nothing per frame looks one up by name. */
export const SID_FIELD_TABLE: readonly SidFieldEntry[] = buildFieldTable();

function buildFieldWidths(): Readonly<Record<SidFieldName, number>> {
  const widths = {} as Record<SidFieldName, number>;
  for (const entry of SID_FIELD_TABLE) {
    widths[entry.name] = entry.width;
  }
  return widths;
}

/** Each field's width in bits — what bounds a value that can be held at it. */
export const SID_FIELD_WIDTHS: Readonly<Record<SidFieldName, number>> = buildFieldWidths();

/**
 * The field's table index, or −1 for an unknown name or a per-voice field whose voice is not an
 * integer 0…2.
 */
export function resolveSidField(field: SidField): number {
  const first = FIRST_INDEX_FOR_NAME.get(field.name);
  if (first === undefined) return -1;
  if (!VOICE_FIELD_NAMES.has(field.name)) return first;

  const voice = 'voice' in field ? field.voice : -1;
  return Number.isInteger(voice) && voice >= 0 && voice < VOICE_COUNT ? first + voice : -1;
}

/**
 * True when `value` is an integer in 0…2^width − 1 for the field at `index`, and `amount` is finite
 * and within 0…1.
 */
export function isUsableHold(index: number, value: number, amount: number): boolean {
  if (!Number.isInteger(index) || index < 0 || index >= SID_FIELD_TABLE.length) return false;
  return (
    Number.isInteger(value) &&
    value >= 0 &&
    value <= SID_FIELD_TABLE[index].ceiling &&
    Number.isFinite(amount) &&
    amount >= 0 &&
    amount <= 1
  );
}

/**
 * True when the field at `index` is numeric and `amount` is an integer no larger in magnitude than
 * the field's ceiling — what `setFieldOffset` accepts.
 */
export function isUsableOffset(index: number, amount: number): boolean {
  if (!Number.isInteger(index) || index < 0 || index >= SID_FIELD_TABLE.length) return false;
  const entry = SID_FIELD_TABLE[index];
  return entry.numeric && Number.isInteger(amount) && Math.abs(amount) <= entry.ceiling;
}

/** The field's value recombined from `registers` at its full width. */
export function readFieldEntry(registers: ArrayLike<number>, entry: SidFieldEntry): number {
  let value = 0;
  for (const part of entry.segments) {
    value |=
      ((registers[part.register] >> part.shift) & ((1 << part.width) - 1)) << part.valueShift;
  }
  return value;
}

/**
 * Splits `value` across the field's registers, OR-ing the bits it covers into `mask` and the value's
 * share of them into `bits` — both indexed by register, and neither cleared first, so several
 * fields can pile into the same pair of buffers.
 */
export function splitFieldEntry(
  entry: SidFieldEntry,
  value: number,
  mask: Uint8Array,
  bits: Uint8Array,
): void {
  for (const part of entry.segments) {
    const partMask = (1 << part.width) - 1;
    mask[part.register] |= partMask << part.shift;
    bits[part.register] |= ((value >> part.valueShift) & partMask) << part.shift;
  }
}

/**
 * A field's raw value decoded from a 25-register array such as `emittedValues().written`. A field
 * that does not resolve reads as 0.
 */
export function readSidField(registers: ArrayLike<number>, field: SidField): number {
  const index = resolveSidField(field);
  return index < 0 ? 0 : readFieldEntry(registers, SID_FIELD_TABLE[index]);
}
