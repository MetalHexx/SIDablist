# asid

The sink that turns a `SidFrame` into ASID SysEx packets and schedules them onto an injected MIDI
transport — the wire format and its scheduling, not sound and not device access.

> [`docs/architecture.md`](../../docs/architecture.md) explains the sink/transport seam split this
> library sits on one side of, and why `core`'s `SidSink` contract carries fields (per-write
> offsets, bidirectional capability) this transport cannot use — deliberately, since widening a
> one-way contract later means rewriting both ends. Read it before changing what this sink
> promises `core`, or before adding a second sink — not for a routine edit.

## How it works

The public surface is `src/index.ts`. Browser-only code is exported separately through the
`./web-midi` subpath (see `package.json`'s `exports`), so a non-browser consumer never pulls in a
DOM type.

- `wire/` — pure byte layout, no I/O: `asid-constants.ts` (the protocol values, transcribed from
  firmware), `slot-map.ts` (`packFrameInto`, mapping a frame's writes onto the 28 ASID slots; `packFrame`
  is its allocating form) and `encoder.ts` (the SysEx packet builders; `writeSidDataPacket` is the
  into-buffer form of `buildSidDataPacket`).
- `sink/` — `createAsidSink` (`asid-sink.ts`, taking `{ time, scheduleAheadMs?, log? }`), `core`'s
  `SidSink` plus the ASID-specific `showText`/`setScheduleAhead`/`stats`; `midi-output-port.ts` (`MidiOutputPort`, the injected
  transport this sink schedules against); `delivery-stats.ts` (the counters `AsidSink.stats`
  reports).
- `web-midi/` — `midiOutputPortFrom`, the one file in this library that touches a browser global:
  it adapts a real `MIDIOutput` into `MidiOutputPort`.

## Conventions

- Byte layout lives in `wire/` and stays pure — no `MidiOutputPort`, no scheduling. Scheduling and
  I/O belong in `sink/`.
- Anything that touches a browser global belongs only under `web-midi/`, exported through the
  `./web-midi` subpath — never re-exported from the package root.
- The sink reads no clock and writes no console: time comes from the `TimeSource` and the two
  schedule-ahead warnings go to the `EngineLog` passed to `createAsidSink`, silent when absent.
  `eslint.config.mjs` restricts `performance` and `console` here, except under `web-midi/`.
- `deliver` allocates nothing. It packs into a preallocated ring slot with `writeSidDataPacket` and
  never builds a packet, a record or an array; `asid-sink.allocation.spec.ts` measures it. Anything
  that grows the ring runs off the tick (`setScheduleAhead`, `retime`). The ring is sized for the
  engine's floor of 1 ms between frames (16 calls a frame is about 1.25 ms), not for a typical
  tune: the sink is never told a tune's rate, so a 16x tune must not overflow it. A full ring
  recycles its oldest slot, so that send stops being tracked and a later `retime()` does not
  re-send it; the first time that happens after `begin()` or `reset()` the sink says so to the
  `EngineLog`.
- A member `core`'s `SidSink` has no concept of (`showText`, `setScheduleAhead`, `stats`) goes on
  `AsidSink`, not smuggled onto the shared contract.

## Hazards

- **The slot table is transcribed from firmware and is not regenerated.**
  `wire/asid-constants.ts`'s `ASID_SLOT_TO_REGISTER` is copied from the TeensyROM firmware's
  `ASIDidToReg[]` (`IOH_ASID.c`). A wrong entry is a wrong register on the wire with no local way
  to prove it — re-transcribe from the firmware source, do not renumber it by inference.
- **The gate double-write must reach both slots.** Registers 4, 11 and 18's second write in a
  frame is a deliberate retrigger, not noise; `slot-map.ts`'s `packFrameInto` routes it to that
  register's secondary slot (25/26/27) rather than overwriting the primary one. Losing that
  routing silently drops the retrigger — the far end plays one gate event instead of two.
- **Each committed send owns its buffer until it is pruned.** `retime()` re-sends exactly those bytes,
  so one shared scratch buffer would re-send the wrong packet. The specs' fake ports copy on `send`,
  which hides it; `asid-sink.spec.ts`'s port that keeps the reference is what shows it. A
  `MidiOutputPort` is given bytes valid only during `send`, and must copy to keep them.
- **The uncancellable-port schedule-ahead ceiling is ear-derived.** `sink/asid-sink.ts`'s
  `UNCANCELLABLE_SCHEDULE_AHEAD_CEILING_MS` (two PAL frames) was settled by listening on real
  hardware, not derived from a test — it is what keeps a stale-tempo frame a tempo change could no
  longer catch too short a window to be audible.
- **`web-midi` never requests access.** `web-midi/midi-output-port.ts`'s `midiOutputPortFrom`
  wraps a `MIDIOutput` the caller already has permission for and chose. Do not add a
  `requestMIDIAccess` call here — the access prompt and the output picker are the application's
  decision, not this library's.

## When a change here ripples

- **Found a behaviour the `SidSink` contract permits but this sink cannot satisfy?**
  `libs/core`'s `conformance/cases.ts` is where that gap becomes a check every sink runs against,
  rather than a workaround local to this one. Add or extend a case there and re-run
  `sink/conformance.spec.ts` here to confirm it now passes. Detail:
  [`libs/core/AGENTS.md`](../core/AGENTS.md).
- **Changed the sink's `passedCount`, `replaceFrom`, `deliver` or `reset` (`sink/asid-sink.ts`)?**
  `libs/dj` rewinds a deck on those counts and runs one spec against this sink, so a deck can redo
  or lose frames on the wire with no compile error. Run `pnpm --filter @sidablist/dj test`, which
  includes `src/proof/asid-sink.spec.ts`. Detail: [`libs/dj/AGENTS.md`](../dj/AGENTS.md).

## Commands

```
pnpm --filter @sidablist/asid build
pnpm --filter @sidablist/asid test
pnpm --filter @sidablist/asid typecheck
```

## Further reading

- [`docs/architecture.md`](../../docs/architecture.md) — the sink/transport seam and why the
  contract is shaped the way it is.
- [`docs/writing-a-sink.md`](../../docs/writing-a-sink.md) — the `SidSink` contract this sink
  implements, member by member, with this package's own `sink/conformance.spec.ts` as the worked
  example. Read it before adding a second sink, or before changing what this one promises core.
- [`AGENTS.md`](../../AGENTS.md) — the root map and the invariants no single library owns.
- [`libs/core/AGENTS.md`](../core/AGENTS.md) — the timeline engine this sink implements a contract
  for.
