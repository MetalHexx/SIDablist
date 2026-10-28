import { describe, it, expect } from 'vitest';
import type { LoopMarker, PlainValue } from '../loop-marker.js';
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

  describe('marker settings', () => {
    interface Shape {
      [key: string]: PlainValue;
      gains: number[];
      nested: { label: string; flags: (boolean | null)[] };
    }

    const asShape = (settings: PlainValue | undefined): Shape => settings as Shape;

    function withSettings(id: string, settings: Shape): LoopMarker {
      return { ...marker(id, 100), settings, usesOwnSettings: true };
    }

    const settingsOf = (loaded: readonly LoopMarker[]): Shape => asShape(loaded[0].settings);

    it('round-trips settings and the own-settings flag', async () => {
      const store = new InMemoryLoopPositionsStore();
      const saved = withSettings('a', {
        gains: [1, 0.5],
        nested: { label: 'x', flags: [true, null] },
      });

      await store.save(IDENTITY, [saved]);

      expect(await store.load(IDENTITY)).toEqual([saved]);
    });

    it('keeps settings kept apart from the flag, and the flag false', async () => {
      const store = new InMemoryLoopPositionsStore();
      const saved: LoopMarker = {
        ...marker('a', 100),
        settings: { kept: 1 },
        usesOwnSettings: false,
      };

      await store.save(IDENTITY, [saved]);

      const [loaded] = await store.load(IDENTITY);
      expect(loaded.settings).toEqual({ kept: 1 });
      expect(loaded.usesOwnSettings).toBe(false);
    });

    it('is not changed by mutating the nested settings passed to save', async () => {
      const store = new InMemoryLoopPositionsStore();
      const passed = withSettings('a', { gains: [1], nested: { label: 'x', flags: [true] } });

      await store.save(IDENTITY, [passed]);
      const shape = asShape(passed.settings);
      shape.gains.push(2);
      shape.nested.flags[0] = false;

      expect(settingsOf(await store.load(IDENTITY))).toEqual({
        gains: [1],
        nested: { label: 'x', flags: [true] },
      });
    });

    it('hands back settings that share nothing with the stored ones or with another load', async () => {
      const store = new InMemoryLoopPositionsStore();
      await store.save(IDENTITY, [
        withSettings('a', { gains: [1], nested: { label: 'x', flags: [true] } }),
      ]);

      const first = settingsOf(await store.load(IDENTITY));
      first.gains.push(2);
      first.nested.flags[0] = false;
      const second = settingsOf(await store.load(IDENTITY));

      expect(second).toEqual({ gains: [1], nested: { label: 'x', flags: [true] } });
      expect(second.gains).not.toBe(first.gains);
      expect(second.nested).not.toBe(first.nested);
    });

    it('round-trips a marker name', async () => {
      const store = new InMemoryLoopPositionsStore();
      const saved: LoopMarker = { ...marker('a', 100), name: 'Drum break' };

      await store.save(IDENTITY, [saved]);

      expect(await store.load(IDENTITY)).toEqual([saved]);
    });

    it('leaves a marker with neither field without either', async () => {
      const store = new InMemoryLoopPositionsStore();
      await store.save(IDENTITY, [marker('a', 100)]);

      const [loaded] = await store.load(IDENTITY);

      expect(loaded).toEqual(marker('a', 100));
      expect('settings' in loaded).toBe(false);
      expect('usesOwnSettings' in loaded).toBe(false);
    });

    it('copies a key named __proto__ as data', async () => {
      const store = new InMemoryLoopPositionsStore();
      const settings = JSON.parse('{"__proto__": {"polluted": true}}') as PlainValue;
      await store.save(IDENTITY, [{ ...marker('a', 100), settings }]);

      const [loaded] = await store.load(IDENTITY);

      expect(Object.keys(loaded.settings as object)).toEqual(['__proto__']);
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    });
  });
});
