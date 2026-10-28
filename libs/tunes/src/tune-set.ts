import type { LoopMarker, PlainValue } from './loop-marker.js';

/** The header facts a row shows for its tune, and the hash that addresses it. */
export interface RowTune {
  /** The content hash of the whole file; addresses the tune. */
  readonly sidHash: string;
  readonly title: string;
  readonly author: string;
  readonly released: string;
  /** How many subtunes the file holds; at least 1. */
  readonly subtuneCount: number;
  readonly byteLength: number;
}

/** Which tune memory a row was copied from, and that memory's `updated` stamp at the time. */
export interface MemoryLink {
  readonly sidHash: string;
  readonly updated: string;
}

/** What a performer left set in one subtune: its markers in list order, and the host's own
 *  settings for the subtune's main track, which the library stores and copies and never reads. */
export interface SubtuneMemory {
  /** 1-based. */
  readonly subtune: number;
  readonly markers: readonly LoopMarker[];
  /** Absent: none kept. */
  readonly settings?: PlainValue;
}

/** A tune's latest version: the memory of the row edited last, keyed by the tune's hash. */
export interface TuneMemory {
  readonly sidHash: string;
  /** The subtune the performer last had selected, 1-based. */
  readonly lastSubtune: number;
  /** Ascending by subtune, at most one entry per subtune; subtunes with nothing set are absent. */
  readonly subtunes: readonly SubtuneMemory[];
  /** ISO-8601, from the host. */
  readonly updated: string;
}

/** One tune placed in a set: a frozen copy of its memory, with a link back to where it came from. */
export interface SetRow {
  /** Minted by the host. */
  readonly id: string;
  readonly tune: RowTune;
  /** Null when the tune had no memory to copy. */
  readonly copiedFrom: MemoryLink | null;
  /** The subtune last selected in this row, 1-based. */
  readonly lastSubtune: number;
  /** Ascending by subtune, at most one entry per subtune. */
  readonly subtunes: readonly SubtuneMemory[];
  /** The host's own value for the row, such as where the file was found. Stored and copied,
   *  never read. Absent: none kept. */
  readonly host?: PlainValue;
}

/** A named, ordered list of rows, holding each tune at most once. */
export interface TuneSet {
  readonly id: string;
  readonly name: string;
  /** The "Set N" the set was created as; an empty rename falls back to it. */
  readonly placeholder: string;
  readonly rows: readonly SetRow[];
  /** ISO-8601, from the host. */
  readonly created: string;
  /** ISO-8601, from the host; stamped by every change that is not a no-op. */
  readonly updated: string;
}

/** What a list of sets shows for one set. */
export interface SetSummary {
  readonly id: string;
  readonly name: string;
  readonly rowCount: number;
  readonly updated: string;
}

/** A change to one subtune's memory. Absent: unchanged. `settings: null` clears the settings. */
export interface SubtuneChange {
  readonly markers?: readonly LoopMarker[];
  readonly settings?: PlainValue | null;
}

/** An edit's result: the new set, the edited row, and the tune's new latest version. */
export interface RowEdit {
  readonly set: TuneSet;
  readonly row: SetRow;
  readonly memory: TuneMemory;
}
