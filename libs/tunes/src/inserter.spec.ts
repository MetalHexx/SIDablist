import { describe, it, expect, vi } from 'vitest';
import { parseSidFile, SidParseError } from '@sidablist/core';
import { createTuneInserter } from './inserter.js';
import { md5Hex } from './md5.js';
import { InMemoryTuneStore } from './testing/in-memory-tune-store.js';
import { decodeBundledTune, STILL_TIME_BASE64 } from './__fixtures__/index.js';

const STILL_TIME_BYTES = decodeBundledTune(STILL_TIME_BASE64);
const STILL_TIME_FILE = parseSidFile(STILL_TIME_BYTES);

describe('createTuneInserter', () => {
  it('puts the bytes and returns a reference matching the header and the content hash', async () => {
    const store = new InMemoryTuneStore();
    const inserter = createTuneInserter(store);

    const reference = await inserter.insert(STILL_TIME_BYTES);

    expect(reference.identity).toEqual({
      sidHash: md5Hex(STILL_TIME_BYTES),
      subtune: STILL_TIME_FILE.startSong,
    });
    expect(reference.title).toBe(STILL_TIME_FILE.name);
    expect(reference.author).toBe(STILL_TIME_FILE.author);
    expect(reference.released).toBe(STILL_TIME_FILE.released);
    expect(reference.subtuneCount).toBe(STILL_TIME_FILE.songs);
    expect(reference.byteLength).toBe(STILL_TIME_BYTES.byteLength);
    expect(await store.getBytes(reference.identity.sidHash)).toEqual(STILL_TIME_BYTES);
  });

  it('is idempotent: a second insert of the same bytes puts again and returns an equal reference', async () => {
    const store = new InMemoryTuneStore();
    const putBytesSpy = vi.spyOn(store, 'putBytes');
    const inserter = createTuneInserter(store);

    const first = await inserter.insert(STILL_TIME_BYTES);
    const second = await inserter.insert(STILL_TIME_BYTES);

    expect(second).toEqual(first);
    expect(putBytesSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects a non-SID file with core's SidParseError", async () => {
    const store = new InMemoryTuneStore();
    const inserter = createTuneInserter(store);

    await expect(inserter.insert(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(SidParseError);
  });
});
