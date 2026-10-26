import { describe, it, expect } from 'vitest';
import type { LoopMarker } from '../loop-marker.js';
import type { TuneIdentity } from '../identity.js';
import { InMemoryLoopPositionsStore } from './in-memory-loop-positions-store.js';

const IDENTITY: TuneIdentity = { sidHash: 'aaaa', subtune: 1 };
const OTHER_SUBTUNE: TuneIdentity = { sidHash: 'aaaa', subtune: 2 };
const OTHER_FILE: TuneIdentity = { sidHash: 'bbbb', subtune: 1 };

function marker(id: string, frame: number): LoopMarker {
  return {
    id,
    start: { frame, offsetFrames: 0 },
    end: { frame: frame + 100, offsetFrames: -2 },
    voices: [0, 1, 2],
  };
}

describe('InMemoryLoopPositionsStore', () => {
  it('loads back the markers saved for a tune in the order they were saved', async () => {
    const store = new InMemoryLoopPositionsStore();
    const markers = [marker('b', 500), marker('a', 100), marker('c', 300)];

    await store.save(IDENTITY, markers);

    expect(await store.load(IDENTITY)).toEqual(markers);
  });

  it('keeps each subtune and each file isolated', async () => {
    const store = new InMemoryLoopPositionsStore();
    const saved = [marker('a', 100)];

    await store.save(IDENTITY, saved);

    expect(await store.load(OTHER_SUBTUNE)).toEqual([]);
    expect(await store.load(OTHER_FILE)).toEqual([]);
    expect(await store.load(IDENTITY)).toEqual(saved);
  });

  it('replaces the whole list on save', async () => {
    const store = new InMemoryLoopPositionsStore();

    await store.save(IDENTITY, [marker('a', 100), marker('b', 200)]);
    await store.save(IDENTITY, [marker('c', 300)]);

    expect(await store.load(IDENTITY)).toEqual([marker('c', 300)]);
  });

  it('removes the entry when saving an empty list', async () => {
    const store = new InMemoryLoopPositionsStore();
    await store.save(IDENTITY, [marker('a', 100)]);

    await store.save(IDENTITY, []);

    expect(await store.load(IDENTITY)).toEqual([]);
  });

  it('is not changed by mutating the array passed to save', async () => {
    const store = new InMemoryLoopPositionsStore();
    const passed: LoopMarker[] = [marker('a', 100)];

    await store.save(IDENTITY, passed);
    passed.push(marker('b', 200));
    passed[0] = marker('z', 999);

    expect(await store.load(IDENTITY)).toEqual([marker('a', 100)]);
  });

  it('hands back a list that is separate from the stored one on every load', async () => {
    const store = new InMemoryLoopPositionsStore();
    await store.save(IDENTITY, [marker('a', 100)]);

    const first = await store.load(IDENTITY);
    const second = await store.load(IDENTITY);

    expect(first).not.toBe(second);
    expect(second).toEqual([marker('a', 100)]);
  });
});
