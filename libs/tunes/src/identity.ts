/**
 * Content-addressed identity of one playable subtune. `sidHash` is the hex MD5 of the whole `.sid`
 * file, computed by this package (see `md5.ts`); `subtune` is 1-based, as SID files store it. Two
 * different subtunes of the same file share `sidHash` but never `subtune`.
 */
export interface TuneIdentity {
  readonly sidHash: string;
  readonly subtune: number;
}
