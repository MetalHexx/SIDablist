import { clamp } from '@sidablist/core';

/** The slowest effective tempo a deck plays at, as a multiple of the tune's own rate. */
export const MIN_TEMPO = 0.3;

/** The fastest effective tempo a deck plays at, as a multiple of the tune's own rate. */
export const MAX_TEMPO = 1.7;

/**
 * The tempo a deck plays at: its speed, the nudge held now and the speed-jump kept, added together
 * and held to the playable range. Each layer is kept as the host sent it, so a later `speed`
 * carries through a jump instead of replacing it.
 */
export function effectiveTempo(speed: number, nudge: number, jump: number): number {
  return clamp(speed + nudge + jump, MIN_TEMPO, MAX_TEMPO);
}
