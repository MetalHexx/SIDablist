import { describe, expect, it } from 'vitest';
import { runSmokeJob } from './smoke.js';

interface FakeWorker {
  onmessage: ((event: MessageEvent<number>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(value: number): void;
  terminate(): void;
}

function createFakeWorker(respond: (worker: FakeWorker, value: number) => void): Worker {
  const worker: FakeWorker = {
    onmessage: null,
    onerror: null,
    postMessage(value) {
      respond(worker, value);
    },
    terminate() {
      // no-op: nothing real to tear down
    },
  };

  return worker as unknown as Worker;
}

describe('runSmokeJob', () => {
  it('round-trips a value through an injected fake worker', async () => {
    const worker = createFakeWorker((fake, value) => {
      fake.onmessage?.({ data: value * 2 } as MessageEvent<number>);
    });

    await expect(runSmokeJob(21, () => worker)).resolves.toBe(42);
  });

  it('rejects when the fake worker fires onerror', async () => {
    const worker = createFakeWorker((fake) => {
      fake.onerror?.({ message: 'boom' } as ErrorEvent);
    });

    await expect(runSmokeJob(21, () => worker)).rejects.toThrow('boom');
  });
});
