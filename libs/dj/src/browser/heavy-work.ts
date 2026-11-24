import { createWorkerReplayRunner } from '@sidablist/core';
import type { AnalysisScanner, ScanMessage, ScanRequest, ScanResult } from '@sidablist/analysis';
import type { HeavyWork } from '../plugs.js';

/**
 * The workers the app builds, because worker URLs belong to its bundler. `replay` and `prepare` run
 * core's `replay.worker` script and `scan` runs analysis's `scan.worker`. A module worker gets no
 * import map, so a script that imports a bare `@sidablist/*` specifier needs a bundler to resolve it.
 */
export interface BrowserWorkers {
  readonly replay: () => Worker;
  readonly prepare?: () => Worker;
  readonly scan: () => Worker;
}

/**
 * Heavy work on workers: each replay runner is core's worker-backed runner on `workers.replay`
 * (and `prepare`), and the scanner is one worker-backed `AnalysisScanner` on `workers.scan`.
 */
export function createBrowserHeavyWork(workers: BrowserWorkers): HeavyWork {
  const prepare = workers.prepare;
  return {
    replayRunner: () => createWorkerReplayRunner(workers.replay),
    ...(prepare === undefined ? {} : { prepareRunner: () => createWorkerReplayRunner(prepare) }),
    scanner: new WorkerScanner(workers.scan),
  };
}

interface PendingScan {
  readonly resolve: (result: ScanResult) => void;
  readonly onProgress: ((frame: number) => void) | undefined;
}

/**
 * Scans on a worker built on first use, matching each message to its request by `id`: `progress`
 * is forwarded, `done` and `failed` resolve. A worker that errors fails every request waiting on
 * it and is retired, so the next scan builds a fresh one.
 */
class WorkerScanner implements AnalysisScanner {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, PendingScan>();

  constructor(private readonly workerFactory: () => Worker) {}

  scan(request: ScanRequest, onProgress?: (frame: number) => void): Promise<ScanResult> {
    const worker = this.ensureWorker();
    return new Promise<ScanResult>((resolve) => {
      this.pending.set(request.id, { resolve, onProgress });
      worker.postMessage(request);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }

  private ensureWorker(): Worker {
    const existing = this.worker;
    if (existing !== null) return existing;

    const worker = this.workerFactory();
    worker.onmessage = (event: MessageEvent<ScanMessage>): void => {
      const message = event.data;
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      if (message.kind === 'progress') {
        entry.onProgress?.(message.frame);
        return;
      }
      this.pending.delete(message.id);
      entry.resolve(message);
    };
    // A worker that dies takes every request waiting on it with it; retiring it means the next
    // scan does not reuse a worker that already failed.
    worker.onerror = (): void => {
      for (const [id, entry] of this.pending) {
        entry.resolve({ id, kind: 'failed', error: 'the scan worker stopped responding' });
      }
      this.pending.clear();
      worker.terminate();
      if (this.worker === worker) this.worker = null;
    };
    this.worker = worker;
    return worker;
  }
}
