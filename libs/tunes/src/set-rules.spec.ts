import { describe, it, expect } from 'vitest';
import {
  addRow,
  changeRowMemory,
  createRow,
  createSet,
  editRowMemory,
  editRowSubtune,
  findRow,
  moveRow,
  nextPlaceholder,
  removeRow,
  renameSet,
  subtuneMemoryOf,
  summaryOf,
  tuneMemoryOf,
} from './set-rules.js';
import type { LoopMarker } from './loop-marker.js';
import type { RowTune, SetRow, TuneMemory, TuneSet } from './tune-set.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const T2 = '2026-01-03T00:00:00.000Z';

function tune(sidHash: string, subtuneCount = 3): RowTune {
  return { sidHash, title: sidHash, author: 'A', released: '1985', subtuneCount, byteLength: 10 };
}

function marker(id: string, settings?: { gains: number[] }): LoopMarker {
  return {
    id,
    start: { frame: 1, offsetFrames: 0 },
    end: null,
    voices: [0, 1, 2],
    ...(settings ? { settings } : {}),
  };
}

function row(id: string, sidHash: string, subtuneCount = 3): SetRow {
  return createRow({ id, tune: tune(sidHash, subtuneCount), memory: null, startSubtune: 1 });
}

function setOf(...rows: SetRow[]): TuneSet {
  return { ...createSet({ id: 's', placeholder: 'Set 1', now: T0 }), rows };
}

const ids = (set: TuneSet): string[] => set.rows.map((r) => r.id);

describe('createSet and nextPlaceholder', () => {
  it('creates an empty set named after its placeholder', () => {
    expect(createSet({ id: 's', placeholder: 'Set 4', now: T0 })).toEqual({
      id: 's',
      name: 'Set 4',
      placeholder: 'Set 4',
      rows: [],
      created: T0,
      updated: T0,
    });
  });

  it('numbers one past the highest "Set N"', () => {
    expect(nextPlaceholder(['Set 1', 'Set 7', 'Set 3'])).toBe('Set 8');
  });

  it('starts at Set 1 and ignores names that are not exactly "Set N"', () => {
    expect(nextPlaceholder([])).toBe('Set 1');
    expect(nextPlaceholder(['Friday', 'Set 9 mix', 'my Set 5', 'Set', 'Set 2.5', ' Set 6'])).toBe(
      'Set 1',
    );
  });
});

describe('createRow', () => {
  const memory: TuneMemory = {
    sidHash: 'h1',
    lastSubtune: 2,
    updated: T1,
    subtunes: [{ subtune: 2, markers: [marker('m', { gains: [1] })], settings: { v: 1 } }],
  };

  it('copies the memory, links back to it and takes its last subtune', () => {
    const created = createRow({ id: 'r', tune: tune('h1'), memory, startSubtune: 3 });

    expect(created.copiedFrom).toEqual({ sidHash: 'h1', updated: T1 });
    expect(created.lastSubtune).toBe(2);
    expect(created.subtunes).toEqual(memory.subtunes);
  });

  it('carries a marker wraps flag through the copy, and leaves it absent when absent', () => {
    const flagged: TuneMemory = {
      ...memory,
      subtunes: [
        {
          subtune: 1,
          markers: [
            { ...marker('w'), end: { frame: 9, offsetFrames: 0 }, wraps: true },
            { ...marker('n'), end: { frame: 9, offsetFrames: 0 } },
          ],
        },
      ],
    };

    const created = createRow({ id: 'r', tune: tune('h1'), memory: flagged, startSubtune: 1 });

    const [wrapping, plain] = created.subtunes[0].markers;
    expect(wrapping.wraps).toBe(true);
    expect('wraps' in plain).toBe(false);
  });

  it('starts empty on startSubtune, clamped, without a memory', () => {
    const created = createRow({ id: 'r', tune: tune('h1'), memory: null, startSubtune: 9 });

    expect(created.copiedFrom).toBeNull();
    expect(created.subtunes).toEqual([]);
    expect(created.lastSubtune).toBe(3);
    expect(
      createRow({ id: 'r', tune: tune('h1'), memory: null, startSubtune: 0 }).lastSubtune,
    ).toBe(1);
  });

  it('throws for a memory of another tune', () => {
    expect(() => createRow({ id: 'r', tune: tune('h2'), memory, startSubtune: 1 })).toThrow(
      RangeError,
    );
  });

  it('shares nothing with the memory it copied, both ways', () => {
    const created = createRow({
      id: 'r',
      tune: tune('h1'),
      memory,
      startSubtune: 1,
      host: { path: ['a'] },
    });

    (created.subtunes[0].settings as { v: number }).v = 99;
    (created.subtunes[0].markers[0].settings as { gains: number[] }).gains.push(2);
    expect(memory.subtunes[0].settings).toEqual({ v: 1 });
    expect(memory.subtunes[0].markers[0].settings).toEqual({ gains: [1] });

    const back = tuneMemoryOf(created, T2);
    (back.subtunes[0].markers[0].settings as { gains: number[] }).gains.push(3);
    expect(created.subtunes[0].markers[0].settings).toEqual({ gains: [1, 2] });
  });
});

describe('addRow, findRow, moveRow, removeRow, renameSet', () => {
  it('appends, or inserts at a clamped index, and stamps the set', () => {
    const base = setOf(row('a', 'h1'), row('b', 'h2'));

    const appended = addRow(base, row('c', 'h3'), null, T1);
    expect(appended.added).toBe(true);
    expect(ids(appended.set)).toEqual(['a', 'b', 'c']);
    expect(appended.set.updated).toBe(T1);

    expect(ids(addRow(base, row('c', 'h3'), 1, T1).set)).toEqual(['a', 'c', 'b']);
    expect(ids(addRow(base, row('c', 'h3'), 99, T1).set)).toEqual(['a', 'b', 'c']);
    expect(ids(addRow(base, row('c', 'h3'), -5, T1).set)).toEqual(['c', 'a', 'b']);
  });

  it('returns the existing row for a SID already in the set', () => {
    const base = setOf(row('a', 'h1'));

    const result = addRow(base, row('other-id', 'h1'), 0, T1);

    expect(result.added).toBe(false);
    expect(result.set).toBe(base);
    expect(result.row).toBe(base.rows[0]);
    expect(findRow(base, 'h1')).toBe(base.rows[0]);
    expect(findRow(base, 'zz')).toBeNull();
  });

  it('moves a row to its final position, clamped', () => {
    const base = setOf(row('a', 'h1'), row('b', 'h2'), row('c', 'h3'));

    expect(ids(moveRow(base, 'a', 2, T1))).toEqual(['b', 'c', 'a']);
    expect(ids(moveRow(base, 'c', 0, T1))).toEqual(['c', 'a', 'b']);
    expect(ids(moveRow(base, 'a', 99, T1))).toEqual(['b', 'c', 'a']);
    expect(ids(moveRow(base, 'c', -4, T1))).toEqual(['c', 'a', 'b']);
    expect(moveRow(base, 'a', 2, T1).updated).toBe(T1);
  });

  it('removes a row', () => {
    const base = setOf(row('a', 'h1'), row('b', 'h2'));

    const removed = removeRow(base, 'a', T1);

    expect(ids(removed)).toEqual(['b']);
    expect(removed.updated).toBe(T1);
  });

  it('renames with trimming and falls back to the placeholder when empty', () => {
    const base = setOf();

    const renamed = renameSet(base, '  Friday  ', T1);
    expect(renamed.name).toBe('Friday');
    expect(renamed.updated).toBe(T1);

    expect(renameSet(renamed, '   ', T2).name).toBe('Set 1');
  });

  it('returns the same set, keeping its stamp, when nothing changes', () => {
    const base = setOf(row('a', 'h1'), row('b', 'h2'));

    expect(moveRow(base, 'a', 0, T1)).toBe(base);
    expect(moveRow(base, 'zz', 0, T1)).toBe(base);
    expect(removeRow(base, 'zz', T1)).toBe(base);
    expect(renameSet(base, 'Set 1', T1)).toBe(base);
    expect(renameSet(base, '  ', T1)).toBe(base);
  });
});

describe('changeRowMemory', () => {
  it('adds subtune entries in ascending order, one per subtune', () => {
    let r = row('a', 'h1');
    r = changeRowMemory(r, 3, { markers: [marker('m3')] });
    r = changeRowMemory(r, 1, { settings: { v: 1 } });
    r = changeRowMemory(r, 3, { markers: [marker('m3'), marker('m3b')] });

    expect(r.subtunes.map((s) => s.subtune)).toEqual([1, 3]);
    expect(r.subtunes[1].markers.map((m) => m.id)).toEqual(['m3', 'm3b']);
    expect(subtuneMemoryOf(r, 1)?.settings).toEqual({ v: 1 });
    expect(subtuneMemoryOf(r, 2)).toBeNull();
  });

  it('keeps what a change leaves absent, and clears settings with null', () => {
    let r = changeRowMemory(row('a', 'h1'), 1, { markers: [marker('m')], settings: { v: 1 } });

    r = changeRowMemory(r, 1, { markers: [marker('m'), marker('n')] });
    expect(subtuneMemoryOf(r, 1)?.settings).toEqual({ v: 1 });

    r = changeRowMemory(r, 1, { settings: null });
    expect(subtuneMemoryOf(r, 1)?.settings).toBeUndefined();
    expect(subtuneMemoryOf(r, 1)?.markers).toHaveLength(2);
  });

  it('drops an entry left with no markers and no settings, keeping the order', () => {
    let r = changeRowMemory(row('a', 'h1'), 1, { markers: [marker('m')] });
    r = changeRowMemory(r, 2, { markers: [marker('n')] });
    r = changeRowMemory(r, 3, { settings: { v: 1 } });

    r = changeRowMemory(r, 2, { markers: [] });

    expect(r.subtunes.map((s) => s.subtune)).toEqual([1, 3]);
    expect(changeRowMemory(r, 3, { settings: null }).subtunes.map((s) => s.subtune)).toEqual([1]);
  });

  it('throws for a subtune the tune does not have', () => {
    const r = row('a', 'h1', 3);

    expect(() => changeRowMemory(r, 0, { markers: [] })).toThrow(RangeError);
    expect(() => changeRowMemory(r, 4, { markers: [] })).toThrow(RangeError);
  });

  it('returns the same row when nothing changes', () => {
    const r = changeRowMemory(row('a', 'h1'), 1, { markers: [marker('m')], settings: { v: 1 } });

    expect(changeRowMemory(r, 1, {})).toBe(r);
    expect(changeRowMemory(r, 1, { markers: [marker('m')] })).toBe(r);
    expect(changeRowMemory(r, 2, { markers: [] })).toBe(r);
  });

  it('copies what it is given, and the source row stays as it was', () => {
    const source = row('a', 'h1');
    const given = marker('m', { gains: [1] });

    const changed = changeRowMemory(source, 1, { markers: [given] });
    (given.settings as { gains: number[] }).gains.push(2);
    (changed.subtunes[0].markers[0].settings as { gains: number[] }).gains.push(3);

    expect(source.subtunes).toEqual([]);
    expect(given.settings).toEqual({ gains: [1, 2] });
  });
});

describe('editRowMemory and editRowSubtune', () => {
  const base = setOf(row('a', 'h1'), row('b', 'h2'));

  it('changes only that row, and returns its whole memory as the tune latest, stamped now', () => {
    const edit = editRowMemory(base, 'a', 2, { markers: [marker('m')] }, T1);

    expect(edit).not.toBeNull();
    const { set, row: edited, memory } = edit!;
    expect(set.updated).toBe(T1);
    expect(set.rows[0]).toBe(edited);
    expect(set.rows[1]).toBe(base.rows[1]);
    expect(memory).toEqual({
      sidHash: 'h1',
      lastSubtune: edited.lastSubtune,
      subtunes: edited.subtunes,
      updated: T1,
    });
    expect(memory.subtunes).not.toBe(edited.subtunes);
    expect(base.rows[0].subtunes).toEqual([]);
  });

  it('returns null for an unknown row', () => {
    expect(editRowMemory(base, 'zz', 1, { markers: [] }, T1)).toBeNull();
    expect(editRowSubtune(base, 'zz', 1, T1)).toBeNull();
  });

  it('selects a clamped subtune and carries it into the memory', () => {
    const edit = editRowSubtune(base, 'a', 99, T1)!;

    expect(edit.row.lastSubtune).toBe(3);
    expect(edit.memory.lastSubtune).toBe(3);
    expect(edit.set.updated).toBe(T1);
    expect(edit.set.rows[1]).toBe(base.rows[1]);
  });

  it('keeps the set and its stamp when the edit changes nothing', () => {
    const same = editRowSubtune(base, 'a', 1, T1)!;
    expect(same.set).toBe(base);
    expect(same.set.updated).toBe(T0);

    expect(editRowMemory(base, 'a', 1, {}, T1)!.set).toBe(base);
  });

  it('shares nothing between the returned memory and the row', () => {
    const edit = editRowMemory(base, 'a', 1, { markers: [marker('m', { gains: [1] })] }, T1)!;

    (edit.memory.subtunes[0].markers[0].settings as { gains: number[] }).gains.push(2);
    (edit.row.subtunes[0].markers[0].settings as { gains: number[] }).gains.push(3);

    expect(edit.memory.subtunes[0].markers[0].settings).toEqual({ gains: [1, 2] });
    expect(edit.row.subtunes[0].markers[0].settings).toEqual({ gains: [1, 3] });
  });
});

describe('summaryOf', () => {
  it('summarises a set', () => {
    expect(summaryOf({ ...setOf(row('a', 'h1')), name: 'Friday', updated: T1 })).toEqual({
      id: 's',
      name: 'Friday',
      rowCount: 1,
      updated: T1,
    });
  });
});
