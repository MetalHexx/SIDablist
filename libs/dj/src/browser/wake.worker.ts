// Imports nothing, so a module worker loads it without an import map or a bundler.

// Keeps this file a module, so its top-level names do not join the global scope.
export {};

/** The part of a dedicated worker's global this script uses. `DedicatedWorkerGlobalScope` is not in the DOM lib. */
interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

declare const self: WorkerScope;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * `{ type: 'start', periodMs }` posts a beat every `periodMs` (replacing any timer running); any
 * other message stops the timer. Worker timers keep running while the page is hidden.
 */
self.addEventListener('message', (event) => {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  const command: { type?: unknown; periodMs?: unknown } | null = event.data;
  if (command?.type === 'start' && typeof command.periodMs === 'number') {
    timer = setInterval(() => self.postMessage('beat'), command.periodMs);
  }
});
