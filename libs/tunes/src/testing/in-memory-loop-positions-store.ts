import type { LoopMarker } from '../loop-marker.js';
import type { LoopPositionsStore } from '../ports.js';
import type { TuneIdentity } from '../identity.js';

/**
 * A `Map`-backed `LoopPositionsStore`: the session implementation a host supplies until a permanent
 * one replaces it behind the same port, and a handy stand-in in consumers' specs. Lists are copied
 * on the way in and on the way out, so no caller can change what is stored by mutating its array.
 */
export class InMemoryLoopPositionsStore implements LoopPositionsStore {
  private readonly markersByKey = new Map<string, readonly LoopMarker[]>();

  async load(identity: TuneIdentity): Promise<readonly LoopMarker[]> {
    const markers = this.markersByKey.get(`${identity.sidHash}:${identity.subtune}`);
    return Object.freeze([...(markers ?? [])]);
  }

  async save(identity: TuneIdentity, markers: readonly LoopMarker[]): Promise<void> {
    const key = `${identity.sidHash}:${identity.subtune}`;
    if (markers.length === 0) {
      this.markersByKey.delete(key);
      return;
    }
    this.markersByKey.set(key, Object.freeze([...markers]));
  }
}
