import { describe, it, expect } from 'vitest';
import {
  copyMachineImage,
  createC64Machine,
  createMachineImage,
  type SidWriteSink,
  UnplayableTuneError,
} from './c64-machine.js';
import {
  NTSC_CYCLES_PER_FRAME,
  PAL_CYCLES_PER_FRAME,
  PLAY_BUDGET_FRAMES,
  TRAMPOLINE_BASE,
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
    version: 2,
    loadAddress,
    initAddress: options.initAddress ?? loadAddress,
    playAddress: options.playAddress ?? 0,
    songs: options.songs ?? 1,
    startSong: 1,
    speedFlags: 0,
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

  it('lets a handler read $DC0D as 0x81 on its way out', () => {
    // LDA $DC0D / STA $D400 / JMP $EA31
    const { sink } = playOnce(
      interruptTune(KERNAL_VECTOR, [0xad, 0x0d, 0xdc, 0x8d, 0x00, 0xd4, 0x4c, 0x31, 0xea]),
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
