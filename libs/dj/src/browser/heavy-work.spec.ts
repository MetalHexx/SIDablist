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

type Role = 'replay' | 'prepare' | 'scan';

/** Each role builds its own workers, kept per role so a spec can tell which factory a worker came from. */
function setup(): {
  built: Record<Role, FakeWorker[]>;
  workers: FakeWorker[];
  heavy: ReturnType<typeof createBrowserHeavyWork>;
} {
  const built: Record<Role, FakeWorker[]> = { replay: [], prepare: [], scan: [] };
  const buildFor = (role: Role) => (): Worker => {
    const worker = new FakeWorker();
    built[role].push(worker);
    return worker as unknown as Worker;
  };
  return {
    built,
    // The scan workers: what the scanner specs below drive.
    workers: built.scan,
    heavy: createBrowserHeavyWork({
      replay: buildFor('replay'),
      prepare: buildFor('prepare'),
      scan: buildFor('scan'),
    }),
  };
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

  it('runs a request on the replay worker, built on first use and no other role', () => {
    const { built, heavy } = setup();
    const runner = heavy.replayRunner();
    expect(built.replay).toHaveLength(0);
    void runner.run({ id: 9 } as Parameters<typeof runner.run>[0]);
    expect(built.replay[0]?.posted).toEqual([{ id: 9 }]);
    expect(built.prepare).toHaveLength(0);
    expect(built.scan).toHaveLength(0);
  });

  it('runs a prepare request on the prepare worker, not the replay worker', () => {
    const { built, heavy } = setup();
    const runner = heavy.prepareRunner?.();
    void runner?.run({ id: 4 } as Parameters<NonNullable<typeof runner>['run']>[0]);
    expect(built.prepare[0]?.posted).toEqual([{ id: 4 }]);
    expect(built.replay).toHaveLength(0);
    expect(built.scan).toHaveLength(0);
  });
});
