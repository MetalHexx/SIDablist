import type { LoopMarker, PlainValue } from './loop-marker.js';
import type { SetRow, SubtuneMemory, TuneMemory, TuneSet } from './tune-set.js';

/** A deep copy of plain data: arrays and plain objects are rebuilt, primitives returned as they are. */
export function copyPlain(value: PlainValue): PlainValue {
  if (Array.isArray(value)) return (value as readonly PlainValue[]).map(copyPlain);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copyPlain(entry)]));
  }
  return value;
}

/** `marker` with every nested array, object and its `settings` copied; absent fields stay absent. */
export function copyMarker(marker: LoopMarker): LoopMarker {
  const { settings, end, ...rest } = marker;
  return {
    ...rest,
    start: { ...marker.start },
    end: end === null ? null : { ...end },
    voices: [...marker.voices],
    ...(settings === undefined ? {} : { settings: copyPlain(settings) }),
  };
}

/** `subtunes` with each entry, its marker list, the markers and the settings copied. */
export function copySubtunes(subtunes: readonly SubtuneMemory[]): SubtuneMemory[] {
  return subtunes.map((entry) => ({
    subtune: entry.subtune,
    markers: entry.markers.map(copyMarker),
    ...(entry.settings === undefined ? {} : { settings: copyPlain(entry.settings) }),
  }));
}

/** `memory` sharing no array or object with the original. */
export function copyTuneMemory(memory: TuneMemory): TuneMemory {
  return { ...memory, subtunes: copySubtunes(memory.subtunes) };
}

/** `row` sharing no array or object with the original. */
export function copySetRow(row: SetRow): SetRow {
  const { host, copiedFrom, ...rest } = row;
  return {
    ...rest,
    tune: { ...row.tune },
    copiedFrom: copiedFrom === null ? null : { ...copiedFrom },
    subtunes: copySubtunes(row.subtunes),
    ...(host === undefined ? {} : { host: copyPlain(host) }),
  };
}

/** `set` sharing no array or object with the original. */
export function copyTuneSet(set: TuneSet): TuneSet {
  return { ...set, rows: set.rows.map(copySetRow) };
}
