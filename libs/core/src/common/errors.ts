/** Turns a thrown value into a display string: an `Error`'s own message, or the value's own
 *  string form for anything else a `catch` might see. Shared by every path that reports a
 *  replay failure verbatim to a diagnostics readout. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
