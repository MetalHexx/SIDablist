/** The few predicates the conformance cases need. No test framework: they throw plain `Error`s
 *  with a useful message, and the consumer's own runner (or `conformance.spec.ts` here) is what
 *  turns a throw into a failed `it()`. */

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** Throws unless `actual` deep-equals `expected`. */
export function assertEqual(actual: unknown, expected: unknown, message?: string): void {
  if (!deepEqual(actual, expected)) {
    throw new Error(
      message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

/** Throws unless every item in `expectedOrder` appears in `sequence`, in that relative order.
 *  Items interleaved between the matches, or after the last one, are ignored — this checks
 *  ordering, not exhaustiveness; use `assertEqual` when the whole sequence matters. */
export function assertOrdered(
  sequence: readonly unknown[],
  expectedOrder: readonly unknown[],
  message?: string,
): void {
  let cursor = 0;
  for (const expected of expectedOrder) {
    const foundAt = sequence.findIndex(
      (item, index) => index >= cursor && deepEqual(item, expected),
    );
    if (foundAt === -1) {
      throw new Error(
        message ??
          `expected ${JSON.stringify(expected)} at or after index ${cursor} in ${JSON.stringify(sequence)}`,
      );
    }
    cursor = foundAt + 1;
  }
}

/** Throws unless calling `fn` itself throws. */
export function assertThrows(fn: () => unknown, message?: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(message ?? 'expected function to throw');
}
