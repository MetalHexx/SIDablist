# Architecture

Explanation, not rules. The rules live in [`AGENTS.md`](../AGENTS.md); this page is the *why*
behind them. Read it before restructuring a library, adding one, or drawing a new boundary — not
for a routine edit.

## The premise

A SID tune is not audio. It is a small 6502 program that writes to twenty-five registers, fifty
times a second, forever.

```
.sid file  ─▶  6502 program  ─▶  register writes  ─▶  SID chip  ─▶  sound
                    │                    │               │
              we run this        we capture these    hardware does this
```

Most SID software stands at the right-hand end of that chain and asks the chip to play. This one
stands at the left and drives it. Every capability that follows — instant seek, real loops, tempo
as a continuous control, a tune that knows its own length — is a consequence of standing on that
side of the register writes rather than a feature bolted on afterwards.

Nothing here synthesizes sound. That is the chip's job, and it is why the whole system can be a
few thousand lines rather than an emulator.

## The packages, and why the arrows point one way

```
                    your application
                deck state · saved cues & loops
             MIDI access · controller mapping · UI
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
      ┌─────────────┐  ┌──────────┐  ┌──────────┐
      │    asid     │  │ analysis │  │  tr-dma  │
      │ wire format │  │  (later) │  │  (later) │
      │ scheduling  │  └──────────┘  └──────────┘
      └─────────────┘        │             │
              └──────────────┼─────────────┘
                             ▼
                    ┌────────────────┐
                    │      core      │
                    │ timeline · ports
                    │ zero deps      │
                    └────────────────┘
```

`core` depends on nothing and does not know the others exist.

That direction is the whole design, and it is why these are separate npm packages rather than
folders in one. Inside a single package, "core must not import a sink" is a convention someone has
to remember and a reviewer has to catch. Across packages it is a **circular dependency the package
manager rejects** — core's `package.json` does not list the sinks, so the import simply does not
resolve. The boundary stops being a promise and becomes a build failure.

The same reasoning explains why this repository is not part of the application that first used it.
In a workspace where a framework is installed at the root, an accidental framework import resolves
fine. Here there is nothing to resolve it to, and CI proves the point by building and testing
`core` with nothing else installed.

## What belongs in core

One question decides it: **does this need to know where the playhead is, or what the user wants?**

Timeline goes in core. User intent stays in the application.

Core is the timeline authority over a tune. It runs the tune, owns time and position, holds the
resulting register state, and hands frames to a sink. It never makes sound and never learns where
bytes physically go.

The corollary that catches most cases: **core owns the operations, the application owns the
collections.**

- Core holds the *active* loop, because it has to enforce it on every frame.
- The application holds the list of saved cues and loops, their names, their pad assignments, and
  whether they survive a reload.
- A cue is a loop without an end marker. Both are *a frame number someone remembered* plus *an
  operation core performs*. The remembering is application; the performing is core.

Worked examples of the same test:

| Thing | Where | Why |
|---|---|---|
| Seek, tempo, active loop, voice control | core | Timeline operations |
| Web MIDI access | application | Bytes to a device; knows nothing about position |
| Persistence | application | A preference, not a timeline fact |
| Crossfader position | application | Intent |
| Applying gain and filter scaling to registers | core | Register state on the frame path |

## The two seams

A register write leaves the tune's own code and ends up on a chip. Two independent seams sit in
that path, and conflating them is the mistake the design exists to avoid.

```
frame ──▶│ SINK SEAM │──▶ wire format ──▶│ TRANSPORT SEAM │──▶ bytes ──▶ device
         protocol semantics               bytes reaching a device
```

- The **sink seam** is about *what a register write means on the wire*. ASID encodes it as a SysEx
  packet; a DMA sink writes it into a ring buffer in the machine's memory.
- The **transport seam** is about *bytes reaching a device*. Web MIDI, a native MIDI binding,
  serial, a network hop.

They are independent: a DMA sink can ride serial or a network without changing the protocol above
it, and ASID's wire format is the same whether the bytes leave through a browser or Node.

### The sink contract is shaped for the richer transport

Only ASID exists today, and the contract is still bidirectional, carries per-write ordering, and
has a time offset per write that ASID cannot honour.

That is deliberate. Widening a one-way contract later means rewriting both ends; an unused field
costs almost nothing. A sink that cannot answer something reports that it cannot, rather than the
contract pretending the question was never asked.

### Timing authority is not the same on every sink

| Sink | Who keeps time | What the host clock must provide |
|---|---|---|
| ASID | The host, reconstructed by the OS MIDI stack | Low instantaneous variance |
| DMA | The C64-side player, on the machine's own timer | A correct average rate only |

This is why the clock port must not assume the strictest case. Designing for ASID's requirement
would impose a browser-grade audio clock on a sink that does not need one, for no benefit.

It is also why *scheduling* lives in the sink rather than in core. Timestamping is how Web MIDI
keeps time; serial has no timestamp mechanism at all. The clearest illustration: on a tempo change
ASID cancels its outstanding packets and re-sends them at the new spacing, while a DMA sink writes
one new timer value and flushes nothing, because nothing needs re-declaring.

Core's half is only ever *this frame is due at T*.

## How a consumer reads core

Core exposes the external store contract — `subscribe(cb)` plus `getSnapshot()` — and no reactive
library. React consumes it through `useSyncExternalStore`, Svelte's store contract already matches,
and Angular wraps it in a signal updated from an effect.

Everything is a plain read. The only distinction is **whether a change notifies you**:

| Read | Notifies | Carries |
|---|---|---|
| `getSnapshot()` | yes | Transport state, tune, tempo, the active loop, voices, error |
| `getPosition()` | no | The playhead frame |
| `getStats()` | no | Drift, jitter, lag, cycle headroom, in-flight depth |

The rule behind the split: **things a person did notify you; things time did, you go and look at.**

This is not stylistic. The engine advances fifty times a second per deck. Pushing the playhead
through a subscription would wake every consumer's change detection fifty times a second to tell it
something it already knew to ask for. Continuous values are pulled by the consumer on its own
schedule, typically in an animation frame, and the hot path never crosses the subscription boundary
at all.

## PAL and NTSC

Playing a tune on a machine it was not written for goes wrong in two independent ways. They have
different causes and different fixes, which is the whole reason they are separable.

| Effect | Cause | Size |
|---|---|---|
| Tempo | Frame rate — 50.1245 Hz PAL vs 59.8261 Hz NTSC | +19.36% |
| Pitch | φ2 clock — 985248.6 Hz PAL vs 1022727.1 Hz NTSC | +3.804%, ≈ +64.6 cents |

The oscillator frequency is:

```
Fout = Fn × φ2 / 2^24
```

The play rate is not in that equation. The oscillator is a free-running phase accumulator inside
the chip, adding `Fn` on every clock cycle whether or not anything is writing to it. So calling the
tune's play routine more often makes its sequencer advance faster — the notes arrive sooner, at the
same pitch.

**Tempo and pitch are therefore independent here**, which is unusual and worth internalising. On a
real machine they always moved together, because the frame rate and φ2 both derive from the same
crystal. Streaming register writes breaks that link: the host owns the play rate, the attached
machine owns φ2. The practical upshot is that tempo changes cost no pitch change — the thing
keylock exists to fake for audio DJs.

Tempo is already ours. Pitch has to be corrected by rewriting the frequency register values before
they leave the engine, scaled by the source/target clock ratio.

Two multipliers compose and stay separate internally:

```
Fn_out = Fn × clockRatio × voicePitch[voice]
```

`clockRatio` is derived, constant for the session, and invisible to the performer. `voicePitch` is
live and user-driven, one value per voice — the application decides whether to gang them. Keeping
them separate means moving a pitch control never disturbs the correction, and an interface can
report how much correction is in effect independently of where a fader sits.

Scale the frequency registers and nothing else:

- **Not filter cutoff.** The filter is genuinely analog, set by external capacitors, with no clock
  term. Emulators model it as a clock-driven discrete-time system, which can give the opposite
  impression.
- **Not pulse width.** Duty cycle is a fraction of the accumulator period, so it is
  clock-independent by construction.
- **Not envelopes.** The rate register is a lookup index, not a linear value, and a 3.8% envelope
  error is far below notice.

Noise and percussion need no special case: uniform scaling shifts noise colour by the same amount
as everything else, which is inaudible, and inferring intent from the waveform register would be
worse than not trying. Hard sync and ring modulation are safe for the same reason — scaling every
voice by one constant preserves the ratios they depend on.

### The trap

Scaling a 16-bit frequency value can change its **high byte even when the tune only wrote the low
one**. A correct implementation keeps a per-voice shadow copy, recomputes the whole scaled value on
every low-*or*-high write, and emits an extra high-byte write when it moved. Round once, at the
end, per voice — and round rather than truncate, which halves the worst-case error.

## Further reading

- [`AGENTS.md`](../AGENTS.md) — the invariants this page explains, stated as rules.
