/**
 * The two machine clocks a tune can have been written for, and the multiplier that carries one onto
 * the other.
 *
 * The clock here is φ2 — the chip's own clock — not the video frame rate. A foreign machine moves a
 * tune in two independent ways, and only pitch lives in this file: tempo belongs to the frame rate
 * and is corrected by the play rate instead.
 */

/** PAL φ2, in Hz. */
export const PAL_PHI2_HZ = 985248.6;
/** NTSC φ2, in Hz — 3.804% above PAL, roughly two-thirds of a semitone. */
export const NTSC_PHI2_HZ = 1022727.1;

/**
 * The frequency-register multiplier that holds a tune's pitch when it plays on a machine clocked
 * differently from the one it was written for.
 *
 * An oscillator sounds at `Fn × φ2 / 2^24`, so holding the pitch across a change of φ2 means
 * dividing the register value by whatever factor the clock rose by — a PAL tune on an NTSC machine
 * scales down.
 *
 * `null` for anything that is not a pair of usable clock frequencies. The numbers reach core from
 * the application, so a pair that cannot be divided is rejected here rather than allowed to become
 * a non-finite coefficient downstream.
 */
export function clockRatio(sourceHz: number, targetHz: number): number | null {
  if (!Number.isFinite(sourceHz) || !Number.isFinite(targetHz)) return null;
  if (sourceHz <= 0 || targetHz <= 0) return null;
  return sourceHz / targetHz;
}
