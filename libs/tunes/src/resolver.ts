import { parseSidFile } from '@sidablist/core';
import { TUNE_INDEX_FORMAT_VERSION } from '@sidablist/analysis';
import type { TuneIndexRecord } from '@sidablist/analysis';
import type { TuneIdentity } from './identity.js';
import type { Playable } from './playable.js';
import type { TuneIndexer, TuneStore } from './ports.js';
import { referenceFor } from './reference.js';

/** Options a caller may pass to `TuneResolver.resolve`. */
export interface ResolveOptions {
  /** Called once, synchronously, immediately before the indexer is asked to scan — only when the
   *  store holds no index for this identity at the current format version. Never called on a
   *  lookup hit. */
  readonly onScanStart?: () => void;
}

/** Resolves an identity to bytes plus a current index — never handing back bytes without one. */
export interface TuneResolver {
  resolve(identity: TuneIdentity, options?: ResolveOptions): Promise<Playable | null>;
}

/** An in-flight resolve, shared by every caller resolving the same identity concurrently. */
interface InFlightEntry {
  promise: Promise<Playable | null>;
  scanStarted: boolean;
  readonly pendingHooks: (() => void)[];
}

/**
 * Builds the resolver: `getBytes` → `null` short-circuits to `null`; otherwise the bytes are
 * parsed to build the reference and validate the subtune, the store's index is used as-is when
 * its `formatVersion` matches, and a miss indexes once and persists the result. In-flight resolves
 * of the same identity share one promise — the POC's `SharedTuneIndex.produceOnce` rule, moved
 * here verbatim in spirit — so a host never scans the same tune twice concurrently.
 */
export function createTuneResolver(store: TuneStore, indexer: TuneIndexer): TuneResolver {
  const inFlight = new Map<string, InFlightEntry>();

  return {
    resolve(identity: TuneIdentity, options?: ResolveOptions): Promise<Playable | null> {
      const key = `${identity.sidHash}:${identity.subtune}`;
      const existing = inFlight.get(key);
      if (existing !== undefined) {
        const onScanStart = options?.onScanStart;
        if (onScanStart !== undefined) {
          // Joined after the scan decision: the hook never gets queued, so fire it right here.
          // Joined before: queue it to run alongside the first caller's when the scan starts.
          if (existing.scanStarted) {
            runHookSafely(onScanStart);
          } else {
            existing.pendingHooks.push(onScanStart);
          }
        }
        return existing.promise;
      }

      const entry: InFlightEntry = {
        // Replaced synchronously below. `notifyScanStart` needs `entry` to close over, and
        // `entry.promise` needs `notifyScanStart` to exist first — this placeholder breaks that
        // cycle and is never observed, since nothing else can run before it is overwritten.
        promise: Promise.resolve(null),
        scanStarted: false,
        pendingHooks: options?.onScanStart ? [options.onScanStart] : [],
      };
      inFlight.set(key, entry);

      const notifyScanStart = (): void => {
        entry.scanStarted = true;
        const hooks = entry.pendingHooks.splice(0, entry.pendingHooks.length);
        for (const hook of hooks) {
          runHookSafely(hook);
        }
      };

      // Deleted in `finally` rather than on success only, so a rejected scan is never cached and
      // the next resolve of this identity scans again instead of replaying the failure.
      entry.promise = resolveOnce(store, indexer, identity, notifyScanStart).finally(() => {
        inFlight.delete(key);
      });
      return entry.promise;
    },
  };
}

/**
 * Runs a caller's `onScanStart` in isolation. This package has no logger, and a hook is a host's
 * side effect, not part of the resolve contract — a throw here must never reject the shared
 * resolve, nor stop another queued hook from running, nor make a late joiner's synchronous
 * `resolve` call throw.
 */
function runHookSafely(hook: () => void): void {
  try {
    hook();
  } catch {
    // Swallowed — see the doc comment above.
  }
}

async function resolveOnce(
  store: TuneStore,
  indexer: TuneIndexer,
  identity: TuneIdentity,
  notifyScanStart: () => void,
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
  let index: TuneIndexRecord;
  if (stored !== null && stored.formatVersion === TUNE_INDEX_FORMAT_VERSION) {
    index = stored;
  } else {
    notifyScanStart();
    index = await indexAndStore(store, indexer, bytes, identity);
  }

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
