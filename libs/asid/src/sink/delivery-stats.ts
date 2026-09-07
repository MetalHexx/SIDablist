/**
 * The delivery counters `AsidSink` owns and reports — the scheduling half of what the DJ engine's
 * pre-extraction `DeliveryTransport` tracked. The delivery-against-due-time measurements
 * (scheduled/late frames, mean/worst lag, reordered, clamped) do not live here: core measures those
 * at the `deliver()` call site, where the due time was computed and the frame handed over.
 * Splitting this way is deliberate — measurement is a timeline concern and this is a protocol one.
 */
export interface DeliveryStats {
  readonly packetsSent: number;
  readonly bytesSent: number;
  /** Mirrors `AsidSink.capabilities.cancellation` — kept alongside the other counters since a
   *  caller reading delivery stats often wants this without reaching into `capabilities` too. */
  readonly cancelSupported: boolean;
  /** How far the furthest-out outstanding send reached past the most recent successful cancel
   *  request, in milliseconds. `-1` until a retime has actually cancelled something, and forced
   *  back to `-1` the moment the port stops supporting cancellation — a reading measured against a
   *  port that has since been swapped out would mislead rather than inform. */
  readonly lastCancelLatencyMs: number;
  /** Frame packets already handed to the port with a future delivery time and not yet due. */
  readonly inFlight: number;
}
