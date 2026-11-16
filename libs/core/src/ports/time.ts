import type { Milliseconds } from '../units.js';

/** The host's time, in milliseconds on the same timeline the frame clock's `dueAtMs` uses. */
export interface TimeSource {
  now(): Milliseconds;
}
