import { STILL_TIME_BASE64 } from './still-time.js';

export { STILL_TIME_BASE64 };

export interface BundledTune {
  readonly id: string;
  readonly label: string;
  readonly base64: string;
}

/** The one tune whose artist cleared it for redistribution — TeensyROM firmware 0.7.2's "Featured
 *  SIDs" thanks @Avrilcadabra by name for permission to share it. Every other HVSC tune stays
 *  off-disk; this package only carries what the moved specs are graded against. */
export const BUNDLED_TUNES: readonly BundledTune[] = [
  { id: 'still-time', label: 'Still Time — Avrilcadabra', base64: STILL_TIME_BASE64 },
];

/** Decodes a bundled tune's base64 payload back into raw bytes. */
export function decodeBundledTune(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
