import type { TuneIndexRecord } from '@sidablist/analysis';
import type { TuneIdentity } from './identity.js';
import type { LoopMarker } from './loop-marker.js';
import type { SetSummary, TuneMemory, TuneSet } from './tune-set.js';

/**
 * The dumb storage a host supplies. No rules live here — insertion order, lookup-or-index
 * resolution, and in-flight de-duplication are the inserter's and resolver's job, never the
 * store's.
 */
export interface TuneStore {
  getBytes(sidHash: string): Promise<Uint8Array | null>;
  putBytes(sidHash: string, bytes: Uint8Array): Promise<void>;
  getIndex(sidHash: string, subtune: number): Promise<TuneIndexRecord | null>;
  putIndex(record: TuneIndexRecord): Promise<void>;
}

/** The scanning port a host supplies — `@sidablist/analysis`'s `indexTune` wrapped however the
 *  host wires it (worker or main thread). */
export interface TuneIndexer {
  index(bytes: Uint8Array, identity: TuneIdentity): Promise<TuneIndexRecord>;
}

/** The dumb storage for the loop markers a performer made in each tune. No rules: it never
 *  validates, orders or merges. The list order it is given is the list order it hands back. */
export interface LoopPositionsStore {
  /** The tune's markers in list order; an empty list when none were saved. */
  load(identity: TuneIdentity): Promise<readonly LoopMarker[]>;
  /** Replaces the tune's markers with `markers`. An empty list removes the entry. */
  save(identity: TuneIdentity, markers: readonly LoopMarker[]): Promise<void>;
}

/** The dumb storage for sets. No rules: it never validates, orders or merges. */
export interface SetStore {
  /** Every saved set, in no particular order; an empty list when none. */
  list(): Promise<readonly SetSummary[]>;
  /** The set saved under `id`, or null when none is. */
  load(id: string): Promise<TuneSet | null>;
  /** Replaces the set saved under `set.id`, or saves it new. */
  save(set: TuneSet): Promise<void>;
  /** Removes the set saved under `id`; nothing happens when none is saved. */
  delete(id: string): Promise<void>;
}

/** The dumb storage for each tune's latest memory, keyed by its hash. No rules: it never
 *  validates or merges. */
export interface TuneMemoryStore {
  /** The memory saved for `sidHash`, or null when none is. */
  load(sidHash: string): Promise<TuneMemory | null>;
  /** Replaces the memory saved under `memory.sidHash`, or saves it new. */
  save(memory: TuneMemory): Promise<void>;
}
