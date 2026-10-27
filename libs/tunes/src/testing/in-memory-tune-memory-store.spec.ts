import { describe, it, expect } from 'vitest';
import { InMemoryTuneMemoryStore } from './in-memory-tune-memory-store.js';
import type { TuneMemory } from '../tune-set.js';

function memory(sidHash: string, updated = '2026-01-01T00:00:00.000Z'): TuneMemory {
  return {
    sidHash,
    lastSubtune: 2,
    updated,
    subtunes: [
      {
        subtune: 2,
        settings: { gains: [1] },
        markers: [
          {
            id: 'm1',
            start: { frame: 1, offsetFrames: 0 },
            end: null,
            voices: [0, 1, 2],
            settings: { v: 1 },
          },
        ],
      },
    ],
  };
}

describe('InMemoryTuneMemoryStore', () => {
  it('round-trips a memory and replaces the one saved under the same hash', async () => {
    const store = new InMemoryTuneMemoryStore();

    await store.save(memory('h1'));
    expect(await store.load('h1')).toEqual(memory('h1'));

    await store.save(memory('h1', '2026-02-01T00:00:00.000Z'));
    expect((await store.load('h1'))?.updated).toBe('2026-02-01T00:00:00.000Z');
  });

  it('loads null for an unknown hash', async () => {
    const store = new InMemoryTuneMemoryStore();
    await store.save(memory('h1'));

    expect(await store.load('h2')).toBeNull();
  });

  it('is not changed by mutating what was passed to save', async () => {
    const store = new InMemoryTuneMemoryStore();
    const passed = memory('h1');
    await store.save(passed);

    (passed.subtunes[0].settings as { gains: number[] }).gains.push(2);
    (passed.subtunes[0].markers[0].settings as { v: number }).v = 9;

    expect(await store.load('h1')).toEqual(memory('h1'));
  });

  it('hands back memory that shares nothing with the stored one or with another load', async () => {
    const store = new InMemoryTuneMemoryStore();
    await store.save(memory('h1'));

    const first = (await store.load('h1')) as TuneMemory;
    (first.subtunes[0].settings as { gains: number[] }).gains.push(2);
    (first.subtunes as unknown[]).length = 0;

    expect(await store.load('h1')).toEqual(memory('h1'));
  });
});
