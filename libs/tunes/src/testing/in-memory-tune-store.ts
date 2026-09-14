import type { TuneIndexRecord } from '@sidablist/analysis';
import type { TuneStore } from '../ports.js';

/** A `Map`-backed `TuneStore` for consumers' specs — no persistence, no rules, just storage. */
export class InMemoryTuneStore implements TuneStore {
  private readonly bytesByHash = new Map<string, Uint8Array>();
  private readonly indexByKey = new Map<string, TuneIndexRecord>();

  async getBytes(sidHash: string): Promise<Uint8Array | null> {
    return this.bytesByHash.get(sidHash) ?? null;
  }

  async putBytes(sidHash: string, bytes: Uint8Array): Promise<void> {
    this.bytesByHash.set(sidHash, bytes);
  }

  async getIndex(sidHash: string, subtune: number): Promise<TuneIndexRecord | null> {
    return this.indexByKey.get(`${sidHash}:${subtune}`) ?? null;
  }

  async putIndex(record: TuneIndexRecord): Promise<void> {
    this.indexByKey.set(`${record.sidHash}:${record.subtune}`, record);
  }
}
