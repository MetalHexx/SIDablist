import { describe, expect, it, vi } from 'vitest';
import type { ReplayRequest, ReplayResponse } from './replay-runner.js';
import type { SidFile } from '../sid/sid-file.model.js';
import { frames } from '../units.js';
import { WorkerReplayRunner } from './worker-replay-runner.js';

/** Everything `WorkerReplayRunner` actually touches on a `Worker` — enough to stand in for the
 *  real thing without a DOM, since `postMessage`/`onmessage`/`onerror`/`terminate` are the whole
 *  of the collaborator it replaces. */
interface FakeWorker {
  onmessage: ((event: MessageEvent<ReplayResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

function createFakeWorker(): FakeWorker {
  return {
    onmessage: null,
    onerror: null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
  };
}

function deliver(worker: FakeWorker, response: ReplayResponse): void {
  worker.onmessage?.({ data: response } as MessageEvent<ReplayResponse>);
}

const file: SidFile = {
  format: 'PSID',
  version: 2,
  loadAddress: 0x1000,
  initAddress: 0x1000,
  playAddress: 0x1000,
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
  data: new Uint8Array(),
};

function request(id: number): ReplayRequest {
  return { id, file, subtune: 1, targetFrame: frames(0), mutes: [false, false, false] };
}

function okResponse(id: number): ReplayResponse {
  return {
    id,
    ok: true,
    result: {
      machine: {
        memory: new Uint8Array(),
        cpu: {},
        trampoline: 0,
        idleAddress: 0,
        playAddress: 0,
        timerALatch: null,
        cyclesThisCall: 0,
        reachedIdle: true,
        expectingOpcodeFetch: false,
        illegalOpcodes: 0,
      },
      registers: { values: new Uint8Array() },
      frame: frames(0),
    },
  };
}

describe('WorkerReplayRunner', () => {
  it('round-trips a request through an injected fake worker', async () => {
    const worker = createFakeWorker();
    const runner = new WorkerReplayRunner(() => worker as unknown as Worker);

    const pending = runner.run(request(1));
    deliver(worker, okResponse(1));

    await expect(pending).resolves.toEqual(okResponse(1));
    expect(worker.postMessage).toHaveBeenCalledWith(request(1));
  });

  it('builds the worker once and reuses it across requests', () => {
    const factory = vi.fn(() => createFakeWorker() as unknown as Worker);
    const runner = new WorkerReplayRunner(factory);

    runner.run(request(1));
    runner.run(request(2));

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('fans a worker error out to every pending promise, leaving none permanently unresolved', async () => {
    const worker = createFakeWorker();
    const runner = new WorkerReplayRunner(() => worker as unknown as Worker);

    const first = runner.run(request(1));
    const second = runner.run(request(2));

    worker.onerror?.({} as ErrorEvent);

    await expect(first).resolves.toEqual({
      id: 1,
      ok: false,
      error: 'the replay worker stopped responding',
    });
    await expect(second).resolves.toEqual({
      id: 2,
      ok: false,
      error: 'the replay worker stopped responding',
    });
  });

  it('discards a response for an id that is no longer awaited, without disturbing what is', async () => {
    const worker = createFakeWorker();
    const runner = new WorkerReplayRunner(() => worker as unknown as Worker);

    const pending = runner.run(request(1));

    expect(() => deliver(worker, okResponse(99))).not.toThrow();

    deliver(worker, okResponse(1));
    await expect(pending).resolves.toEqual(okResponse(1));
  });

  it('leaves a request outstanding when disposed while it is in flight', async () => {
    const worker = createFakeWorker();
    const runner = new WorkerReplayRunner(() => worker as unknown as Worker);

    const pending = runner.run(request(1));
    runner.dispose();

    expect(worker.terminate).toHaveBeenCalledTimes(1);

    const outcome = await Promise.race([
      pending.then(() => 'settled' as const),
      Promise.resolve('still-pending' as const),
    ]);
    expect(outcome).toBe('still-pending');
  });

  it('builds a fresh worker for the next request after dispose', () => {
    const factory = vi.fn(() => createFakeWorker() as unknown as Worker);
    const runner = new WorkerReplayRunner(factory);

    runner.run(request(1));
    runner.dispose();
    runner.run(request(2));

    expect(factory).toHaveBeenCalledTimes(2);
  });
});
