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
- `registers/` — `SidFrame` (one frame's writes), `RegisterFrame` (the accumulator and
  knob-scaling engine that builds one), and the register and clock constants.
- `clock/` — `FrameAccumulator`, `ClockStats` and the play-rate math a host clock is measured and
  paced by.
- `timeline/` — `AnchorRing`, `seekToFrame` and `ActiveLoopTracker`: the position and loop
  operations core owns.
- `player/` — `createSidPlayer`, the composition root wiring the above into `SidPlayer`, plus
  `PlayerSnapshotStore` and the `PlayerSnapshot`/`PlayerStats` shapes a consumer reads.
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
- A capability a sink cannot honour is a new field on `SinkCapabilities` (`ports/sink.ts`),
  reported and worked around by core — never a thrown error, and never a method core assumes
  every sink implements.

## Hazards

- **The hot path does not allocate.** `RegisterFrame`'s per-frame state — `values`, `writeOrder`,
  the reused `SidFrame` buffers `takeSnapshot()` hands back — is mutated in place on purpose (see
  `registers/register-frame.ts`). Frame delivery runs fifty times a second per deck; wrapping any
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

## Commands

```
pnpm --filter @sidablist/core build
pnpm --filter @sidablist/core test
pnpm --filter @sidablist/core typecheck
```

## Further reading

- [`docs/architecture.md`](../../docs/architecture.md) — the _why_ behind every hazard and
  convention above.
- [`AGENTS.md`](../../AGENTS.md) — the root map and the invariants no single library owns.
- [`libs/asid/AGENTS.md`](../asid/AGENTS.md) — the sink that implements a contract against this
  library.
