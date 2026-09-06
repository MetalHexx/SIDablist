/**
 * Bytes reaching a device and nothing more. No timestamps, no ordering semantics — deliberately
 * narrower than `SidSink`; conflating the two is the mistake this design exists to avoid.
 *
 * Nothing in this project implements it: ASID's `MidiOutputPort` deliberately is not it, because
 * that interface carries scheduled-send-with-timestamp semantics a DMA sink has no use for. Expect
 * no consumer until a later project.
 */
export interface Transport {
  send(bytes: Uint8Array): void;
  readonly connected: boolean;
}
