/** One frame's register writes, in the order the tune made them.
 *  Buffers are reused between frames — a sink that needs to keep a frame must copy it. */
export interface SidFrame {
  readonly count: number;
  /** [0, count) — SID register number, 0..24. */
  readonly registers: Uint8Array;
  /** [0, count) — the byte to write, post-scaling. */
  readonly values: Uint8Array;
  /** [0, count) — microseconds after the frame's due time this write should land.
   *  Always 0 today; the field exists because widening a one-way contract later
   *  means rewriting both ends. */
  readonly offsetsUs: Int32Array;
}
