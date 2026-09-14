import type { TuneIndexRecord } from '@sidablist/analysis';
import type { TuneIdentity } from './identity.js';

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
