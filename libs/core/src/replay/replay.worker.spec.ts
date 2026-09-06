import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplayRequest, ReplayResponse } from './replay-runner.js';
import type { SidFile } from '../sid/sid-file.model.js';
import { frames } from '../units.js';

/** The slice of `DedicatedWorkerGlobalScope` the entry point actually touches. Node has no `self`
 *  of its own, so the worker module reads whatever this test installs on `globalThis` before
 *  importing it. */
interface FakeWorkerScope {
  onmessage: ((event: MessageEvent<ReplayRequest>) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
}

const RTS = 0x60;

function tune(overrides: Partial<SidFile> = {}): SidFile {
  return {
    format: 'PSID',
    version: 2,
    loadAddress: 0x1000,
    initAddress: 0x1000,
    playAddress: 0x1000, // header names a real address, so init succeeds without an RSID vector
    songs: 1,
    startSong: 1,
    speedFlags: 0,
    name: '',
    author: '',
    released: '',
    clock: 'pal',
    model: 'unknown',
    secondSidAddress: null,
    thirdSidAddress: null,
    data: new Uint8Array([RTS]),
    ...overrides,
  };
}

async function importWorkerWithFakeScope(): Promise<FakeWorkerScope> {
  vi.resetModules();
  const scope: FakeWorkerScope = { onmessage: null, postMessage: vi.fn() };
  (globalThis as unknown as { self: FakeWorkerScope }).self = scope;
  await import('./replay.worker.js');
  return scope;
}

describe('replay worker entry point', () => {
  afterEach(() => {
    delete (globalThis as { self?: unknown }).self;
  });

  it('responds with the replay result on success', async () => {
    const scope = await importWorkerWithFakeScope();
    const request: ReplayRequest = {
      id: 1,
      file: tune(),
      subtune: 1,
      targetFrame: frames(0),
      mutes: [false, false, false],
    };

    scope.onmessage?.({ data: request } as MessageEvent<ReplayRequest>);

    expect(scope.postMessage).toHaveBeenCalledTimes(1);
    const response = scope.postMessage.mock.calls[0]?.[0] as ReplayResponse;
    expect(response.id).toBe(1);
    expect(response.ok).toBe(true);
  });

  it('responds with { ok: false, error } instead of throwing when replayToFrame fails', async () => {
    const scope = await importWorkerWithFakeScope();
    const request: ReplayRequest = {
      id: 2,
      file: tune(),
      subtune: 4, // outside the tune's 1..1 subtune range
      targetFrame: frames(0),
      mutes: [false, false, false],
    };

    expect(() => scope.onmessage?.({ data: request } as MessageEvent<ReplayRequest>)).not.toThrow();

    expect(scope.postMessage).toHaveBeenCalledWith({
      id: 2,
      ok: false,
      error: expect.stringContaining('failed during init'),
    });
  });
});
