import type { ReplayResult } from './replay-to-frame.js';
import type { Frames } from '../units.js';
import type { SidFile } from '../sid/sid-file.model.js';

/**
 * One jump, as it crosses the thread boundary. Everything here is structured-cloneable: `SidFile`
 * is a plain object around a `Uint8Array` and carries no methods.
 */
export interface ReplayRequest {
  /** Correlates the response, and decides whether it is still the one the caller is waiting on. */
  readonly id: number;
  readonly file: SidFile;
  readonly subtune: number;
  readonly targetFrame: Frames;
  readonly mutes: readonly boolean[];
}

/** A replay's outcome. A failure comes back as a message rather than a thrown error, because it
 *  was thrown somewhere this thread cannot catch. */
export type ReplayResponse =
  | { readonly id: number; readonly ok: true; readonly result: ReplayResult }
  | { readonly id: number; readonly ok: false; readonly error: string };

/** Runs `replayToFrame` somewhere other than here, one request at a time from the caller's view. */
export interface ReplayRunner {
  run(request: ReplayRequest): Promise<ReplayResponse>;
  /** Releases the thread the runner holds. Nothing outstanding is expected to resolve after it. */
  dispose(): void;
}
