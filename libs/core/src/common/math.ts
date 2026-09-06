/** Shared by every engine collaborator that turns a µs interval into a millisecond one. */
export const MICROSECONDS_PER_SECOND = 1_000_000;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** frames * (nominalIntervalUs / callsPerFrame) / 1_000_000 — every reader needs this, and every
 *  reader would otherwise get the multispeed factor wrong. */
export function framesToSeconds(
  frames: number,
  nominalIntervalUs: number,
  callsPerFrame: number,
): number {
  return (frames * (nominalIntervalUs / callsPerFrame)) / MICROSECONDS_PER_SECOND;
}
