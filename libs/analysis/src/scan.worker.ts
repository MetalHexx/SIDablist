import { handleScanRequest } from './scan-worker-handler.js';
import type { ScanRequest } from './scanner.js';

// A shim and nothing else. Its module graph reaches only relative files and published packages, so
// the worker never needs a workspace path alias resolved.
declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<ScanRequest>): void =>
  handleScanRequest(event.data, (m) => self.postMessage(m));
