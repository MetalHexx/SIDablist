# dj

The DJ logic over a deck's playhead: when and where it goes, in industry DJ terms (decks, loops, cues,
slip, the live looper, the hand and rewind). It is its own module because it sits above `libs/core`,
`libs/analysis` and its callers, and must know no application: a host sends it plain messages and
supplies everything environmental.

## How it works

- `src/messages/` — the message contract: `commands.ts` (what a host sends), `reports.ts` (what a deck
  tells the host), `validate.ts` (`validateInbound`, the guard for untrusted input) and `setting-table.ts` (`SETTING`, the
  fixed numbered settings, and `describeSetting`: each one's kind, chip field, voice and range; a number
  is never reused, and the validator and the deck both read the table).
- `src/plugs.ts` — the plugs a host supplies (`DjPlugs`, `Wake`, `HeavyWork`, `DeckOutput`) and the
  `Dj` surface.
- `src/dj.ts` — `createDj`: decks kept by id, validation and the refusal log, and the one wake that
  follows whichever decks are rendering.
- `src/deck/` — one deck. `deck.ts` is the deck: the command log, the flush and rewind, loading, taps,
  events and the picture. Around it: `driven-clock.ts` (the engine's `FrameClock`, ticked only by the deck),
  `sink-tap.ts` (the engine's `SidSink`, mapping the output's counts onto stream frames),
  `restore-ring.ts` (the restore points), `deck-state.ts` (`DeckState`, the package's own saved state),
  `command-log.ts` and `event-queue.ts` (preallocated, outside the saved state), `tempo.ts` (the
  tempo layers) and `settings.ts` (the settings lists, applying one setting to the engine and what a
  jump carries; the table itself lives in `messages/setting-table.ts`), `loops.ts` (`DeckLoops`:
  jumps, the hot cue press, letting go, edits to the running loop, and the settings in play, with a
  loop's own swapped in on its landing frame and out on its let-go),
  `hand.ts` (`DeckHand`: the touch, the moves and the lift as varispeed, and the throw that slows to
  the deck's own speed), `slip.ts` (`DeckSlip`: the departures, the second count and the landing
  on it; `loops.ts` and `hand.ts` tell it where a departure begins and ends) and `live-loop.ts`
  (`DeckLiveLoop`: the grid's crossing lines, the live loop's start, resizing and end back into the
  loop underneath; `loops.ts` adopts it as the running loop and ends it when a loop lands over it).
- `src/heavy-work/inline.ts` — `createInlineHeavyWork`, replay and scan on the calling thread, for Node,
  tests and the bench.
- `src/index.ts` — the main path's public surface. Browser-only files live under `src/browser/` and
  reach the host through their own subpath, never through this one.
- `src/browser/` — the only code that touches a browser, exported through `@sidablist/dj/browser` (and `./browser/wake.worker`) and never from the root: `time.ts` (`createBrowserTime`), `wake.ts` and `wake.worker.ts` (`createBrowserWake`, a worker-timer or silent-audio wake with `readings` for late wakes), `heavy-work.ts` (`createBrowserHeavyWork`: core’s worker replay runners and a worker-backed scanner over workers the app builds) and `carry.ts` (`serveDj` on the package’s side, `connectDj` on the host’s, over any `PortLike`: a `MessagePort`, a `Worker` or a worker’s global).
- `src/testing/` — helpers for specs, never exported; typechecked with the DOM, excluded from the
  main-path check. `harness.ts` (fake time, a manual wake, a `Rig` over `createDj`), `holding-sink.ts`
  (a sink that holds frames until its time passes them), `compare.ts` (a straight deck against a
  rewound one; the straight deck is sent every command up front and only advanced, so it cannot
  express a `play` after a `pause` or `stop` (`deck/deck.spec.ts` exercises that, though not frame
  for frame), and a seek to a frame with no prepared image compares equal only while no other rewind
  lands before the image is ready, because a ready landing is fixed when a deck first sees the image
  ready, so the two decks fix it on different frames) and `measure-allocation.ts` (a copy of core's,
  which core does not export).
  `src/__fixtures__/` holds the tunes cleared for redistribution (`still-time`, `insid3-out`); no
  other HVSC tune goes in the repo.
- `src/proof/` — specs only, across the whole package: `equivalence.spec.ts` (a deck against a bare
  engine, and two decks told the same commands), `determinism.spec.ts` (a run replayed from its
  `landed` events), `asid-sink.spec.ts` (the real ASID sink over a fake port) and
  `rules-easy-to-lose.spec.ts` (the behaviours a rewrite drops quietly).

## Conventions

- Messages are plain data: no classes, functions, `Map`, `Set`, `Date` or `undefined`-only meaning, so
  they survive structured clone and `postMessage`. Frames in a command are tune frames unless the field
  says stream frame.
- Browser globals are allowed only under `src/browser/` (lint ignores it). Nothing outside it imports from it, and the root index never re-exports it. The adapter never requests MIDI access: the permission and the output picker are the application’s.
- A module worker gets no import map: a worker script that imports a bare `@sidablist/*` specifier needs the app’s bundler, so the app builds core’s `replay.worker` and analysis’s `scan.worker` and passes factories. `wake.worker.ts` imports nothing so it loads as it is, and declares a local shape for `self` because `DedicatedWorkerGlobalScope` is not in the DOM lib.
- The carry’s wire is plain data (`inbound`, `report`, `fetch-tune`, `tune-bytes`, `tune-failed`); a message added to it joins both `serveDj` and `connectDj`. `connectDj` sends a copy of the bytes `fetchTune` returns, so a host may keep and reuse them.
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
  `deck/rewind.spec.ts` catches it, by playing a rewound deck against a straight one. The loops'
  fields (the queued and the waiting target, the settings they carry, the change pending, whether
  the loop's own settings play) are held there by reference: a command is immutable, and a save
  allocates nothing.
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
  seek's or jump's landing frame is fixed once, when it is first seen ready, and a re-render lands
  it there.
- **A hot cue is resolved at its landing frame.** A `hot-cue` is a start, a queue, a cancel or a
  let-go by what the deck holds on the frame it lands on, never by what it held when it was sent, so
  a replay at that frame (`fixed` is always `{ at: 'frame' }` for it) resolves the same way. A
  `jump` sent for `pass-end` is the exception: it lands on its `from` frame and the engine's queue
  owns the end of the pass. A first answer is only ever the engine's (is an image held, did it take
  a change): whether a loop runs is derived again every time an entry is applied, because a command
  that lands earlier can change it.
- **The engine's queue is learnt from `tune.handOffs`.** A queued jump disappears from the engine on a
  cancel, a replace, a `setActiveLoop`, a stop and a load as well as when it lands, so only a rise in
  `handOffs`, read after each tick, is a landing: it moves the queued target to running, swaps the
  settings and reports `jump-landed`. The settings a landing carries are built when the command lands,
  never at the landing tick, which allocates nothing.
- **`setActiveLoop` drops the queued jump and a pending change, so every caller names them again.**
  A jump now that replaces the loop drops the queue on purpose; a stab (`seek` alone) and a change of
  wrap (`setActiveLoop` with the same bounds, then `queueJump` and `changeLoopAt` again) keep them.
  A new caller that sets the loop and forgets to re-queue loses a queued jump with no error.
- **A frame past the tune is refused at the deck, not the validator.** A seek, a `jump` or `hot-cue`
  target's start and a `loop-bounds` start above the bound are refused with a reason
  (`Deck.refusal`); a `targets` list drops such frames with a warning (`Deck.receive`). The bound is
  the greatest of the engine's jump ceiling (a fixed 300 s of play calls, `JUMP_CEILING_SECONDS` in
  `libs/core/src/player/tune-session.ts`), the position basis (the indexed length, else that
  ceiling) and the tune's own length. The engine clamps nothing there and replays from the start of
  the tune at a cost linear in the frame, which with the inline heavy work blocks the caller and
  with workers holds the deck (`settling`) until the replay ends. `validateInbound` is stateless and
  knows no tune, so the bound cannot live there. On an unindexed tune a cue, seek or loop start past
  about 300 s is refused with a reason that reaches a host only through a `log` plug: index the tune
  first.
- **The command log holds 256 entries, and a flood past it refuses whatever cannot fold.** An entry
  goes once the sink has passed its frame, so a sustained control stream never reaches the cap; a
  burst of more than 256 in one turn, or automation laid out ahead, does. At the cap a `speed`,
  `nudge`, `speed-jump`, `loop-wraps` or `setting` folds only into the newest entry, when it is of
  the same kind (and, for `setting`, the same setting number), not yet flushed, on the same frame,
  and neither it nor the entry is a `pass-end`: the latest value replaces it and survives.
  Sweepable commands interleaved past the cap (`speed` and `nudge` alternating, say) are refused
  like any other command, with a warning to the log plug, which a host with no `log` plug never
  sees. The command a fold replaces gets no `landed` report of its own.
- **Seeks never replay off-thread while playing.** A seek to a frame the engine holds no image for is
  declared and waited for, because a replay's landing time would depend on the worker and break
  determinism.
- **`play()` settles asynchronously, so await it.** It sets the transport only after its clock start
  resolves; a `pause()` any earlier does nothing. Every engine call that returns a promise is awaited,
  and the deck renders nothing and holds later commands until it settles.
- **A sink that holds nothing never rewinds a frame.** The real ASID sink's `passedCount()` is its
  deliveries and `replaceFrom` returns it, so a command lands on the next frame to render and nothing
  is redone. A sink that reports fewer frames passed than it was handed makes the deck re-render
  frames the far end already has: duplicated on the wire, with no error. `proof/asid-sink.spec.ts`
  catches it.
- **A replay is exact from `fixed`, and from nothing else.** A `landed` event's `fixed` is
  `{ at: 'pass-end', from }` for a jump taken at the end of a pass; replayed as a frame it queues
  nothing and plays another run. Due times are exact only across stretches with no resume (`play`
  after a pause) and no catch-up skip, since both take theirs from `time.now()`; registers, values and
  frame numbers always agree. A replay sends every command ahead of its frame, so a halt landing
  ahead must drop no held frame before it.
- **Ring memory grows with lookahead, tempo and crossing lines.** A slot holds a whole engine state,
  one per frame the deck can hold at the fastest tempo, plus one; a ring is made off the frame path
  and rebuilt, not grown.
- **Crossing lines rebuild the ring.** The grid and the kept live-loop size decide which lines the
  engine saves images at (`setCrossingCaptures`), and a restore point is only good for the lines it
  was saved under, so declaring new ones makes the restore ring again, between ticks and after the
  command's own engine calls (the ring is seeded with the state the command leaves). Lines already
  declared change nothing.
- **The grid and the tap run are saved state.** `DeckState.grid` (by reference: a load's grid and a fit
  are immutable) and the run of taps (the positions its taps marked, and how many) are in every restore
  point and both copy methods. The grid is read from there by the live looper, the gate and the picture;
  a copy kept anywhere else restores almost exactly. `tap-end` and a load empty the run.
- **A tap's mark is a first answer; its fit is not.** The mark is kept on the log entry and reused when
  a rewind applies the tap again: the history behind it (each delivered frame's due time and position,
  by `frame % 512`, outside `DeckState`) is overwritten by re-renders. The fit is made again on every
  application, because it is a function of the whole run in force and a replay's run can differ: a
  tap landing ahead of one already applied adds a mark before it, and a cached fit would set the grid
  from the shorter run. A fit that changes the grid sets it and declares the lines after the tap's own
  state changes, so the restore point the new ring is seeded with holds them; every fit, changed or
  not, queues its `grid-fitted` beside the `landed`, which a rewind discards and makes again once.
- **A tap's mark searches only the frames before its own landing frame.** Never the held frames a
  flush is about to re-render: searching from the newest render would mark a frame the replay, which
  sees only the frames before the landing frame, never sees, and a replay at the fixed frame would
  mark another position.
- **A tap's mark replays exactly only where due times do.** The mark is the position of the latest
  frame due at or before the tap's host time, so a replay agrees across stretches with no resume
  (`play` after a pause) and no catch-up skip, the same limit as every other due time.
- **Each distinct fitted grid rebuilds the restore ring.** A new ring is a whole engine state per slot,
  allocated between ticks inside the flush, never on the frame path, so memory in proportion to its
  slots and images is made again for each grid; taps that keep fitting the same grid rebuild nothing.
  What a rebuild costs in time on a heavy tune is measured on the bench.
- **Note starts are derived from the record, and the gate reads the engine's record.** They are made
  once when the register record's own log entry applies and kept by record identity outside
  `DeckState`, because they are a pure function of a record the engine's saved state holds. A tap
  before the engine holds a record, or on a deck that is not playing, does nothing and says so once.
- **A live loop's start is found one frame past the playhead.** A wrap falls due a frame before the
  end, so a line at the playhead's own frame could never be met by a loop ending there; the search
  is for the last line at or behind `floor(position) + 1`. A start behind the playhead with no image
  held and no register record moves to the next line.
- **The loop underneath is put back before slip lands, or its count starts again.** A landing
  gives the loop running at it the lap its count is in, and a loop set after it starts from its own
  lap 0. Under a live loop the loop underneath, its queued target and its pending change stay in
  `DeckState` and reach the engine only on return; an edit to it waits. Folding into it with no
  register record to land on plays on with no loop, never replays off-thread, and sets the loop
  again as the folded frame's seek lands, so the deck's own `seek` command (whose hooks would clear
  the loop underneath) is never used for it.
- **The hand's rate source runs inside the engine's tick.** `VarispeedRateSource` is called by the
  tick before it moves the record, so it may read the hand's numbers in `DeckState` and the engine's
  snapshot and nothing else: no allocation, no engine command. The throw reaching the deck's speed
  is acted on by `DeckHand.afterTick`, between ticks and before the restore point is saved (a rate
  source or an arrival the slot does not hold replays a frame late). The rate source changes
  `DeckState` fields itself, which is why a rewind replays it exactly: every field it touches is in
  the slot.
- **Slip begins before the engine call that moves the playhead, and the hand's before
  `enterVarispeed`.** The shadow starts from the player's own position, phase and lap, and
  varispeed clears the phase (a gate-off still owed after a jump). Begun after, a touch made on the
  frame of a jump counts a frame off. A loop's departure begins before `setActiveLoop` replaces the
  loop it returns into, and its landing is marked after.
- **Slip nests one level.** A live loop or the hand begun inside a running departure keeps it and
  its count as the outer line, which resumes (the count folded through the ticks the inner ran,
  lapping the outer's own lap, else the track's) when the inner ends; a third level replaces the
  outer one; a loop begun inside a departure begins nothing. All of it is in `DeckState` as numbers.
- **The hand on a stopped record lands every command at the frontier.** The engine refuses every
  restore into a stopped player, so a command under the hand there lands a lookahead late and
  `timing.frontierLandings` counts it; a paused record in varispeed rewinds as a playing one does.
  A throw arriving on a deck that is not playing runs the engine's paused landing, which starts an
  off-thread jump and returns no promise: the deck follows it with an awaited `seek` to the
  position and settles, so a `play` sent meanwhile waits and resumes exactly there.
- **The per-frame path allocates nothing.** Preallocated typed arrays and records, no closures, no
  `for…of` over a `Map`, no `subarray`. `deck/deck.allocation.spec.ts` measures it (it needs
  `--expose-gc`, which `vitest.config.ts` gives the workers). The due time handed to the engine's
  clock callback is a fractional double V8 boxes, which the specs' budgets allow for. A running loop
  adds the `lapProgress` of each update, boxed the same way, and for a length that is not whole the
  lap phase and length it is worked out from, which the loop specs' shorter pass allows for. A
  landing the engine makes is read after the tick from `tune.handOffs` with number compares and
  builds nothing but the picture and the event it reports.
- **A setting's number is fixed forever.** A new setting takes the next number; an old one is never
  reused or renumbered, because a recording, a stored list and `validateInbound` all mean the number.
- **Both settings lists are saved state.** `DeckState.mainSettings` and `loopSettings`, each the value
  of every setting by number, are in every restore point and both copy methods; a setting kept
  anywhere else restores almost exactly.
- **A loop's own list and the main list are each complete: unnamed means home.** A jump into a target
  with settings of its own carries every field the package owns (pitch and mutes for three voices, an
  offset for every offset setting, a hold for every hold), built when the command lands; a jump with
  none, landing while a loop's own play, carries the main list back whole. A jump never goes through
  `releaseSettings`, which the end of a loop does (let-go, stop-loop, a seek, a stop, a load), so the
  main list is applied once.
- **The engine carries holds and offsets across a load, so a load writes the whole list.** At its
  landing frame it puts both lists and the engine home, with a tune or without (a `settings` can land
  on an empty deck), and at install it writes the main list over home, which also overwrites a
  `settings` that landed while the load waited. Writing only what the load names leaves the last
  tune's holds and offsets in force.
- **`flip-lock` reads `written`, not `sent`.** A lock is the opposite of what the tune wrote in the
  last frame rendered before its landing frame, before any shaping; `sent` is the package's own
  shaped output and would lock against itself.
- **`voice-hold` is the engine's and is never carried.** The engine inverts the voice's latched mute
  while it is held and keeps the hold in its own saved state. It is in no settings list, no jump's
  settings and no picture, and a load releases it.

## When a change here ripples

- **Changed a message's shape (`messages/commands.ts`, `messages/reports.ts`)?** The validation rule for
  that kind, the sample in `testing/samples.ts` and the browser adapter all read the same shape; a
  field one of them misses compiles in the adapter and then fails at the boundary or drops silently
  across `postMessage`. Update `messages/validate.ts`, run `messages/validate.spec.ts` and
  `messages/round-trip.spec.ts`, and update the adapter (`src/browser/carry.ts`). Detail:
  [`src/messages/validate.ts`](./src/messages/validate.ts)
- **Changed the setting table (`messages/setting-table.ts`: numbers, fields or ranges)?** It changes
  what a recording means and what `validateInbound` refuses, and `deck/settings.ts` builds every list,
  engine call and carried jump from it. Run `messages/setting-table.spec.ts`, the validate and
  round-trip specs, and the whole dj suite. Detail:
  [`src/messages/setting-table.ts`](./src/messages/setting-table.ts)
- **Changed how a command lands, or a field the deck keeps that decides frames (`deck/deck.ts`,
  `deck/deck-state.ts`, `deck/command-log.ts`, `deck/loops.ts`, `deck/settings.ts`, `deck/hand.ts`,
  `deck/slip.ts`, `deck/live-loop.ts`)?** The rewind must still give exactly the frames a
  deck that ran straight gives, due times and frame numbers included. Run `deck/rewind.spec.ts` (it
  plays the two decks against each other) and `deck/deck.spec.ts`, and `deck/deck.allocation.spec.ts`
  for what the frame path allocates. Detail: [`src/deck/deck.ts`](./src/deck/deck.ts)

- **Changed what a deck delivers: a landing rule, `fixed`, the `landed` event, the sink tap, or how
  the deck reads a sink's `passedCount` and `replaceFrom` (`deck/`, `testing/holding-sink.ts`)?**
  Unit specs can stay green while a deck stops matching a bare engine, a replay of its own run, or
  the real ASID sink, and those fail by frame and register. Run the whole package's tests, `proof/`
  included. Detail: [`src/proof/determinism.spec.ts`](./src/proof/determinism.spec.ts)
- **Changed `libs/asid`'s sink (`passedCount`, `replaceFrom`, `deliver`, `reset`)?** This package takes
  `@sidablist/asid` as a dev dependency for one spec, and a deck's rewind rests on those counts. Run
  `pnpm --filter @sidablist/dj test`. Detail: [`src/proof/asid-sink.spec.ts`](./src/proof/asid-sink.spec.ts)

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
