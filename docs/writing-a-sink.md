# Writing a sink

Explanation, not rules. The rules for `libs/asid` — the one sink that exists today — live in
[`libs/asid/AGENTS.md`](../libs/asid/AGENTS.md); core's side of the contract lives in
[`libs/core/AGENTS.md`](../libs/core/AGENTS.md). This page is for the moment either of those says
"read this first": before changing what a sink promises core, or before adding a second one. See
[`architecture.md`](./architecture.md) for the sink/transport seam split this contract sits on one
side of.

A sink turns one `SidFrame` — an ordered list of register writes — into whatever its far end
actually needs: SysEx packets for ASID, a ring-buffer write for a DMA cartridge. Core builds the
frame and calls the contract below; everything past that point is the sink's own business.

## The contract, member by member

`SidSink` (`libs/core/src/ports/sink.ts`) is small on purpose — a widened one-way contract costs
almost nothing unused, while narrowing a shipped one means rewriting both ends.

- **`capabilities`** — a getter, not a frozen object, because it can change under the sink with no
  call back in (a MIDI port swap, a same-device reconnect). Core reads it fresh rather than caching
  it. See `SinkCapabilities` below.
- **`begin(tune)`** — called once before the first frame of a run. `tune.chipModel` comes from the
  `.sid` file's own header, which is why core hands it over rather than a sink going looking for it.
  ASID forwards it as its own packet; a DMA sink may ignore it.
- **`end()`** — the far end should stop. Called on pause, stop, end-of-track and dispose.
- **`deliver(frame, frameNumber, dueAtMs, catchUpClamped)`** — one frame, scheduled for `dueAtMs` on
  the same timeline the clock reports. `frameNumber` is the timeline position this frame represents,
  for a sink that can read its far end back. `catchUpClamped` marks a frame whose due time reads later
  than the truth because the clock's advance hit its catch-up ceiling — a sink measuring lag needs to
  know its reading is a floor, not a fact. See the buffer-reuse rule below before storing `frame`.
- **`deliverNow(frame)`** — sends immediately, outside the schedule and ahead of anything queued. This
  is the gate-off a pause needs: queued behind scheduled frames it would let notes ring on until the
  queue drained.
- **`retime(intervalUs)`** — re-times or withdraws whatever is still outstanding after a tempo change.
  A sink with no scheduling of its own implements this as a no-op.
- **`reset()`** — drops everything outstanding without stopping the far end. Separate from `end()`
  because a seek resets without stopping.
- **`readAt()`** — what the far end has consumed, as a `FarEndConsumption`. `{ kind: 'unknown',
inFlight }` is a legitimate answer, not a failure — but a sink that knows its own queue depth must
  report it even when it cannot report what actually played.

## What a capability flag means

`SinkCapabilities` is how a sink tells core what it cannot do, instead of core finding out at run
time:

- **`perWriteOffsets`** — whether the sink can honour `SidFrame.offsetsUs`, a per-write delay within
  the frame. Always `0` from every tune today, but the field — and the capability describing whether
  a sink could act on it — exists because widening a one-way contract later means rewriting both
  ends; an unused field costs almost nothing now.
- **`cancellation`** — whether a pending, not-yet-sent frame can be withdrawn.
- **`scheduleAheadMs`** — how far ahead the sink wants frames handed over, if it has an opinion. `null`
  means it has none. Reported live, after clamping, not the value last requested.
- **`preservesWriteOrder`** — whether the sink's wire preserves the arrival order of writes to two
  _different_ registers made within one frame. A sink streaming one wire message per write can; one
  that packs a whole frame into a fixed-layout snapshot, applied by the far end in the layout's own
  slot order, cannot — cross-register arrival order is simply not representable on that wire.

**Reporting a limitation beats failing at run time.** A sink that cannot honour a capability reports
it as `false` (or `null`) and silently ignores the request — it never throws, and core never checks a
capability before calling the method it gates. The alternative is a contract that pretends every sink
can do everything, discovered false the first time it matters. Look at how `libs/asid`'s
`asid-sink.ts` answers each of these: `preservesWriteOrder` is `false` because one `SID_DATA` packet
carries a whole frame in the firmware's fixed slot order regardless of arrival order; `cancellation`
mirrors the injected `MidiOutputPort`'s own `supportsCancel`, live, because that can flip out from
under the sink on a port swap.

## The frame-buffer reuse rule

`SidFrame`'s three arrays are reused between frames — the same `Uint8Array`/`Int32Array` instances
come back with new contents on the next call. **Copy if you outlive the call.** A sink that only
reads a frame synchronously inside `deliver`/`deliverNow` (to build a packet immediately, say) needs
nothing extra. A sink — or a test — that wants to compare frame _n_ against frame _n+1_ later must
copy `registers`, `values` and `offsetsUs` out first, or it will find frame _n_'s slot silently
holding frame _n+1_'s bytes. `libs/core`'s own `FakeSink` (`testing/fake-sink.ts`) does exactly this
before recording a delivered frame — copy the pattern rather than reinvent it:

```ts
function copyFrame(frame: SidFrame): SidFrame {
  return {
    count: frame.count,
    registers: frame.registers.slice(),
    values: frame.values.slice(),
    offsetsUs: frame.offsetsUs.slice(),
  };
}
```

## Running the shared conformance suite

`SINK_CONFORMANCE_CASES` (exported from `@sidablist/core/conformance`, a separate subpath so a sink
that never needs it never pulls it in) is the suite every `SidSink` implementation runs against
itself. It exercises exactly the behaviours the contract above states in words: write ordering,
gate-off draining ahead of a resync, clean recovery from underrun, honouring `cancellation` and
`perWriteOffsets` correctly whichever way a sink answers them, `reset` actually dropping what is
outstanding, and `readAt().inFlight` staying accurate regardless of `FarEndConsumption`'s `kind`.

A consumer hands the suite one thing: a `ConformanceHarness` — a fresh `sink`, an `emitted()` reader
and an `advanceMs()` that drives whatever notion of time the sink schedules against. Once that harness
exists, running the whole suite is three lines:

```ts
for (const c of SINK_CONFORMANCE_CASES) {
  it(c.name, async () => await c.run(makeHarness));
}
```

The harness is where the real work is, and it is necessarily sink-specific — `emitted()` has to
decode the sink's own wire format back into `{ register, value }` pairs, because a sink that cannot
show what it actually sent cannot be conformance-tested at all. `libs/asid`'s
`sink/conformance.spec.ts` is the worked example: its `makeHarness()` wraps a fake `MidiOutputPort`,
decodes ASID's present/MSB masks back into register writes, and advances a mocked `performance.now()`
so `advanceMs` releases whatever is due. A case a new sink fails is the suite doing its job — the sink
needs to change, not the case.

## Further reading

- [`architecture.md`](./architecture.md) — the sink/transport seam split, and why the frame crossing
  it is an ordered list rather than any one sink's own wire layout.
- [`libs/core/AGENTS.md`](../libs/core/AGENTS.md) — the `SidSink` contract's home, and what ripples
  through `conformance/cases.ts` when it changes.
- [`libs/asid/AGENTS.md`](../libs/asid/AGENTS.md) — the one sink that exists today, and the hazards
  specific to it.
