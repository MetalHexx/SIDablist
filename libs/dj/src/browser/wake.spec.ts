import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserWake } from './wake.js';

// Whether a wake keeps firing on a hidden page cannot be proven in Node: the bench measures it
// (late-wake numbers from `readings`). These specs cover the wiring through injected fakes and
// assert no timing.

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

  beat(): void {
    this.onmessage?.({ data: 'beat' } as MessageEvent);
  }
}

function fakeFactory(): { workers: FakeWorker[]; factory: () => Worker } {
  const workers: FakeWorker[] = [];
  return {
    workers,
    factory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('worker wake', () => {
  it('tells the worker the period and calls back on each beat', () => {
    const { workers, factory } = fakeFactory();
    const wake = createBrowserWake({ workerFactory: factory });
    let fired = 0;
    wake.start(2500, () => fired++);

    expect(wake.source).toBe('worker');
    expect(workers[0]?.posted).toEqual([{ type: 'start', periodMs: 2.5 }]);
    workers[0]?.beat();
    workers[0]?.beat();
    expect(fired).toBe(2);
  });

  it('stop terminates the worker and later beats do nothing', () => {
    const { workers, factory } = fakeFactory();
    const wake = createBrowserWake({ workerFactory: factory });
    let fired = 0;
    wake.start(1000, () => fired++);
    wake.stop();

    expect(workers[0]?.terminated).toBe(true);
    workers[0]?.beat();
    expect(fired).toBe(0);
  });

  it('start replaces a running wake with a fresh worker', () => {
    const { workers, factory } = fakeFactory();
    const wake = createBrowserWake({ workerFactory: factory });
    wake.start(1000, () => undefined);
    wake.start(3000, () => undefined);

    expect(workers).toHaveLength(2);
    expect(workers[0]?.terminated).toBe(true);
    expect(workers[1]?.posted).toEqual([{ type: 'start', periodMs: 3 }]);
  });

  it('logs a worker error', () => {
    const { workers, factory } = fakeFactory();
    const errors: string[] = [];
    const wake = createBrowserWake({
      workerFactory: factory,
      log: { warn: () => undefined, error: (m) => void errors.push(m) },
    });
    wake.start(1000, () => undefined);
    workers[0]?.onerror?.({} as ErrorEvent);
    expect(errors).toHaveLength(1);
  });
});

describe('wake readings', () => {
  it('counts wakes and the gaps between them, and resets', () => {
    const now = vi.spyOn(performance, 'now');
    const { workers, factory } = fakeFactory();
    const wake = createBrowserWake({ workerFactory: factory });
    wake.start(1000, () => undefined); // period 1 ms: a gap over 2 ms is late

    for (const at of [10, 11, 12, 20]) {
      now.mockReturnValue(at);
      workers[0]?.beat();
    }
    expect(wake.readings.wakes).toBe(4);
    expect(wake.readings.worstGapMs).toBe(8);
    expect(wake.readings.lateWakes).toBe(1);
    expect(wake.readings.meanGapMs).toBeCloseTo(10 / 3);

    wake.readings.reset();
    expect(wake.readings).toMatchObject({ wakes: 0, meanGapMs: 0, worstGapMs: 0, lateWakes: 0 });
  });

  it('measures no gap across a restart', () => {
    const now = vi.spyOn(performance, 'now');
    const { workers, factory } = fakeFactory();
    const wake = createBrowserWake({ workerFactory: factory });
    wake.start(1000, () => undefined);
    now.mockReturnValue(10);
    workers[0]?.beat();
    wake.start(1000, () => undefined);
    now.mockReturnValue(500);
    workers[1]?.beat();

    expect(wake.readings.wakes).toBe(2);
    expect(wake.readings.lateWakes).toBe(0);
  });
});

describe('wake.worker script', () => {
  it('posts a beat every period after start and stops on any other message', async () => {
    vi.useFakeTimers();
    let listener: ((event: { data: unknown }) => void) | undefined;
    const posted: unknown[] = [];
    vi.stubGlobal('self', {
      postMessage: (message: unknown) => void posted.push(message),
      addEventListener: (_type: string, l: (event: { data: unknown }) => void) => {
        listener = l;
      },
      removeEventListener: () => undefined,
    });
    await import('./wake.worker.js');

    listener?.({ data: { type: 'start', periodMs: 5 } });
    vi.advanceTimersByTime(20);
    expect(posted).toHaveLength(4);

    listener?.({ data: { type: 'stop' } });
    vi.advanceTimersByTime(20);
    expect(posted).toHaveLength(4);
  });
});

describe('audio wake', () => {
  class FakeContext {
    static last: FakeContext | null = null;
    state = 'suspended';
    resumed = false;
    closed = false;
    readonly destination = {};
    processor = {
      connect: () => undefined,
      disconnect: () => undefined,
      onaudioprocess: null as unknown,
    };
    gain = { gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined };
    constructor() {
      FakeContext.last = this;
    }
    createScriptProcessor(bufferSize: number): unknown {
      expect(bufferSize).toBe(256);
      return this.processor;
    }
    createGain(): unknown {
      return this.gain;
    }
    resume(): Promise<void> {
      this.resumed = true;
      return Promise.resolve();
    }
    close(): Promise<void> {
      this.closed = true;
      return Promise.resolve();
    }
  }

  it('beats on audio callbacks, silences the output, warns if still suspended, and closes on stop', () => {
    vi.useFakeTimers();
    vi.stubGlobal('AudioContext', FakeContext);
    const warnings: string[] = [];
    const wake = createBrowserWake({
      source: 'audio',
      log: { warn: (m) => void warnings.push(m), error: () => undefined },
    });
    let fired = 0;
    wake.start(1000, () => fired++);
    const context = FakeContext.last!;

    expect(wake.source).toBe('audio');
    expect(context.resumed).toBe(true);
    expect(context.gain.gain.value).toBe(0);
    (context.processor.onaudioprocess as () => void)();
    expect(fired).toBe(1);

    vi.advanceTimersByTime(999);
    expect(warnings).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(warnings).toHaveLength(1);

    wake.stop();
    expect(context.closed).toBe(true);
    expect(context.processor.onaudioprocess).toBeNull();
  });
});
