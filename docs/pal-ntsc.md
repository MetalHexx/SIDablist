# PAL and NTSC

Explanation, not rules. The invariants this page explains — the ear-validated constants in
`registers/clock-ratio.ts` and `registers/sid-constants.ts`, and the shape of the frequency-scaling
path in `registers/register-frame.ts` — live in [`libs/core/AGENTS.md`](../libs/core/AGENTS.md). Read
this before touching either file, not for a routine edit. See
[`architecture.md`](./architecture.md) for where this correction sits among core's other
responsibilities.

## Two effects, two causes

Playing a tune on a machine it was not written for goes wrong in two independent ways:

| Effect | Cause                                           | Size                   |
| ------ | ----------------------------------------------- | ---------------------- |
| Tempo  | Frame rate — 50.1245 Hz PAL vs 59.8261 Hz NTSC  | +19.36%                |
| Pitch  | φ2 clock — 985248.6 Hz PAL vs 1022727.1 Hz NTSC | +3.804%, ≈ +64.6 cents |

They have different causes, so they need different fixes — which is the whole reason it is useful
that they are separable at all.

## Why they are separable here and were not on real hardware

The oscillator frequency is:

```
Fout = Fn × φ2 / 2^24
```

The play rate is not in that equation. The oscillator is a free-running phase accumulator inside the
chip, adding `Fn` on every clock cycle whether or not anything is writing to it. Calling the tune's
play routine more often only makes its sequencer advance faster — notes arrive sooner, at the same
pitch. Tempo and pitch are therefore independent variables in this system, and correcting one costs
nothing on the other.

On real hardware they always moved together, because the frame rate and φ2 both derive from the same
crystal — there was never a machine that ran PAL's video timing off NTSC's clock or vice versa, so the
two effects had no way to appear separately. Streaming register writes breaks that link: the host
owns the play rate, the attached machine owns φ2. The practical upshot is that a tempo change costs no
pitch change — the thing keylock exists to fake for audio DJs, and here it is simply true rather than
compensated for.

Tempo is corrected by the play rate — moving how often the play routine runs, which core already
owns. Pitch has to be corrected by rewriting the frequency register values themselves before they
leave the engine, scaled by the source/target clock ratio. The rest of this page is about that half.

## The composition

Two multipliers compose, and stay separate internally, in `registers/register-frame.ts`:

```
Fn_out = Fn × clockRatio × voicePitch[voice]
```

- **`clockRatio`** (`registers/clock-ratio.ts`'s `clockRatio(sourceHz, targetHz)`) is derived from the
  two φ2 values, constant for the session, and invisible to the performer. It answers "what was this
  tune written for, and what is it playing on" — a fact about the tune and the target machine, not a
  performance control.
  Concretely: `clockRatio(sourceHz, targetHz) = sourceHz / targetHz`, so a PAL tune corrected for
  playback on NTSC divides its frequency registers by NTSC's clock rising over PAL's — a downward
  scale — and an NTSC tune corrected for PAL scales up by the same ratio inverted.
- **`voicePitch`** is live and user-driven, one independent value per voice. Whether a performer's
  interface gangs the three voices together is an application decision core has no opinion on.

Keeping them apart means moving a pitch fader never disturbs the clock correction, and vice versa: a
`setTargetClock` call re-derives `clockRatio` without touching whatever `voicePitch` a performer has
already set, and `setVoicePitch` composes with whatever `clockRatio` is already in force. An interface
can report how much correction is in effect independently of where a fader currently sits.

## What is scaled, and what is not — and why

Only the frequency registers move. Everything else is left alone, deliberately:

- **Not filter cutoff.** The filter is genuinely analog, set by external capacitors, with no clock
  term in its own operation. Emulators model it as a clock-driven discrete-time system for
  implementation reasons, which can give the false impression that it should scale with φ2 the way the
  oscillator does. It should not, because the real chip's filter does not.
- **Not pulse width.** Duty cycle is a fraction of the accumulator's own period, so it is
  clock-independent by construction — scaling the clock does not change what fraction of a cycle the
  pulse stays high.
- **Not envelopes.** The attack/decay/sustain/release register is a lookup index into a rate table,
  not a linear duration. A 3.8% clock error turns into a rate-table neighbour at worst, and the
  resulting envelope-timing error is far below what a listener would notice.

Noise and percussion need no special case: uniform scaling shifts the noise waveform's colour by the
same amount as every tonal voice, which is inaudible on its own, and trying to infer a tune's intent
from the waveform register to skip scaling it would be a worse bet than simply always scaling. Hard
sync and ring modulation are safe for the same reason: they depend on the _ratio_ between two voices'
frequencies, and scaling every voice by the same `clockRatio` preserves every ratio between them
exactly, even though `voicePitch` can still detune one voice relative to another on purpose.

## The high-byte trap

A SID frequency register is 16 bits split across two 8-bit registers (voice 1: `$D400` low, `$D401`
high). Scaling the combined 16-bit value can change its **high byte even when the tune's play routine
only wrote the low one this frame** — which is the ordinary case for a slide or a vibrato, where only
the low byte moves from call to call.

A correct implementation therefore keeps a per-voice shadow of both bytes, recomputes the _whole_
16-bit value from that shadow on every low-or-high write, and emits both registers — not just the one
the tune wrote — whenever the recomputed value moved. `register-frame.ts`'s `scaleVoiceFrequency`
does exactly this: it recombines both shadow bytes, rounds once, and the frame-construction path
forces both frequency registers of a voice out on every frame the voice's combined coefficient is off
its 1.0 home, specifically so the moved high byte reaches the chip instead of being left behind at the
tune's own value.

**Worked case.** Take an NTSC tune corrected for PAL playback: `clockRatio(1022727.1, 985248.6) ≈
1.03804`, a +3.804% upward scale. Say the tune's own frequency shadow for voice 1 currently holds
`$00FE` (high byte `$00`, low byte `$FE` — 254), and this frame's play call writes only the low byte,
to `$FE` again (a value it was already holding, as a slide's steady state might). Scaling the combined
value:

```
254 × 1.03804 ≈ 263.66 → round → 264 = $0108
```

The corrected value's high byte is now `$01`, not `$00` — it crossed a byte boundary that the tune's
own write, to the low byte alone, gave no sign of. An implementation that only re-scaled the byte the
tune actually wrote would emit `$08` to the low register and leave the high register at its last
value, landing the chip on `$0008` instead of `$0108` — over four octaves flat, and audibly broken, not
merely imprecise. Recomputing the full value from the shadow, and emitting both bytes, is what makes
this land correctly instead: **round once, at the end, per voice** — and round rather than truncate,
which halves the worst-case error against either neighbouring value.

## Further reading

- [`architecture.md`](./architecture.md) — where the PAL/NTSC correction sits among core's other
  responsibilities, and the read-side split that surfaces how much correction is in effect.
- [`libs/core/AGENTS.md`](../libs/core/AGENTS.md) — the hazard against re-deriving
  `PAL_PHI2_HZ`/`NTSC_PHI2_HZ` or `PAL_FRAME_INTERVAL_US` from anything other than real hardware.
