# analysis

Turns a scanned tune's raw register stream into the persisted `TuneIndexRecord` a host caches: the
loop, key, structure, novelty and pulse detectors, plus the scan ladder — `indexTune` — that decides
how deep to scan and when to stop. Framework-free and worker-portable, so a host can index a tune
with no Angular, and no browser main thread blocked, in sight.

## How it works

The public surface is `src/index.ts`; nothing under `__fixtures__` is exported from it.

- `scan-tune.ts` — `TuneScan`/`scanTune`, the frame-by-frame emulation loop every detector reads
  its input from. Wraps `@sidablist/core`'s `C64Machine`, and is the one file here that runs the
  6502 core rather than reading its output.
- `scanner.ts` — the `AnalysisScanner` port and its message types (`ScanRequest`/`ScanMessage`/
  `ScanResult`), the seam a host's worker or main-thread scanner implements. Carries no
  `InjectionToken` — that belongs to the host's DI framework, not this package.
- `scan-worker-handler.ts` / `scan.worker.ts` — the pure request handler and the thin
  `self.onmessage` shim wrapping it, split so the handler is testable under Node. Published as the
  `./scan.worker` subpath (see `package.json`'s `exports`).
- `index-tune.ts` — `indexTune`, the scan ladder lifted out of the POC's Angular service into one
  pure function from tune bytes and an identity to a `TuneIndexRecord`.
- `frame-features.ts`, `notes.ts`, `key.ts`, `novelty.ts`, `structure.ts`, `pulse.ts`,
  `loop-detect.ts` — the detectors themselves, each pure over a `ScanOutput` or the `FeatureMatrix`
  derived from one.
- `tune-index.model.ts` — `TuneIndexRecord` and `TUNE_INDEX_FORMAT_VERSION`, the persisted shape
  and its compatibility gate.
- `tune-index-readouts.ts`, `tune-length.ts`, `marker-moments.ts`, `format.ts` — display-facing
  helpers a host's UI reads a record through.
- `__fixtures__/` — a bundled real tune (Still Time) the moved specs and `index-tune.spec.ts`'s
  end-to-end test run the pipeline against. Internal only; never exported from the package root.

## Conventions

- Relative imports carry explicit `.js` extensions — the root invariant, worth restating here since
  every file this package's specs moved in from the POC needed exactly this edit and nothing else
  structural.
- Nothing here computes a `sidHash`. `indexTune` takes the identity in and never derives it: the
  hash is content MD5 over the whole `.sid` file, computed by whichever host package owns hashing —
  this package cannot depend on that host without inverting the dependency arrow described below.

## Hazards

- **Rung math is sized off the probe's _rounded_ rate, on purpose.** `index-tune.ts` converts
  `MIN_TAIL_SECONDS`/`IDLE_PERIOD_SECONDS` and every rung depth through the zero-frame probe's
  rounded `PlayRate` literal, not its exact one — the loop guard's job is telling a real repeat from
  a played-out buffer, and a threshold a few frames either way changes nothing about that. Sizing
  rungs off the exact rate instead is not a precision improvement; it is a deviation from the
  baseline the ladder's depths were measured against.
- **The zero-frame probe is load-bearing, not an optimisation to skip.** It is what tells the ladder
  a multispeed tune's real `callsPerFrame` before committing to a rung depth — guessing single-speed
  instead sizes every rung wrong for any tune that is not.
- **The dependency arrow is `analysis → core` only.** `core` must never import from this package.
  `indexTune` receiving the `sidHash` as a parameter, rather than reaching for a hashing routine
  itself, is what keeps that arrow one-directional — see Conventions above.

## When a change here ripples

- **Changed `TuneIndexRecord`'s fields, or bumped `TUNE_INDEX_FORMAT_VERSION`?** The `libs/tunes`
  package (not yet standing) resolves a tune's cached scan by comparing this version on every hit,
  and the consuming application stores the record itself — a bump invalidates every stored scan.
  Confirm the new shape and version are what the resolver and the application's storage migration
  actually expect before shipping the bump.

## Commands

```
pnpm --filter @sidablist/analysis build
pnpm --filter @sidablist/analysis test
pnpm --filter @sidablist/analysis typecheck
```

## Further reading

- [`AGENTS.md`](../../AGENTS.md) — the root map and the invariants no single library owns.
- [`libs/core/AGENTS.md`](../core/AGENTS.md) — the timeline engine this package reads `ScanOutput`
  from; see its own ripple edge for what changing `C64Machine`'s frame/rate surface costs here.
