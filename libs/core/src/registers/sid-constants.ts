/**
 * The SID chip's own register layout and the video standards' frame intervals — facts about the
 * hardware a tune was written for, independent of any wire format that carries the writes.
 */

/** Registers 0-24 are the writable ones; 25-31 read back chip state a host never writes. */
export const SID_REGISTER_COUNT = 25;

/** Voice n's seven registers start at `n * REGISTERS_PER_VOICE`. */
export const REGISTERS_PER_VOICE = 7;
export const VOICE_COUNT = 3;

/** Offsets from a voice's base register. */
export const VOICE_FREQUENCY_LOW_OFFSET = 0;
export const VOICE_FREQUENCY_HIGH_OFFSET = 1;
export const VOICE_PULSE_WIDTH_LOW_OFFSET = 2;
export const VOICE_PULSE_WIDTH_HIGH_OFFSET = 3;

/** `$D404`, `$D40B`, `$D412` — the per-voice control registers, indexed by voice (0..2). Bit 0 is
 *  the gate, which is why a player writes one of these twice in a frame to retrigger a note. */
export const VOICE_CONTROL_REGISTERS: readonly number[] = [4, 11, 18];

/** `$D418` — SID master volume. The low nibble is the only volume control the chip has; bits 4-6
 *  select the filter mode and bit 7 silences voice 3. */
export const SID_VOLUME_REGISTER = 24;

/** `$D415` — filter cutoff low bits, in bits 0-2 only; bits 3-7 are unused and must survive a write. */
export const SID_FILTER_CUTOFF_LOW_REGISTER = 21;
/** `$D416` — filter cutoff high 8 bits, completing the 11-bit cutoff. */
export const SID_FILTER_CUTOFF_HIGH_REGISTER = 22;
/** `$D417` — filter resonance in bits 4-7, voice/external filter routing in bits 0-3. */
export const SID_FILTER_RESONANCE_REGISTER = 23;

/**
 * `$D418` bits 4-6 select the filter mode — one bit per pass band, and they combine. All three
 * clear means the filter is out of the signal path.
 */
export const SID_FILTER_MODE_OFF = 0b000;
export const SID_FILTER_MODE_LOW_PASS = 0b001;
export const SID_FILTER_MODE_BAND_PASS = 0b010;
export const SID_FILTER_MODE_HIGH_PASS = 0b100;
export const SID_FILTER_MODE_SHIFT = 4;
export const SID_FILTER_MODE_MASK = 0b111;

/** 50.125 Hz — real PAL hardware. Deliberately not the TeensyROM firmware's own 19975
 *  split-the-difference value: this looks like a typo against the firmware and is not. */
export const PAL_FRAME_INTERVAL_US = 19950;
/** 59.827 Hz. */
export const NTSC_FRAME_INTERVAL_US = 16715;
