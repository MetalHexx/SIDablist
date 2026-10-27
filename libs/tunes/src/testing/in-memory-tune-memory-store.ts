import type { TuneMemoryStore } from '../ports.js';
import { copyTuneMemory } from '../plain-copy.js';
import type { TuneMemory } from '../tune-set.js';

/**
 * A `Map`-backed `TuneMemoryStore`: the session implementation a host supplies until a permanent
 * one replaces it behind the same port, and a handy stand-in in consumers' specs. Memory is
 * deep-copied on the way in and on the way out, so no caller can change what is stored.
 */
export class InMemoryTuneMemoryStore implements TuneMemoryStore {
  private readonly memoryByHash = new Map<string, TuneMemory>();

  async load(sidHash: string): Promise<TuneMemory | null> {
    const memory = this.memoryByHash.get(sidHash);
    return memory ? copyTuneMemory(memory) : null;
  }

  async save(memory: TuneMemory): Promise<void> {
    this.memoryByHash.set(memory.sidHash, copyTuneMemory(memory));
  }
}
