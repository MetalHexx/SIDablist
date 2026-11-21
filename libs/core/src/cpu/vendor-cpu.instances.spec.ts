import { describe, expect, it } from 'vitest';
import type { Cpu6502, Cpu6502Bus } from './cpu-port.js';
import { createVendorCpu } from './vendor-cpu.js';

const CYCLES = 20_000;

const WRITE_FLAG = 1 << 24;

/**
 * A 64 KB bus that logs every access as one packed number (address, value, a write flag), running a
 * program that loops forever through indexed loads and stores that cross pages, a taken branch, a
 * subroutine call, stack pushes and pulls, a zero-page increment and an indirect-indexed load:
 *
 * ```
 * $0800  LDX #$00 / LDY #$01
 * $0804  LDA $04F8,X / ADC #$01 / STA $04F8,X / INX / PHA / JSR $0820 / PLA / CMP #$FF / BNE $0804
 * $0816  INC $10 / LDA ($20),Y / JMP $0804
 * $0820  ASL A / RTS
 * ```
 */
function createTracedMachine(): { bus: Cpu6502Bus; trace: number[] } {
  const memory = new Uint8Array(0x10000);
  const trace: number[] = [];
  memory.set(
    [
      0xa2, 0x00, 0xa0, 0x01, 0xbd, 0xf8, 0x04, 0x69, 0x01, 0x9d, 0xf8, 0x04, 0xe8, 0x48, 0x20,
      0x20, 0x08, 0x68, 0xc9, 0xff, 0xd0, 0xee, 0xe6, 0x10, 0xb1, 0x20, 0x4c, 0x04, 0x08,
    ],
    0x0800,
  );
  memory.set([0x0a, 0x60], 0x0820);
  memory[0xfffc] = 0x00;
  memory[0xfffd] = 0x08;

  const bus: Cpu6502Bus = {
    read(address) {
      const value = memory[address & 0xffff];
      trace.push((address & 0xffff) | (value << 16));
      return value;
    },
    write(address, value) {
      const byte = value & 0xff;
      memory[address & 0xffff] = byte;
      trace.push((address & 0xffff) | (byte << 16) | WRITE_FLAG);
    },
  };
  return { bus, trace };
}

function runCycles(cpu: Cpu6502, count: number): void {
  for (let i = 0; i < count; i++) {
    cpu.emulate();
  }
}

describe('two vendored CPUs side by side', () => {
  it('each produce the bus trace and final state one produces alone', () => {
    const alone = createTracedMachine();
    const aloneCpu = createVendorCpu(alone.bus);
    alone.trace.length = 0;
    runCycles(aloneCpu, CYCLES);

    const first = createTracedMachine();
    const second = createTracedMachine();
    const firstCpu = createVendorCpu(first.bus);
    const secondCpu = createVendorCpu(second.bus);
    first.trace.length = 0;
    second.trace.length = 0;

    // Uneven slices keep the two at different points in different instructions at every hand-over,
    // so state shared between them has nothing to hide behind.
    let firstDone = 0;
    let secondDone = 0;
    for (let turn = 0; firstDone < CYCLES || secondDone < CYCLES; turn++) {
      const firstSlice = Math.min((turn % 5) + 1, CYCLES - firstDone);
      const secondSlice = Math.min((turn % 3) + 1, CYCLES - secondDone);
      runCycles(firstCpu, firstSlice);
      runCycles(secondCpu, secondSlice);
      firstDone += firstSlice;
      secondDone += secondSlice;
    }

    expect(alone.trace.length).toBeGreaterThan(CYCLES / 2);
    expect(first.trace).toEqual(alone.trace);
    expect(second.trace).toEqual(alone.trace);
    expect(firstCpu.getState()).toEqual(aloneCpu.getState());
    expect(secondCpu.getState()).toEqual(aloneCpu.getState());
  });
});
