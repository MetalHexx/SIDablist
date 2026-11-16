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
  version?: number;
  speedFlags?: number;
  psidSpecific?: boolean;
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
