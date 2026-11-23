import { describe, expect, it } from 'vitest';
import type { ScanMessage, ScanRequest } from '@sidablist/analysis';
import { createBrowserHeavyWork } from './heavy-work.js';

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: unknown[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  answer(message: ScanMessage): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }
}

const request = (id: number): ScanRequest => ({
  id,
  session: 1,
  file: {} as ScanRequest['file'],
  subtune: 1,
  maxFrames: 100,
});

function setup(): { workers: FakeWorker[]; heavy: ReturnType<typeof createBrowserHeavyWork> } {
  const workers: FakeWorker[] = [];
  const build = (): Worker => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  };
  return { workers, heavy: createBrowserHeavyWork({ replay: build, prepare: build, scan: build }) };
}

describe('browser heavy work scanner', () => {
  it('builds no worker until the first scan', () => {
    const { workers, heavy } = setup();
    expect(workers).toHaveLength(0);
    void heavy.scanner.scan(request(1));
    expect(workers).toHaveLength(1);
  });

  it('forwards progress to the request that asked and resolves on done', async () => {
    const { workers, heavy } = setup();
    const seen: number[] = [];
    const first = heavy.scanner.scan(request(1), (frame) => seen.push(frame));
    const second = heavy.scanner.scan(request(2));
    const output = { tag: 'out' } as unknown as Extract<ScanMessage, { kind: 'done' }>['output'];

    workers[0]?.answer({ id: 1, kind: 'progress', frame: 50 });
    workers[0]?.answer({ id: 2, kind: 'progress', frame: 7 });
    workers[0]?.answer({ id: 1, kind: 'done', output });
    workers[0]?.answer({ id: 2, kind: 'failed', error: 'bad tune' });

    expect(seen).toEqual([50]);
    expect(workers[0]?.posted).toEqual([request(1), request(2)]);
    expect(await first).toEqual({ id: 1, kind: 'done', output });
    expect(await second).toEqual({ id: 2, kind: 'failed', error: 'bad tune' });
  });

  it('fails every pending request when the worker errors, and builds a fresh worker next', async () => {
    const { workers, heavy } = setup();
    const first = heavy.scanner.scan(request(1));
    const second = heavy.scanner.scan(request(2));
    workers[0]?.onerror?.({} as ErrorEvent);

    expect(await first).toMatchObject({ id: 1, kind: 'failed' });
    expect(await second).toMatchObject({ id: 2, kind: 'failed' });
    expect(workers[0]?.terminated).toBe(true);

    void heavy.scanner.scan(request(3));
    expect(workers).toHaveLength(2);
  });

  it('dispose terminates the worker', () => {
    const { workers, heavy } = setup();
    void heavy.scanner.scan(request(1));
    heavy.scanner.dispose();
    expect(workers[0]?.terminated).toBe(true);
  });
});

describe('browser heavy work replay runners', () => {
  it('gives each deck its own runner, and a prepare runner only when a worker is supplied', () => {
    const { heavy } = setup();
    expect(heavy.replayRunner()).not.toBe(heavy.replayRunner());
    expect(heavy.prepareRunner).toBeDefined();

    const bare = createBrowserHeavyWork({
      replay: () => new FakeWorker() as unknown as Worker,
      scan: () => new FakeWorker() as unknown as Worker,
    });
    expect(bare.prepareRunner).toBeUndefined();
  });

  it('runs a request on the replay worker, built on first use', () => {
    const workers: FakeWorker[] = [];
    const heavy = createBrowserHeavyWork({
      replay: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
      scan: () => new FakeWorker() as unknown as Worker,
    });
    const runner = heavy.replayRunner();
    expect(workers).toHaveLength(0);
    void runner.run({ id: 9 } as Parameters<typeof runner.run>[0]);
    expect(workers[0]?.posted).toEqual([{ id: 9 }]);
  });
});
