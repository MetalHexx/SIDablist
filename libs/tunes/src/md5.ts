/**
 * RFC 1321 MD5, hand-rolled with no dependency. This package needs nothing more than a content
 * hash to key a tune by — the identity `sidHash` is the hex MD5 of the whole `.sid` file, and MD5
 * is what HVSC's own `Songlengths.md5` addresses every tune by. Single file, no streaming API: a
 * whole `.sid` file comfortably fits in memory, so there is nothing a chunked interface would buy.
 */

// Per-round left-rotate amounts, four per round of sixteen steps.
const SHIFT_AMOUNTS: readonly number[] = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

// K[i] = floor(abs(sin(i + 1)) * 2^32), the binary integer part of the sine of (i+1) radians.
const SINE_TABLE: readonly number[] = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

const INITIAL_A = 0x67452301;
const INITIAL_B = 0xefcdab89;
const INITIAL_C = 0x98badcfe;
const INITIAL_D = 0x10325476;

/** Appends `0x80`, zero bytes up to 56 mod 64, then the original bit length as a 64-bit
 *  little-endian integer — RFC 1321's padding, sized to land the message on a whole number of
 *  64-byte blocks. */
function padMessage(bytes: Uint8Array): Uint8Array {
  const bitLength = BigInt(bytes.length) * 8n;

  let paddedLength = bytes.length + 1; // the message plus the mandatory 0x80 byte
  while (paddedLength % 64 !== 56) {
    paddedLength++;
  }
  paddedLength += 8; // the 64-bit length field

  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setBigUint64(paddedLength - 8, bitLength, true);
  return padded;
}

function leftRotate(value: number, amount: number): number {
  return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

/** Renders a 32-bit word as four little-endian bytes of lowercase hex. */
function wordToLittleEndianHex(word: number): string {
  let hex = '';
  for (let byteIndex = 0; byteIndex < 4; byteIndex++) {
    const byte = (word >>> (byteIndex * 8)) & 0xff;
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Computes the MD5 digest of `bytes`, returned as 32 lowercase hex characters. */
export function md5Hex(bytes: Uint8Array): string {
  const padded = padMessage(bytes);
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const words = new Uint32Array(16);

  let a0 = INITIAL_A;
  let b0 = INITIAL_B;
  let c0 = INITIAL_C;
  let d0 = INITIAL_D;

  for (let blockStart = 0; blockStart < padded.length; blockStart += 64) {
    for (let wordIndex = 0; wordIndex < 16; wordIndex++) {
      words[wordIndex] = view.getUint32(blockStart + wordIndex * 4, true);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let step = 0; step < 64; step++) {
      let f: number;
      let sourceIndex: number;

      if (step < 16) {
        f = (b & c) | (~b & d);
        sourceIndex = step;
      } else if (step < 32) {
        f = (d & b) | (~d & c);
        sourceIndex = (5 * step + 1) % 16;
      } else if (step < 48) {
        f = b ^ c ^ d;
        sourceIndex = (3 * step + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        sourceIndex = (7 * step) % 16;
      }

      f = (f + a + SINE_TABLE[step] + words[sourceIndex]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + leftRotate(f, SHIFT_AMOUNTS[step])) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return [a0, b0, c0, d0].map(wordToLittleEndianHex).join('');
}
