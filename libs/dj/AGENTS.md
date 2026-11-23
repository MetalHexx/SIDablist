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
- `src/dj.ts` — `createDj`: decks kept by id, validation and the refusal log, and the one wake that
  follows whichever decks are rendering.
- `src/deck/` — one deck. `deck.ts` is the deck: the command log, the flush and rewind, loading, events
  and the picture. Around it: `driven-clock.ts` (the engine's `FrameClock`, ticked only by the deck),
  `sink-tap.ts` (the engine's `SidSink`, mapping the output's counts onto stream frames),
  `restore-ring.ts` (the restore points), `deck-state.ts` (`DeckState`, the package's own saved state),
  `command-log.ts` and `event-queue.ts` (preallocated, outside the saved state), `tempo.ts` and
  `settings.ts` (the tempo layers and the main settings).
- `src/heavy-work/inline.ts` — `createInlineHeavyWork`, replay and scan on the calling thread, for Node,
  tests and the bench.
- `src/index.ts` — the main path's public surface. Browser-only files live under `src/browser/` and
  reach the host through their own subpath, never through this one.
- `src/testing/` — helpers for specs, never exported; typechecked with the DOM, excluded from the
  main-path check. `harness.ts` (fake time, a manual wake, a `Rig` over `createDj`), `holding-sink.ts`
  (a sink that holds frames until its time passes them), `compare.ts` (a straight deck against a
  rewound one), `measure-allocation.ts` (a copy of core's, which core does not export).
  `src/__fixtures__/` holds the two tunes cleared for redistribution; no other HVSC tune goes in the
  repo.

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
- **Frames are held by the sink, never by the package.** A deck renders ahead into its output, each
  frame carrying its due time, and the sink holds it until due. A deck with no output renders into a
  sink that holds nothing, which is never rewound.
- **A command lands through one rewind path, and so does anything the engine saves that arrives
  late.** The register record is the one that bites: the engine's saved state holds it, so every
  restore point saved before it has none, and calling `setRegisterRecord` directly between ticks lets
  the next rewind restore one without it and withdraw it for good. The same goes for any call into the
  engine between ticks that does not go through the log: the held restore points lack it.
- **The command log and the fixed ready landings live outside the saved state**, so a rewind
  re-applies commands rather than losing them. A slot is saved after its frame's between-tick logic
  and records the last log entry applied at its next frame (`appliedThrough`: a mark within one
  frame, since commands land out of arrival order). A re-applied entry reuses its first answers,
  because the engine saves no images and asking again could answer differently.
- **`DeckState` is the saved state, and a field left out restores almost exactly.** A field the deck
  keeps that decides the next frames joins `DeckState` (and both copy methods), or its doc comment
  says why it is out. It passes most specs and breaks one playing state much later; only
  `deck/rewind.spec.ts` catches it, by playing a rewound deck against a straight one.
- **A save is never made inside a tick, and the package never subscribes to the engine.** Listeners
  run inside the tick, and a call back into the engine from there, or a save, breaks its contract.
  All package logic runs between ticks.
- **Events go out once their frame has passed, never at render.** A rewind discards the queued events
  on the frames it re-renders, and the re-render makes them again if they still happen. `loaded` and
  `load-failed` report a load that finished off the frame path and are never discarded. Updates are
  not events: a re-render sends them again.
- **The tap swallows `retime`.** The frames carry exact due times from the driven clock, and a tempo
  change takes effect from its landing frame by re-rendering; the engine's retime would re-time the
  frames already held wrongly.
- **A halt due ahead waits until the frames before it have passed.** The engine's halt (`pause`,
  `stop`, a load's `stop()`) resets the sink, which drops everything held, so the deck renders no
  further than the frame before it and applies the halt when the sink has passed that frame.
- **Switching a sink while playing does not resync the far end.** A restore queues no resync and core
  has no public one, so a sink switched in while playing gets only the registers that change after
  the switch; its far end starts with an incomplete chip until the tune writes each register.
  Re-sending a playing deck's registers is left to the cutover.
- **With repeat off, the end of the tune drops the held tail.** The engine's end resets the sink, so
  the last lookahead of frames is not heard. Decks repeat by default.
- **A ready landing is fixed outside the saved state.** The engine does not save which images are
  prepared, so a re-render would find a waiting target ready earlier than it first was. A waiting
  seek's landing frame is fixed once, when it is first seen ready, and a re-render lands it there.
- **Seeks never replay off-thread while playing.** A seek to a frame the engine holds no image for is
  declared and waited for, because a replay's landing time would depend on the worker and break
  determinism.
- **`play()` settles asynchronously, so await it.** It sets the transport only after its clock start
  resolves; a `pause()` any earlier does nothing. Every engine call that returns a promise is awaited,
  and the deck renders nothing and holds later commands until it settles.
- **Ring memory grows with lookahead, tempo and crossing lines.** About 136 KB a slot, one per frame
  the deck can hold at the fastest tempo, plus one; a ring is made off the frame path and rebuilt, not
  grown.
- **The per-frame path allocates nothing.** Preallocated typed arrays and records, no closures, no
  `for…of` over a `Map`, no `subarray`. `deck/deck.allocation.spec.ts` measures it (it needs
  `--expose-gc`, which `vitest.config.ts` gives the workers). The due time handed to the engine's
  clock callback is a fractional double V8 boxes: about 16 bytes a frame, which the specs' budgets
  allow for.

## When a change here ripples

- **Changed a message's shape (`messages/commands.ts`, `messages/reports.ts`)?** The validation rule for
  that kind, the sample in `testing/samples.ts` and the browser adapter all read the same shape; a
  field one of them misses compiles in the adapter and then fails at the boundary or drops silently
  across `postMessage`. Update `messages/validate.ts`, run `messages/validate.spec.ts` and
  `messages/round-trip.spec.ts`, and update the adapter once it exists. Detail:
  [`src/messages/validate.ts`](./src/messages/validate.ts)
- **Changed how a command lands, or a field the deck keeps that decides frames (`deck/deck.ts`,
  `deck/deck-state.ts`, `deck/command-log.ts`)?** The rewind must still give exactly the frames a
  deck that ran straight gives, due times and frame numbers included. Run `deck/rewind.spec.ts` (it
  plays the two decks against each other) and `deck/deck.spec.ts`, and `deck/deck.allocation.spec.ts`
  for what the frame path allocates. Detail: [`src/deck/deck.ts`](./src/deck/deck.ts)

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
