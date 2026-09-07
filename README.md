# SIDablist

Framework-free TypeScript libraries for driving real SID hardware from a host. A `.sid` file is not
audio — it is a small 6502 program that writes to twenty-five registers, fifty times a second. These
libraries run that program and stream the register writes it makes; nothing here synthesizes sound.
That is the sound chip's job, and standing on the write side of it is what makes instant seek, real
loops and tempo as a continuous control possible at all.

## Packages

Not yet published to a registry — see [Installing from a local checkout](#installing-from-a-local-checkout)
below.

| Package                          | Owns                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@sidablist/core`](./libs/core) | The timeline engine: runs a tune's own 6502 code against a faked C64 and turns its register writes into `SidFrame`s. Zero runtime dependencies, no browser globals. |
| [`@sidablist/asid`](./libs/asid) | A `SidSink` implementation: the ASID wire format and the MIDI scheduling that puts a `SidFrame` on the wire to a TeensyROM cartridge.                               |

Read [`docs/architecture.md`](./docs/architecture.md) for why the boundary between them sits where it
does, [`docs/writing-a-sink.md`](./docs/writing-a-sink.md) for what a second sink would need to
implement, and [`docs/pal-ntsc.md`](./docs/pal-ntsc.md) for the pitch correction a foreign-clock tune
needs.

## Installing from a local checkout

Both packages ship only their built `dist/`, and that is not committed — building is a step you run,
not a file you fetch. There is no published npm package yet, so a consumer installs straight from a
checkout of this repository, assumed to sit as a **sibling directory** of the project consuming it:

```
your-workspace/
├── sidablist/        ← this repository
└── your-app/         ← the project that plays SID tunes
```

Build this repo once:

```
cd sidablist
pnpm install
pnpm build
```

Then, from `your-app`, add the packages by path:

```
cd ../your-app
pnpm add ../sidablist/libs/core ../sidablist/libs/asid
```

npm and Yarn accept the same relative path, or an explicit `file:../sidablist/libs/core` specifier if
your package manager needs it spelled out. `@sidablist/asid` depends on `@sidablist/core`, so both
have to resolve — installing them together, as above, is the simplest way to guarantee that.

## Quick start

The example below hand-writes a ten-byte "tune" — `init` does nothing, `play` increments a counter and
stores it into voice 1's frequency low byte — rather than loading a `.sid` file, so it has no external
dependency and runs as-is with nothing but `node`. A real consumer reads a `.sid` file's bytes from
disk and calls `parseSidFile(bytes)` to get the same `SidFile` shape this example builds by hand.

It also stands in for the collaborators a browser host would supply with its own: `FakeClock` and
`FakeSink` are real, exported fixtures (not test-only mocks smuggled into a public API) meant for
exactly this — driving a player with no audio graph and no MIDI device in the loop — and the
`replayRunner` below is `replayToFrame` run on the calling thread instead of on the worker a browser
host would use via `createWorkerReplayRunner()`.

```js
// hello-register-writes.mjs
import { createSidPlayer, FakeClock, FakeSink, replayToFrame } from '@sidablist/core';

const RTS = 0x60;

// init: RTS. play: INC $FB; LDA $FB; STA $D400; RTS — ten bytes of 6502, the whole tune.
const loadAddress = 0x1000;
const data = new Uint8Array(0x1010 + 8 - loadAddress);
data.set([RTS], 0x1000 - loadAddress);
data.set([0xe6, 0xfb, 0xa5, 0xfb, 0x8d, 0x00, 0xd4, RTS], 0x1010 - loadAddress);

const tune = {
  format: 'PSID',
  version: 2,
  loadAddress,
  initAddress: loadAddress,
  playAddress: 0x1010,
  songs: 1,
  startSong: 1,
  speedFlags: 0,
  name: 'Hello, register writes',
  author: 'sidablist',
  released: '2026',
  clock: 'pal',
  model: 'mos6581',
  secondSidAddress: null,
  thirdSidAddress: null,
  data,
};

const sink = new FakeSink();
const clock = new FakeClock();
const replayRunner = {
  async run(request) {
    try {
      const result = replayToFrame(
        request.file,
        request.subtune,
        request.targetFrame,
        request.mutes,
      );
      return { id: request.id, ok: true, result };
    } catch (error) {
      return { id: request.id, ok: false, error: String(error) };
    }
  },
  dispose() {},
};

const player = createSidPlayer({ sink, clock, replayRunner });
player.loadTune(tune);
await player.play();

for (let frame = 0; frame < 5; frame++) {
  clock.tick(frame * 20); // a PAL frame is ~20 ms
}

for (const { frameNumber, frame } of sink.deliveredFrames) {
  const writes = [];
  for (let i = 0; i < frame.count; i++) {
    writes.push(`reg ${frame.registers[i]} = ${frame.values[i]}`);
  }
  console.log(`frame ${frameNumber}:`, writes.join(', '));
}

player.dispose();
```

Run it with `node hello-register-writes.mjs`. The first frame carries a full 25-register resync
(every register core has ever touched, forced out once after init); every frame after that carries
only what the play routine actually wrote:

```
frame 0: reg 0 = 1, reg 1 = 0, reg 2 = 0, reg 3 = 0, reg 4 = 0, reg 5 = 0, reg 6 = 0, reg 7 = 0, reg 8 = 0, reg 9 = 0, reg 10 = 0, reg 11 = 0, reg 12 = 0, reg 13 = 0, reg 14 = 0, reg 15 = 0, reg 16 = 0, reg 17 = 0, reg 18 = 0, reg 19 = 0, reg 20 = 0, reg 21 = 0, reg 22 = 0, reg 23 = 0, reg 24 = 0
frame 1: reg 0 = 2
frame 2: reg 0 = 3
frame 3: reg 0 = 4
frame 4: reg 0 = 5
```

A real host swaps `FakeClock` for a `FrameClock` riding an audio graph, `FakeSink` for
`createAsidSink(midiOutputPort)` from `@sidablist/asid`, and `replayRunner` for
`createWorkerReplayRunner()` — see [`docs/writing-a-sink.md`](./docs/writing-a-sink.md) for the sink
contract and [`docs/architecture.md`](./docs/architecture.md#the-clock-port-is-split-the-same-way)
for the clock port's own split.

## License

MIT — see [`LICENSE`](./LICENSE).

## Third-party code

`libs/core/src/vendor/mos6502/` vendors [`mos6502`](https://github.com/kgtrey1/mos6502) v1.1.1 by
Kevin Gouyet, MIT licensed, as source rather than as a dependency — so a `.sid` tune's own 6502 code
can be fixed and extended in place, which is this repository's problem to solve, not upstream's. The
original license is kept verbatim alongside it at
[`libs/core/src/vendor/mos6502/LICENSE`](./libs/core/src/vendor/mos6502/LICENSE), and every modified
file says so.
