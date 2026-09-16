import { describe, it, expect, vi } from 'vitest';
import { parseSidFile, SidParseError } from '@sidablist/core';
import { TUNE_INDEX_FORMAT_VERSION } from '@sidablist/analysis';
import type { TuneIndexRecord } from '@sidablist/analysis';
import { createTuneResolver } from './resolver.js';
import { InMemoryTuneStore } from './testing/in-memory-tune-store.js';
import { md5Hex } from './md5.js';
import { decodeBundledTune, STILL_TIME_BASE64 } from './__fixtures__/index.js';
import type { TuneIdentity } from './identity.js';

const STILL_TIME_BYTES = decodeBundledTune(STILL_TIME_BASE64);
const STILL_TIME_FILE = parseSidFile(STILL_TIME_BYTES);
const STILL_TIME_HASH = md5Hex(STILL_TIME_BYTES);
const IDENTITY: TuneIdentity = { sidHash: STILL_TIME_HASH, subtune: STILL_TIME_FILE.startSong };

function fakeIndexRecord(overrides: Partial<TuneIndexRecord> = {}): TuneIndexRecord {
  return {
    sidHash: IDENTITY.sidHash,
    subtune: IDENTITY.subtune,
    loopStartFrame: null,
    loopPeriodFrames: null,
    endedAtFrame: null,
    sectionBoundaries: [],
    detectedMoments: [],
    tonic: null,
    mode: null,
    camelot: null,
    tuningReferenceHz: null,
    tuningCents: null,
    keyConfidence: 'none',
    scalePitchClasses: [],
    dominantIntervalFrames: null,
    pulseConfidence: 'none',
    nativeTempo: null,
    callsPerFrame: 1,
    exactCallsPerFrame: 1,
    timingMode: 'exact',
    formatVersion: TUNE_INDEX_FORMAT_VERSION,
    computedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function seededStore(): Promise<InMemoryTuneStore> {
  const store = new InMemoryTuneStore();
  await store.putBytes(STILL_TIME_HASH, STILL_TIME_BYTES);
  return store;
}

function fakeIndexer() {
  const index = vi.fn(async (_bytes: Uint8Array, identity: TuneIdentity) =>
    fakeIndexRecord({ sidHash: identity.sidHash, subtune: identity.subtune }),
  );
  return { index };
}

describe('createTuneResolver', () => {
  it('resolves bytes and a stored current index without calling the indexer', async () => {
    const store = await seededStore();
    const record = fakeIndexRecord();
    await store.putIndex(record);
    const indexer = fakeIndexer();
    const resolver = createTuneResolver(store, indexer);

    const playable = await resolver.resolve(IDENTITY);

    expect(playable?.bytes).toEqual(STILL_TIME_BYTES);
    expect(playable?.index).toEqual(record);
    expect(indexer.index).not.toHaveBeenCalled();
  });

  it('indexes and stores on a missing index, calling the indexer once', async () => {
    const store = await seededStore();
    const indexer = fakeIndexer();
    const resolver = createTuneResolver(store, indexer);

    const playable = await resolver.resolve(IDENTITY);

    expect(indexer.index).toHaveBeenCalledTimes(1);
    expect(indexer.index).toHaveBeenCalledWith(STILL_TIME_BYTES, IDENTITY);
    expect(await store.getIndex(STILL_TIME_HASH, IDENTITY.subtune)).toEqual(playable?.index);
  });

  it('indexes and stores on a stale-version index, calling the indexer once', async () => {
    const store = await seededStore();
    await store.putIndex(fakeIndexRecord({ formatVersion: TUNE_INDEX_FORMAT_VERSION - 1 }));
    const indexer = fakeIndexer();
    const resolver = createTuneResolver(store, indexer);

    await resolver.resolve(IDENTITY);

    expect(indexer.index).toHaveBeenCalledTimes(1);
  });

  it('joins two concurrent resolves of one identity into a single indexer call and playable', async () => {
    const store = await seededStore();
    const indexer = fakeIndexer();
    const resolver = createTuneResolver(store, indexer);

    const [first, second] = await Promise.all([
      resolver.resolve(IDENTITY),
      resolver.resolve(IDENTITY),
    ]);

    expect(indexer.index).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('resolves null for an unknown hash', async () => {
    const store = new InMemoryTuneStore();
    const indexer = fakeIndexer();
    const resolver = createTuneResolver(store, indexer);

    const playable = await resolver.resolve({ sidHash: 'unknown-hash', subtune: 1 });

    expect(playable).toBeNull();
    expect(indexer.index).not.toHaveBeenCalled();
  });

  it('propagates an indexer rejection, and a following resolve calls the indexer again', async () => {
    const store = await seededStore();
    const index = vi.fn();
    index.mockRejectedValueOnce(new Error('scan failed'));
    index.mockResolvedValueOnce(fakeIndexRecord());
    const resolver = createTuneResolver(store, { index });

    await expect(resolver.resolve(IDENTITY)).rejects.toThrow('scan failed');
    const playable = await resolver.resolve(IDENTITY);

    expect(playable).not.toBeNull();
    expect(index).toHaveBeenCalledTimes(2);
  });

  it('throws RangeError for a subtune out of range, and never calls the indexer', async () => {
    const store = await seededStore();
    const indexer = fakeIndexer();
    const resolver = createTuneResolver(store, indexer);

    await expect(
      resolver.resolve({ sidHash: STILL_TIME_HASH, subtune: STILL_TIME_FILE.songs + 1 }),
    ).rejects.toThrow(RangeError);
    expect(indexer.index).not.toHaveBeenCalled();
  });

  it('rejects non-SID bytes with SidParseError', async () => {
    const store = new InMemoryTuneStore();
    await store.putBytes('bad-hash', new Uint8Array([1, 2, 3, 4]));
    const indexer = fakeIndexer();
    const resolver = createTuneResolver(store, indexer);

    await expect(resolver.resolve({ sidHash: 'bad-hash', subtune: 1 })).rejects.toThrow(
      SidParseError,
    );
  });

  describe('onScanStart', () => {
    it('fires once on a miss, before the indexer is called', async () => {
      const store = await seededStore();
      const indexer = fakeIndexer();
      const resolver = createTuneResolver(store, indexer);
      const onScanStart = vi.fn(() => {
        expect(indexer.index).not.toHaveBeenCalled();
      });

      await resolver.resolve(IDENTITY, { onScanStart });

      expect(onScanStart).toHaveBeenCalledTimes(1);
      expect(indexer.index).toHaveBeenCalledTimes(1);
    });

    it('does not fire on a lookup hit', async () => {
      const store = await seededStore();
      await store.putIndex(fakeIndexRecord());
      const indexer = fakeIndexer();
      const resolver = createTuneResolver(store, indexer);
      const onScanStart = vi.fn();

      await resolver.resolve(IDENTITY, { onScanStart });

      expect(onScanStart).not.toHaveBeenCalled();
    });

    it('does not fire when getBytes is null', async () => {
      const store = new InMemoryTuneStore();
      const indexer = fakeIndexer();
      const resolver = createTuneResolver(store, indexer);
      const onScanStart = vi.fn();

      const playable = await resolver.resolve(
        { sidHash: 'unknown-hash', subtune: 1 },
        { onScanStart },
      );

      expect(playable).toBeNull();
      expect(onScanStart).not.toHaveBeenCalled();
    });

    it('fires on a stale formatVersion', async () => {
      const store = await seededStore();
      await store.putIndex(fakeIndexRecord({ formatVersion: TUNE_INDEX_FORMAT_VERSION - 1 }));
      const indexer = fakeIndexer();
      const resolver = createTuneResolver(store, indexer);
      const onScanStart = vi.fn();

      await resolver.resolve(IDENTITY, { onScanStart });

      expect(onScanStart).toHaveBeenCalledTimes(1);
    });

    it('fires for both callers of two concurrent resolves sharing one scan', async () => {
      const store = await seededStore();
      const indexer = fakeIndexer();
      const resolver = createTuneResolver(store, indexer);
      const firstHook = vi.fn();
      const secondHook = vi.fn();

      await Promise.all([
        resolver.resolve(IDENTITY, { onScanStart: firstHook }),
        resolver.resolve(IDENTITY, { onScanStart: secondHook }),
      ]);

      expect(indexer.index).toHaveBeenCalledTimes(1);
      expect(firstHook).toHaveBeenCalledTimes(1);
      expect(secondHook).toHaveBeenCalledTimes(1);
    });

    it('fires immediately for a joiner arriving after the scan started', async () => {
      const store = await seededStore();
      let releaseIndex: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseIndex = resolve;
      });
      const index = vi.fn(async (bytes: Uint8Array, identity: TuneIdentity) => {
        await gate;
        return fakeIndexRecord({ sidHash: identity.sidHash, subtune: identity.subtune });
      });
      const resolver = createTuneResolver(store, { index });
      const firstHook = vi.fn(() => {
        // Scan has started: a joiner arriving now must be invoked synchronously, inline.
        const lateHook = vi.fn();
        resolver.resolve(IDENTITY, { onScanStart: lateHook });
        expect(lateHook).toHaveBeenCalledTimes(1);
      });

      const first = resolver.resolve(IDENTITY, { onScanStart: firstHook });
      releaseIndex?.();
      await first;

      expect(firstHook).toHaveBeenCalledTimes(1);
    });

    it('swallows a throwing hook without rejecting resolve or blocking a second hook', async () => {
      const store = await seededStore();
      const indexer = fakeIndexer();
      const resolver = createTuneResolver(store, indexer);
      const throwingHook = vi.fn(() => {
        throw new Error('boom');
      });
      const secondHook = vi.fn();

      const [first, second] = await Promise.all([
        resolver.resolve(IDENTITY, { onScanStart: throwingHook }),
        resolver.resolve(IDENTITY, { onScanStart: secondHook }),
      ]);

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(throwingHook).toHaveBeenCalledTimes(1);
      expect(secondHook).toHaveBeenCalledTimes(1);
    });
  });
});
