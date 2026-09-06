// Worker entry for the smoke round trip. Imports nothing: this file must stand alone in `dist`
// so `new URL('./smoke.worker.js', import.meta.url)` resolves to a real, separate module.
declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<number>) => {
  self.postMessage(event.data * 2);
};
