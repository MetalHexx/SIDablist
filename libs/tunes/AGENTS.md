# tunes

The DJ's knowledge of a tune: what one _is_ (`TuneIdentity`, `TuneReference`, `Playable`,
`LoopMarker`), the sets and tune memory a performer builds from it (`TuneSet`, `SetRow`,
`TuneMemory`) with the rules that create, edit and order them, the ports a host supplies to store
and index it (`TuneStore`, `TuneIndexer`, `LoopPositionsStore`, `SetStore`, `TuneMemoryStore`), and
the one rule — index once per hash and subtune, look up before scanning — that lives here instead
of in every deck that plays a tune.

## How it works

The public surface is `src/index.ts`; nothing under `__fixtures__` or `testing/` is exported from
it except the `InMemory*` doubles. `plain-copy.ts` is internal too.

- `identity.ts`, `reference.ts`, `playable.ts` — the values: `TuneIdentity` (content hash plus
  1-based subtune), `TuneReference` (header facts plus identity, and `referenceFor` that builds
  one from a parsed `SidFile`), `Playable` (bytes plus reference plus index — never one without
  the other).
- `loop-marker.ts` — `LoopMarker`, `LoopBoundary` and `PlainValue`: the positions a performer marked
  in one tune, as plain frame-and-offset numbers. The marker also carries an optional `name`, and
  `PlainValue` `settings` and `usesOwnSettings`, which the library stores and copies but never reads. A storage shape only;
  no engine snapshot or readiness flag belongs on it, since `@sidablist/core` rebuilds snapshots
  from these positions and never depends on this package.
- `tune-set.ts` — `TuneSet`, `SetRow`, `SubtuneMemory`, `TuneMemory` and their companions: the
  storage shape of a set and of a tune's latest memory.
- `set-rules.ts` — the pure rules that create, edit and order sets and rows, keep a SID once per
  set, and turn a row edit into the tune's latest memory.
- `plain-copy.ts` — the deep copies of plain data, markers, memory, rows and sets that keep rules
  and doubles from sharing references.
- `ports.ts` — `TuneStore`, `TuneIndexer`, `LoopPositionsStore`, `SetStore` and `TuneMemoryStore`,
  the seams a host implements. All but `TuneIndexer` are deliberately dumb: no rules, just storage.
- `inserter.ts` — `TuneInserter` / `createTuneInserter`: hashes and stores a tune's bytes,
  idempotent by construction.
- `resolver.ts` — `TuneResolver` / `createTuneResolver`: the lookup-or-index rule, the in-flight
  de-duplication that makes concurrent resolves of one identity share a single scan, and the
  optional `onScanStart` hook that tells a host a real scan (not a cache hit) is about to run.
- `md5.ts` — `md5Hex`, RFC 1321 MD5 hand-rolled with no dependency, since `sidHash` is a content
  MD5 and nothing else here needs a hashing library.
- `testing/in-memory-tune-store.ts` — `InMemoryTuneStore`, a `Map`-backed `TuneStore` exported
  from the package root the way `core` exports `FakeSink`.
- `testing/in-memory-loop-positions-store.ts` — `InMemoryLoopPositionsStore`, a `Map`-backed
  `LoopPositionsStore` that copies lists on save and load, and deep-copies each marker's `settings`.
  It is the session implementation a host uses until a permanent store replaces it behind the same
  port, and a stand-in in consumers' specs.
- `testing/in-memory-set-store.ts`, `testing/in-memory-tune-memory-store.ts` — `Map`-backed
  `SetStore` and `TuneMemoryStore` that deep-copy on save and load.
- `__fixtures__/` — a bundled real tune (Still Time) `md5.spec.ts`, `inserter.spec.ts` and
  `resolver.spec.ts` run against. Internal only; never exported from the package root.

## Conventions

- Relative imports carry explicit `.js` extensions — the root invariant.
- `sidHash` is always computed here, by `md5Hex`, over the whole `.sid` file. Nothing in this
  package accepts a hash from a caller as ground truth without deriving it the same way `insert`
  does.

## Hazards

- **The set rules never read a clock or mint an id.** Ids and `now` come from the caller; a rule
  that reaches for `Date` or a generator makes every host's sets untestable and its stamps unequal.
  A change that changes nothing returns its input object, and callers compare on that.
- **The in-flight de-dup map is per-resolver-instance and rejection clears it.** `resolver.ts`
  keys `Map<string, InFlightEntry>` by `${sidHash}:${subtune}`, where each entry holds the shared
  promise, whether its scan has started, and the `onScanStart` hooks still waiting on it — and
  deletes the entry in `finally`, not only on success, so a rejected scan is never cached as if it
  were a completed answer and the next resolve of that identity scans again instead of wedging.
  A joiner's hook fires immediately, inline, if it arrives after `scanStarted` flips true; before
  that it queues to fire alongside the others when the scan starts. Every hook runs inside its own
  `try/catch` so a throwing host callback never rejects the shared promise or blocks a sibling hook.
- **A `Playable` never exists without its `index`.** The resolver's only two outcomes are
  bytes-with-index or `null`; do not add a code path that hands back bytes alone; a deck that plays
  from a `Playable` trusts the index is there.

## When a change here ripples

- **Changed `TuneStore`, `TuneIndexer` or `LoopPositionsStore`'s method signatures?** Every host
  adapter that implements them breaks at its call site, not here — this package has no adapter of
  its own to catch it. Grep the host application for `TuneStore`/`TuneIndexer`/`LoopPositionsStore`
  implementations before shipping the change.
- **Changed `LoopMarker` or `LoopBoundary`'s fields?** Every host's permanent `LoopPositionsStore`
  holds markers in this shape, so a field change is a storage-format change, not a refactor —
  markers already saved stop loading. The inner shape of `settings` is the host's to version: a
  change to it is the host's migration, never this package's. Grep the host application for
  `LoopPositionsStore` implementations before shipping the change. Detail:
  [`src/ports.ts`](./src/ports.ts).
- **Changed `TuneSet`, `SetRow`, `SubtuneMemory` or `TuneMemory`'s shape?** It is a
  storage-format change for every host's set and tune-memory stores: sets already saved stop
  loading. `teensyrom-web`'s DJ library DTOs and validator must move with it.
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
