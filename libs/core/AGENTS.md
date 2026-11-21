# core

Runs a `.sid` tune's own 6502 code against a faked C64 and turns the register writes it makes into
`SidFrame`s a sink can put on a wire. Owns the timeline — position, tempo, the active loop — and
holds no notion of where bytes physically go or what a person wants.

> [`docs/architecture.md`](../../docs/architecture.md) is the _why_ behind the conventions and
> hazards below: the premise that a tune is a program rather than audio, the sink/transport seam
> split, how a consumer reads the snapshot/position/stats split, and the PAL/NTSC pitch
> correction's derivation. Read it before restructuring this library, adding a port, or drawing a
> new boundary — not for a routine edit.

## How it works

The public surface is `src/index.ts`; nothing outside it is meant to be imported directly.

- `sid/` — parses a `.sid` file into the model the rest of this library runs.
- `cpu/` — `C64Machine`, the faked 64 KB address space a tune's `init`/`play` routines run against,
  driven through a `Cpu6502` port (`cpu-port.ts`) the vendored core in `vendor/mos6502/` implements.
  `io-chips.ts` is its VIC raster flag and both CIAs' timers, with the cycle count that places each
  play call in time.
- `registers/` — `SidFrame` (one frame's writes), `RegisterFrame` (the accumulator and the output
  stage — multiplier, offset, hold — that builds one), `sid-fields.ts` (the table of chip fields an
  application can drive), `register-record.ts` (`RegisterRecord`, a tune's register stream as data,
  which varispeed plays), `__reference__/` (the frozen pre-field-table implementation
  `register-frame.equivalence.spec.ts` checks against), and the register and clock constants.
- `clock/` — `FrameAccumulator`, `ClockStats` and the play-rate math a host clock is measured and
  paced by.
- `timeline/` — `AnchorRing`, `seekToFrame` and `ActiveLoopTracker`: the position and loop
  operations core owns. An `ActiveLoop` may carry `varispeedStart`, which varispeed alone reads.
  `ActiveLoopTracker.changeAt` names a change of loop for the lap that ends at a frame. A loop whose
  length is not a whole number of frames laps in alternating whole-frame lengths: `ActiveLoop.lapPhase`
  is the unrounded grid position its laps are counted from, and `lapLength`, `lapSpan`, `lapsWithin`,
  `lapPhaseAfter` and `reduceLapPhase` (all exported) are the arithmetic the tracker, the shadow and
  a host share. `isUsableLoopLength` and `MIN_FRACTIONAL_LOOP_FRAMES` say which lengths may run.
  `crossing-captures.ts` is the bounded pool of images saved as the playhead crosses declared lines
  (`CrossingLines`) and the arithmetic that says when to save one. `shadow-position.ts` is the
  counter behind the shadow position and `countAfter`, the pure arithmetic a host folds its own
  count with.
- `player/` — `createSidPlayer`, the composition root wiring the above into `SidPlayer`, plus
  `PlayerSnapshotStore` and the `PlayerSnapshot`/`PlayerStats` shapes a consumer reads. The jump
  surface: `setJumpTargets` declares the frames built ahead into ready snapshots (readiness and the
  queue are published under `tune.preparedFrames`, `tune.queuedJump` and `tune.handOffs`);
  `queueJump` queues a hand-off for the running loop's next wrap; `queueJump` and `seek` can carry
  `JumpSettings`, applied as the jump lands; `capturePosition()` returns the frame it captured.
  `SidPlayerCollaborators.prepareRunner` is an optional second replay runner for those builds, so a
  scrub does not wait behind a batch of them; without it they share the scrub runner. Varispeed
  (`enterVarispeed`/`leaveVarispeed`) plays a `RegisterRecord` at a rate the host names per tick,
  held inside a loop that carries `varispeedStart`; `varispeed.ts` is the record-driven half the
  coordinator sequences. `keepDeliveries`/`drainDeliveries` keep a bounded history of every frame
  delivered (`delivery-history.ts`, whose `DeliveryBatch` and `createDeliveryBatch` are public and
  whose `DeliveryHistory` is not), for a host that samples slower than frames are built.
  `getLapPhase()` reads the running loop's lap in progress, pulled like `getPosition()`.
  `createSavedState`, `saveState` and `restoreState` keep a restore point of everything that decides
  the next frames, every frame if a host likes, and come back to it exactly (`saved-state.ts` is
  its layout; `SavedPlayerState` is opaque).
  `setCrossingCaptures` declares lines the live machine is saved at as the playhead crosses them,
  and `holdsImageAt` says whether an entry image exists for a frame (prepared, cached or saved at a
  crossing); a loop set at such a frame re-enters from the saved image with no replay.
  `changeLoopAt` changes a running loop's bounds from the lap that ends on a named frame, published
  as `tune.loopChange`. The shadow position (`startShadow`, `getShadowPosition`, `getShadowCount`,
  `getShadowTicks`) is a second count that moves a frame a tick while playing, wherever the
  playhead goes, and is pulled like `getPosition()`; `land` and `landOnShadow` put the playhead on
  a frame the register record covers, playing from the record while the machine is rebuilt ahead.
- `replay/` — runs frames ahead of the playhead for analysis, on the main thread or a worker.
- `conformance/` — `SINK_CONFORMANCE_CASES`, the suite any `SidSink` implementation runs against
  itself, and `SINK_REPLACE_CASES`, the part of it a sink with no clock can run alone.
- `ports/` — `FrameClock`, `SidSink`, `Transport`, `TimeSource`, `EngineLog`: the interfaces a host
  injects; this library depends on none of their implementations.
- `testing/` — `FakeClock`, `FakeSink`, `FakeTransport`: fixtures for a consumer's own specs.
- `vendor/mos6502/` — the vendored 6502 core. See Hazards below before touching it.

## Conventions

- **Core reads no clock, writes no console and builds no worker.** Time comes from the injected
  `TimeSource`, rejected input and failures go to the optional `EngineLog` (absent means silent),
  and `createWorkerReplayRunner` requires its worker factory. `eslint.config.mjs` enforces it:
  `performance` and `console` are restricted globals and `new Worker(...)` is banned under
  `libs/core/src` (specs and `testing/` excepted).
- A new field on `PlayerSnapshot` or `PlayerStats` lands inside an existing named group, never as
  a new flat top-level property — see either interface's own doc comment for why.
- Whether new player state goes on `PlayerSnapshot` (pushed through `subscribe`) or `PlayerStats`
  (pulled via `getStats()`) follows the read/notify split `docs/architecture.md`'s "How a consumer
  reads core" explains: a person's action notifies, time passing does not.
- A chip field an application wants to drive is a row in `registers/sid-fields.ts`, reached through
  `holdField`/`releaseField` and `setFieldOffset`/`clearFieldOffset` — never a new per-field method
  on `RegisterFrame` or `SidPlayer`.
- A host that needs every delivery between its reads — a one-frame gate, a doubled control write —
  uses `keepDeliveries`/`drainDeliveries`, never `readRegisters`: that is the chip at one instant,
  and anything that came and went between two reads is gone from it.
- A stateful part the player is built from (`ActiveLoopTracker`, `TrackStructure`, `ShadowPosition`,
  `Varispeed`, `RegisterFrame`, `CrossingCaptures`) is `Saveable` (`common/saveable.ts`):
  `createState` allocates off the tick, `saveInto` and `restoreFrom` allocate nothing and run no
  setter, hook or notification. A new field on one of them joins its state type, or its doc comment
  says why it is out — a field left out restores almost exactly, which only a round-trip spec in the
  part's own spec file catches. The tracker's three images are held by reference, not copied, so
  whoever owns them must keep them valid between a save and its restore: the player's save copies
  the loop-entry buffer, the one mutable image among them, itself.
- A new field on the player (`SidPlayerCoordinator`) joins the saved state — `player/saved-state.ts`,
  `saveState`, `restoreState` — or the list under "A saved state holds everything…" below says why it
  is left out.
- A capability a sink cannot honour is a new field on `SinkCapabilities` (`ports/sink.ts`),
  reported and worked around by core — never a thrown error, and never a method core assumes
  every sink implements.

## Hazards

- **The hot path does not allocate.** `RegisterFrame`'s per-frame state — `values`, `writeOrder`,
  the reused `SidFrame` buffers `takeSnapshot()` hands back — is mutated in place on purpose (see
  `registers/register-frame.ts`). Frame delivery runs fifty times a second; wrapping any
  of it in a fresh object or a getter for readability is a real regression, and it is audible.
  `player/create-sid-player.allocation.spec.ts` and `timeline/anchor-ring.allocation.spec.ts` measure
  plain play, laps, landings, the hand, a save every frame with a restore every fifty, alternating
  restores, a restore while playing and the anchor ring against a sink that holds nothing;
  `player/create-sid-player.allocation-rate.spec.ts` measures a tune that changes its rate every call,
  whole and fractional, in a file of its own (they need `--expose-gc`, which `vitest.config.ts` gives
  the workers). A new thing on the tick that allocates shows there: a result object, a `for…of` over a
  `Set` or `Map`, a keyed read or store of a field the CPU holds as a double (`copyStateInto` and
  `setState` name their fields for that reason), a snapshot built where nothing published changed.
- **A saved state holds everything that decides the next frames, and a field left out restores
  almost exactly.** It passes most specs and breaks one playing state, which is why
  `player/create-sid-player.save-restore.spec.ts` plays two players on one tune — one straight
  through, one saving, playing on with other commands, restoring — and compares every delivered
  frame register for register, frame number and due time included, across each playing state. In: the
  machine, the register frame's output stage, the position, tempo and the rate mirror, mutes, the
  output settings the next load carries (gain, scales, target clock, pitches), field holds and
  offsets, the running loop with its queued jump, its settings, a pending change and the images they
  hold, the track structure and the track loop's entry image, the hand-offs landed, the crossing
  pool, the shadow, and the hand (varispeed, rate source, the handback, the gate-off owed). Out:
  what only reports (stats, the delivery history, snapshots), what the host owns (its clock, sink,
  the rate source's own state, the transport), what the tune alone determines (prepared images,
  declared frames, the entry-image cache), and the tokens that tell a late answer from a current one
  (`handbackGeneration`, `varispeedRun`, `clockStarts`, `imageVersions`, the pool's stamps), which
  only rise: put back, an answer in flight would pass for the next request's. A save is made
  between ticks, never from a sink or a listener a tick reaches.
- **A save copies a mutable image only when a fill has replaced the one it holds.** `loopEntry` is
  numbered by `markLoopEntryFilled` and each crossing slot by the pool's stamp, and a state keeps
  the number of the copy it holds, so a save every frame costs one machine image (about 3 µs) plus a
  copy per fill, and a restore copies back only a slot a later fill replaced. A new place that
  refills either without going through them hands a state an image that is stale and looks
  current. The prepared and cached images are never refilled, so a state holds them by reference.
- **A restore is the same player, not a landing.** It owes no gate-off and queues no resync — the sink
  is handed the deltas an undisturbed player would send, and the history is left alone — keeps the
  transport, drops a jump still replaying, and re-times the clock (never the sink) when the restored
  rate or tempo moves it; the sink is retimed only for the tempo, a host command's effect. It
  notifies once, after everything is back, and only through `restoreMovedPublished`, which compares
  the published snapshot field against the live ones because `markDirty` builds the snapshot before it
  compares: a published field a restore can change has to join that check, or a restore stops
  publishing it.
- **A restore resets the anchor ring to its seed.** An anchor recorded after the save may have been
  taken with a voice muted, which leaves that voice's control register zeroed in the image, and a
  loop re-entering along the ring would carry the zero into a player that is not muted. The ring
  refills within a few anchors' spacing, so a seek or a lap with no entry image in the first
  moments after a restore replays from frame 0, which is slower and exact.
- **A restore across varispeed leaves the clock as the exit or entry requires.** Into varispeed it
  needs the transport playing, since nothing from here can start the clock a non-playing varispeed
  owns, and is refused otherwise. Out of one, `endVarispeed` returns the rate pitch to home, and a
  non-playing varispeed's clock stops and its sink ends as for any other exit. A handback saved
  before its image arrived asks for it again. A player that is `stopped` or `ended` refuses every
  state, with a warning and no change: nothing from here starts the transport it left.
- **A result handed back on the tick is the owner's, and no caller keeps it.** `C64Machine.runFrame`
  and `initSubtune` return one object the machine refills, `ActiveLoopTracker.advance` returns a
  constant or one object the tracker refills, and `AnchorRing.select` returns the ring's own image,
  which the next `record` overwrites. Read what you need before the next call: a caller holding two
  at once, or one across a tick, reads the later call's numbers. `seekToFrame` restores from its
  anchor before any record can run, which is why it is safe.
- **A lap builds no snapshot unless something published moved.** `enforceLoop`'s `'looped'` branch calls
  `markDirty` only when `publishedLoopStale()` says the loop, the pending change or the varispeed flag
  differs from what the last `buildSnapshot` published; per-lap state is not on the snapshot. A new
  published field a lap can change has to join that check, or a lap stops publishing it.
- **The delivery history records inside frame delivery.** `DeliveryHistory.record` runs after every
  `sink.deliver` and `sink.deliverNow` — allocation-free, and after the sink call so the wire is
  never delayed by the append. A new place that hands a frame to the sink must record it too, through
  `deliver` or the coordinator's private `deliverNow`; a bare `this.sink.deliverNow(...)` leaves a
  frame the chip received missing from the history, and nothing fails.
- **The history is built from the delivered frame, not from `RegisterFrame`.** The shadow keeps the
  _first_ byte of a doubled voice control write while the chip is given the second, so an entry read
  from the shadow shows the wrong byte on exactly the retrigger frames. A third write to one control
  register in a frame folds into the second before delivery, so the chip never receives it and the
  history never shows it; do not widen the engine to track more. The request lives on the
  coordinator, not on `TuneSession`: `session.load` builds a new `RegisterFrame`.
- **A lap is not a discontinuity; a landing is.** The history restarts where the playhead goes
  somewhere else (load, stop, a fresh play, a subtune change, a restore, a queued-jump hand-off) and
  nowhere a lap, pause, resume or varispeed entry or exit passes through. Restart in the arrow handed
  to `createTuneSession`, in `enforceLoop`'s `'handed-off'` branch and in `land`, before
  `queueResync()` — never inside `queueResync()` itself, which the `'looped'` branch also calls.
- **A wrap falls due one frame before the end it wraps at, not at it.** Every re-entry — a lap, a
  queued hand-off, a repeating track's wrap — owes the stream a gate-off in a tick of its own, and
  `create-sid-player.ts` hands the tracker that lead (`REENTRY_GATE_OFF_FRAMES`, exported by
  `timeline/active-loop.ts`, the tracker's `wrapLeadFrames`) so the gate-off takes the loop's last
  slot and a lap is exactly `endFrame - startFrame` ticks. For a length that is not whole a lap is
  the whole frames of that lap (`lapLength`), and `endFrame` is only the average end. Wrapping at the end again, or adding a step a re-entry owes
  without raising the lead, makes every lap a tick longer than its loop: two loops at one tempo
  whose lengths are exact multiples drift apart by a tick per lap of the shorter one, audibly
  within a minute of a two-deck mix, and only the `lap timing` specs catch it. A repeat-off stop
  owes nothing and still ends on the track's true last frame.
- **A loop whose length is not whole laps by rounding the line, never the length.** Lap `k` of a loop
  at lap phase `p` lasts `Math.round(p + (k+1) × length) - Math.round(p + k × length)` frames
  (`lapLength`), so any run of laps telescopes to `lapSpan` and each lap end lands on the frame the
  grid's own line rounds to (`gridLine`). Rounding each lap's length alone, or restarting the phase at
  each lap, passes every whole-length spec and drifts a frame at a time on a fractional one; only the
  `lap timing` specs and `timeline/active-loop.spec.ts` catch it.
- **A queued hand-off laps on from the outgoing loop's clock, not from its own phase.** A queued loop
  landing at a running loop's wrap takes that loop's next lap phase (`phaseAfterWrap` in
  `timeline/active-loop.ts`); with a change named, the change's `lapPhase`; the queued loop's own
  `lapPhase` is used only when the track's own loop hands off. The loop still reads back with the
  phase it was queued with, so the clock is read from `getLapPhase()`, never off the loop. Restarting
  each landed loop at its own phase makes every hand-off's rounding permanent and drifts one way down a
  chain of hand-offs, and only the `a queued loop landing` specs in `timeline/active-loop.spec.ts` and
  the `a loop whose length is not a whole number of frames` specs in `player/create-sid-player.spec.ts`
  catch it.
- **A length that is not whole is at least `MIN_FRACTIONAL_LOOP_FRAMES` (2) long, and per-lap state
  stays off `PlayerSnapshot`.** Every lap is then at least a play call and its gate-off, so the wrap
  can fall due. The tracker's `set`, `queue` and `changeAt` refuse a shorter one through
  `isUsableLoopLength`, and the player's `setActiveLoop`, `changeLoopAt`, `queueJump` and
  `startShadow` through `isRunnableLoop`; a new entry point that takes a loop must do the same. A lap
  changes the phase and `markDirty` fires on every lap, so a lap phase published on the snapshot would
  notify every consumer on every lap of a short loop: `getLapPhase()` is pulled, and
  `tune.queuedJump.lapPhase` only changes when a jump is queued.
- **The application names only the far end's clock; the tune's clock is read from its header.**
  `setTargetClock(targetHz)` is held across loads, and `loadTune` derives the tune's φ2 by the
  same `file.clock === 'ntsc'` test that sets its tempo. A source clock taken from the host, or
  kept from the tune before, plays the next tune of the other standard about two-thirds of a
  semitone off, and only the `pitch correction` specs in `player/create-sid-player.spec.ts`
  catch it.
- **Hardware-precise constants are not typos to fix.** `registers/sid-constants.ts`'s
  `PAL_FRAME_INTERVAL_US` is deliberately `19950`, not the TeensyROM firmware's own `19975` —
  the comment on it exists because that gap looks like a mistake and is not. The φ2 clock rates in
  `registers/clock-ratio.ts` are the same kind of value: settled against real hardware, not
  derivable from a test. Changing one to "agree" with a different source is the hardware
  experiment root's invariant warns about, not a fix.
- **`getSnapshot()` must stay referentially stable.** `player/store.ts`'s
  `createPlayerSnapshotStore` only swaps the snapshot's identity when a structural comparison says
  something actually changed. A consumer wired through `useSyncExternalStore` re-renders
  continuously the moment that stops holding, so a new snapshot producer must go through
  `markDirty` rather than hand back a fresh object on every read.
- **The vendored emulator is modified, and lives behind a port.** `vendor/mos6502/` is
  third-party source reworked in place for speed and an allocation-free step (its README lists what
  changed), consumed only through the `Cpu6502` port — nothing above `cpu/` reaches into it
  directly. See the co-change edge below before touching a field it exposes.
- **The CPU's step path is shared and allocation-free, and so is its bus.** The vendored core's
  addressing modes and instructions are prototype methods, dispatched by name through tables built
  once for the class, and `emulate` returns nothing and builds nothing. `C64MachineImpl.Bus` is a
  class for the same reason. A per-instance closure on the path — a handler written as an arrow
  function, or a bus built from a literal of arrows — hands the CPU's call sites a second target once
  a second machine exists, and every machine in the process stays slower; a value returned or created
  per cycle costs every machine too. Both pass every functional spec.
  `cpu/vendor-cpu.allocation.spec.ts` catches an allocation in any legal opcode's handler (it runs
  a program holding every one, and needs `--expose-gc`, which `vitest.config.ts` gives the workers), `cpu/vendor-cpu.instances.spec.ts` catches state kept off
  the instance, and only the bench's `instances.mjs` catches a closure. The bus looks `read` and
  `write` up on the machine instance at every access, and the machine sets `expectingOpcodeFetch`
  before each `emulate()`: the fingerprint bench wraps both on the instance, so binding or capturing
  them blinds its probe.
- **A PSID with play address 0 is entered as an interrupt, and the stack is the seam.** The
  trampoline in `cpu/c64-machine.ts` pushes a hardware frame (plus A, X, Y on the `$0314` path), and
  the handler leaves through the KERNAL's own exits at `$EA31`, `$EA7E` and `$EA81`, or through an
  `RTI` or `RTS` of its own. All of them must end on a `JMP idle`; a frame a byte off sends the
  handler into zeroed memory and the call never completes. The entry's extra cycles over a `JSR` are
  left out of the call's cycle count so the handler sees the same raster and budget
  (`INTERRUPT_ENTRY_EXTRA_CYCLES_*`). An RSID keeps the `JSR` entry and one `RTI` at `$EA31`, which its `BRK` shares; a
  PSID's `BRK` runs a separate `RTI` stub (`BRK_HANDLER_STUB`) that `resolvePlayAddress` treats as the
  default `$FFFE`.
- **A PSID's trampoline lives where a PSID driver would, because a tune's init may overwrite any RAM
  it is not asked to keep.** `chooseTrampolineBase` takes the header's free range (`relocStartPage` and
  `relocPages`, read from `+$78`/`+$79` when the header reaches them) when it is one libsidplayfp's
  `checkRelocInfo` accepts, else for a tune that names none the first page from `$04` to `$CF` outside
  `$A0`–`$BF` that `fits()`, and only then falls back to `$EA00` and the first page from `$02`. Seven
  tunes copy their player under the KERNAL to `$E000` and up, over the old trampoline, and one clears
  page 2 (_Piracy_): the call then never reaches the idle address, or reaches it by running tune data as
  code, and either way the header's play routine never runs. An RSID keeps `$EA00`: moving it changed 35
  of 69 sampled, all unloadable either way. A call ends only on an opcode fetch of the idle address,
  never on a read of it as data, which a tune sharing the trampoline's page can make. Everything else
  a tune writes over, the KERNAL's `$EA31`/`$EA7E`/`$EA81` and `$FE66` stubs among it, is still plain
  RAM here, and a tune that fills the RAM under `$E000` takes those with it.
- **A read of a chip register can change the chip, so a read is made once and nowhere else.** A PSID's
  `$D019`, `$D01A` and CIA `$x4`–`$xF` come from `IoChips`, and a read of `$xD` returns the flags and
  clears them. `C64MachineImpl.read` is the only caller and calls once per bus access: a classifier, a
  snapshot, a debug dump or a "peek" that goes through `read` or `readBus` takes the flag the CPU was
  about to see. The fingerprint bench wraps `read` and delegates once for the same reason. An RSID
  keeps plain memory and a constant `$DC0D`/`$DD0D`.
- **The chip model counts lazily and holds one cycle count.** Timers are not stepped: an access counts
  a timer on to the cycle it happens at, from `IoChips.state`, one `Float64Array` of fixed layout
  (`io-chips.ts` documents it) that a snapshot copies whole. A play call starts one period after the
  last one started — `latch + 1` when CIA 1 timer A drove it, `cyclesPerFrame` otherwise — or when the
  last one ended if it ran past that, and the timers count on through the gap. The cycle count is a
  plain number, never an `int32`: it passes 2³¹ in about 36 minutes, which is why every play call
  rebases it to zero at the last call's end (`IoChips.rebase`), and a slot that holds a cycle count
  must be shifted there. A new register, or a field on
  the state, goes in the layout and in `CHIP_STATE_LENGTH` so every capture carries it; one that
  steps per cycle, builds an object per read, or lives outside `state` is the regression.
- **CIA 1 timer A's latch keeps the default's byte for a half the tune never wrote.** A tune that
  writes only `$DC04` or only `$DC05` plays at that byte over the other half of the PSID default
  (`$4025` PAL, `$4295` NTSC), as on a real C64, and an RSID is read the same way. Zeroing the half it
  did not write, as the play rate once did, runs a tune that writes `$00` to `$DC04` alone sixteen
  calls a frame where the default's byte gives about one; `io-chips.spec.ts` and the `the play rate`
  specs in `c64-machine.spec.ts` pin the rule. A change here moves the rate of every tune that
  writes one half, and `--change play-rate` is its class.
- **`$01` is ignored, so the RAM under the chips cannot be read.** The chip model answers `$D019`,
  `$D01A` and the CIA timer registers whatever a tune banks in, so a tune that banks the I/O out to
  copy the RAM under them reads live timers and not the memory it meant. `Snow_Strike` is the known
  case (1519 SID writes in 300 calls while those reads returned memory, 5 since the chips went live).
  Honouring `$01` for chip reads means honouring it for the SID write path too, which no change has
  done yet.
- **A play-address-0 tune's interrupt vector is read once, after init.** `patchPlayTarget` resolves the
  handler from `$0314` (or `$FFFE`) when init returns and never again, where a real C64 reads it at
  every interrupt. A tune that re-points the vector after its first call keeps being entered at the
  old one. Seven PSIDs in the test set do (_First Day Tune_, _Buon Natale_, _Mexico 86_, _Hoodoo
  Voodoo_, _Toccata and Fugue_ parts 1 to 3): five still make sound, _First Day Tune_ writes only its
  init registers, and _Hoodoo Voodoo_ writes nothing after init where it once wrote 7103 registers.
  Re-reading the two words before each call would fix it, and is a change to every such tune's
  output: `fingerprint.mjs check --change interrupt-exits`, in the shared SIDABLIST-ROOT bench.
- **The filter-type override is a hold of `filterType`, not state of its own.** `setFilterMode`
  routes through `holdField`/`releaseField`; giving the player or the frame a separate copy again
  re-creates two owners that can disagree about which mode is forced.
- **An entry image is a pure function of (file, subtune, frame, mutes at capture).** Prepared
  images are built with every voice unmuted, so a restore into an unmuted player sounds; a muted
  voice's control register is zeroed in an image taken muted. Only an image built by an unmuted
  replay may start a chained build — a live `capturePosition()` never does, and a capture taken
  after a mute and unmute can carry a stale control register until the tune next writes it.
- **Crossing images are live captures and never chain.** A frame saved at a crossing is a copy of the
  live machine, so it never enters `prepared` and never starts a chained build. A voice muted at the
  crossing has its control register zeroed in the image — `RegisterFrame` zeroes it when the voice is
  muted and discards the tune's later writes, so it holds no value of the tune's own to save instead
  — and a loop re-entered from that image has the voice silent after it is unmuted until the tune
  writes the register again.
- **The crossing pool is allocated off the tick.** `setCrossingCaptures` allocates every buffer
  (about 64 KB each, `sum(keep) + 1` of them) and the tick only copies into one through
  `C64Machine.snapshotInto`, the CPU's `copyStateInto` and `RegisterFrame.snapshotValuesInto`. A
  capture that builds an object, a `snapshot()` or an iterator on the tick is the regression. A new
  declaration holds memory for as long as it stays declared. The anchor ring is the same: its
  `ANCHOR_RING_SIZE` images are allocated with the ring, and a record copies into the oldest
  non-seed one.
- **At most one copy a tick.** A frame on several sets of lines is copied once and held by each; a
  loop's start is saved straight into the loop-entry buffer, and the lines skip that frame.
- **A running loop's image lives in the loop-entry buffer, never in a slot that is still recycling.**
  `setActiveLoop` and `changeLoopAt` copy a crossing slot's image into the one preallocated buffer
  before handing it to the tracker, because the next crossings recycle the slot. A running loop grown
  or shrunk finds its start in the buffer and uses it as it is; copying the buffer onto itself, or
  handing the tracker a slot, makes a lap re-enter from whatever the slot holds by then. The lookup is
  one order everywhere (`imageAt`): the buffer, the prepared images, the four-entry cache, then the
  slots.
- **A loop set ahead of the playhead in live play is armed by the tick that reaches its start, not by
  a replay.** Nothing is requested for it; a jump that puts the playhead on or past the start without
  crossing it leaves the loop with no entry image, and its first wrap falls back to the main-thread
  seek. At or behind the playhead, in varispeed and in a handback, `setActiveLoop` still requests the
  replay. A change named by `changeLoopAt` skips this arming, since its image may be the buffer.
- **`holdsImageAt` reads wider than `queueJump` and `setJumpTargets` do.** A queued jump holds its
  image by reference until it lands, and a crossing slot is recycled, so those two look only in the
  prepared images and the cache; a frame held only at a crossing still costs a replay there.
- **A pending loop change has already moved the running loop's end.** `changeLoopAt` sets the end to
  the named frame at once and holds the new bounds in the tracker, which `set` clears and a subtune
  change cancels; the wrap there is a lap (`looped`), with no history restart. Setting the end through
  `ActiveLoopTracker.set` would drop the queued jump and the entry image with it.
- **Every declared jump frame holds about 64 KB** (the machine image plus a register shadow), for as
  long as it stays declared. The four-image cache for undeclared captures does not bound them; the
  host's declaration does.
- **A queued jump never lands without a held image.** A target that is not yet built waits whole
  laps for it rather than replaying on the main thread inside the tick, so a host that queues an
  unprepared frame sees the running loop continue. Frame 0 is no exception: an undeclared target
  is replayed off-thread like any other, since a queued hand-off restores only from an image. `tune.handOffs` is how it tells a landing from a
  dropped queue; clearing a queue never touches it.
- **A landing assigns settings prepared earlier and allocates nothing.** `queueJump` and `seek`
  validate and resolve a jump's `JumpSettings` when they are called, building the records the
  coordinator carries once; `applyPreparedSettings` only assigns, because it runs on the frame path.
  Validating, resolving or building anything at the landing is an allocation on a tick.
- **A jump's settings go in before its image is restored.** `RegisterFrame.restoreValues` re-zeroes
  the control register of exactly the voices muted at that moment, so settings applied after the
  restore leave a voice they unmute at 0 until the tune next writes its control register. A replayed
  seek carrying settings is seeded with no voice muted for the same reason: a muted seed leaves that
  voice's control register at 0 in the image, and no restore brings the voice back.
- **The landing notifies only after the restore, never from inside a hook.** Listeners run
  synchronously inside `markDirty` and may call straight back into the player, so `QueuedNext`'s
  `beforeLanding` and `jumpToFrame`'s hook change state and leave the notification to the landing
  that follows them.
- **A superseded or discarded seek never applies its settings.** `TuneSession` runs the hook only
  for the response that is still the outstanding one; anything that discards the jump takes its
  settings with it.
- **Offsets and multipliers never enter the shadow.** The shadow holds what the tune wrote, and the
  output stage shapes a copy of it on the way out. Writing a multiplied or offset value back into
  the shadow makes a cue re-entered at another setting apply it twice.
- **The rate source must not issue a player command or allocate.** `VarispeedRateSource` is called
  from inside the tick, before it moves the position: a `seek`, `pause`, `leaveVarispeed` or
  `enterVarispeed` from there re-enters the tick that is calling it. Pure reads — `getSnapshot`,
  `getPosition` — are fine. The rate is pulled, never published; only entering and leaving notify.
- **The handback relies on the record's chip state matching replay's byte for byte.** Leaving
  varispeed while playing sends no gate-off and no re-emit, because the chip state the record has
  built to the image's frame is the state live playback would have built. A record built from a
  shaped frame (multiplied, offset, held, muted) or from the shadow instead of the chip state —
  where a doubled control write differs — breaks that silently: a hung or dropped note at the seam,
  and no spec of the record's own will say so.
- **A non-playing varispeed owns the running clock.** With the transport `paused`, `stopped` or
  `ended`, nothing in the transport rules stops the clock varispeed started, so every exit from it
  must — `loadTune`, `selectSubtune`, `stop`, `dispose` and the paused landing each do. A new exit
  that forgets leaves a clock ticking a player that reads stopped.
- **The play rate is the header's speed bit and the tune's own interrupt enables, and the player's
  mirror must never lag the machine.** A PSID with a play address plays at CIA 1 timer A's rate when
  its song's speed bit is 1 (the latch the tune wrote, else the PSID default) and once per frame when
  it is 0, whatever the latch says; one with play address 0 ignores the bits and follows the interrupt
  `$DC0D` and `$D01A` have left enabled; an RSID keeps "a written latch means CIA". The rate's inputs
  are read from the chip model — CIA 1 timer A's latch and interrupt enable — and the speed bit, and
  ride in `MachineSnapshot` as `chips` and `speedBit`, in all five places together — the interface,
  `WritableMachineSnapshot`, `createMachineImage`, `copyMachineImage` and `snapshot`/`snapshotInto`/
  `restore` — as numbers and a typed array, so a snapshot still structured-clones to the replay
  worker. The player
  mirrors the two rates and `followPlayRate` compares them after every tick and every place the live
  machine is restored: `TuneSession.adoptState` (which `restoreState`, a jump landing and a handback
  all go through) and the lap and hand-off in `enforceLoop`. A new restore that skips it runs the
  clock at the old rate until the tune next changes it; only the `a tune that changes its own play
rate` specs in `player/create-sid-player.spec.ts` catch it.
- **A rate the tune changes re-times the clock and nothing else.** `followPlayRate` calls
  `clock.setIntervalUs` and keeps `runningIntervalUs` in step; it never calls `sink.retime`, because
  the frames the sink already holds were played at the rate they had, and that stays with a tempo
  command through `applyIntervalChange`. It builds no snapshot either: `PlayerSnapshot.tempo.rate` and
  `effectiveIntervalUs` catch up at the player's next notification for any other reason, a deliberate
  lag, while `getStats().rate` reads live. It is two number compares and allocates nothing, even for a
  tune that swings its latch every call — which is why `effectiveIntervalUs` divides through
  `playCallIntervalUsAt` and not a `PlayRate`.
- **Varispeed sees a rate change only where an image lands.** No machine runs there, so the rate moves
  only when a handback adopts an image or a lap or hand-off restores one, and each of those ends the
  varispeed: the clock re-times as it ends, through the same `followPlayRate`, and nothing applies
  sooner. The rate source still issues no command.
- **`exactCallsPerFrame` is below 1 for a timer slower than a frame, and every reader of it has to
  stand that.** `callsPerFrame` and `roundedCallsPerFrame` stay at 1 or above, so `'rounded'` timing
  plays such a tune at one call a frame, as it always did. In exact timing `playCallIntervalUs` is
  longer than the nominal interval, `msToPlayCalls` and `playCallsPerSecond` give fewer calls to a
  second of music, `seekReachFrames` shrinks (about 15 frames at the slowest timer a latch can
  program) and the anchor ring re-spaces to it, and a varispeed tick is the longer running interval.
  The handback lead and the ring spacing floor at one frame, which is what keeps a slow tune from
  dividing them to nothing. `libs/analysis` reads the same rate; its guide says what it does there.
- **Every exit from varispeed returns the rate pitch to home through `endVarispeed`.** The rate pitch
  lives on the `RegisterFrame`, which `stop()` and a subtune change keep, so one left at 0 silences
  the next play. A new exit calls the one routine rather than setting the pitch itself.
- **A lap with no entry image whose start the record covers goes on the record, never through
  `seekToFrame`.** `ActiveLoopTracker.advance` reports `due-unheld` for a wrap that would replay
  frames from the anchor ring, and `enforceLoop` then moves the record position to the loop's start
  and owes the lap's resync, starting a handback in live play or carrying on the one under way. It
  runs the seek only when the record does not cover the start. The track's own wrap to frame 0 is a
  pure restore of the ring's seed and stays a `looped`. A lap on the record owes the stream a gate-off
  that leaves the position where it is, as every other lap does, and is not a discontinuity.
- **A landing is a jump, and its gate-off is a varispeed tick's to honour.** `land` restarts the
  history, then owes a gate-off and a full re-emit; the varispeed branch of `onTick` returns before
  the `gateOffOwed` check, so `varispeedTick` takes the pending gate-off itself. A landing on a bare
  frame moves the position and the record on by one on that tick (`gateOffAdvances`); a landing on a
  held count, and a lap, leave them where they are. Alignment with an undisturbed player is exact
  and only the shadow's spec pair catches an off-by-one frame.
- **The shadow counts in `getPosition()`'s unit with the lap's lead.** `ShadowPosition` and
  `countAfter` wrap `REENTRY_GATE_OFF_FRAMES` early through `wrapDueFrame`, the tracker's own
  rule; a copy that wraps at the end drifts a frame a lap from the position it shadows. It ticks
  at the top of `onTick` while the transport is `'playing'` and never while paused, even with a
  non-playing varispeed running the clock, and it never notifies: only starting and stopping it
  does (`tune.shadowRunning`).
- **A held loop moves the varispeed record, never the machine.** A wrap under varispeed must not
  lap, restore an image or hand off: doing so would apply a queued jump mid-scratch. On a handback
  tick the hold stands aside for `enforceLoop`, since wrapping the record there would hide the loop's
  end from it and the queued jump would never fire.
- **`capturePosition()` caches nothing while in varispeed.** The live machine is not at the
  position, so an image taken of it would be filed under a frame it does not describe.
- **A spec that needs a DOM is a spec testing the wrong thing.** `vitest.config.ts` here runs
  `environment: 'node'`, no `jsdom`, matching the "touches no browser global" invariant at the
  root. A `core` spec that reaches for `window` or `document` has crossed a port boundary that
  should have been faked instead.

## When a change here ripples

- **Changed `SidFrame`'s shape (`registers/sid-frame.ts`) or the `SidSink` contract
  (`ports/sink.ts`)?** `libs/asid`'s slot packing (`wire/slot-map.ts`, `wire/encoder.ts`) and its
  sink (`sink/asid-sink.ts`) both implement what these types promise. A change that stays
  type-compatible but shifts what a field means still reaches the wire wrong — a wrong packet, not
  a compiler error. A new member (`passedCount`, `replaceFrom`) is also one every implementation
  must have, `FakeSink` and the specs' own sinks among them. Update asid's packing/sink to match and
  run its specs. Detail:
  [`libs/asid/AGENTS.md`](../asid/AGENTS.md).
- **Added or changed a case in `SINK_CONFORMANCE_CASES` (`conformance/cases.ts`)?**
  `libs/asid`'s `sink/conformance.spec.ts` runs every case in the suite against the real ASID
  sink. One going red there is the suite doing its job — asid's sink needs to change to satisfy
  it, not the case to relax. Detail:
  [`libs/asid/src/sink/conformance.spec.ts`](../asid/src/sink/conformance.spec.ts).
- **Changed anything the CPU port reads or writes (`cpu/cpu-port.ts`, `cpu/vendor-cpu.ts`, or a
  field name inside the vendored `mos6502` core)?** `vendor-cpu.ts`'s `CPU_STATE_KEYS`/
  `assertCpuStateKeys` is the only thing standing between a renamed field and a cue that restores
  incomplete CPU state silently, since `MachineSnapshot.cpu` is an opaque `CpuState` record. Keep
  the key list in sync and run `cpu/vendor-cpu.spec.ts`; `copyStateInto`, which the crossing captures
  copy through, reads the same list. A handler or bus method that allocates or keeps state off the
  instance only shows in `cpu/vendor-cpu.allocation.spec.ts` and
  `cpu/vendor-cpu.instances.spec.ts`, and a per-instance closure on the step path only in the
  shared bench's `instances.mjs` (`SIDABLIST_DIR=… node instances.mjs`, in SIDABLIST-ROOT's
  `bench/`). Detail:
  [`cpu/vendor-cpu.ts`](./src/cpu/vendor-cpu.ts).
- **Changed the interrupt entry or the KERNAL exit stubs (`writeTrampoline`, `writeInterruptEntry`,
  `installRomStubs` in `cpu/c64-machine.ts`; `TRAMPOLINE_*`, `INTERRUPT_*`, `IRQ_*_STUB`,
  `BRK_HANDLER_STUB` in `cpu/cpu-constants.ts`)?** `INTERRUPT_ENTRY_EXTRA_CYCLES_KERNAL` and
  `_HARDWARE` are the entry's cycle counts past a `JSR`, and nothing derives them from the bytes: a
  stale one shifts the raster and the budget every handler sees, with no compile error. A moved
  trampoline byte must also stay inside `TRAMPOLINE_INTERRUPT_LENGTH` and the continuation, or a tune
  covering it is overwritten rather than relocated around. Update the constants, then run
  `cpu/c64-machine.spec.ts` (the `entering a handler as an interrupt` specs) and the HVSC fingerprint
  check (`fingerprint.mjs check --change interrupt-exits`, in the shared SIDABLIST-ROOT bench), since
  every tune's writes ride on this entry. A change to where a PSID's trampoline goes
  (`chooseTrampolineBase`) is `--change trampoline`. Detail: [`cpu/c64-machine.ts`](./src/cpu/c64-machine.ts).
- **Changed the VIC or CIA model (`cpu/io-chips.ts`; the register addresses in `cpu/cpu-constants.ts`;
  `readBus`, `readChipRegister` and `write` in `cpu/c64-machine.ts`)?** What a tune reads from
  `$D019`, `$D01A` and the CIA timers decides which branch a player takes, so a shifted flag, period
  or read side effect changes what a tune writes, or hangs it, with no compile error. A new slot in
  `IoChips.state` is a new `chips` length that a snapshot carries as it is. Run `cpu/io-chips.spec.ts`
  and `cpu/c64-machine.spec.ts`, and the HVSC fingerprint check
  (`fingerprint.mjs check --change vic-cia`, in the shared SIDABLIST-ROOT bench), which says which
  tunes moved and which of those it cannot explain. `TUNE_INDEX_FORMAT_VERSION` already says the
  engine's VIC and CIA changed what tunes play; a later change to it bumps the version again. Detail:
  [`cpu/io-chips.ts`](./src/cpu/io-chips.ts).
- **Changed `C64Machine`'s frame/rate surface (`runFrame`, `callsPerFrame`, `exactCallsPerFrame`),
  what decides the rate (`speedFlags`, `psidSpecific`, the `$DC0D` and `$D01A` handling) or
  `RegisterFrame`'s snapshot API (`snapshotInto` and `snapshotValuesInto` among it)?**
  `libs/analysis`'s `scan-tune.ts` reads both rates once, when it builds its output, not per frame — a
  shifted meaning is a wrong index record, not a compile error, and a change to what a tune plays
  needs `TUNE_INDEX_FORMAT_VERSION` bumped so every stored scan is redone. Run analysis's
  `scan-tune.spec.ts`, and the HVSC fingerprint check
  (`fingerprint.mjs check --change <name>`, in the shared SIDABLIST-ROOT bench) to see which tunes
  moved. Detail: [`libs/analysis/AGENTS.md`](../analysis/AGENTS.md).
- **Changed `RegisterRecord` (`registers/register-record.ts`), or how `RegisterFrame` snapshots a
  doubled voice control write?** `libs/analysis`'s `toRegisterRecord` and `TuneScan.recordControls`
  build the record from that shape, and `feed` (`player/varispeed.ts`) plays it back. A shifted
  meaning records a stream that hangs or drops notes at the handback, with no compile error. Update
  both and run `libs/analysis/src/register-record.spec.ts`. Detail:
  [`libs/analysis/src/register-record.ts`](../analysis/src/register-record.ts).

- **Added a `sink.deliver*` call, or changed how a `SidFrame` carries voice control writes
  (`registers/register-frame.ts`'s doubled-write handling)?** `player/delivery-history.ts` records
  exactly what the sink was handed, so a frame that skips `record` is missing from every host's
  history, and a shifted meaning of a control write records the wrong byte, with no compile error.
  Record at the new call and run `player/delivery-history.spec.ts` and the `delivery history` specs
  in `player/create-sid-player.spec.ts`.
- **Added a field to the player, to `TuneSession`, or to a part's state?** It joins the saved state or
  this guide says why not: `player/saved-state.ts`, `saveState`, `restoreState`, and a spec in
  `player/create-sid-player.save-restore.spec.ts` that plays it through a rewind. One a snapshot
  publishes also joins `restoreMovedPublished`. Left out, it restores almost exactly, which is a
  state that sounds right until the one playing state it is wrong in; the reference test only
  catches the fields it drives. Detail: [`src/player/saved-state.ts`](./src/player/saved-state.ts).
- **Changed how a lap's end rounds (`lapLength`, `lapSpan`, `lapsWithin` in `timeline/active-loop.ts`)?**
  They round with `Math.round`, as `gridLine` and `isOnLine` do, and `libs/analysis`'s
  `grid-lines.ts` imports them for `shrinkLanding`, `foldIntoLoop`, `lapPhaseAt` and
  `lapPhaseOfFold`: a lap end one frame off its grid line compiles and passes the type-checker while
  every loop of a fractional length ends off the grid. Change them together and run
  `timeline/active-loop.spec.ts`, `timeline/shadow-position.spec.ts`, the `lap timing` specs in
  `player/create-sid-player.spec.ts` and analysis's `grid-lines.spec.ts`. Detail:
  [`libs/analysis/src/grid-lines.ts`](../analysis/src/grid-lines.ts).
- **Changed how a crossing line rounds (`isOnLine` in `timeline/crossing-captures.ts`)?**
  `libs/analysis`'s `gridLine` names the frames a host declares lines at by the same
  `Math.round(origin + k × period)`; a line off by one saves an image no loop can start from, with no
  error. Change both and run `timeline/crossing-captures.spec.ts`, the `crossing captures` specs in
  `player/create-sid-player.spec.ts` and analysis's `grid-lines.spec.ts`. Detail:
  [`libs/analysis/src/grid-lines.ts`](../analysis/src/grid-lines.ts).
- **Added a variant to `AdvanceResult` (`timeline/active-loop.ts`)?** Every `switch` or branch on
  `action` ripples — `enforceLoop` in `player/create-sid-player.ts` handles each one, and an
  unhandled variant leaves the player's position and the stream out of step without a compile
  error. Handle it there, then run `player/create-sid-player.spec.ts` and its `lap timing` specs.
  The same branches end a varispeed handback: a variant that moves the stream but does not call
  `endVarispeed` leaves the player in varispeed with a position the machine has abandoned.
  `due-unheld` is the one that does not end it on purpose: it goes on the record and the handback
  carries on.
- **Changed how the player's position moves on a tick or a lap (`onTick`, `varispeedTick`,
  `wrapDueFrame`, `REENTRY_GATE_OFF_FRAMES`)?** The shadow position (`timeline/shadow-position.ts`)
  counts the same moves, and a host folds its own count with `countAfter`: a shifted lap length or
  gate-off tick makes it drift from `getPosition()` with no compile error. Change both and run
  `timeline/shadow-position.spec.ts` and the `the shadow position and landing on a frame` specs in
  `player/create-sid-player.spec.ts`.
- **Changed `QueuedNext` or the hand-off order in `advance` (`timeline/active-loop.ts`)?**
  `queueJump` in `player/create-sid-player.ts` builds the `beforeLanding` hook and relies on it
  running ahead of the image restore; moved after it, a voice a landing unmutes stays at 0 until the
  tune writes its control register again, and nothing fails to compile. `advance` also reads
  `phaseAfterWrap` before the landing changes anything; read after, a queued loop laps from its own
  phase and the hand-offs drift. Update `queueJump`'s hook,
  then run the `jump settings` specs in `player/create-sid-player.spec.ts` and
  `timeline/active-loop.spec.ts`. Detail: [`src/player/create-sid-player.ts`](./src/player/create-sid-player.ts)
- **Changed `ReplayRequest`'s shape (`replay/replay-runner.ts`)?** `replay/replay.worker.ts` unpacks
  the request field by field into `replayToFrame`, and every host `ReplayRunner` implementation
  forwards it in its own way. A field one of them drops compiles fine and degrades quietly: a
  dropped `start` makes every prepared build replay from the top, and a dropped `mutes` builds
  frames that sound wrong once unmuted. Update the worker and each runner, then run
  `replay/replay.worker.spec.ts`, which pins that the worker forwards `start`. No spec catches a
  `ReplayRunner` implementation that drops it, since the in-spec fakes forward it themselves. Detail:
  [`replay/replay.worker.ts`](./src/replay/replay.worker.ts)
- **Made a deliberate change to how multiply, offset or hold compose?**
  `registers/register-frame.equivalence.spec.ts` fails against the frozen reference in
  `registers/__reference__/`, because the reference still composes them the old way. Confirm the
  change is intended, then retire `registers/__reference__/` and that spec together. Detail:
  [`docs/architecture.md`](../../docs/architecture.md).

## Commands

```
pnpm --filter @sidablist/core build
pnpm --filter @sidablist/core test
pnpm --filter @sidablist/core typecheck
```

## Further reading

- [`docs/architecture.md`](../../docs/architecture.md) — the _why_ behind every hazard and
  convention above.
- [`docs/writing-a-sink.md`](../../docs/writing-a-sink.md) — the `SidSink` contract member by
  member. Read it before changing `ports/sink.ts` or `conformance/cases.ts`, or when a capability
  gap surfaces that `SinkCapabilities` does not yet describe.
- [`docs/pal-ntsc.md`](../../docs/pal-ntsc.md) — the pitch-correction derivation and the high-byte
  trap. Read it before touching `registers/clock-ratio.ts` or the frequency-scaling path in
  `registers/register-frame.ts`.
- [`AGENTS.md`](../../AGENTS.md) — the root map and the invariants no single library owns.
- [`libs/asid/AGENTS.md`](../asid/AGENTS.md) — the sink that implements a contract against this
  library.
