import type { SetStore } from '../ports.js';
import { copyTuneSet } from '../plain-copy.js';
import { summaryOf } from '../set-rules.js';
import type { SetSummary, TuneSet } from '../tune-set.js';

/**
 * A `Map`-backed `SetStore`: the session implementation a host supplies until a permanent one
 * replaces it behind the same port, and a handy stand-in in consumers' specs. Sets are deep-copied
 * on the way in and on the way out, so no caller can change what is stored, and no two loads
 * share a reference.
 */
export class InMemorySetStore implements SetStore {
  private readonly setsById = new Map<string, TuneSet>();

  async list(): Promise<readonly SetSummary[]> {
    return Object.freeze([...this.setsById.values()].map(summaryOf));
  }

  async load(id: string): Promise<TuneSet | null> {
    const set = this.setsById.get(id);
    return set ? copyTuneSet(set) : null;
  }

  async save(set: TuneSet): Promise<void> {
    this.setsById.set(set.id, copyTuneSet(set));
  }

  async delete(id: string): Promise<void> {
    this.setsById.delete(id);
  }
}
