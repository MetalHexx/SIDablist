/**
 * Hand-assembled PSID fixtures for specs that need a tune whose writes are known byte for byte.
 */

/**
 * A PSID whose play routine is `code`, at $1010, with `table` at $1020 for it to read. Init returns
 * at once.
 */
export function psid(code: readonly number[], table: readonly number[] = []): Uint8Array {
  const header = new Uint8Array(0x7c);
  const view = new DataView(header.buffer);
  header.set([0x50, 0x53, 0x49, 0x44]);
  view.setUint16(0x04, 2);
  view.setUint16(0x06, 0x7c);
  view.setUint16(0x08, 0x1000);
  view.setUint16(0x0a, 0x1000);
  view.setUint16(0x0c, 0x1010);
  view.setUint16(0x0e, 1);
  view.setUint16(0x10, 1);
  const payload = new Uint8Array(0x40);
  payload[0] = 0x60;
  payload.set(code, 0x10);
  payload.set(table, 0x20);
  const bytes = new Uint8Array(header.length + payload.length);
  bytes.set(header);
  bytes.set(payload, header.length);
  return bytes;
}

/** Copies the 25 bytes at $1020 to the chip every frame: LDX #24; LDA $1020,X; STA $D400,X; DEX; BPL; RTS. */
export const COPY_TABLE = [0xa2, 0x18, 0xbd, 0x20, 0x10, 0x9d, 0x00, 0xd4, 0xca, 0x10, 0xf7, 0x60];

/**
 * What the steady tune writes, every frame: each voice pulse and gated, a low-pass filter at cutoff
 * 256 with resonance 4 on all three, and full volume. Its writes never move, so a register read at
 * one moment is comparable with one read at another.
 */
export const STEADY = [
  0x45, 0x1d, 0x00, 0x08, 0x41, 0x29, 0xa4, 0x00, 0x20, 0x00, 0x08, 0x41, 0x29, 0xa4, 0x00, 0x30,
  0x00, 0x08, 0x41, 0x29, 0xa4, 0x00, 0x20, 0x47, 0x1f,
];

/** Writes voice 1's gate high from the 30th play call on: INC $FB; LDA $FB; CMP #30; LDA #0; ROL A; STA $D404; RTS. */
export const GATE_RISES = [
  0xe6, 0xfb, 0xa5, 0xfb, 0xc9, 0x1e, 0xa9, 0x00, 0x2a, 0x8d, 0x04, 0xd4, 0x60,
];
