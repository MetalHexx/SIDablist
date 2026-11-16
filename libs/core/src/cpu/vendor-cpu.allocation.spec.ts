import { describe, expect, it } from 'vitest';
import { ALLOCATION_NOISE_BYTES, measureAllocation } from '../testing/measure-allocation.js';
import type { Cpu6502, Cpu6502Bus } from './cpu-port.js';
import { createVendorCpu } from './vendor-cpu.js';

const CYCLES = 1_000_000;

/**
 * A 64 KB bus that only reads and writes its own memory, so whatever allocates during a run is the
 * CPU. The program loops forever through indexed loads and stores that cross pages, a taken branch,
 * a subroutine call, stack pushes and pulls, a zero-page increment and an indirect-indexed load:
 *
 * ```
 * $0800  LDX #$00 / LDY #$01
 * $0804  LDA $04F8,X / ADC #$01 / STA $04F8,X / INX / PHA / JSR $0820 / PLA / CMP #$FF / BNE $0804
 * $0816  INC $10 / LDA ($20),Y / JMP $0804
 * $0820  ASL A / RTS
 * ```
 */
function createBareBus(): Cpu6502Bus {
  const memory = new Uint8Array(0x10000);
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

  return {
    read(address) {
      return memory[address & 0xffff];
    },
    write(address, value) {
      memory[address & 0xffff] = value & 0xff;
    },
  };
}

function runCycles(cpu: Cpu6502, count: number): void {
  for (let i = 0; i < count; i++) {
    cpu.emulate();
  }
}

describe('stepping the vendored CPU', () => {
  it('allocates nothing across a million cycles of a looping program', async () => {
    const cpu = createVendorCpu(createBareBus());

    const { heapGrowthBytes, scavenges } = await measureAllocation(() => runCycles(cpu, CYCLES));

    expect(scavenges).toBe(0);
    expect(heapGrowthBytes).toBeLessThan(ALLOCATION_NOISE_BYTES);
  });

  it('is told by the measurement when work does allocate', async () => {
    const kept: object[] = new Array<object>(1024);

    const { scavenges } = await measureAllocation(() => {
      for (let i = 0; i < CYCLES; i++) {
        kept[i & 1023] = { i, twice: i * 2, thrice: i * 3 };
      }
    });

    expect(scavenges).toBeGreaterThan(0);
  });
});
