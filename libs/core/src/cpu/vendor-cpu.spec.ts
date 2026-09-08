import { describe, expect, it } from 'vitest';
import type { Cpu6502, Cpu6502Bus } from './cpu-port.js';
import { assertCpuStateKeys, createVendorCpu } from './vendor-cpu.js';

interface RecordedWrite {
  readonly address: number;
  readonly value: number;
}

/**
 * A 64 KB address space running a tight loop — LDA/STA to seed a counter, then INC/JMP forever —
 * so every write past the seed is deterministic and driven purely by CPU state, not by any input
 * this harness varies between runs.
 */
function createLoopMachine(): { bus: Cpu6502Bus; memory: Uint8Array; writeLog: RecordedWrite[] } {
  const memory = new Uint8Array(0x10000);
  const writeLog: RecordedWrite[] = [];

  const program = [
    0xa9,
    0x01, // LDA #$01
    0x8d,
    0x00,
    0x04, // STA $0400
    0xee,
    0x00,
    0x04, // INC $0400
    0x4c,
    0x05,
    0x08, // JMP $0805
  ];
  memory.set(program, 0x0800);
  memory[0xfffc] = 0x00;
  memory[0xfffd] = 0x08;

  const bus: Cpu6502Bus = {
    read(address) {
      return memory[address & 0xffff] ?? 0;
    },
    write(address, value) {
      const maskedAddress = address & 0xffff;
      const maskedValue = value & 0xff;
      memory[maskedAddress] = maskedValue;
      writeLog.push({ address: maskedAddress, value: maskedValue });
    },
  };

  return { bus, memory, writeLog };
}

function runCycles(cpu: Cpu6502, count: number): void {
  for (let i = 0; i < count; i++) {
    cpu.emulate();
  }
}

describe('createVendorCpu', () => {
  it('round-trips CPU state so run/snapshot/run/restore/run produces identical bus traffic', () => {
    const { bus, memory, writeLog } = createLoopMachine();
    const cpu = createVendorCpu(bus);
    cpu.reset();
    runCycles(cpu, 30);

    const snapshotMemory = memory.slice();
    const snapshotState = cpu.getState();

    writeLog.length = 0;
    runCycles(cpu, 60);
    const runAfterSnapshot = writeLog.slice();

    memory.set(snapshotMemory);
    cpu.setState(snapshotState);

    writeLog.length = 0;
    runCycles(cpu, 60);
    const runAfterRestore = writeLog.slice();

    expect(runAfterRestore).toEqual(runAfterSnapshot);
    expect(runAfterSnapshot.length).toBeGreaterThan(0);
  });

  it('returns a getState() snapshot that later emulate() calls do not mutate', () => {
    const { bus } = createLoopMachine();
    const cpu = createVendorCpu(bus);
    cpu.reset();
    runCycles(cpu, 30);

    const snapshot = cpu.getState();
    const capturedFields = { ...snapshot };

    runCycles(cpu, 60);

    expect(snapshot).toEqual(capturedFields);
  });

  it('classifies a documented opcode as legal and an unassigned opcode as illegal', () => {
    const { bus } = createLoopMachine();
    const cpu = createVendorCpu(bus);

    expect(cpu.decode(0xea)).toEqual({ illegal: false }); // NOP
    expect(cpu.decode(0x02)).toEqual({ illegal: true }); // not in the decode matrix
  });

  it('throws the pinned message when a required CPU state field is missing', () => {
    expect(() => assertCpuStateKeys({})).toThrow(
      /cue snapshots would restore incomplete CPU state without saying so/,
    );
  });

  it('does not throw when every required CPU state field is present', () => {
    const complete = {
      a: 0,
      x: 0,
      y: 0,
      pc: 0,
      stkp: 0,
      status: 0,
      addr: 0,
      currentInstruction: {},
      cycle: 0,
    };
    expect(() => assertCpuStateKeys(complete)).not.toThrow();
  });
});
