import { parseSidFile } from '@sidablist/core';
import { TUNE_INDEX_FORMAT_VERSION } from '@sidablist/analysis';
import type { TuneIndexRecord } from '@sidablist/analysis';
import type { TuneIdentity } from './identity.js';
import type { Playable } from './playable.js';
import type { TuneIndexer, TuneStore } from './ports.js';
import { referenceFor } from './reference.js';

/** Resolves an identity to bytes plus a current index — never handing back bytes without one. */
export interface TuneResolver {
  resolve(identity: TuneIdentity): Promise<Playable | null>;
}

/**
 * Builds the resolver: `getBytes` → `null` short-circuits to `null`; otherwise the bytes are
 * parsed to build the reference and validate the subtune, the store's index is used as-is when
 * its `formatVersion` matches, and a miss indexes once and persists the result. In-flight resolves
 * of the same identity share one promise — the POC's `SharedTuneIndex.produceOnce` rule, moved
 * here verbatim in spirit — so a host never scans the same tune twice concurrently.
 */
export function createTuneResolver(store: TuneStore, indexer: TuneIndexer): TuneResolver {
  const inFlight = new Map<string, Promise<Playable | null>>();

  return {
    resolve(identity: TuneIdentity): Promise<Playable | null> {
      const key = `${identity.sidHash}:${identity.subtune}`;
      const existing = inFlight.get(key);
      if (existing !== undefined) {
        return existing;
      }

      // Deleted in `finally` rather than on success only, so a rejected scan is never cached and
      // the next resolve of this identity scans again instead of replaying the failure.
      const promise = resolveOnce(store, indexer, identity).finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, promise);
      return promise;
    },
  };
}

async function resolveOnce(
  store: TuneStore,
  indexer: TuneIndexer,
  identity: TuneIdentity,
): Promise<Playable | null> {
  const { sidHash, subtune } = identity;
  const bytes = await store.getBytes(sidHash);
  if (bytes === null) {
    return null;
  }

  const file = parseSidFile(bytes);
  if (subtune < 1 || subtune > file.songs) {
    throw new RangeError(
      `subtune ${subtune} is out of range for ${sidHash} (file has ${file.songs} subtune(s))`,
    );
  }
  const reference = referenceFor(file, identity, bytes.byteLength);

  const stored = await store.getIndex(sidHash, subtune);
  const index =
    stored !== null && stored.formatVersion === TUNE_INDEX_FORMAT_VERSION
      ? stored
      : await indexAndStore(store, indexer, bytes, identity);

  return { reference, bytes, index };
}

async function indexAndStore(
  store: TuneStore,
  indexer: TuneIndexer,
  bytes: Uint8Array,
  identity: TuneIdentity,
): Promise<TuneIndexRecord> {
  const record = await indexer.index(bytes, identity);
  await store.putIndex(record);
  return record;
}
