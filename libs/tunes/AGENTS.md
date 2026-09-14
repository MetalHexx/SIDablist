# tunes

The DJ's knowledge of a tune: what one _is_ (`TuneIdentity`, `TuneReference`, `Playable`), the two
ports a host supplies to store and index it (`TuneStore`, `TuneIndexer`), and the one rule —
index once per hash and subtune, look up before scanning — that lives here instead of in every
deck that plays a tune.

## How it works

The public surface is `src/index.ts`; nothing under `__fixtures__` or `testing/` is exported from
it except `InMemoryTuneStore`.

- `identity.ts`, `reference.ts`, `playable.ts` — the values: `TuneIdentity` (content hash plus
  1-based subtune), `TuneReference` (header facts plus identity, and `referenceFor` that builds
  one from a parsed `SidFile`), `Playable` (bytes plus reference plus index — never one without
  the other).
- `ports.ts` — `TuneStore` and `TuneIndexer`, the seams a host implements. `TuneStore` is
  deliberately dumb: no rules, just storage.
- `inserter.ts` — `TuneInserter` / `createTuneInserter`: hashes and stores a tune's bytes,
  idempotent by construction.
- `resolver.ts` — `TuneResolver` / `createTuneResolver`: the lookup-or-index rule and the
  in-flight de-duplication that makes concurrent resolves of one identity share a single scan.
- `md5.ts` — `md5Hex`, RFC 1321 MD5 hand-rolled with no dependency, since `sidHash` is a content
  MD5 and nothing else here needs a hashing library.
- `testing/in-memory-tune-store.ts` — `InMemoryTuneStore`, a `Map`-backed `TuneStore` exported
  from the package root the way `core` exports `FakeSink`.
- `__fixtures__/` — a bundled real tune (Still Time) `md5.spec.ts`, `inserter.spec.ts` and
  `resolver.spec.ts` run against. Internal only; never exported from the package root.

## Conventions

- Relative imports carry explicit `.js` extensions — the root invariant.
- `sidHash` is always computed here, by `md5Hex`, over the whole `.sid` file. Nothing in this
  package accepts a hash from a caller as ground truth without deriving it the same way `insert`
  does.

## Hazards

- **The in-flight de-dup map is per-resolver-instance and rejection clears it.** `resolver.ts`
  keys `Map<string, Promise<Playable | null>>` by `${sidHash}:${subtune}` and deletes the entry in
  `finally`, not only on success — a rejected scan must never be cached as if it were a completed
  answer, or a transient failure would wedge that identity until the process restarts.
- **A `Playable` never exists without its `index`.** The resolver's only two outcomes are
  bytes-with-index or `null`; do not add a code path that hands back bytes alone; a deck that plays
  from a `Playable` trusts the index is there.

## When a change here ripples

- **Changed `TuneStore` or `TuneIndexer`'s method signatures?** Every host adapter that implements
  them breaks at its call site, not here — this package has no adapter of its own to catch it.
  Grep the host application for `TuneStore`/`TuneIndexer` implementations before shipping the
  change.
- **Changed what `md5Hex` returns, or how a `sidHash` is derived?** Every previously computed
  `sidHash` stops matching what a fresh insert produces — treat it like a storage key format
  change, not a refactor. `md5.spec.ts`'s HVSC-sourced Still Time digest is the check that this
  package still agrees with the file HVSC's own `Songlengths.md5` addresses by the same hash.
- **Bumped `@sidablist/analysis`'s `TUNE_INDEX_FORMAT_VERSION` or reshaped `TuneIndexRecord`?**
  `resolver.ts` compares `formatVersion` on every `getIndex` hit — confirm the miss path still
  round-trips the new shape through `TuneStore.putIndex` the way the host's storage expects.
  Detail: [`libs/analysis/AGENTS.md`](../analysis/AGENTS.md).

## Commands

```
pnpm --filter @sidablist/tunes build
pnpm --filter @sidablist/tunes test
pnpm --filter @sidablist/tunes typecheck
```

## Further reading

- [`AGENTS.md`](../../AGENTS.md) — the root map and the invariants no single library owns.
- [`libs/analysis/AGENTS.md`](../analysis/AGENTS.md) — `TuneIndexRecord` and
  `TUNE_INDEX_FORMAT_VERSION`, the shape this package resolves and caches but never computes
  itself.
- [`libs/core/AGENTS.md`](../core/AGENTS.md) — `SidFile` and `parseSidFile`, which `inserter.ts`
  and `resolver.ts` both read through.
