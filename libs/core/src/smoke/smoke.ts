/** Stamped at author time, not build time — a consumer reads it to confirm which build it linked. */
export const CORE_BUILD_ID = '2026-09-06-p02-t01';

const defaultWorkerFactory = (): Worker =>
  new Worker(new URL('./smoke.worker.js', import.meta.url), { type: 'module' });

/** Posts `value` to a worker shipped inside this package and resolves with `value * 2`.
 *  The worker is constructed through `workerFactory` so a Node test never touches `Worker`. */
export function runSmokeJob(
  value: number,
  workerFactory: () => Worker = defaultWorkerFactory,
): Promise<number> {
  const worker = workerFactory();

  return new Promise<number>((resolve, reject) => {
    worker.onmessage = (event) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(`smoke worker failed: ${event.message || 'unknown error'}`));
    };
    worker.postMessage(value);
  });
}
