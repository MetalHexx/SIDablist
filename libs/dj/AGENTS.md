# dj

The DJ logic over a deck's playhead: when and where it goes, in industry DJ terms (decks, loops, cues,
slip, the live looper, the hand and rewind). It is its own module because it sits above `libs/core`,
`libs/analysis` and its callers, and must know no application: a host sends it plain messages and
supplies everything environmental.

## How it works

- `src/messages/` — the message contract: `commands.ts` (what a host sends), `reports.ts` (what a deck
  tells the host), `validate.ts` (`validateInbound`, the guard for untrusted input).
- `src/plugs.ts` — the plugs a host supplies (`DjPlugs`, `Wake`, `HeavyWork`, `DeckOutput`) and the
  `Dj` surface.
- `src/index.ts` — the main path's public surface. Browser-only files live under `src/browser/` and
  reach the host through their own subpath, never through this one.
- `src/testing/` — helpers for specs; typechecked with the DOM, excluded from the main-path check.

## Conventions

- Messages are plain data: no classes, functions, `Map`, `Set`, `Date` or `undefined`-only meaning, so
  they survive structured clone and `postMessage`. Frames in a command are tune frames unless the field
  says stream frame.
- The main path takes the clock, the log, workers and the wake-up through plugs. It reads no clock,
  writes no console and builds no worker.
- Nothing here names an application, a screen or a product; vocabulary is the DJ's.
- The package never subscribes to the engine: it drives `libs/core` and reads its answers.

## Hazards

- The main path's typecheck (`tsconfig.main.json`) has no DOM lib on purpose. A `setTimeout`,
  `performance` or `window` that fails it is a real violation: route it through a plug instead of
  widening the config.
- `validateInbound` refuses unknown fields. A field added to a command that is not added to its rule
  is refused at the door, not ignored.

## When a change here ripples

- **Changed a message's shape (`messages/commands.ts`, `messages/reports.ts`)?** The validation rule for
  that kind, the sample in `testing/samples.ts` and the browser adapter all read the same shape; a
  field one of them misses compiles in the adapter and then fails at the boundary or drops silently
  across `postMessage`. Update `messages/validate.ts`, run `messages/validate.spec.ts` and
  `messages/round-trip.spec.ts`, and update the adapter once it exists. Detail:
  [`src/messages/validate.ts`](./src/messages/validate.ts)

## Commands

```
pnpm --filter @sidablist/dj build
pnpm --filter @sidablist/dj test
pnpm --filter @sidablist/dj typecheck
```

## Further reading

- [`AGENTS.md`](../../AGENTS.md) — the root map and the invariants no single library owns.
- [`libs/core/AGENTS.md`](../core/AGENTS.md) — the engine this package drives, and the edge for what
  changing it costs here.
- [`libs/analysis/AGENTS.md`](../analysis/AGENTS.md) — the frame arithmetic and recording this package
  builds on.
