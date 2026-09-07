/**
 * The MIDI output surface `AsidSink` schedules against. Lives in asid, not core: core's transport
 * contract is "bytes to a device," while this one carries scheduled-send-with-timestamp semantics
 * a DMA far end has no use for.
 *
 * `portId` and `supportsCancel` are plain readable properties rather than framework signals — the
 * application re-reads them on its own cadence, and a port swap produces a new `MidiOutputPort`
 * rather than mutating this one in place.
 */
export interface MidiOutputPort {
  readonly portId: string | null;
  readonly supportsCancel: boolean;
  /** Omitting `timestampMs` sends immediately; supplying it hands the value to the underlying MIDI
   *  subsystem's own clock so it releases the bytes when that clock reaches it. */
  send(bytes: Uint8Array, timestampMs?: number): void;
  /** Withdraws whatever is still pending on this port. Returns whether it actually cancelled
   *  something — a port with nothing pending, or with no cancel support at all, reports `false`. */
  cancelPending(): boolean;
}
