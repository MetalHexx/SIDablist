/**
 * Spec-only: measures what a piece of work allocates. A copy of core's `testing/measure-allocation.ts`,
 * which core does not export. It needs a Node process started with `--expose-gc` (this package's
 * `vitest.config.ts` does that).
 */

// The tsconfig carries no Node types, so the Node global this needs is declared here rather than
// pulled from `@types/node`.
declare const process: { memoryUsage(): { heapUsed: number } };
type Gc = (options?: { type: 'minor' | 'major' }) => void;

/** `perf_hooks.constants.NODE_PERFORMANCE_GC_MINOR`: the entry kind of a young-generation collection. */
const GC_KIND_MINOR = 1;

/**
 * The heap growth, in bytes, below which `work` counts as allocation-free. It covers the
 * measurement's own noise — the observer, the promise, code the engine installs while tiering up
 * (a few tens of KB seen over a million emulated cycles) — and sits well below what allocating on
 * the step path costs over a run of a million (about 3 MB for the core before it was reworked).
 */
export const ALLOCATION_NOISE_BYTES = 256 * 1024;

/** How long to wait after the warmup for the engine's background compiles to land. */
const SETTLE_MS = 200;
/** Passes that bring the code back to optimised after the collection that follows the warmup. */
const REWARM = 3;

export interface AllocationMeasurement {
  /** `heapUsed` after `work` minus before, with no collection in between. */
  readonly heapGrowthBytes: number;
  /** Young-generation collections that ran while `work` did. Allocation-free work runs none. */
  readonly scavenges: number;
}

interface GcEntry {
  readonly detail?: { readonly kind?: number };
}

/**
 * Runs `work` `warmup` times (default 2) so the engine has optimised it, collects, runs it back up to
 * speed, collects again, then runs it once more and reports what that run allocated. Async because
 * gc entries reach a `PerformanceObserver` after a macrotask.
 *
 * Throws, rather than skipping, when the process was not started with `--expose-gc`: a measurement
 * that quietly cannot run would let an allocation regression pass.
 */
export async function measureAllocation(
  work: () => void,
  opts: { warmup?: number } = {},
): Promise<AllocationMeasurement> {
  const gc = (globalThis as unknown as { gc?: Gc }).gc;
  if (typeof gc !== 'function') {
    throw new Error(
      'measureAllocation needs globalThis.gc: start the process with --expose-gc ' +
        '(libs/dj/vitest.config.ts sets it for the test workers).',
    );
  }

  const warmup = opts.warmup ?? 2;
  for (let i = 0; i < warmup; i++) {
    work();
  }
  // Optimised code that embeds an object the earlier work left dead is thrown away by the first
  // collection, and the unoptimised code it falls back to boxes every fractional number it handles.
  // So collect once, then run it back up to speed before the collection the measurement starts from.
  gc();
  for (let i = 0; i < REWARM; i++) {
    work();
  }
  // The engine compiles on another thread and installs on the next call after it finishes.
  await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));
  work();
  // Only the young generation: a full collection here would throw the code away again.
  gc({ type: 'minor' });

  let scavenges = 0;
  const count = (entries: readonly GcEntry[]): void => {
    for (const entry of entries) {
      if (entry.detail?.kind === GC_KIND_MINOR) {
        scavenges++;
      }
    }
  };
  const observer = new PerformanceObserver((list) => count(list.getEntries() as GcEntry[]));
  const before = process.memoryUsage().heapUsed;
  observer.observe({ entryTypes: ['gc'] });
  work();
  const after = process.memoryUsage().heapUsed;

  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  count(observer.takeRecords() as GcEntry[]);
  observer.disconnect();

  return { heapGrowthBytes: after - before, scavenges };
}
