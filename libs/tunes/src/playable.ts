import type { TuneIndexRecord } from '@sidablist/analysis';
import type { TuneReference } from './reference.js';

/**
 * A tune ready to play: its bytes and reference, plus the index record every play needs. A
 * `Playable` never exists without its `index` — the resolver hands back bytes-with-index or
 * `null`, nothing in between.
 */
export interface Playable {
  readonly reference: TuneReference;
  readonly bytes: Uint8Array;
  readonly index: TuneIndexRecord;
}
