import { copyPlain, copySubtunes, copyTuneMemory } from './plain-copy.js';
import type { PlainValue } from './loop-marker.js';
import type {
  RowEdit,
  RowTune,
  SetRow,
  SetSummary,
  SubtuneChange,
  SubtuneMemory,
  TuneMemory,
  TuneSet,
} from './tune-set.js';

/*
 * The rules for sets and tune memory. Pure: ids and the time come from the caller, nothing here
 * reads a clock or mints an id, and a change that changes nothing returns its input object.
 */

const PLACEHOLDER = /^Set (\d+)$/;

/** A new, empty set named after its placeholder. */
export function createSet(input: { id: string; placeholder: string; now: string }): TuneSet {
  return {
    id: input.id,
    name: input.placeholder,
    placeholder: input.placeholder,
    rows: [],
    created: input.now,
    updated: input.now,
  };
}

/** "Set N", one past the highest N among `names` that read exactly "Set N"; "Set 1" when none do. */
export function nextPlaceholder(names: readonly string[]): string {
  let highest = 0;
  for (const name of names) {
    const match = PLACEHOLDER.exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `Set ${highest + 1}`;
}

/**
 * A row for `tune`, copying `memory` deeply when the tune has one. Its `lastSubtune` is the
 * memory's, else `startSubtune`, clamped to the tune's subtunes.
 * @throws RangeError when `memory` belongs to another tune.
 */
export function createRow(input: {
  id: string;
  tune: RowTune;
  host?: PlainValue;
  memory: TuneMemory | null;
  startSubtune: number;
}): SetRow {
  const { id, tune, host, memory, startSubtune } = input;
  if (memory && memory.sidHash !== tune.sidHash) {
    throw new RangeError('The tune memory belongs to a different tune than the row.');
  }
  return {
    id,
    tune: { ...tune },
    copiedFrom: memory ? { sidHash: memory.sidHash, updated: memory.updated } : null,
    lastSubtune: clampSubtune(memory?.lastSubtune ?? startSubtune, tune.subtuneCount),
    subtunes: memory ? copySubtunes(memory.subtunes) : [],
    ...(host === undefined ? {} : { host: copyPlain(host) }),
  };
}

/** The row holding the tune with `sidHash`, or null. */
export function findRow(set: TuneSet, sidHash: string): SetRow | null {
  return set.rows.find((row) => row.tune.sidHash === sidHash) ?? null;
}

/**
 * Adds `row` at `index` (clamped to the list; appended when null). A tune already in the set is
 * not added again: the set comes back as it is with the existing row and `added: false`.
 */
export function addRow(
  set: TuneSet,
  row: SetRow,
  index: number | null,
  now: string,
): { readonly set: TuneSet; readonly row: SetRow; readonly added: boolean } {
  const existing = findRow(set, row.tune.sidHash);
  if (existing) return { set, row: existing, added: false };
  const at = index === null ? set.rows.length : clampIndex(index, set.rows.length);
  const rows = [...set.rows.slice(0, at), row, ...set.rows.slice(at)];
  return { set: { ...set, rows, updated: now }, row, added: true };
}

/** Moves the row so it ends at `toIndex` (clamped to the list) once it is taken out. */
export function moveRow(set: TuneSet, rowId: string, toIndex: number, now: string): TuneSet {
  const from = set.rows.findIndex((row) => row.id === rowId);
  if (from < 0) return set;
  const to = clampIndex(toIndex, set.rows.length - 1);
  if (to === from) return set;
  const rows = set.rows.filter((row) => row.id !== rowId);
  rows.splice(to, 0, set.rows[from]);
  return { ...set, rows, updated: now };
}

/** Removes the row; a set without it comes back as it is. */
export function removeRow(set: TuneSet, rowId: string, now: string): TuneSet {
  if (!set.rows.some((row) => row.id === rowId)) return set;
  return { ...set, rows: set.rows.filter((row) => row.id !== rowId), updated: now };
}

/** Renames the set to `name` trimmed; an empty name falls back to the placeholder. */
export function renameSet(set: TuneSet, name: string, now: string): TuneSet {
  const next = name.trim() || set.placeholder;
  return next === set.name ? set : { ...set, name: next, updated: now };
}

/** What a row or tune memory holds for `subtune`, or null when it holds nothing. */
export function subtuneMemoryOf(
  source: SetRow | TuneMemory,
  subtune: number,
): SubtuneMemory | null {
  return source.subtunes.find((entry) => entry.subtune === subtune) ?? null;
}

/**
 * The row with `change` applied to `subtune`'s memory. Subtunes stay ascending with one entry
 * each, and an entry left with no markers and no settings is dropped.
 * @throws RangeError when `subtune` is not one of the tune's subtunes.
 */
export function changeRowMemory(row: SetRow, subtune: number, change: SubtuneChange): SetRow {
  if (!Number.isInteger(subtune) || subtune < 1 || subtune > row.tune.subtuneCount) {
    throw new RangeError(`Subtune ${subtune} is not one of the tune's ${row.tune.subtuneCount}.`);
  }
  if (change.markers === undefined && change.settings === undefined) return row;
  const current = subtuneMemoryOf(row, subtune);
  const [next] = copySubtunes([
    {
      subtune,
      markers: change.markers ?? current?.markers ?? [],
      ...settingsAfter(current, change),
    },
  ]);
  const others = row.subtunes.filter((entry) => entry.subtune !== subtune);
  const isEmpty = next.markers.length === 0 && next.settings === undefined;
  const subtunes = isEmpty ? others : [...others, next].sort((a, b) => a.subtune - b.subtune);
  if (JSON.stringify(subtunes) === JSON.stringify(row.subtunes)) return row;
  return { ...row, subtunes: copySubtunes(subtunes) };
}

/** The row's whole memory as the tune's latest version, copied, stamped `now`. */
export function tuneMemoryOf(row: SetRow, now: string): TuneMemory {
  return copyTuneMemory({
    sidHash: row.tune.sidHash,
    lastSubtune: row.lastSubtune,
    subtunes: row.subtunes,
    updated: now,
  });
}

/** Applies `change` to one subtune of one row, touching no other row. Null for an unknown row. */
export function editRowMemory(
  set: TuneSet,
  rowId: string,
  subtune: number,
  change: SubtuneChange,
  now: string,
): RowEdit | null {
  return editRow(set, rowId, now, (row) => changeRowMemory(row, subtune, change));
}

/** Selects `subtune` (clamped to the tune's subtunes) in one row. Null for an unknown row. */
export function editRowSubtune(
  set: TuneSet,
  rowId: string,
  subtune: number,
  now: string,
): RowEdit | null {
  return editRow(set, rowId, now, (row) => {
    const lastSubtune = clampSubtune(subtune, row.tune.subtuneCount);
    return lastSubtune === row.lastSubtune ? row : { ...row, lastSubtune };
  });
}

/** What a list of sets shows for `set`. */
export function summaryOf(set: TuneSet): SetSummary {
  return { id: set.id, name: set.name, rowCount: set.rows.length, updated: set.updated };
}

function editRow(
  set: TuneSet,
  rowId: string,
  now: string,
  change: (row: SetRow) => SetRow,
): RowEdit | null {
  const row = set.rows.find((candidate) => candidate.id === rowId);
  if (!row) return null;
  const edited = change(row);
  const memory = tuneMemoryOf(edited, now);
  if (edited === row) return { set, row, memory };
  const rows = set.rows.map((candidate) => (candidate === row ? edited : candidate));
  return { set: { ...set, rows, updated: now }, row: edited, memory };
}

function settingsAfter(
  current: SubtuneMemory | null,
  change: SubtuneChange,
): { settings?: PlainValue } {
  const settings = change.settings === undefined ? current?.settings : change.settings;
  return settings === undefined || settings === null ? {} : { settings };
}

function clampIndex(index: number, max: number): number {
  return Math.min(Math.max(Math.trunc(index), 0), Math.max(max, 0));
}

function clampSubtune(subtune: number, subtuneCount: number): number {
  return Math.min(Math.max(Math.trunc(subtune), 1), Math.max(subtuneCount, 1));
}
