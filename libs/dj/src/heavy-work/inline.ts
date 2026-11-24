import { replayToFrame } from '@sidablist/core';
import type { ReplayRequest, ReplayResponse, ReplayRunner } from '@sidablist/core';
import { handleScanRequest } from '@sidablist/analysis';
import type { AnalysisScanner, ScanRequest, ScanResult } from '@sidablist/analysis';
import type { HeavyWork } from '../plugs.js';

/** Runs `replayToFrame` on the calling thread, answering as a worker would. */
const replayRunner: ReplayRunner = {
  run(request: ReplayRequest): Promise<ReplayResponse> {
    try {
      const result = replayToFrame(
        request.file,
        request.subtune,
        request.targetFrame,
        request.mutes,
        request.start,
      );
      return Promise.resolve({ id: request.id, ok: true, result });
    } catch (error) {
      return Promise.resolve({ id: request.id, ok: false, error: String(error) });
    }
  },
  dispose(): void {
    // nothing is held open
  },
};

/** Runs a scan on the calling thread: `handleScanRequest` posts its messages before it returns. */
const scanner: AnalysisScanner = {
  scan(request: ScanRequest, onProgress?: (frame: number) => void): Promise<ScanResult> {
    return new Promise<ScanResult>((resolve) => {
      handleScanRequest(request, (message) => {
        if (message.kind === 'progress') onProgress?.(message.frame);
        else resolve(message);
      });
    });
  },
  dispose(): void {
    // nothing is held open
  },
};

/**
 * Heavy work that runs on the calling thread, for Node, tests and the bench: a replay or a scan
 * blocks the thread it is asked on, so a host with a thread of its own to keep free supplies workers.
 */
export function createInlineHeavyWork(): HeavyWork {
  return {
    replayRunner: () => replayRunner,
    scanner,
  };
}
