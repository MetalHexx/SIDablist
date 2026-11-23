import { milliseconds } from '@sidablist/core';
import type { TimeSource } from '@sidablist/core';

/** The host's time as `performance.now()`: milliseconds on the page's monotonic timeline. */
export function createBrowserTime(): TimeSource {
  return { now: () => milliseconds(performance.now()) };
}
