import { parseSidFile } from '@sidablist/core';
import { md5Hex } from './md5.js';
import { referenceFor } from './reference.js';
import type { TuneReference } from './reference.js';
import type { TuneStore } from './ports.js';

/** Puts a tune's bytes in the store, keyed by their content hash. Idempotent by construction: a
 *  second insert of the same bytes puts again and returns an equal reference. */
export interface TuneInserter {
  insert(bytes: Uint8Array): Promise<TuneReference>;
}

export function createTuneInserter(store: TuneStore): TuneInserter {
  return {
    async insert(bytes: Uint8Array): Promise<TuneReference> {
      const file = parseSidFile(bytes);
      const sidHash = md5Hex(bytes);
      await store.putBytes(sidHash, bytes);
      return referenceFor(file, { sidHash, subtune: file.startSong }, bytes.byteLength);
    },
  };
}
