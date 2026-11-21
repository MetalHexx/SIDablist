import { describe, it, expect } from 'vitest';
import {
  type C64Machine,
  copyMachineImage,
  createC64Machine,
  createMachineImage,
  type SidWriteSink,
  UnplayableTuneError,
} from './c64-machine.js';
import {
  IO_START,
  MEMORY_SIZE,
  NTSC_CYCLES_PER_FRAME,
  PAL_CYCLES_PER_FRAME,
  PLAY_BUDGET_FRAMES,
  PORT_DATA,
  PORT_DDR,
  TRAMPOLINE_BASE,
  TRAMPOLINE_IDLE_OFFSET,
  TRAMPOLINE_PLAY_RETURN_OFFSET,
} from './cpu-constants.js';
import type { SidClock, SidFile } from '../sid/sid-file.model.js';
import { parseSidFile } from '../sid/sid-file.parser.js';
import { BUNDLED_TUNES, decodeBundledTune } from '../sid/__fixtures__/index.js';

interface CodeBlock {
  readonly at: number;
  readonly bytes: readonly number[];
}

interface TuneOptions {
  loadAddress?: number;
  initAddress?: number;
  playAddress?: number;
  format?: 'PSID' | 'RSID';
  clock?: SidClock;
  songs?: number;
  version?: number;
  speedFlags?: number;
  psidSpecific?: boolean;
  relocStartPage?: number;
  relocPages?: number;
  padTo?: number;
  secondSidAddress?: number | null;
  thirdSidAddress?: number | null;
  blocks: readonly CodeBlock[];
}

/** Assembles hand-written blocks into a `SidFile` whose payload is the machine's C64 memory image. */
function tune(options: TuneOptions): SidFile {
  const loadAddress = options.loadAddress ?? 0x1000;
  const codeEnd = options.blocks.reduce(
    (end, block) => Math.max(end, block.at + block.bytes.length),
    loadAddress,
  );
  const data = new Uint8Array(Math.max(codeEnd, options.padTo ?? 0) - loadAddress);
  for (const block of options.blocks) {
    data.set(block.bytes, block.at - loadAddress);
  }

  return {
    format: options.format ?? 'PSID',
    version: options.version ?? 2,
    loadAddress,
    initAddress: options.initAddress ?? loadAddress,
    playAddress: options.playAddress ?? 0,
    songs: options.songs ?? 1,
    startSong: 1,
    speedFlags: options.speedFlags ?? 0,
    ...(options.psidSpecific === undefined ? {} : { psidSpecific: options.psidSpecific }),
    ...(options.relocStartPage === undefined ? {} : { relocStartPage: options.relocStartPage }),
    ...(options.relocPages === undefined ? {} : { relocPages: options.relocPages }),
    name: '',
    author: '',
    released: '',
    clock: options.clock ?? 'pal',
    model: 'unknown',
    secondSidAddress: options.secondSidAddress ?? null,
    thirdSidAddress: options.thirdSidAddress ?? null,
    data,
  };
}

class RecordingSink implements SidWriteSink {
  readonly writes: { register: number; value: number }[] = [];

  onSidWrite(register: number, value: number): void {
    this.writes.push({ register, value });
  }
}

function valuesFor(sink: RecordingSink, register: number): number[] {
  return sink.writes.filter((write) => write.register === register).map((write) => write.value);
}

describe('C64Machine', () => {
  it('hands every SID-range write made by init to the sink', () => {
    // LDX #0 / TXA / STA $D400,X / INX / CPX #$19 / BNE loop / RTS
    const file = tune({
      initAddress: 0x1000,
      playAddress: 0x100c,
      blocks: [
        {
          at: 0x1000,
          bytes: [0xa2, 0x00, 0x8a, 0x9d, 0x00, 0xd4, 0xe8, 0xe0, 0x19, 0xd0, 0xf7, 0x60],
        },
        { at: 0x100c, bytes: [0x60] },
      ],
    });
    const sink = new RecordingSink();
    const machine = createC64Machine(file, sink);

    const result = machine.initSubtune(1);

    expect(result.completed).toBe(true);
    expect(result.cyclesUsed).toBeGreaterThan(0);
    expect(sink.writes).toHaveLength(25);
    expect(sink.writes[0]).toEqual({ register: 0, value: 0 });
    expect(sink.writes[24]).toEqual({ register: 24, value: 24 });
  });

  it('mirrors the $D420 alias onto register 0 and drops the non-audible registers', () => {
    // LDA #$2A / STA $D420 / LDA #$7F / STA $D41B / RTS
    const file = tune({
      loadAddress: 0x2000,
      playAddress: 0x200b,
      blocks: [
        { at: 0x2000, bytes: [0xa9, 0x2a, 0x8d, 0x20, 0xd4, 0xa9, 0x7f, 0x8d, 0x1b, 0xd4, 0x60] },
        { at: 0x200b, bytes: [0x60] },
      ],
    });
    const sink = new RecordingSink();

    createC64Machine(file, sink).initSubtune(1);

    expect(sink.writes).toEqual([{ register: 0, value: 0x2a }]);
  });

  it('excludes writes to a v3 header second SID address from the sink', () => {
    // init:  LDA #$2A / STA $D400 / LDA #$55 / STA $D420 / RTS
    // play:  LDA #$3C / STA $D401 / LDA #$66 / STA $D421 / RTS
    const file = tune({
      loadAddress: 0x2000,
      playAddress: 0x200b,
      secondSidAddress: 0xd420,
      blocks: [
        { at: 0x2000, bytes: [0xa9, 0x2a, 0x8d, 0x00, 0xd4, 0xa9, 0x55, 0x8d, 0x20, 0xd4, 0x60] },
        { at: 0x200b, bytes: [0xa9, 0x3c, 0x8d, 0x01, 0xd4, 0xa9, 0x66, 0x8d, 0x21, 0xd4, 0x60] },
      ],
    });
    const sink = new RecordingSink();
    const machine = createC64Machine(file, sink);

    machine.initSubtune(1);
    machine.runFrame();

    expect(sink.writes).toEqual([
      { register: 0, value: 0x2a },
      { register: 1, value: 0x3c },
    ]);
  });

  it('runs the play routine exactly once per frame', () => {
    // init: RTS. play: LDA $D404 / TAX / INX / STX $D404 / RTS
    const file = tune({
      playAddress: 0x1001,
      blocks: [
        { at: 0x1000, bytes: [0x60] },
        { at: 0x1001, bytes: [0xad, 0x04, 0xd4, 0xaa, 0xe8, 0x8e, 0x04, 0xd4, 0x60] },
      ],
    });
    const sink = new RecordingSink();
    const machine = createC64Machine(file, sink);
    machine.initSubtune(1);

    const results = [machine.runFrame(), machine.runFrame(), machine.runFrame()];

    expect(results.every((result) => result.completed)).toBe(true);
    expect(valuesFor(sink, 4)).toEqual([1, 2, 3]);
  });

  it('gives up on a play routine that never returns instead of spinning', () => {
    // init: RTS. play: JMP self
    const file = tune({
      playAddress: 0x1001,
      blocks: [{ at: 0x1000, bytes: [0x60, 0x4c, 0x01, 0x10] }],
    });
    const machine = createC64Machine(file, new RecordingSink());
    machine.initSubtune(1);

    const result = machine.runFrame();

    expect(result.completed).toBe(false);
    expect(result.cyclesUsed).toBe(PAL_CYCLES_PER_FRAME * 2);
  });

  it('advances the raster counter as a frame progresses', () => {
    // play: sample $D012 into $D400, burn ~10k cycles in a nested loop, sample again into $D401
    const file = tune({
      playAddress: 0x1010,
      blocks: [
        { at: 0x1000, bytes: [0x60] },
        {
          at: 0x1010,
          bytes: [
            0xad, 0x12, 0xd0, 0x8d, 0x00, 0xd4, 0xa2, 0x08, 0xa0, 0x00, 0x88, 0xd0, 0xfd, 0xca,
            0xd0, 0xfa, 0xad, 0x12, 0xd0, 0x8d, 0x01, 0xd4, 0x60,
          ],
        },
      ],
    });
    const sink = new RecordingSink();
    const machine = createC64Machine(file, sink);
    machine.initSubtune(1);

    expect(machine.runFrame().completed).toBe(true);
    expect(valuesFor(sink, 1)[0]).not.toBe(valuesFor(sink, 0)[0]);
  });

  it('derives the play rate from the CIA 1 timer A latch a tune programs during init', () => {
    // LDA #$31 / STA $DC04 / LDA #$13 / STA $DC05 / RTS — latch $1331, so 4914 cycles per call
    const file = tune({
      speedFlags: 1,
      playAddress: 0x100b,
      blocks: [
        { at: 0x1000, bytes: [0xa9, 0x31, 0x8d, 0x04, 0xdc, 0xa9, 0x13, 0x8d, 0x05, 0xdc, 0x60] },
        { at: 0x100b, bytes: [0x60] },
      ],
    });
    const machine = createC64Machine(file, new RecordingSink());

    machine.initSubtune(1);

    expect(machine.cyclesPerPlayCall).toBe(0x1331 + 1);
    expect(machine.callsPerFrame).toBe(Math.round(PAL_CYCLES_PER_FRAME / (0x1331 + 1)));
  });

  it('keeps a fractional play rate unrounded, so a duration derived from it is not paced wrong', () => {
    // LDA #$FD / STA $DC04 / LDA #$1F / STA $DC05 / RTS — latch $1FFD, so 8190 cycles per call.
    // 19656 / 8190 is exactly 2.4: a rate that does not divide the frame evenly, which is ordinary
    // for a CIA-timer tune and is precisely the case rounding gets wrong.
    const file = tune({
      speedFlags: 1,
      playAddress: 0x100b,
      blocks: [
        { at: 0x1000, bytes: [0xa9, 0xfd, 0x8d, 0x04, 0xdc, 0xa9, 0x1f, 0x8d, 0x05, 0xdc, 0x60] },
        { at: 0x100b, bytes: [0x60] },
      ],
    });
    const machine = createC64Machine(file, new RecordingSink());

    machine.initSubtune(1);

    expect(machine.cyclesPerPlayCall).toBe(0x1ffd + 1);
    expect(machine.exactCallsPerFrame).toBeCloseTo(2.4, 5);
    // The integer form still answers its own question, and the two genuinely disagree here — an
    // interval divided by the rounded rate would run this tune 20% slow.
    expect(machine.callsPerFrame).toBe(2);

    const into = new Float64Array(2);
    machine.readRatesInto(into);
    expect([into[0], into[1]]).toEqual([machine.exactCallsPerFrame, machine.callsPerFrame]);
  });

  it("reports the frame cycle budget against the tune's own clock, PAL or NTSC", () => {
    const palMachine = createC64Machine(
      tune({ clock: 'pal', blocks: [{ at: 0x1000, bytes: [0x60] }] }),
      new RecordingSink(),
    );
    const ntscMachine = createC64Machine(
      tune({ clock: 'ntsc', blocks: [{ at: 0x1000, bytes: [0x60] }] }),
      new RecordingSink(),
    );

    expect(palMachine.frameCycleBudget).toBe(PAL_CYCLES_PER_FRAME * PLAY_BUDGET_FRAMES);
    expect(ntscMachine.frameCycleBudget).toBe(NTSC_CYCLES_PER_FRAME * PLAY_BUDGET_FRAMES);
    expect(palMachine.frameCycleBudget).not.toBe(ntscMachine.frameCycleBudget);
  });

  it('reports one call per frame for a tune that never programs the timer', () => {
    const file = tune({ playAddress: 0x1001, blocks: [{ at: 0x1000, bytes: [0x60, 0x60] }] });
    const machine = createC64Machine(file, new RecordingSink());

    machine.initSubtune(1);

    expect(machine.cyclesPerPlayCall).toBeNull();
    expect(machine.callsPerFrame).toBe(1);
  });

  it('discovers the play address an RSID installs at $0314 during init', () => {
    // LDA #$10 / STA $0314 / STA $0315 / RTS, with the handler at $1010
    const file = tune({
      format: 'RSID',
      playAddress: 0,
      blocks: [
        { at: 0x1000, bytes: [0xa9, 0x10, 0x8d, 0x14, 0x03, 0x8d, 0x15, 0x03, 0x60] },
        { at: 0x1010, bytes: [0xa9, 0x07, 0x8d, 0x00, 0xd4, 0x60] },
      ],
    });
    const sink = new RecordingSink();
    const machine = createC64Machine(file, sink);

    machine.initSubtune(1);

    expect(machine.resolvedPlayAddress).toBe(0x1010);
    expect(machine.runFrame().completed).toBe(true);
    expect(sink.writes).toEqual([{ register: 0, value: 0x07 }]);
  });

  it('refuses a tune that installs no interrupt vector rather than calling address 0', () => {
    const file = tune({ format: 'RSID', playAddress: 0, blocks: [{ at: 0x1000, bytes: [0x60] }] });
    const machine = createC64Machine(file, new RecordingSink());

    expect(() => machine.initSubtune(1)).toThrow(UnplayableTuneError);
  });

  it('rejects a subtune outside the range the header declares', () => {
    const file = tune({
      playAddress: 0x1001,
      songs: 2,
      blocks: [{ at: 0x1000, bytes: [0x60, 0x60] }],
    });
    const machine = createC64Machine(file, new RecordingSink());

    expect(() => machine.initSubtune(3)).toThrow(RangeError);
    expect(() => machine.initSubtune(0)).toThrow(RangeError);
  });

  it('relocates the trampoline when the tune covers the page it defaults to', () => {
    // LDA #$11 / STA $D400 / RTS, loaded across $E900-$EAFF so it swallows $EA00
    const file = tune({
      loadAddress: 0xe900,
      playAddress: 0xe906,
      padTo: 0xeb00,
      blocks: [
        { at: 0xe900, bytes: [0xa9, 0x11, 0x8d, 0x00, 0xd4, 0x60] },
        { at: 0xe906, bytes: [0x60] },
      ],
    });
    const sink = new RecordingSink();
    const machine = createC64Machine(file, sink);

    const result = machine.initSubtune(1);

    expect(machine.trampolineBase).not.toBe(TRAMPOLINE_BASE);
    expect(result.completed).toBe(true);
    expect(sink.writes).toEqual([{ register: 0, value: 0x11 }]);
  });

  it('counts undocumented opcodes instead of failing on them', () => {
    // play: two illegal implied opcodes ($1A, $02) then RTS
    const file = tune({
      playAddress: 0x1001,
      blocks: [{ at: 0x1000, bytes: [0x60, 0x1a, 0x02, 0x60] }],
    });
    const machine = createC64Machine(file, new RecordingSink());
    machine.initSubtune(1);

    expect(machine.illegalOpcodeCount).toBe(0);
    expect(machine.runFrame().completed).toBe(true);
    expect(machine.illegalOpcodeCount).toBe(2);
  });

  it('passes the zero-based subtune number to init in the accumulator', () => {
    // init: STA $D400 with whatever A holds, so the subtune number in A is observable
    const file = tune({
      playAddress: 0x1004,
      songs: 4,
      blocks: [
        { at: 0x1000, bytes: [0x8d, 0x00, 0xd4, 0x60] },
        { at: 0x1004, bytes: [0x60] },
      ],
    });
    const sink = new RecordingSink();
    const machine = createC64Machine(file, sink);

    machine.initSubtune(1);
    machine.initSubtune(3);

    // The PSID convention is zero-based in the accumulator even though subtunes are 1-based.
    expect(valuesFor(sink, 0)).toEqual([0, 2]);
  });
});

describe('C64Machine init budget', () => {
  // LDA #9 / STA $FB, then nine passes of a 256 x 256 countdown (about 329,000 cycles each, about 150
  // PAL frames in all), then LDA #$5A / STA $1200 / RTS: an init that returns, but not within 100 frames.
  const slowInit = [
    0xa9, 0x09, 0x85, 0xfb, 0xa0, 0x00, 0xa2, 0x00, 0xca, 0xd0, 0xfd, 0x88, 0xd0, 0xf8, 0xc6, 0xfb,
    0xd0, 0xf2, 0xa9, 0x5a, 0x8d, 0x00, 0x12, 0x60,
  ];
  // LDA $1200 / STA $D400 / RTS
  const play = [0xad, 0x00, 0x12, 0x8d, 0x00, 0xd4, 0x60];

  it('lets an init that returns after about 150 frames return, so play sees what it stored', () => {
    const file = tune({
      initAddress: 0x1000,
      playAddress: 0x1100,
      blocks: [
        { at: 0x1000, bytes: slowInit },
        { at: 0x1100, bytes: play },
      ],
    });
    const sink = new RecordingSink();
    const machine = createC64Machine(file, sink);

    // The result is the machine's own, refilled by the next call: read what init says before playing.
    const { completed, cyclesUsed } = machine.initSubtune(1);
    sink.writes.length = 0;
    const callsCompleted = Array.from({ length: 3 }, () => machine.runFrame().completed);

    expect(completed).toBe(true);
    expect(cyclesUsed).toBeGreaterThan(100 * PAL_CYCLES_PER_FRAME);
    expect(callsCompleted).toEqual([true, true, true]);
    expect(valuesFor(sink, 0)).toEqual([0x5a, 0x5a, 0x5a]);
  });
});

describe('C64Machine placing the trampoline', () => {
  const PLAY = [0xa9, 0x11, 0x8d, 0x00, 0xd4, 0x60]; // LDA #$11 / STA $D400 / RTS
  const PLAY_AT = 0x100a;

  /** LDA #0 / TAX / loop: STA `page`,X / INX / BNE loop / RTS — an init that clears one page. */
  const clearPage = (page: number): number[] => [
    0xa9,
    0x00,
    0xaa,
    0x9d,
    0x00,
    page,
    0xe8,
    0xd0,
    0xfa,
    0x60,
  ];

  interface CallsRun {
    readonly sink: RecordingSink;
    readonly machine: C64Machine;
    readonly initCompleted: boolean;
    readonly completed: boolean[];
    readonly cycles: number[];
  }

  function runCalls(file: SidFile, calls: number): CallsRun {
    const sink = new RecordingSink();
    const machine = createC64Machine(file, sink);
    const initCompleted = machine.initSubtune(1).completed;
    sink.writes.length = 0;
    const results = Array.from({ length: calls }, () => {
      const { completed, cyclesUsed } = machine.runFrame();
      return { completed, cyclesUsed };
    });
    return {
      sink,
      machine,
      initCompleted,
      completed: results.map((result) => result.completed),
      cycles: results.map((result) => result.cyclesUsed),
    };
  }

  it('keeps the trampoline clear of an init that fills the RAM under the KERNAL', () => {
    const file = tune({
      playAddress: PLAY_AT,
      blocks: [
        { at: 0x1000, bytes: clearPage(0xea) },
        { at: PLAY_AT, bytes: PLAY },
      ],
    });

    const { sink, machine, initCompleted, completed } = runCalls(file, 4);

    expect(machine.trampolineBase).toBeGreaterThanOrEqual(0x0400);
    expect(machine.trampolineBase).toBeLessThan(0xa000);
    expect(initCompleted).toBe(true);
    expect(completed).toEqual([true, true, true, true]);
    expect(sink.writes).toEqual(Array(4).fill({ register: 0, value: 0x11 }));
  });

  it('puts the trampoline on a page of the header range', () => {
    const file = tune({
      playAddress: 0x1001,
      relocStartPage: 0x50,
      relocPages: 0x10,
      blocks: [{ at: 0x1000, bytes: [0x60, ...PLAY] }],
    });

    const { machine, initCompleted, completed } = runCalls(file, 2);

    expect(machine.trampolineBase).toBe(0x5000);
    expect(initCompleted).toBe(true);
    expect(completed).toEqual([true, true]);
  });

  it('ignores a header range that overlaps the image', () => {
    const file = tune({
      loadAddress: 0x5000,
      playAddress: 0x5001,
      padTo: 0x5200,
      relocStartPage: 0x4f,
      relocPages: 0x08,
      blocks: [{ at: 0x5000, bytes: [0x60, ...PLAY] }],
    });

    expect(runCalls(file, 1).machine.trampolineBase).toBe(TRAMPOLINE_BASE);
  });

  it.each([
    ['names the zero page, the stack and the KERNAL work area', 0x02, 0x04],
    ['names the BASIC ROM', 0xa0, 0x10],
    ['runs into the I/O area', 0xc8, 0x10],
    ['runs past $FF', 0x80, 0x90],
    ['says there is no room', 0xff, 0x01],
  ])('falls back to the default page when the header range %s', (_name, startPage, pages) => {
    const file = tune({
      playAddress: 0x1001,
      relocStartPage: startPage,
      relocPages: pages,
      blocks: [{ at: 0x1000, bytes: [0x60, ...PLAY] }],
    });

    expect(runCalls(file, 1).machine.trampolineBase).toBe(TRAMPOLINE_BASE);
  });

  it('keeps an RSID on the default page whatever its header says', () => {
    const file = tune({
      format: 'RSID',
      playAddress: 0x1001,
      relocStartPage: 0x50,
      relocPages: 0x10,
      blocks: [{ at: 0x1000, bytes: [0x60, ...PLAY] }],
    });

    expect(runCalls(file, 1).machine.trampolineBase).toBe(TRAMPOLINE_BASE);
  });

  it('keeps the trampoline clear of an init that clears page 2', () => {
    const file = tune({
      loadAddress: 0xe600,
      initAddress: 0xe600,
      playAddress: 0xe60a,
      padTo: 0xec00,
      blocks: [
        { at: 0xe600, bytes: clearPage(0x02) },
        { at: 0xe60a, bytes: PLAY },
      ],
    });

    const { sink, machine, initCompleted, completed } = runCalls(file, 3);

    expect(machine.trampolineBase).toBeGreaterThanOrEqual(0x0400);
    expect(initCompleted).toBe(true);
    expect(completed).toEqual([true, true, true]);
    expect(sink.writes).toEqual(Array(3).fill({ register: 0, value: 0x11 }));
  });

  it('keeps an interrupt-entry trampoline and its continuation clear of an init that wipes the old page', () => {
    // init: $0314 = $1100, then zero $EA00-$EA3F and $EAC0-$EAFF — the old trampoline and its $EAEA
    // continuation, but not the $EA7E/$EA81 exits the handler leaves through.
    const init = [
      0xa9, 0x00, 0x8d, 0x14, 0x03, 0xa9, 0x11, 0x8d, 0x15, 0x03, 0xa9, 0x00, 0xaa, 0x9d, 0x00,
      0xea, 0x9d, 0xc0, 0xea, 0xe8, 0xe0, 0x40, 0xd0, 0xf5, 0x60,
    ];
    // LDA #$22 / STA $D400 / JMP $EA81
    const handler = [0xa9, 0x22, 0x8d, 0x00, 0xd4, 0x4c, 0x81, 0xea];
    const file = tune({
      playAddress: 0,
      blocks: [
        { at: 0x1000, bytes: init },
        { at: 0x1100, bytes: handler },
      ],
    });

    const { sink, machine, initCompleted, completed } = runCalls(file, 3);

    expect(machine.trampolineBase).toBeGreaterThanOrEqual(0x3000);
    expect(initCompleted).toBe(true);
    expect(completed).toEqual([true, true, true]);
    expect(sink.writes).toEqual(Array(3).fill({ register: 0, value: 0x22 }));
  });

  it.each([
    ['the idle address', TRAMPOLINE_IDLE_OFFSET],
    ["the play JSR's return address", TRAMPOLINE_PLAY_RETURN_OFFSET],
  ])('ends a call on an opcode fetch of %s, not on a data read of it', (_name, offset) => {
    // play: LDA <address> / LDA #$44 / STA $D400 / RTS — the first load reads the address as data.
    const playReading = (address: number): SidFile =>
      tune({
        playAddress: 0x1001,
        blocks: [
          { at: 0x1000, bytes: [0x60] },
          {
            at: 0x1001,
            bytes: [0xad, address & 0xff, address >> 8, 0xa9, 0x44, 0x8d, 0x00, 0xd4, 0x60],
          },
        ],
      });
    const probe = createC64Machine(playReading(0), new RecordingSink());
    probe.initSubtune(1);
    const address = probe.trampolineBase + offset;

    const { sink, completed } = runCalls(playReading(address), 3);

    expect(completed).toEqual([true, true, true]);
    expect(sink.writes).toEqual(Array(3).fill({ register: 0, value: 0x44 }));
  });

  it('counts a play routine that returns with RTI through the trampoline JSR frame as returned', () => {
    // play: LDA #$66 / STA $D400 / JSR sub. sub: PLA / RTI — the PLA drops one byte of play's own JSR
    // frame, so the RTI pulls a status byte and then the trampoline JSR's return address as its PC.
    const file = tune({
      playAddress: 0x1001,
      blocks: [
        { at: 0x1000, bytes: [0x60] },
        { at: 0x1001, bytes: [0xa9, 0x66, 0x8d, 0x00, 0xd4, 0x20, 0x09, 0x10, 0x68, 0x40] },
      ],
    });

    const { sink, initCompleted, completed, cycles } = runCalls(file, 4);

    expect(initCompleted).toBe(true);
    expect(completed).toEqual([true, true, true, true]);
    expect(sink.writes).toEqual(Array(4).fill({ register: 0, value: 0x66 }));
    // Without the sentinel the RTI lands in a walk through empty RAM that takes thousands of cycles
    // to wander back onto the idle address, if it does.
    expect(Math.max(...cycles)).toBeLessThan(100);
  });
});

describe('C64Machine entering a handler as an interrupt', () => {
  const HANDLER = 0x1100;
  const KERNAL_VECTOR = 0x0314;
  const HARDWARE_VECTOR = 0xfffe;

  /** Init stores `HANDLER` in `vector`; the handler is `handler`. */
  function interruptTune(
    vector: number,
    handler: readonly number[],
    options: Partial<TuneOptions> = {},
  ): SidFile {
    return tune({
      ...options,
      blocks: [
        {
          at: 0x1000,
          bytes: [
            0xa9,
            HANDLER & 0xff,
            0x8d,
            vector & 0xff,
            vector >> 8,
            0xa9,
            HANDLER >> 8,
            0x8d,
            (vector + 1) & 0xff,
            (vector + 1) >> 8,
            0x60,
          ],
        },
        { at: HANDLER, bytes: handler },
      ],
    });
  }

  /** A handler entered by a plain `JSR`, as a header play address gives. */
  function jsrTune(handler: readonly number[]): SidFile {
    return tune({
      playAddress: HANDLER,
      blocks: [
        { at: 0x1000, bytes: [0x60] },
        { at: HANDLER, bytes: handler },
      ],
    });
  }

  function stackPointer(machine: ReturnType<typeof createC64Machine>): unknown {
    return machine.snapshot().cpu['stkp'];
  }

  function playOnce(file: SidFile): {
    sink: RecordingSink;
    machine: ReturnType<typeof createC64Machine>;
    result: ReturnType<ReturnType<typeof createC64Machine>['runFrame']>;
  } {
    const sink = new RecordingSink();
    const machine = createC64Machine(file, sink);
    machine.initSubtune(1);
    sink.writes.length = 0;
    return { sink, machine, result: machine.runFrame() };
  }

  // LDA #$5A / STA $D400 / JMP exit
  const writeThenJump = (exit: number): number[] => [
    0xa9,
    0x5a,
    0x8d,
    0x00,
    0xd4,
    0x4c,
    exit & 0xff,
    exit >> 8,
  ];

  it.each([
    ['$EA31', 0xea31],
    ['$EA7E', 0xea7e],
    ['$EA81', 0xea81],
  ])(
    'completes a 0x0314 handler that ends in JMP %s with the stack back where it started',
    (_name, exit) => {
      const { sink, machine, result } = playOnce(interruptTune(KERNAL_VECTOR, writeThenJump(exit)));

      expect(result.completed).toBe(true);
      expect(result.cyclesUsed).toBeLessThan(200);
      expect(sink.writes).toEqual([{ register: 0, value: 0x5a }]);
      expect(stackPointer(machine)).toBe(0xff);
    },
  );

  it('completes a $FFFE handler that restores its own register and returns with RTI', () => {
    // PHA / LDA #$7F / STA $D400 / PLA / RTI
    const handler = [0x48, 0xa9, 0x7f, 0x8d, 0x00, 0xd4, 0x68, 0x40];

    const { sink, machine, result } = playOnce(interruptTune(HARDWARE_VECTOR, handler));

    expect(result.completed).toBe(true);
    expect(sink.writes).toEqual([{ register: 0, value: 0x7f }]);
    expect(stackPointer(machine)).toBe(0xff);
  });

  it.each([
    ['$0314', KERNAL_VECTOR],
    ['$FFFE', HARDWARE_VECTOR],
  ])('completes a %s handler that ends in RTS', (_name, vector) => {
    // LDA #$33 / STA $D400 / RTS
    const { sink, result } = playOnce(interruptTune(vector, [0xa9, 0x33, 0x8d, 0x00, 0xd4, 0x60]));

    expect(result.completed).toBe(true);
    expect(sink.writes).toEqual([{ register: 0, value: 0x33 }]);
  });

  describe('as seen by the handler on entry', () => {
    // STA $D400 / STX $D401 / STY $D402 / PHP / PLA / STA $D404 / LDY #$FF / DEY / BNE -3 /
    // LDA $D012 / STA $D403 / RTS — A, X, Y and the flags, then a delay, then the raster line
    const probe = [
      0x8d, 0x00, 0xd4, 0x8e, 0x01, 0xd4, 0x8c, 0x02, 0xd4, 0x08, 0x68, 0x8d, 0x04, 0xd4, 0xa0,
      0xff, 0x88, 0xd0, 0xfd, 0xad, 0x12, 0xd0, 0x8d, 0x03, 0xd4, 0x60,
    ];

    it.each([
      ['$0314', KERNAL_VECTOR],
      ['$FFFE', HARDWARE_VECTOR],
    ])('sees what a JSR entry shows it, on the %s path, in the same cycles', (_name, vector) => {
      const today = playOnce(jsrTune(probe));
      const entered = playOnce(interruptTune(vector, probe));

      expect(today.sink.writes.length).toBe(5);
      expect(entered.sink.writes).toEqual(today.sink.writes);
      expect(entered.result).toEqual(today.result);
    });

    it('sees the same budget: a handler that never returns runs out at exactly the same cycle', () => {
      const spin = [0x4c, 0x00, 0x11];

      const today = playOnce(jsrTune(spin));
      const entered = playOnce(interruptTune(KERNAL_VECTOR, spin));

      expect(entered.result.completed).toBe(false);
      expect(entered.result).toEqual(today.result);
    });

    it('leaves the stack as deep as the frame it pushed', () => {
      // TSX / STX $D400 / RTS
      const handler = [0xba, 0x8e, 0x00, 0xd4, 0x60];

      expect(playOnce(jsrTune(handler)).sink.writes).toEqual([{ register: 0, value: 0xfd }]);
      expect(playOnce(interruptTune(KERNAL_VECTOR, handler)).sink.writes).toEqual([
        { register: 0, value: 0xf9 },
      ]);
      expect(playOnce(interruptTune(HARDWARE_VECTOR, handler)).sink.writes).toEqual([
        { register: 0, value: 0xfc },
      ]);
    });
  });

  it('keeps an RSID tune on the JSR entry and the single RTI stub', () => {
    // TSX / STX $D400 / RTS
    const handler = [0xba, 0x8e, 0x00, 0xd4, 0x60];

    const { sink, machine, result } = playOnce(
      interruptTune(KERNAL_VECTOR, handler, { format: 'RSID' }),
    );

    expect(result.completed).toBe(true);
    expect(sink.writes).toEqual([{ register: 0, value: 0xfd }]);
    expect(machine.snapshot().memory[0xea31]).toBe(0x40);
  });

  it('lets a CIA-driven handler read $DC0D as 0x81 on its way out', () => {
    // LDA $DC0D / STA $D400 / JMP $EA31
    const { sink } = playOnce(
      interruptTune(KERNAL_VECTOR, [0xad, 0x0d, 0xdc, 0x8d, 0x00, 0xd4, 0x4c, 0x31, 0xea], {
        speedFlags: 1,
      }),
    );

    expect(sink.writes).toEqual([{ register: 0, value: 0x81 }]);
  });

  it.each([
    ['an interrupt entry', (handler: number[]) => interruptTune(KERNAL_VECTOR, handler)],
    ['a JSR entry', (handler: number[]) => jsrTune(handler)],
  ])('resumes after a BRK inside a play routine, on %s', (_name, build) => {
    // LDA #1 / STA $D400 / BRK / padding / LDA #2 / STA $D400 / RTS
    const handler = [0xa9, 0x01, 0x8d, 0x00, 0xd4, 0x00, 0xea, 0xa9, 0x02, 0x8d, 0x00, 0xd4, 0x60];

    const { sink, result } = playOnce(build(handler));

    expect(result.completed).toBe(true);
    expect(sink.writes.map((write) => write.value)).toEqual([1, 2]);
  });

  it('keeps the bytes of a tune loaded over $EA7E', () => {
    // init at $EA40 vectors to $EA50; the handler jumps to the tune's own $EA7E, which writes $44
    // and carries on to its own copy of the register restore at $EA90.
    const file = tune({
      loadAddress: 0xea40,
      initAddress: 0xea40,
      blocks: [
        {
          at: 0xea40,
          bytes: [0xa9, 0x50, 0x8d, 0x14, 0x03, 0xa9, 0xea, 0x8d, 0x15, 0x03, 0x60],
        },
        { at: 0xea50, bytes: [0x4c, 0x7e, 0xea] },
        { at: 0xea7e, bytes: [0xa9, 0x44, 0x8d, 0x00, 0xd4, 0x4c, 0x90, 0xea] },
        { at: 0xea90, bytes: [0x68, 0xa8, 0x68, 0xaa, 0x68, 0x40] },
      ],
    });

    const { sink, result } = playOnce(file);

    expect(result.completed).toBe(true);
    expect(sink.writes).toEqual([{ register: 0, value: 0x44 }]);
  });

  it('moves the trampoline off a page whose continuation the tune covers', () => {
    // The tune spans $EA40-$EAFF: clear of the trampoline at $EA00, but over its $EAEA continuation.
    const file = tune({
      loadAddress: 0xea40,
      initAddress: 0xea40,
      padTo: 0xeb00,
      blocks: [
        {
          at: 0xea40,
          bytes: [0xa9, 0x50, 0x8d, 0x14, 0x03, 0xa9, 0xea, 0x8d, 0x15, 0x03, 0x60],
        },
        // LDA #$66 / STA $D400 / PLA / TAY / PLA / TAX / PLA / RTI - the tune covers the KERNAL exits
        {
          at: 0xea50,
          bytes: [0xa9, 0x66, 0x8d, 0x00, 0xd4, 0x68, 0xa8, 0x68, 0xaa, 0x68, 0x40],
        },
      ],
    });

    const { sink, machine, result } = playOnce(file);

    expect(machine.trampolineBase).not.toBe(TRAMPOLINE_BASE);
    expect(result.completed).toBe(true);
    expect(sink.writes).toEqual([{ register: 0, value: 0x66 }]);
  });

  it('round-trips a snapshot taken between calls', () => {
    // INC $1200 / LDA $1200 / STA $D400 / JMP $EA31
    const file = interruptTune(
      KERNAL_VECTOR,
      [0xee, 0x00, 0x12, 0xad, 0x00, 0x12, 0x8d, 0x00, 0xd4, 0x4c, 0x31, 0xea],
    );
    const sink = new RecordingSink();
    const machine = createC64Machine(file, sink);
    machine.initSubtune(1);
    machine.runFrame();
    machine.runFrame();

    const snapshot = machine.snapshot();
    const fromSnapshot = sink.writes.length;
    machine.runFrame();
    machine.runFrame();
    const expected = sink.writes.slice(fromSnapshot);

    machine.restore(snapshot);
    const fromRestore = sink.writes.length;
    const results = [machine.runFrame(), machine.runFrame()];

    expect(results.every((result) => result.completed)).toBe(true);
    expect(sink.writes.slice(fromRestore)).toEqual(expected);
    expect(expected.map((write) => write.value)).toEqual([3, 4]);
  });
});

describe('C64Machine play rate', () => {
  const ROUTINE = 0x1100;
  const RTS = 0x60;
  const CIA_INTERRUPT_CONTROL = 0xdc0d;
  const VIC_INTERRUPT_ENABLE = 0xd01a;

  /** LDA #low / STA $DC04 / LDA #high / STA $DC05 */
  const writeLatch = (latch: number): number[] => [
    0xa9,
    latch & 0xff,
    0x8d,
    0x04,
    0xdc,
    0xa9,
    latch >> 8,
    0x8d,
    0x05,
    0xdc,
  ];
  /** LDA #value / STA address */
  const store = (value: number, address: number): number[] => [
    0xa9,
    value,
    0x8d,
    address & 0xff,
    address >> 8,
  ];

  /** A tune with a header play address: init runs `init` and the play routine runs `play`. */
  function playTune(
    init: readonly number[],
    play: readonly number[],
    options: Partial<TuneOptions> = {},
  ): SidFile {
    return tune({
      ...options,
      playAddress: ROUTINE,
      blocks: [
        { at: 0x1000, bytes: [...init, RTS] },
        { at: ROUTINE, bytes: [...play, RTS] },
      ],
    });
  }

  /** A PSID with play address 0: init runs `init`, then installs a `$0314` handler that runs `play`. */
  function handlerTune(
    init: readonly number[],
    play: readonly number[],
    options: Partial<TuneOptions> = {},
  ): SidFile {
    return tune({
      ...options,
      playAddress: 0,
      blocks: [
        {
          at: 0x1000,
          bytes: [...init, ...store(ROUTINE & 0xff, 0x0314), ...store(ROUTINE >> 8, 0x0315), RTS],
        },
        { at: ROUTINE, bytes: [...play, RTS] },
      ],
    });
  }

  function initialised(file: SidFile, song = 1): ReturnType<typeof createC64Machine> {
    const machine = createC64Machine(file, new RecordingSink());
    machine.initSubtune(song);
    return machine;
  }

  describe('a tune with a play address', () => {
    it('plays once per frame when the speed bit says vertical blank, whatever the latch says', () => {
      const machine = initialised(playTune(writeLatch(0x2663), [], { speedFlags: 0 }));

      expect(machine.cyclesPerPlayCall).toBeNull();
      expect(machine.exactCallsPerFrame).toBe(1);
      expect(machine.callsPerFrame).toBe(1);
    });

    it('plays at the latch it wrote when the speed bit says CIA, and at the PSID default when it wrote none', () => {
      const written = initialised(playTune(writeLatch(0x2663), [], { speedFlags: 1 }));
      const defaulted = initialised(playTune([], [], { speedFlags: 1 }));

      expect(written.cyclesPerPlayCall).toBe(0x2663 + 1);
      expect(written.exactCallsPerFrame).toBeCloseTo(2, 5);
      expect(defaulted.cyclesPerPlayCall).toBe(0x4025 + 1);
      expect(defaulted.exactCallsPerFrame).toBeCloseTo(1.197, 3);
      expect(defaulted.callsPerFrame).toBe(1);
    });

    it("takes the default latch from the tune's own clock", () => {
      const machine = initialised(playTune([], [], { speedFlags: 1, clock: 'ntsc' }));

      expect(machine.cyclesPerPlayCall).toBe(0x4295 + 1);
      expect(machine.exactCallsPerFrame).toBeCloseTo(NTSC_CYCLES_PER_FRAME / (0x4295 + 1), 10);
    });

    it('follows a timer slower than a frame below one call per frame, while the rounded rate stays at one', () => {
      // $7FFF + 1 = 32768 cycles, a little over one and a half frames
      const machine = initialised(playTune(writeLatch(0x7fff), [], { speedFlags: 1 }));

      expect(machine.exactCallsPerFrame).toBeCloseTo(PAL_CYCLES_PER_FRAME / 0x8000, 10);
      expect(machine.exactCallsPerFrame).toBeLessThan(1);
      expect(machine.callsPerFrame).toBe(1);
    });

    it('caps a timer faster than sixteen calls a frame at sixteen, exact and rounded alike', () => {
      const machine = initialised(playTune(writeLatch(0x0010), [], { speedFlags: 1 }));

      expect(machine.exactCallsPerFrame).toBe(16);
      expect(machine.callsPerFrame).toBe(16);
    });

    it('moves to a latch written mid-song from the next call on', () => {
      const machine = initialised(playTune([], writeLatch(0x2663), { speedFlags: 1 }));
      const before = machine.exactCallsPerFrame;

      machine.runFrame();

      expect(before).toBeCloseTo(1.197, 3);
      expect(machine.exactCallsPerFrame).toBeCloseTo(2, 5);
      expect(machine.callsPerFrame).toBe(2);
    });

    it('stays on its timer however the tune masks the CIA interrupt', () => {
      const machine = initialised(
        playTune([...writeLatch(0x2663), ...store(0x7f, CIA_INTERRUPT_CONTROL)], [], {
          speedFlags: 1,
        }),
      );

      expect(machine.exactCallsPerFrame).toBeCloseTo(2, 5);
    });
  });

  describe('which bit of the speed word a song reads', () => {
    const isCiaTimed = (file: SidFile, song: number): boolean =>
      initialised(file, song).cyclesPerPlayCall !== null;
    const manySongs = (options: Partial<TuneOptions>): SidFile =>
      playTune([], [], { songs: 40, ...options });
    // Songs 2 and 32 are CIA-timed.
    const bits = 0x80000002;

    it('gives every song past the 32nd the last bit when a later header version is not PlaySID specific', () => {
      const file = manySongs({ speedFlags: bits });

      expect([1, 2, 32, 33, 40].map((song) => isCiaTimed(file, song))).toEqual([
        false,
        true,
        true,
        true,
        true,
      ]);
    });

    it.each([
      ['version 1', { version: 1 }],
      ['flagged PlaySID specific', { psidSpecific: true }],
    ])('repeats the 32 bits across songs for a header that is %s', (_name, options) => {
      const file = manySongs({ speedFlags: bits, ...options });

      expect([32, 33, 34, 40].map((song) => isCiaTimed(file, song))).toEqual([
        true,
        false,
        true,
        false,
      ]);
    });

    it('reads the bit again on every subtune init', () => {
      const machine = initialised(playTune([], [], { songs: 2, speedFlags: 0b10 }));
      expect(machine.cyclesPerPlayCall).toBeNull();

      machine.initSubtune(2);

      expect(machine.cyclesPerPlayCall).not.toBeNull();
    });
  });

  describe('a tune with play address 0', () => {
    it('starts from the interrupt the speed bit names: timer A for CIA, the raster for vertical blank', () => {
      const cia = initialised(handlerTune([], [], { speedFlags: 1 }));
      const vbi = initialised(handlerTune([], [], { speedFlags: 0 }));

      expect(cia.exactCallsPerFrame).toBeCloseTo(1.197, 3);
      expect(vbi.exactCallsPerFrame).toBe(1);
      expect(vbi.cyclesPerPlayCall).toBeNull();
    });

    it('follows timer A once the tune enables it, whatever the speed bit says', () => {
      const machine = initialised(
        handlerTune(
          [
            ...writeLatch(0x2663),
            ...store(0x81, CIA_INTERRUPT_CONTROL),
            ...store(0, VIC_INTERRUPT_ENABLE),
          ],
          [],
          { speedFlags: 0 },
        ),
      );

      expect(machine.exactCallsPerFrame).toBeCloseTo(2, 5);
    });

    it('plays once per frame when the tune masks timer A, though it programmed the latch and the speed bit says CIA', () => {
      const machine = initialised(
        handlerTune(
          [
            ...writeLatch(0x2663),
            ...store(0x7f, CIA_INTERRUPT_CONTROL),
            ...store(1, VIC_INTERRUPT_ENABLE),
          ],
          [],
          { speedFlags: 1 },
        ),
      );

      expect(machine.cyclesPerPlayCall).toBeNull();
      expect(machine.exactCallsPerFrame).toBe(1);
      expect(machine.callsPerFrame).toBe(1);
    });

    it('changes only the mask bits a $DC0D write names', () => {
      // $82 sets bit 1 and $7E clears bits 1-6: neither names timer A, which stays enabled.
      const machine = initialised(
        handlerTune(
          [...store(0x82, CIA_INTERRUPT_CONTROL), ...store(0x7e, CIA_INTERRUPT_CONTROL)],
          [],
          {
            speedFlags: 1,
          },
        ),
      );

      expect(machine.exactCallsPerFrame).toBeCloseTo(1.197, 3);
    });

    it('follows timer A being masked and enabled again from the handler, call by call', () => {
      // play: INC $1200 / LDA $1200 / AND #1 / BEQ even / LDA #$7F / BNE store / even: LDA #$81 / store: STA $DC0D
      // — an odd call count masks timer A, an even one enables it.
      const toggling = [
        ...[0xee, 0x00, 0x12, 0xad, 0x00, 0x12, 0x29, 0x01, 0xf0, 0x04],
        ...[0xa9, 0x7f, 0xd0, 0x02, 0xa9, 0x81, 0x8d, 0x0d, 0xdc],
      ];
      const machine = initialised(handlerTune(writeLatch(0x2663), toggling, { speedFlags: 1 }));
      const rates = [machine.exactCallsPerFrame];

      machine.runFrame();
      rates.push(machine.exactCallsPerFrame);
      machine.runFrame();
      rates.push(machine.exactCallsPerFrame);

      expect(rates[0]).toBeCloseTo(2, 5);
      expect(rates[1]).toBe(1);
      expect(rates[2]).toBeCloseTo(2, 5);
    });
  });

  describe('the snapshot', () => {
    // Two calls a frame after init; the play routine then moves the rate off it.
    const slowing = (): SidFile =>
      playTune(writeLatch(0x2663), writeLatch(0x7fff), { speedFlags: 1 });
    const masking = (): SidFile =>
      handlerTune(writeLatch(0x2663), store(0x7f, CIA_INTERRUPT_CONTROL), { speedFlags: 1 });

    it.each([
      ['a play address', slowing],
      ['no play address', masking],
    ])('puts the rate back with the image it was taken at, for a tune with %s', (_name, build) => {
      const machine = initialised(build());
      const atInit = machine.exactCallsPerFrame;
      const snapshot = machine.snapshot();
      machine.runFrame();
      const afterCall = machine.exactCallsPerFrame;

      machine.restore(snapshot);

      expect(afterCall).toBeLessThan(atInit);
      expect(machine.exactCallsPerFrame).toBe(atInit);
      machine.runFrame();
      expect(machine.exactCallsPerFrame).toBe(afterCall);
    });

    it('carries the rate to a machine that did not take it, across a structured clone', () => {
      const source = initialised(slowing());
      const atInit = source.exactCallsPerFrame;
      const image = structuredClone(source.snapshot());
      const other = initialised(slowing());
      other.runFrame();
      expect(other.exactCallsPerFrame).toBeLessThan(atInit);

      other.restore(image);

      expect(other.exactCallsPerFrame).toBe(atInit);
    });

    it('carries the rate through snapshotInto and copyMachineImage as through snapshot', () => {
      const machine = initialised(masking());
      const image = createMachineImage();
      const copy = createMachineImage();
      machine.snapshotInto(image);
      copyMachineImage(image, copy);
      machine.runFrame();
      expect(machine.exactCallsPerFrame).toBe(1);

      machine.restore(image);
      const fromImage = machine.exactCallsPerFrame;
      machine.runFrame();
      machine.restore(copy);

      expect(fromImage).toBeCloseTo(2, 5);
      expect(machine.exactCallsPerFrame).toBeCloseTo(2, 5);
    });
  });
});

describe('C64Machine VIC and CIA', () => {
  const PLAY = 0x1100;
  const RTS = 0x60;

  /** LDA address */
  const load = (address: number): number[] => [0xad, address & 0xff, address >> 8];
  /** STA address */
  const save = (address: number): number[] => [0x8d, address & 0xff, address >> 8];
  /** LDA #value / STA address */
  const store = (value: number, address: number): number[] => [0xa9, value, ...save(address)];
  /** Reads `address` and hands it to the sink as SID register `register`, so a spec sees what the tune saw. */
  const report = (address: number, register: number): number[] => [
    ...load(address),
    ...save(0xd400 + register),
  ];
  /** LDX #$63 / DEX / BNE -3 / 8 x NOP: exactly 512 cycles. */
  const delay512 = [0xa2, 0x63, 0xca, 0xd0, 0xfd, ...Array<number>(8).fill(0xea)];

  /** A tune with a header play address: init runs `init`, the play routine runs `play`. */
  function chipTune(
    init: readonly number[],
    play: readonly number[],
    options: Partial<TuneOptions> = {},
  ): SidFile {
    return tune({
      ...options,
      playAddress: PLAY,
      blocks: [
        { at: 0x1000, bytes: [...init, RTS] },
        { at: PLAY, bytes: [...play, RTS] },
      ],
    });
  }

  function run(
    file: SidFile,
    frames: number,
  ): { sink: RecordingSink; machine: C64Machine; results: ReturnType<C64Machine['runFrame']>[] } {
    const sink = new RecordingSink();
    const machine = createC64Machine(file, sink);
    machine.initSubtune(1);
    const results = Array.from({ length: frames }, () => machine.runFrame());
    return { sink, machine, results };
  }

  function runFrames(machine: C64Machine, frames: number): void {
    for (let call = 0; call < frames; call++) {
      machine.runFrame();
    }
  }

  describe('the raster flag', () => {
    // LDA $D019 / AND #1 / BEQ skip / STA $D019 / LDA #$5A / STA $D400 / skip: LDA $D019 / STA $D401
    const acknowledging = [
      ...load(0xd019),
      0x29,
      0x01,
      0xf0,
      0x08,
      ...save(0xd019),
      0xa9,
      0x5a,
      ...save(0xd400),
      ...report(0xd019, 1),
    ];

    it('is set for a raster-driven call, so a play routine that tests it writes the SID, and acknowledging clears it', () => {
      const { sink, results } = run(chipTune([], acknowledging, { speedFlags: 0 }), 3);

      expect(results.every((result) => result.completed)).toBe(true);
      expect(valuesFor(sink, 0)).toEqual([0x5a, 0x5a, 0x5a]);
      expect(valuesFor(sink, 1)).toEqual([0x70, 0x70, 0x70]);
    });

    it('is left clear by a CIA-driven call, so the same routine writes nothing', () => {
      const { sink } = run(chipTune([], acknowledging, { speedFlags: 1 }), 3);

      expect(valuesFor(sink, 0)).toEqual([]);
      expect(valuesFor(sink, 1)).toEqual([0x70, 0x70, 0x70]);
    });

    it('reads with bit 7 while the raster interrupt is enabled, and without it once the tune disables it', () => {
      const { sink } = run(
        chipTune([], [...report(0xd019, 0), ...store(0x00, 0xd01a), ...report(0xd019, 1)]),
        1,
      );

      expect(valuesFor(sink, 0)).toEqual([0xf1]);
      expect(valuesFor(sink, 1)).toEqual([0x71]);
    });
  });

  describe('the timers', () => {
    it('shows a timer read twice within a call counting down by the cycles between the reads', () => {
      const { sink } = run(
        chipTune(store(0x01, 0xdd0e), [...report(0xdd04, 0), ...report(0xdd04, 1)]),
        3,
      );

      const first = valuesFor(sink, 0);
      const second = valuesFor(sink, 1);
      expect(first).toHaveLength(3);
      // LDA and STA are four cycles each, so the second read comes eight cycles after the first.
      expect(first.map((value, call) => (value - second[call] + 256) % 256)).toEqual([8, 8, 8]);
    });

    it.each([
      ['PAL', 'pal' as const, PAL_CYCLES_PER_FRAME],
      ['NTSC', 'ntsc' as const, NTSC_CYCLES_PER_FRAME],
    ])(
      'moves a timer a raster-driven tune reads at the same point in two calls on by one %s frame, wrapped at its latch',
      (_name, clock, cyclesPerFrame) => {
        // CIA 1 timer A latched at $00C7 — a period of 200 — loaded and running
        const init = [...store(0xc7, 0xdc04), ...store(0x00, 0xdc05), ...store(0x11, 0xdc0e)];
        const { sink } = run(chipTune(init, report(0xdc04, 0), { speedFlags: 0, clock }), 4);

        const seen = valuesFor(sink, 0);
        expect(seen).toHaveLength(4);
        for (let call = 1; call < seen.length; call++) {
          expect((seen[call - 1] - seen[call] + 200) % 200).toBe(cyclesPerFrame % 200);
        }
      },
    );

    it('starts the next call when a call that ran past its period ends, not at the period', () => {
      // The first call reads the clock, then spins for about 25,700 cycles; the next two just read it.
      // CIA 2 timer A counts down from $FFFF, so its high byte is the cycle count in units of 256.
      const spinOnFirstCall = [
        ...report(0xdd05, 0),
        ...[0xee, 0x00, 0x12, 0xad, 0x00, 0x12, 0xc9, 0x01, 0xd0, 0x0a],
        ...[0xa0, 0x14, 0xa2, 0x00, 0xca, 0xd0, 0xfd, 0x88, 0xd0, 0xf8],
      ];
      const sink = new RecordingSink();
      const machine = createC64Machine(chipTune(store(0x01, 0xdd0e), spinOnFirstCall), sink);
      machine.initSubtune(1);

      // Copied: the machine refills one result on every call.
      const [first, second, third] = [0, 1, 2].map(() => ({ ...machine.runFrame() }));
      const [atFirst, atSecond, atThird] = valuesFor(sink, 0);

      expect(first.cyclesUsed).toBeGreaterThan(PAL_CYCLES_PER_FRAME);
      expect(second.cyclesUsed).toBeLessThan(100);
      expect(third.completed).toBe(true);
      expect(Math.abs((atFirst - atSecond) * 256 - first.cyclesUsed)).toBeLessThanOrEqual(256);
      expect(Math.abs((atSecond - atThird) * 256 - PAL_CYCLES_PER_FRAME)).toBeLessThanOrEqual(256);
    });

    it('drops timer B by one every 52 cycles with timer A latched at $0033 and timer B counting its underflows', () => {
      // What Crosshatch does: $55 to timer B's control, timer A's latch rewritten each call.
      const init = [
        ...store(0x33, 0xdc04),
        ...store(0x00, 0xdc05),
        ...store(0x11, 0xdc0e),
        ...store(0x55, 0xdc0f),
      ];
      const play = [
        ...store(0x33, 0xdc04),
        ...store(0x00, 0xdc05),
        ...report(0xdc06, 0),
        ...delay512,
        ...report(0xdc06, 1),
      ];
      const { sink } = run(chipTune(init, play), 3);

      // From one read to the next: the STA's four cycles, the delay's 512 and the LDA's own four.
      const after = valuesFor(sink, 1);
      const drops = valuesFor(sink, 0).map((before, call) => (before - after[call] + 256) % 256);
      expect(drops).toEqual([10, 10, 10]);
    });

    it.each([
      ['a flag the tune has not enabled', [], 0x01],
      ['a flag the tune has enabled', store(0x81, 0xdd0d), 0x81],
    ])(
      'sets the flag on an underflow, and a read of $DD0D returns it and clears it: %s',
      (_name, enable, flagged) => {
        // CIA 2 timer A, latched at $0010, one-shot: it underflows once, long before the play routine reads it.
        const init = [
          ...store(0x10, 0xdd04),
          ...store(0x00, 0xdd05),
          ...enable,
          ...store(0x09, 0xdd0e),
        ];
        const { sink } = run(
          chipTune(init, [...delay512, ...report(0xdd0d, 0), ...report(0xdd0d, 1)]),
          1,
        );

        expect(valuesFor(sink, 0)).toEqual([flagged]);
        expect(valuesFor(sink, 1)).toEqual([0x00]);
      },
    );

    it('has a CIA-driven handler read $DC0D as 0x81 once, as its call begins on a timer A underflow', () => {
      const { sink } = run(
        chipTune([], [...report(0xdc0d, 0), ...report(0xdc0d, 1)], { speedFlags: 1 }),
        3,
      );

      expect(valuesFor(sink, 0)).toEqual([0x81, 0x81, 0x81]);
      expect(valuesFor(sink, 1)).toEqual([0x00, 0x00, 0x00]);
    });

    it('shows a raster-driven handler the underflow flag only once timer A has run out', () => {
      const { sink } = run(chipTune([], report(0xdc0d, 0), { speedFlags: 0 }), 2);

      // Timer A's period is $4025 + 1 cycles: not yet over in the first call, just after init, but over
      // by the second, a frame later.
      expect(valuesFor(sink, 0)).toEqual([0x00, 0x01]);
    });

    it('answers a read once however the bus is wrapped, so a diagnostic and the CPU see the same read', () => {
      const sink = new RecordingSink();
      const machine = createC64Machine(
        chipTune([], [...report(0xdc0d, 0), ...report(0xdc0d, 1)], { speedFlags: 1 }),
        sink,
      );
      const original = (Object.getPrototypeOf(machine) as { read(address: number): number }).read;
      const seen: number[] = [];
      (machine as unknown as { read(address: number): number }).read = (address) => {
        const value = original.call(machine, address);
        if (address === 0xdc0d) {
          seen.push(value);
        }
        return value;
      };
      machine.initSubtune(1);

      machine.runFrame();

      expect(seen).toEqual([0x81, 0x00]);
      expect(valuesFor(sink, 0)).toEqual([0x81]);
    });
  });

  describe('the default environment', () => {
    it.each([
      ['speed bit 0, PAL', 0, 'pal' as const, 0xf1, 0x40],
      ['speed bit 1, PAL', 1, 'pal' as const, 0xf0, 0x40],
      ['speed bit 0, NTSC', 0, 'ntsc' as const, 0xf1, 0x42],
      ['speed bit 1, NTSC', 1, 'ntsc' as const, 0xf0, 0x42],
    ])('holds for %s', (_name, speedFlags, clock, vicEnables, timerAHigh) => {
      const init = [
        ...report(0xd01a, 0),
        ...report(0xdc0e, 1),
        ...report(0xdc05, 2),
        ...report(0xdc0f, 3),
        ...report(0xdc07, 4),
        ...report(0xdd0e, 5),
        ...report(0xdd0f, 6),
        ...report(0xdd05, 7),
        ...report(0xdd07, 8),
      ];
      const { sink } = run(chipTune(init, [], { speedFlags, clock }), 0);

      const seen = Array.from({ length: 9 }, (_unused, register) => valuesFor(sink, register)[0]);
      expect(seen).toEqual([vicEnables, 0x01, timerAHigh, 0x00, 0xff, 0x00, 0x00, 0xff, 0xff]);
    });
  });

  describe('the play rate', () => {
    it.each([
      ['PAL', 'pal' as const, 0x4025],
      ['NTSC', 'ntsc' as const, 0x4295],
    ])(
      "keeps the default's byte for a latch half the tune never wrote, so a tune writing one half plays at that half over the default's, on %s",
      (_name, clock, defaultLatch) => {
        const highOnly = chipTune(store(0x20, 0xdc05), [], { speedFlags: 1, clock });
        const lowOnly = chipTune(store(0x20, 0xdc04), [], { speedFlags: 1, clock });

        expect(run(highOnly, 0).machine.cyclesPerPlayCall).toBe(0x2000 + (defaultLatch & 0xff) + 1);
        expect(run(lowOnly, 0).machine.cyclesPerPlayCall).toBe((defaultLatch & 0xff00) + 0x20 + 1);
      },
    );

    it('plays a tune that writes $00 to the low half only at the default high byte, not sixteen calls a frame', () => {
      const lowZero = chipTune(store(0x00, 0xdc04), [], { speedFlags: 1 });

      const machine = run(lowZero, 0).machine;

      expect(machine.cyclesPerPlayCall).toBe(0x4000 + 1);
      expect(machine.callsPerFrame).toBe(1);
    });

    it('spaces CIA-driven calls the latch plus one cycles apart', () => {
      // CIA 1 timer A latched at $0FFF: a call every 4096 cycles. CIA 2 timer A counts down from
      // $FFFF, so its high byte falls by 16 across 4096 cycles whatever the call reads it at.
      const init = [...store(0xff, 0xdc04), ...store(0x0f, 0xdc05), ...store(0x01, 0xdd0e)];
      const { sink } = run(chipTune(init, report(0xdd05, 0), { speedFlags: 1 }), 4);

      const seen = valuesFor(sink, 0);
      expect(seen.slice(1).map((value, call) => seen[call] - value)).toEqual([16, 16, 16]);
    });
  });

  describe('an RSID', () => {
    it('keeps plain memory for the chip registers and a constant $DC0D that never clears', () => {
      const init = store(0x2a, 0xdc06);
      const play = [
        ...report(0xdc06, 0),
        ...report(0xdc0d, 1),
        ...report(0xdc0d, 2),
        ...report(0xd019, 3),
      ];
      const { sink } = run(chipTune(init, play, { format: 'RSID' }), 1);

      expect(valuesFor(sink, 0)).toEqual([0x2a]);
      expect(valuesFor(sink, 1)).toEqual([0x81]);
      expect(valuesFor(sink, 2)).toEqual([0x81]);
      expect(valuesFor(sink, 3)).toEqual([0x00]);
    });

    it('is CIA-timed once it has written the latch, and plays once a frame until then', () => {
      const writesLatch = chipTune([...store(0x63, 0xdc04), ...store(0x26, 0xdc05)], [], {
        format: 'RSID',
      });
      const writesNone = chipTune([], [], { format: 'RSID' });

      expect(run(writesLatch, 0).machine.cyclesPerPlayCall).toBe(0x2663 + 1);
      expect(run(writesNone, 0).machine.cyclesPerPlayCall).toBeNull();
    });

    it("keeps the default's byte for a latch half it never wrote, as a PSID does", () => {
      const highOnly = chipTune(store(0x20, 0xdc05), [], { format: 'RSID' });

      expect(run(highOnly, 0).machine.cyclesPerPlayCall).toBe(0x2025 + 1);
    });
  });

  describe('the 6510 port', () => {
    const ramUnderIo = (address: number): number => MEMORY_SIZE + address - IO_START;
    /** LDA #bank / STA $01 */
    const bankTo = (bank: number): number[] => store(bank, PORT_DATA);

    it('reads the RAM under the chips while they are banked out, and the live timer while they are in', () => {
      // A payload byte at $DC04 is what the RAM under CIA 1 holds. Bank / LDA $DC04 / STA $1200, then
      // bank the chips back in so the sink sees what was read.
      const seen = (bank: number): number[] => {
        const read = [...bankTo(bank), ...load(0xdc04), ...save(0x1200), ...bankTo(0x37)];
        const file = tune({
          playAddress: PLAY,
          blocks: [
            { at: 0x1000, bytes: [RTS] },
            { at: PLAY, bytes: [...read, ...report(0x1200, 0), RTS] },
            { at: 0xdc04, bytes: [0x5a] },
          ],
        });
        return valuesFor(run(file, 1).sink, 0);
      };

      expect(seen(0x34)).toEqual([0x5a]);
      expect(seen(0x35)).toHaveLength(1);
      expect(seen(0x35)).not.toEqual([0x5a]);
    });

    const heldUnder = 'lands in the RAM under the chips and reaches no sink';
    const reachesChip = 'reaches the sink and leaves the RAM under the chips alone';
    it.each([
      ['$34', heldUnder, 0x34, [], 0x00, 0x0f],
      ['$35', reachesChip, 0x35, [0x0f], 0x0f, 0x00],
      ['$36', reachesChip, 0x36, [0x0f], 0x0f, 0x00],
      ['$37', reachesChip, 0x37, [0x0f], 0x0f, 0x00],
    ])('under %s a store to $D418 %s', (_name, _outcome, bank, reached, inIoView, underIo) => {
      const { sink, machine } = run(chipTune([], [...bankTo(bank), ...store(0x0f, 0xd418)]), 1);

      expect(valuesFor(sink, 24)).toEqual(reached);
      const memory = machine.snapshot().memory;
      expect(memory[0xd418]).toBe(inIoView);
      expect(memory[ramUnderIo(0xd418)]).toBe(underIo);
    });

    it('leaves the play rate alone when a store to a CIA register lands in the RAM under it', () => {
      const writeHigh = (bank: number): C64Machine =>
        run(chipTune([...bankTo(bank), ...store(0x20, 0xdc05)], [], { speedFlags: 1 }), 0).machine;

      const banked = writeHigh(0x34);
      const live = writeHigh(0x35);

      expect(banked.cyclesPerPlayCall).toBe(0x4025 + 1);
      expect(banked.snapshot().memory[ramUnderIo(0xdc05)]).toBe(0x20);
      expect(live.cyclesPerPlayCall).toBe(0x2025 + 1);
    });

    it.each([
      ['below BASIC', 0x1000, 0x37],
      ['under BASIC', 0xa000, 0x36],
      ['under the chips', 0xd000, 0x34],
      ['under the KERNAL', 0xe000, 0x35],
    ])(
      'starts the init of a PSID %s with $00 at $2F and $01 at its bank value',
      (_where, initAt, bank) => {
        // LDA $00 / STA $1200 / LDA $01 / STA $1201 / RTS, kept in RAM for play to report.
        const probe = [
          ...load(PORT_DDR),
          ...save(0x1200),
          ...load(PORT_DATA),
          ...save(0x1201),
          RTS,
        ];
        const file = tune({
          initAddress: initAt,
          playAddress: PLAY,
          blocks: [
            { at: initAt, bytes: probe },
            { at: PLAY, bytes: [...report(0x1200, 0), ...report(0x1201, 1), RTS] },
          ],
        });

        const { sink } = run(file, 1);

        expect(valuesFor(sink, 0)).toEqual([0x2f]);
        expect(valuesFor(sink, 1)).toEqual([bank]);
      },
    );

    it.each([
      ['at $1100', 0x1100, 0x37],
      ['at $E000', 0xe000, 0x35],
    ])(
      'writes the bank value of a play routine %s before every call, even after a call left $30 there',
      (_where, playAt, bank) => {
        const file = tune({
          playAddress: playAt,
          blocks: [
            { at: 0x1000, bytes: [RTS] },
            { at: playAt, bytes: [...report(PORT_DATA, 0), ...bankTo(0x30), RTS] },
          ],
        });

        const { sink } = run(file, 3);

        expect(valuesFor(sink, 0)).toEqual([bank, bank, bank]);
      },
    );

    it('shows the chips when the direction register leaves the banking lines as pulled-up inputs', () => {
      const withDirection = (direction: number): number[] =>
        valuesFor(
          run(
            chipTune([], [...store(direction, PORT_DDR), ...bankTo(0x00), ...store(0x0f, 0xd418)]),
            1,
          ).sink,
          24,
        );

      expect(withDirection(0x28)).toEqual([0x0f]);
      expect(withDirection(0x2f)).toEqual([]);
    });

    it('reads $01 as the output lines it drives and the pulled-up level of the rest', () => {
      // DDR $28 makes bits 3 and 5 outputs; bits 0-2 and 4 are inputs, pulled up.
      const play = [...store(0x28, PORT_DDR), ...bankTo(0xff), ...report(PORT_DATA, 0)];

      expect(valuesFor(run(chipTune([], play), 1).sink, 0)).toEqual([0x28 | 0x17]);
    });

    it('leaves an RSID at $2F and $37 and never re-banks it', () => {
      const init = [...report(PORT_DDR, 0), ...report(PORT_DATA, 1), ...bankTo(0x35)];

      const { sink } = run(chipTune(init, report(PORT_DATA, 2), { format: 'RSID' }), 2);

      expect(valuesFor(sink, 0)).toEqual([0x2f]);
      expect(valuesFor(sink, 1)).toEqual([0x37]);
      expect(valuesFor(sink, 2)).toEqual([0x35, 0x35]);
    });

    it('leaves a PSID entered as an interrupt with whatever its own code left in $01', () => {
      const init = [
        ...bankTo(0x35),
        ...store(PLAY & 0xff, 0x0314),
        ...store(PLAY >> 8, 0x0315),
        RTS,
      ];
      const file = tune({
        blocks: [
          { at: 0x1000, bytes: init },
          { at: PLAY, bytes: [...report(PORT_DATA, 0), 0x40] },
        ],
      });

      const { sink } = run(file, 2);

      expect(valuesFor(sink, 0)).toEqual([0x35, 0x35]);
    });

    it('carries the RAM under the chips through a snapshot and restore, into another machine too', () => {
      // Init banks the chips out and leaves $AB in the RAM under $D800. Each play call counts it up
      // there and hands the count to the sink.
      const init = [...bankTo(0x34), ...store(0xab, 0xd800)];
      const play = [
        ...bankTo(0x34),
        0xee, // INC $D800
        0x00,
        0xd8,
        ...load(0xd800),
        ...save(0x1200),
        ...bankTo(0x37),
        ...report(0x1200, 0),
      ];
      const counting = (): SidFile => chipTune(init, play);
      const sink = new RecordingSink();
      const machine = createC64Machine(counting(), sink);
      machine.initSubtune(1);
      runFrames(machine, 2);
      const snapshot = machine.snapshot();
      const fromSnapshot = sink.writes.length;
      runFrames(machine, 3);
      const expected = sink.writes.slice(fromSnapshot);
      const otherSink = new RecordingSink();
      const other = createC64Machine(counting(), otherSink);
      other.initSubtune(1);
      runFrames(other, 6);

      machine.restore(snapshot);
      const fromRestore = sink.writes.length;
      runFrames(machine, 3);
      other.restore(structuredClone(snapshot));
      otherSink.writes.length = 0;
      runFrames(other, 3);

      expect(expected.map((write) => write.value)).toEqual([0xae, 0xaf, 0xb0]);
      expect(sink.writes.slice(fromRestore)).toEqual(expected);
      expect(otherSink.writes).toEqual(expected);
    });
  });

  describe('the snapshot', () => {
    // CIA 2 timer A latched at $00C7 and running, CIA 1 timer B counting timer A's underflows at $0033,
    // and a play routine that reports a counter, the cascade, the CIA flags and the raster flag.
    const busy = (): SidFile =>
      chipTune(
        [
          ...store(0xc7, 0xdd04),
          ...store(0x00, 0xdd05),
          ...store(0x11, 0xdd0e),
          ...store(0x33, 0xdc04),
          ...store(0x00, 0xdc05),
          ...store(0x11, 0xdc0e),
          ...store(0x55, 0xdc0f),
        ],
        [
          ...report(0xdd04, 0),
          ...report(0xdc06, 1),
          ...report(0xdc0d, 2),
          ...report(0xd019, 3),
          ...delay512,
        ],
      );

    it('puts the chips back where they were, counters mid-count, and replays the same reads', () => {
      const sink = new RecordingSink();
      const machine = createC64Machine(busy(), sink);
      machine.initSubtune(1);
      runFrames(machine, 3);
      const snapshot = machine.snapshot();
      const fromSnapshot = sink.writes.length;
      runFrames(machine, 4);
      const expected = sink.writes.slice(fromSnapshot);
      const chipsAfter = machine.snapshot().chips;

      machine.restore(snapshot);
      const fromRestore = sink.writes.length;
      runFrames(machine, 4);

      expect(sink.writes.slice(fromRestore)).toEqual(expected);
      expect(machine.snapshot().chips).toEqual(chipsAfter);
      const counters = expected.filter((write) => write.register === 0).map((write) => write.value);
      expect(new Set(counters).size).toBeGreaterThan(1);
    });

    it('carries the chips to a machine that did not take it, across a structured clone', () => {
      const sink = new RecordingSink();
      const source = createC64Machine(busy(), sink);
      source.initSubtune(1);
      runFrames(source, 3);
      const image = structuredClone(source.snapshot());
      const fromImage = sink.writes.length;
      runFrames(source, 4);
      const expected = sink.writes.slice(fromImage);

      const otherSink = new RecordingSink();
      const other = createC64Machine(busy(), otherSink);
      other.initSubtune(1);
      runFrames(other, 9);
      other.restore(image);
      otherSink.writes.length = 0;
      runFrames(other, 4);

      expect(otherSink.writes).toEqual(expected);
    });

    it('carries the chips through snapshotInto and copyMachineImage as through snapshot', () => {
      const sink = new RecordingSink();
      const machine = createC64Machine(busy(), sink);
      machine.initSubtune(1);
      runFrames(machine, 3);
      const image = createMachineImage();
      const copy = createMachineImage();
      machine.snapshotInto(image);
      copyMachineImage(image, copy);
      const fromImage = sink.writes.length;
      runFrames(machine, 4);
      const expected = sink.writes.slice(fromImage);

      machine.restore(copy);
      const fromRestore = sink.writes.length;
      runFrames(machine, 4);

      expect(copy.chips).toEqual(image.chips);
      expect(copy.chips).not.toBe(image.chips);
      expect(sink.writes.slice(fromRestore)).toEqual(expected);
    });
  });
});

describe('C64Machine on the bundled tunes', () => {
  function bundled(id: string): SidFile {
    const entry = BUNDLED_TUNES.find((candidate) => candidate.id === id);
    if (!entry) {
      throw new Error(`bundled tune "${id}" not found`);
    }
    return parseSidFile(decodeBundledTune(entry.base64));
  }

  it('plays fifty frames of Still Time, writing across many SID registers', () => {
    const sink = new RecordingSink();
    const machine = createC64Machine(bundled('still-time'), sink);

    expect(machine.initSubtune(1).completed).toBe(true);
    const frames = Array.from({ length: 50 }, () => machine.runFrame());

    expect(frames.every((frame) => frame.completed)).toBe(true);
    expect(new Set(sink.writes.map((write) => write.register)).size).toBeGreaterThan(5);
  }, 20_000);

  it('reports a CIA-timed play rate for InSID3 Out', () => {
    const machine = createC64Machine(bundled('insid3-out'), new RecordingSink());

    expect(machine.initSubtune(1).completed).toBe(true);

    expect(machine.cyclesPerPlayCall).not.toBeNull();
    expect(machine.callsPerFrame).toBeGreaterThanOrEqual(1);
  }, 20_000);

  describe('snapshot and restore', () => {
    /**
     * The guard on `CPU_STATE_KEYS`. `mos6502` declares its registers `private` and offers no setter,
     * so a restore assigns them directly by name — if an upstream release renames one, the restore
     * would silently put back partial state and this is what catches it. Divergence here means the
     * key list is stale, not that the test is wrong.
     */
    it('replays byte-for-byte identically after a restore', () => {
      const sink = new RecordingSink();
      const machine = createC64Machine(bundled('still-time'), sink);
      machine.initSubtune(1);
      for (let i = 0; i < 20; i++) machine.runFrame();

      const snapshot = machine.snapshot();
      const fromSnapshot = sink.writes.length;
      for (let i = 0; i < 30; i++) machine.runFrame();
      const expected = sink.writes.slice(fromSnapshot);

      machine.restore(snapshot);
      const fromRestore = sink.writes.length;
      for (let i = 0; i < 30; i++) machine.runFrame();

      expect(sink.writes.slice(fromRestore)).toEqual(expected);
      expect(expected.length).toBeGreaterThan(0); // a machine writing nothing would pass vacuously
    }, 20_000);

    it('detaches the snapshot from the machine, so later frames cannot alter it', () => {
      const machine = createC64Machine(bundled('still-time'), new RecordingSink());
      machine.initSubtune(1);
      machine.runFrame();

      const snapshot = machine.snapshot();
      const memoryAtCapture = snapshot.memory.slice();
      for (let i = 0; i < 30; i++) machine.runFrame();

      expect(snapshot.memory).toEqual(memoryAtCapture);
    }, 20_000);

    it('fills an image the caller holds with exactly what snapshot() would have returned', () => {
      const machine = createC64Machine(bundled('still-time'), new RecordingSink());
      machine.initSubtune(1);
      for (let i = 0; i < 20; i++) machine.runFrame();
      const image = createMachineImage();
      const memory = image.memory;
      const cpu = image.cpu;

      machine.snapshotInto(image);

      expect(image).toEqual(machine.snapshot());
      expect(image.memory).toBe(memory);
      expect(image.cpu).toBe(cpu);
      // Refilled in place, it still holds what it was given when the machine runs on.
      const atCapture = image.memory.slice();
      for (let i = 0; i < 30; i++) machine.runFrame();
      expect(image.memory).toEqual(atCapture);
    }, 20_000);

    it('restores a machine from an image filled in place as it does from a snapshot', () => {
      const sink = new RecordingSink();
      const machine = createC64Machine(bundled('still-time'), sink);
      machine.initSubtune(1);
      for (let i = 0; i < 20; i++) machine.runFrame();
      const image = createMachineImage();
      machine.snapshotInto(image);
      const copy = createMachineImage();
      copyMachineImage(image, copy);
      const fromImage = sink.writes.length;
      for (let i = 0; i < 30; i++) machine.runFrame();
      const expected = sink.writes.slice(fromImage);

      machine.restore(copy);
      const fromRestore = sink.writes.length;
      for (let i = 0; i < 30; i++) machine.runFrame();

      expect(sink.writes.slice(fromRestore)).toEqual(expected);
      expect(expected.length).toBeGreaterThan(0);
    }, 20_000);

    it('rewinds an advanced machine to an earlier capture', () => {
      const sink = new RecordingSink();
      const machine = createC64Machine(bundled('still-time'), sink);
      machine.initSubtune(1);
      machine.runFrame();

      const early = machine.snapshot();
      for (let i = 0; i < 40; i++) machine.runFrame();
      const advanced = machine.snapshot();

      expect(advanced.memory).not.toEqual(early.memory);

      machine.restore(early);
      expect(machine.snapshot().memory).toEqual(early.memory);
    }, 20_000);
  });
});
