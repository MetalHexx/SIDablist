import type { Transport } from '../ports/transport.js';

/** Collects the bytes it was handed instead of writing to a device. */
export class FakeTransport implements Transport {
  private readonly sentPackets: Uint8Array[] = [];
  private isConnected = true;

  send(bytes: Uint8Array): void {
    this.sentPackets.push(bytes.slice());
  }

  get connected(): boolean {
    return this.isConnected;
  }

  /** Lets a test simulate a device disconnecting or reconnecting. */
  setConnected(connected: boolean): void {
    this.isConnected = connected;
  }

  /** Every call to `send`, in order, each copied so a later send cannot mutate what an earlier
   *  one recorded. */
  get sent(): readonly Uint8Array[] {
    return this.sentPackets;
  }
}
