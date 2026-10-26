/** One boundary of a loop marker: the frame (play call) it was captured at, and the nudge applied
 *  to it. The resolved boundary is `frame + offsetFrames`, never below 0. Plain numbers — this is a
 *  storage shape, and the store never computes with it. */
export interface LoopBoundary {
  readonly frame: number;
  /** Signed play calls; the host keeps it within its nudge window. */
  readonly offsetFrames: number;
}

/** A position a performer marked in one tune. A cue when `end` is null, a loop when it is set. */
export interface LoopMarker {
  /** Minted by the host; stable across edits. */
  readonly id: string;
  readonly start: LoopBoundary;
  readonly end: LoopBoundary | null;
  /** 0-based voice numbers, ascending; all three today. */
  readonly voices: readonly number[];
}
