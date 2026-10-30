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
- `cpu/` — `C64Machine`, the faked 64 KB address space and CIA/VIC stubs a tune's `init`/`play`
  routines run against, driven through a `Cpu6502` port (`cpu-port.ts`) the vendored core in
  `vendor/mos6502/` implements.
- `registers/` — `SidFrame` (one frame's writes), `RegisterFrame` (the accumulator and the output
  stage — multiplier, offset, hold — that builds one), `sid-fields.ts` (the table of chip fields an
  application can drive), `register-record.ts` (`RegisterRecord`, a tune's register stream as data,
  which varispeed plays), `__reference__/` (the frozen pre-field-table implementation
  `register-frame.equivalence.spec.ts` checks against), and the register and clock constants.
- `clock/` — `FrameAccumulator`, `ClockStats` and the play-rate math a host clock is measured and
  paced by.
- `timeline/` — `AnchorRing`, `seekToFrame` and `ActiveLoopTracker`: the position and loop
  operations core owns.
- `player/` — `createSidPlayer`, the composition root wiring the above into `SidPlayer`, plus
  `PlayerSnapshotStore` and the `PlayerSnapshot`/`PlayerStats` shapes a consumer reads. The jump
  surface: `setJumpTargets` declares the frames built ahead into ready snapshots (readiness and the
  queue are published under `tune.preparedFrames`, `tune.queuedJump` and `tune.handOffs`);
  `queueJump` queues a hand-off for the running loop's next wrap; `queueJump` and `seek` can carry
  `JumpSettings`, applied as the jump lands; `capturePosition()` returns the frame it captured.
  `SidPlayerCollaborators.prepareRunner` is an optional second replay runner for those builds, so a
  scrub does not wait behind a batch of them; without it they share the scrub runner. Varispeed
  (`enterVarispeed`/`leaveVarispeed`) plays a `RegisterRecord` at a rate the host names per tick;
  `varispeed.ts` is the record-driven half the coordinator sequences.
- `replay/` — runs frames ahead of the playhead for analysis, on the main thread or a worker.
- `conformance/` — `SINK_CONFORMANCE_CASES`, the suite any `SidSink` implementation runs against
  itself.
- `ports/` — `Clock`, `SidSink`, `Transport`: the interfaces a host injects; this library depends
  on none of their implementations.
- `testing/` — `FakeClock`, `FakeSink`, `FakeTransport`: fixtures for a consumer's own specs.
- `vendor/mos6502/` — the vendored 6502 core. See Hazards below before touching it.

## Conventions

- A new field on `PlayerSnapshot` or `PlayerStats` lands inside an existing named group, never as
  a new flat top-level property — see either interface's own doc comment for why.
- Whether new player state goes on `PlayerSnapshot` (pushed through `subscribe`) or `PlayerStats`
  (pulled via `getStats()`) follows the read/notify split `docs/architecture.md`'s "How a consumer
  reads core" explains: a person's action notifies, time passing does not.
- A chip field an application wants to drive is a row in `registers/sid-fields.ts`, reached through
  `holdField`/`releaseField` and `setFieldOffset`/`clearFieldOffset` — never a new per-field method
  on `RegisterFrame` or `SidPlayer`.
- A capability a sink cannot honour is a new field on `SinkCapabilities` (`ports/sink.ts`),
  reported and worked around by core — never a thrown error, and never a method core assumes
  every sink implements.

## Hazards

- **The hot path does not allocate.** `RegisterFrame`'s per-frame state — `values`, `writeOrder`,
  the reused `SidFrame` buffers `takeSnapshot()` hands back — is mutated in place on purpose (see
  `registers/register-frame.ts`). Frame delivery runs fifty times a second; wrapping any
  of it in a fresh object or a getter for readability is a real regression, and it is audible, not
  caught by a test.
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
  third-party source with one deliberate behavioural change (`cpu/vendor-cpu.ts`'s
  `QuietMos6502`), consumed only through the `Cpu6502` port — nothing above `cpu/` reaches into it
  directly. See the co-change edge below before touching a field it exposes.
- **The filter-type override is a hold of `filterType`, not state of its own.** `setFilterMode`
  routes through `holdField`/`releaseField`; giving the player or the frame a separate copy again
  re-creates two owners that can disagree about which mode is forced.
- **An entry image is a pure function of (file, subtune, frame, mutes at capture).** Prepared
  images are built with every voice unmuted, so a restore into an unmuted player sounds; a muted
  voice's control register is zeroed in an image taken muted. Only an image built by an unmuted
  replay may start a chained build — a live `capturePosition()` never does, and a capture taken
  after a mute and unmute can carry a stale control register until the tune next writes it.
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
- **Every exit from varispeed returns the rate pitch to home through `endVarispeed`.** The rate pitch
  lives on the `RegisterFrame`, which `stop()` and a subtune change keep, so one left at 0 silences
  the next play. A new exit calls the one routine rather than setting the pitch itself.
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
  a compiler error. Update asid's packing/sink to match and run its specs. Detail:
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
  the key list in sync and run `cpu/vendor-cpu.spec.ts`. Detail:
  [`cpu/vendor-cpu.ts`](./src/cpu/vendor-cpu.ts).
- **Changed `C64Machine`'s frame/rate surface (`runFrame`, `callsPerFrame`, `exactCallsPerFrame`)
  or `RegisterFrame`'s snapshot API?** `libs/analysis`'s `scan-tune.ts` records both per frame — a
  shifted meaning is a wrong index record, not a compile error. Run analysis's
  `scan-tune.spec.ts`. Detail: [`libs/analysis/AGENTS.md`](../analysis/AGENTS.md).
- **Changed `RegisterRecord` (`registers/register-record.ts`), or how `RegisterFrame` snapshots a
  doubled voice control write?** `libs/analysis`'s `toRegisterRecord` and `TuneScan.recordControls`
  build the record from that shape, and `feed` (`player/varispeed.ts`) plays it back. A shifted
  meaning records a stream that hangs or drops notes at the handback, with no compile error. Update
  both and run `libs/analysis/src/register-record.spec.ts`. Detail:
  [`libs/analysis/src/register-record.ts`](../analysis/src/register-record.ts).

- **Added a variant to `AdvanceResult` (`timeline/active-loop.ts`)?** Every `switch` or branch on
  `action` ripples — `enforceLoop` in `player/create-sid-player.ts` handles each one, and an
  unhandled variant leaves the player's position and the stream out of step without a compile
  error. Handle it there, then run `player/create-sid-player.spec.ts`. The same branches end a
  varispeed handback: a variant that moves the stream but does not call `endVarispeed` leaves the
  player in varispeed with a position the machine has abandoned.
- **Changed `QueuedNext` or the hand-off order in `advance` (`timeline/active-loop.ts`)?**
  `queueJump` in `player/create-sid-player.ts` builds the `beforeLanding` hook and relies on it
  running ahead of the image restore; moved after it, a voice a landing unmutes stays at 0 until the
  tune writes its control register again, and nothing fails to compile. Update `queueJump`'s hook,
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
