import { describe, it, expect } from 'vitest';
import { md5Hex } from './md5.js';
import { decodeBundledTune, STILL_TIME_BASE64 } from './__fixtures__/index.js';

const encoder = new TextEncoder();

describe('md5Hex — RFC 1321 Appendix A.5', () => {
  it.each([
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    [
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
      'd174ab98d277d9f5a5611c2c9f419d9f',
    ],
    [
      '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
      '57edf4a22be3c955ac49da2e2107b67a',
    ],
  ])('hashes %j to %s', (input, expected) => {
    expect(md5Hex(encoder.encode(input))).toBe(expected);
  });

  // HVSC #83's DOCUMENTS/Songlengths.md5, line 15321: the entry for
  // /MUSICIANS/A/Avrilcadabra/Still_Time.sid. Multi-block (~1000 64-byte blocks) and a real SID,
  // unlike the short RFC vectors above.
  it('hashes the bundled Still Time fixture to the HVSC-listed digest', () => {
    const bytes = decodeBundledTune(STILL_TIME_BASE64);
    expect(md5Hex(bytes)).toBe('92ab178f800743952e5f885e935d5b67');
  });
});
