import type { SidFile } from '@sidablist/core';
import type { TuneIdentity } from './identity.js';

/** The header facts a host displays for a tune, plus the identity that addresses it. */
export interface TuneReference {
  readonly identity: TuneIdentity;
  readonly title: string;
  readonly author: string;
  readonly released: string;
  readonly subtuneCount: number;
  readonly byteLength: number;
}

/** Builds a `TuneReference` from a parsed SID file's header and the identity already resolved for it. */
export function referenceFor(
  file: SidFile,
  identity: TuneIdentity,
  byteLength: number,
): TuneReference {
  return {
    identity,
    title: file.name,
    author: file.author,
    released: file.released,
    subtuneCount: file.songs,
    byteLength,
  };
}
