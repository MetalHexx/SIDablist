import { describe, expect, it } from 'vitest';
import { ALLOCATION_NOISE_BYTES, measureAllocation } from '../testing/measure-allocation.js';
import { decode, type AddressingModes } from '../vendor/mos6502/index.js';
import type { Cpu6502, Cpu6502Bus } from './cpu-port.js';
import { createVendorCpu } from './vendor-cpu.js';

/**
 * A pass through the program is about a thousand cycles, and a handler it runs once adds a small
 * allocation once a pass. This many cycles is enough passes for that to add up past the noise bound.
 */
const STEP_CYCLES = 5_000_000;
const HARNESS_CYCLES = 1_000_000;
const ILLEGAL = '???';

const PROGRAM = 0x2000;
const RTS_AT = 0x3000;
const RTI_AT = 0x3001;
const JUMP_POINTER = 0x00fa;
const WRITABLE_FROM = 0x0100;
const WRITABLE_TO = 0x0600;

/** The bytes after an opcode, by addressing mode: zero-page and data-area addresses, never the program. */
const OPERANDS: Readonly<Record<AddressingModes, readonly number[]>> = {
  ACC: [],
  IMP: [],
  IMM: [0x20],
  ZPI: [0x20],
  ZPX: [0x20],
  ZPY: [0x20],
  INX: [0x20],
  INY: [0x20],
  REL: [0x00],
  ABS: [0xf8, 0x04],
  ABX: [0xf8, 0x04],
  ABY: [0xf8, 0x04],
  IND: [JUMP_POINTER, 0x00],
};

/** Opcodes that need the control flow around them to be written by hand rather than from the table. */
const FLOW_MNEMONICS: ReadonlySet<string> = new Set(['BRK', 'JSR', 'RTI', 'JMP', 'RTS', 'TXS']);

/** How to make each flag set or clear in one or more instructions, so a branch can be run both ways. */
const FLAG_SETUPS = {
  N: { set: [[0xa9, 0x80]], clear: [[0xa9, 0x01]] },
  V: { set: [[0x24, 0x22]], clear: [[0xb8]] },
  C: { set: [[0x38]], clear: [[0x18]] },
  Z: { set: [[0xa9, 0x00]], clear: [[0xa9, 0x01]] },
} as const;

/** Each branch's opcode, the flag it reads, and whether it is taken when that flag is set. */
const BRANCHES: readonly (readonly [number, keyof typeof FLAG_SETUPS, boolean])[] = [
  [0x10, 'N', false],
  [0x30, 'N', true],
  [0x50, 'V', false],
  [0x70, 'V', true],
  [0x90, 'C', false],
  [0xb0, 'C', true],
  [0xd0, 'Z', false],
  [0xf0, 'Z', true],
];

interface BareMachine {
  readonly bus: Cpu6502Bus;
  readonly memory: Uint8Array;
  /** The address of every instruction the program holds. */
  readonly starts: readonly number[];
  /** Nonzero at each address the bus has been asked to read. */
  readonly read: Uint8Array;
}

/**
 * A 64 KB bus that only reads and writes its own memory, so whatever allocates during a run is the
 * CPU, loaded with a program that runs forever through every legal opcode once a pass:
 *
 * - every opcode with no control flow of its own, in opcode order, with an operand that stays in
 *   range (`OPERANDS`);
 * - `TXS` after a `LDX #$FF`, so the stack pointer is known;
 * - each branch twice, once taken and once not, over a zero offset;
 * - a `JSR` to an `RTS`, a `JMP` and a `JMP (indirect)` to the next instruction, and a `BRK` whose
 *   vector is an `RTI`;
 * - a `JMP` back to the start.
 *
 * Writes land only in `WRITABLE_FROM` to `WRITABLE_TO` (the stack and a data area), so whatever the
 * registers hold, no store can reach the program, a pointer or a vector.
 */
function createBareMachine(): BareMachine {
  const memory = new Uint8Array(0x10000);
  const starts: number[] = [];
  let at = PROGRAM;
  const emit = (...bytes: number[]): void => {
    starts.push(at);
    for (const byte of bytes) {
      memory[at++] = byte;
    }
  };

  memory[0x20] = 0x00;
  memory[0x21] = 0x04;
  memory[0x22] = 0x40;
  for (let address = 0x0200; address < WRITABLE_TO; address++) {
    memory[address] = (address * 37 + 11) & 0xff;
  }

  for (let opcode = 0; opcode < 0x100; opcode++) {
    const { instruction, addressing } = decode(opcode);
    if (instruction !== ILLEGAL && !FLOW_MNEMONICS.has(instruction) && addressing !== 'REL') {
      emit(opcode, ...OPERANDS[addressing]);
    }
  }

  emit(0xa2, 0xff);
  emit(0x9a);

  for (const [opcode, flag, takenWhenSet] of BRANCHES) {
    for (const setting of [takenWhenSet, !takenWhenSet]) {
      for (const setup of FLAG_SETUPS[flag][setting ? 'set' : 'clear']) {
        emit(...setup);
      }
      emit(opcode, 0x00);
    }
  }

  emit(0x20, RTS_AT & 0xff, RTS_AT >> 8);
  emit(0x4c, (at + 3) & 0xff, (at + 3) >> 8);
  memory[JUMP_POINTER] = (at + 3) & 0xff;
  memory[JUMP_POINTER + 1] = (at + 3) >> 8;
  emit(0x6c, JUMP_POINTER, 0x00);
  emit(0x00, 0xea);
  emit(0x4c, PROGRAM & 0xff, PROGRAM >> 8);

  memory[RTS_AT] = 0x60;
  memory[RTI_AT] = 0x40;
  starts.push(RTS_AT, RTI_AT);
  memory[0xfffc] = PROGRAM & 0xff;
  memory[0xfffd] = PROGRAM >> 8;
  memory[0xfffe] = RTI_AT & 0xff;
  memory[0xffff] = RTI_AT >> 8;

  const read = new Uint8Array(0x10000);
  const bus: Cpu6502Bus = {
    read(address) {
      const target = address & 0xffff;
      read[target] = 1;
      return memory[target];
    },
    write(address, value) {
      const target = address & 0xffff;
      if (target >= WRITABLE_FROM && target < WRITABLE_TO) {
        memory[target] = value & 0xff;
      }
    },
  };
  return { bus, memory, starts, read };
}

function runCycles(cpu: Cpu6502, count: number): void {
  for (let i = 0; i < count; i++) {
    cpu.emulate();
  }
}

describe('stepping the vendored CPU', () => {
  it('runs a program holding every legal opcode, and reaches every instruction in it', () => {
    const { bus, memory, starts, read } = createBareMachine();
    const cpu = createVendorCpu(bus);

    runCycles(cpu, 50_000);

    const held = new Set(starts.map((address) => memory[address]));
    const missing = Array.from({ length: 0x100 }, (_, opcode) => opcode).filter(
      (opcode) => decode(opcode).instruction !== ILLEGAL && !held.has(opcode),
    );
    const unreached = starts.filter((address) => read[address] === 0);
    expect({ missing, unreached }).toEqual({ missing: [], unreached: [] });
  });

  it('allocates nothing across millions of cycles of every legal opcode', async () => {
    const cpu = createVendorCpu(createBareMachine().bus);

    const { heapGrowthBytes, scavenges } = await measureAllocation(() =>
      runCycles(cpu, STEP_CYCLES),
    );

    // The heap growth is the detector: a run that allocates a little at a time still fits in the young
    // generation, so it can pass the scavenge count and not this bound.
    expect(heapGrowthBytes).toBeLessThan(ALLOCATION_NOISE_BYTES);
    expect(scavenges).toBe(0);
  });

  it('is told by the measurement when work does allocate', async () => {
    const kept: object[] = new Array<object>(1024);

    const { scavenges } = await measureAllocation(() => {
      for (let i = 0; i < HARNESS_CYCLES; i++) {
        kept[i & 1023] = { i, twice: i * 2, thrice: i * 3 };
      }
    });

    expect(scavenges).toBeGreaterThan(0);
  });
});
