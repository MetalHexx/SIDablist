/** One boundary of a loop marker: the frame (play call) it was captured at, and the nudge applied
 *  to it. The resolved boundary is `frame + offsetFrames`, never below 0. Plain numbers — this is a
 *  storage shape, and the store never computes with it. */
export interface LoopBoundary {
  readonly frame: number;
  /** Signed play calls; the host keeps it within its nudge window. */
  readonly offsetFrames: number;
}

/** Plain, serializable data — what a host files with a marker and gets back unchanged:
 *  primitives, arrays and plain objects only. */
export type PlainValue =
  null | boolean | number | string | readonly PlainValue[] | { readonly [key: string]: PlainValue };

/** A position a performer marked in one tune. A cue when `end` is null, a loop when it is set. */
export interface LoopMarker {
  /** Minted by the host; stable across edits. */
  readonly id: string;
  readonly start: LoopBoundary;
  readonly end: LoopBoundary | null;
  /** 0-based voice numbers, ascending; all three today. */
  readonly voices: readonly number[];
  /** The host's own settings for this marker, as plain data. The library stores and copies it
   *  and never reads it; its shape is the host's to define and version. Absent: none kept. */
  readonly settings?: PlainValue;
  /** True while the marker plays with `settings` rather than the host's shared ones. Absent or
   *  false: it shares. Separate from `settings`, so going back to sharing keeps them. */
  readonly usesOwnSettings?: boolean;
}
