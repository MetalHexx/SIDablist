/**
 * Spec-only: measures what a piece of work allocates, and not exported from the package. A copy of
 * core's helper of the same name, which asid cannot import: core's package exports only `.`,
 * `./conformance` and `./replay.worker`. It needs a Node process started with `--expose-gc`
 * (asid's `vitest.config.ts` does that).
 */

// asid's tsconfig carries no Node types, so the one Node global this needs is declared here rather
// than pulled from `@types/node`.
declare const process: { memoryUsage(): { heapUsed: number } };
type Gc = () => void;

/** `perf_hooks.constants.NODE_PERFORMANCE_GC_MINOR`: the entry kind of a young-generation collection. */
const GC_KIND_MINOR = 1;

/**
 * The heap growth, in bytes, below which `work` counts as allocation-free. It covers the
 * measurement's own noise — the observer, the promise, code the engine installs while tiering up —
 * and sits well below what a packet per `deliver` costs over ten thousand of them.
 */
export const ALLOCATION_NOISE_BYTES = 256 * 1024;

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
 * Runs `work` `warmup` times (default 2) so the engine has optimised it, collects, then runs it once
 * more and reports what that run allocated. Async because gc entries reach a `PerformanceObserver`
 * after a macrotask.
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
        '(libs/asid/vitest.config.ts sets it for the test workers).',
    );
  }

  const warmup = opts.warmup ?? 2;
  for (let i = 0; i < warmup; i++) {
    work();
  }
  gc();

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
