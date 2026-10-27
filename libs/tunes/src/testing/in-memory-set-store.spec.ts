import { describe, it, expect } from 'vitest';
import { InMemorySetStore } from './in-memory-set-store.js';
import type { SetRow, TuneSet } from '../tune-set.js';

function row(id: string, sidHash: string): SetRow {
  return {
    id,
    tune: { sidHash, title: 'T', author: 'A', released: '1985', subtuneCount: 2, byteLength: 100 },
    copiedFrom: { sidHash, updated: '2026-01-01T00:00:00.000Z' },
    lastSubtune: 1,
    subtunes: [
      {
        subtune: 1,
        settings: { v: 1, gains: [1, 2] },
        markers: [
          {
            id: 'm1',
            name: 'Drum break',
            start: { frame: 10, offsetFrames: 0 },
            end: { frame: 20, offsetFrames: 1 },
            voices: [0, 1, 2],
            settings: { v: 1 },
          },
        ],
      },
    ],
    host: { where: { path: ['a', 'b'] } },
  };
}

function set(id: string, rows: SetRow[] = []): TuneSet {
  return {
    id,
    name: `Name ${id}`,
    placeholder: 'Set 1',
    rows,
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-02T00:00:00.000Z',
  };
}

describe('InMemorySetStore', () => {
  it('round-trips a set and replaces the one saved under the same id', async () => {
    const store = new InMemorySetStore();
    const saved = set('a', [row('r1', 'h1')]);

    await store.save(saved);
    expect(await store.load('a')).toEqual(saved);

    await store.save({ ...saved, name: 'Renamed' });
    expect((await store.load('a'))?.name).toBe('Renamed');
  });

  it('loads null for an unknown id', async () => {
    expect(await new InMemorySetStore().load('nope')).toBeNull();
  });

  it('lists a summary for every set, and nothing when empty', async () => {
    const store = new InMemorySetStore();
    expect(await store.list()).toEqual([]);

    await store.save(set('a', [row('r1', 'h1'), row('r2', 'h2')]));
    await store.save(set('b'));

    const summaries = [...(await store.list())].sort((x, y) => x.id.localeCompare(y.id));
    expect(summaries).toEqual([
      { id: 'a', name: 'Name a', rowCount: 2, updated: '2026-01-02T00:00:00.000Z' },
      { id: 'b', name: 'Name b', rowCount: 0, updated: '2026-01-02T00:00:00.000Z' },
    ]);
  });

  it('deletes a set, and ignores an id that is not saved', async () => {
    const store = new InMemorySetStore();
    await store.save(set('a'));

    await store.delete('a');
    await store.delete('a');

    expect(await store.load('a')).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it('is not changed by mutating what was passed to save', async () => {
    const store = new InMemorySetStore();
    const passed = set('a', [row('r1', 'h1')]);
    await store.save(passed);

    const settings = passed.rows[0].subtunes[0].settings as { gains: number[] };
    settings.gains.push(3);
    (passed.rows[0].subtunes[0].markers as unknown[]).length = 0;

    expect(await store.load('a')).toEqual(set('a', [row('r1', 'h1')]));
  });

  it('hands back sets that share nothing with the stored one or with another load', async () => {
    const store = new InMemorySetStore();
    await store.save(set('a', [row('r1', 'h1')]));

    const first = (await store.load('a')) as TuneSet;
    const settings = first.rows[0].subtunes[0].settings as { gains: number[] };
    settings.gains.push(3);
    (first.rows[0].host as { where: { path: string[] } }).where.path.push('c');
    const second = (await store.load('a')) as TuneSet;

    expect(second).toEqual(set('a', [row('r1', 'h1')]));
    expect(second.rows[0]).not.toBe(first.rows[0]);
  });
});
