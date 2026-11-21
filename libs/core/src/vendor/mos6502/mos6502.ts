/**
 * Vendored from mos6502 v1.1.1 <https://github.com/kgtrey1/mos6502>, MIT licensed, by Kevin Gouyet.
 * This file has been modified from the original upstream source; see ./README.md.
 */

import type { DebugInfo } from './types/debug.js';
import { Flags } from './types/flags.js';
import type { RegistersInfo } from './types/register.js';

import type { AddressingModesMap } from './addressing.js';
import type { Instruction, InstructionsMap } from './instructions.js';
import { decode } from './decoder.js';

/** The memory the CPU reads and writes through. Called directly, once per access. */
export interface Mos6502Bus {
  read(address: number): number;
  write(address: number, value: number): void;
}

export interface ProcessorStatus {
  info: Array<DebugInfo>;
  registers: RegistersInfo;
}

export class mos6502 {
  /**
   * The dispatch tables. Built once for the class: the handlers are prototype methods, called with
   * the instance as `this`, so an instance carries no handler closures and stepping a cycle
   * allocates nothing.
   */
  private static readonly addressingModes: AddressingModesMap = {
    IMP: mos6502.prototype.IMP,
    IMM: mos6502.prototype.IMM,
    ABS: mos6502.prototype.ABS,
    ABX: mos6502.prototype.ABX,
    ABY: mos6502.prototype.ABY,
    IND: mos6502.prototype.IND,
    INX: mos6502.prototype.IX,
    INY: mos6502.prototype.IY,
    REL: mos6502.prototype.REL,
    ZPI: mos6502.prototype.ZP,
    ZPX: mos6502.prototype.ZPX,
    ZPY: mos6502.prototype.ZPY,
    ACC: mos6502.prototype.IMP,
  };
  private static readonly instructionsMap: InstructionsMap = {
    ADC: mos6502.prototype.ADC,
    AND: mos6502.prototype.AND,
    ASL: mos6502.prototype.ASL,
    BCC: mos6502.prototype.BCC,
    BCS: mos6502.prototype.BCS,
    BEQ: mos6502.prototype.BEQ,
    BIT: mos6502.prototype.BIT,
    BMI: mos6502.prototype.BMI,
    BNE: mos6502.prototype.BNE,
    BPL: mos6502.prototype.BPL,
    BRK: mos6502.prototype.BRK,
    BVC: mos6502.prototype.BVC,
    BVS: mos6502.prototype.BVS,
    CLC: mos6502.prototype.CLC,
    CLD: mos6502.prototype.CLD,
    CLI: mos6502.prototype.CLI,
    CLV: mos6502.prototype.CLV,
    CMP: mos6502.prototype.CMP,
    CPX: mos6502.prototype.CPX,
    CPY: mos6502.prototype.CPY,
    DEC: mos6502.prototype.DEC,
    DEX: mos6502.prototype.DEX,
    DEY: mos6502.prototype.DEY,
    EOR: mos6502.prototype.EOR,
    INC: mos6502.prototype.INC,
    INX: mos6502.prototype.INX,
    INY: mos6502.prototype.INY,
    JMP: mos6502.prototype.JMP,
    JSR: mos6502.prototype.JSR,
    LDA: mos6502.prototype.LDA,
    LDX: mos6502.prototype.LDX,
    LDY: mos6502.prototype.LDY,
    LSR: mos6502.prototype.LSR,
    NOP: mos6502.prototype.NOP,
    ORA: mos6502.prototype.ORA,
    PHA: mos6502.prototype.PHA,
    PHP: mos6502.prototype.PHP,
    PLA: mos6502.prototype.PLA,
    PLP: mos6502.prototype.PLP,
    ROL: mos6502.prototype.ROL,
    ROR: mos6502.prototype.ROR,
    RTI: mos6502.prototype.RTI,
    RTS: mos6502.prototype.RTS,
    SBC: mos6502.prototype.SBC,
    SEC: mos6502.prototype.SEC,
    SED: mos6502.prototype.SED,
    SEI: mos6502.prototype.SEI,
    STA: mos6502.prototype.STA,
    STX: mos6502.prototype.STX,
    STY: mos6502.prototype.STY,
    TAX: mos6502.prototype.TAX,
    TAY: mos6502.prototype.TAY,
    TSX: mos6502.prototype.TSX,
    TXA: mos6502.prototype.TXA,
    TXS: mos6502.prototype.TXS,
    TYA: mos6502.prototype.TYA,
    '???': mos6502.prototype.ILL,
  };

  private a: number = 0x00;
  private x: number = 0x00;
  private y: number = 0x00;
  private pc: number = 0x00;
  private stkp: number = 0x00;
  private status: number = 0x00;
  private addr: number = 0x00;
  private currentInstruction: Instruction = { instruction: '???', addressing: 'IMP', cycles: 2 };
  private cycle: number = 0;
  private bus: Mos6502Bus;

  /** Debug Only */
  private debug: boolean;

  /** Debug only: the status after the last instruction started; stays null unless `debug` is on. */
  public processorStatus: ProcessorStatus | null = null;

  constructor(bus: Mos6502Bus, debug: boolean = false) {
    this.bus = bus;

    this.reset();
    this.cycle = 0;
    this.debug = debug;
  }

  /** Advances one cycle. An instruction's work all happens on its first cycle; the rest count down. */
  public emulate(): void {
    if (this.cycle === 0) {
      this.setFlag(Flags.A, true);
      const pc = this.pc;

      this.currentInstruction = decode(this.bus.read(this.pc) & 0xff);
      this.pc = this.pc + 1;
      this.cycle = this.currentInstruction.cycles;
      this.cycle =
        this.cycle + mos6502.addressingModes[this.currentInstruction.addressing].call(this);
      this.cycle =
        this.cycle + mos6502.instructionsMap[this.currentInstruction.instruction].call(this);
      if (this.debug) {
        this.processorStatus = this.getProcessorStatus(pc);
      }
      this.setFlag(Flags.A, true);
    }
    this.cycle = this.cycle - 1;
  }

  public getFlag(flag: Flags): number {
    const mask = (1 << flag) & 0xff;

    return (this.status & mask) !== 0 ? 1 : 0;
  }

  public setFlag(flag: Flags, value: boolean): void {
    const mask = 1 << flag;

    if (value) {
      this.status |= mask;
    } else {
      this.status &= ~mask;
    }
    return;
  }

  /**
   * Trigger a Non-Maskable Interrupt (NMI).
   *
   * @method
   * @public
   * @returns {void}
   */
  public nmi(): void {
    const lo = this.bus.read(0xfffa);
    const hi = this.bus.read(0xfffb);

    this.setFlag(Flags.B, false);
    this.setFlag(Flags.A, true);
    this.setFlag(Flags.I, true);
    this.bus.write(0x100 + this.stkp, (this.pc >> 8) & 0x00ff);
    this.bus.write(0x100 + this.stkp - 1, this.pc & 0x00ff);
    this.bus.write(0x100 + this.stkp - 2, this.status);
    this.stkp = (this.stkp - 3) & 0xff;
    this.pc = (hi << 8) | lo;
    this.cycle = 7;
  }

  /**
   * Trigger a CPU Reset.
   *
   * @method
   * @public
   * @returns {void}
   */
  public reset(): void {
    const lo = this.bus.read(0xfffc);
    const hi = this.bus.read(0xfffd);

    this.pc = (hi << 8) | lo;
    this.a = 0;
    this.x = 0;
    this.y = 0;
    this.stkp = 0xff;
    this.status = 0x00;
    this.setFlag(Flags.B, true);
    this.setFlag(Flags.I, true);
    this.setFlag(Flags.Z, true);
    this.setFlag(Flags.A, true);
    this.cycle = 6;
  }

  /**
   * Handles an Interrupt Request (IRQ).
   *
   * @method
   * @public
   * @returns {void}
   */
  public irq(): void {
    if (this.getFlag(Flags.I) === 1) {
      return;
    }
    const lo = this.bus.read(0xfffe);
    const hi = this.bus.read(0xffff);

    this.setFlag(Flags.B, false);
    this.setFlag(Flags.A, true);
    this.setFlag(Flags.I, true);
    this.bus.write(0x100 + this.stkp, (this.pc >> 8) & 0x00ff);
    this.bus.write(0x100 + this.stkp - 1, this.pc & 0x00ff);
    this.bus.write(0x100 + this.stkp - 2, this.status);
    this.stkp = (this.stkp - 3) & 0xff;
    this.pc = (hi << 8) | lo;
    this.cycle = 7;
  }

  public getState(): {
    instruction: Instruction;
    registers: RegistersInfo;
    cycle: number;
    pc: number;
  } {
    return {
      instruction: this.currentInstruction,
      registers: {
        a: this.a,
        x: this.x,
        y: this.y,
        stkp: this.stkp,
        status: {
          n: this.getFlag(Flags.N),
          v: this.getFlag(Flags.V),
          d: this.getFlag(Flags.D),
          i: this.getFlag(Flags.I),
          z: this.getFlag(Flags.Z),
          c: this.getFlag(Flags.C),
        },
      },
      cycle: this.cycle,
      pc: this.pc,
    };
  }

  /* Addressing modes */

  /**
   * Implied Addressing mode.
   *
   * No address operand, we do nothing
   * @returns {number} 0, this addressing mode does not require additionnal clock cycles.
   */
  private IMP(): number {
    return 0;
  }

  /**
   * Immediate Addressing mode.
   *
   * Use the next byte as a value
   * @returns {number} 0, this addressing mode does not require additionnal clock cycles.
   */
  private IMM(): number {
    this.addr = this.pc;
    this.pc = (this.pc + 1) & 0xffff;
    return 0;
  }

  /**
   * Absolute Addressing mode.
   *
   * The address of the value that the instruction will use is located in the next to bytes.
   * @returns {number} 0, this addressing mode does not require additionnal clock cycles.
   */
  private ABS(): number {
    const low = this.bus.read(this.pc);
    const high = this.bus.read((this.pc + 1) & 0xffff);

    this.pc = (this.pc + 2) & 0xffff;
    this.addr = (high << 8) | low;
    return 0;
  }

  /**
   * Absolute with X index Addressing mode.
   *
   * The address of the value that the instruction will use is located in the next to bytes.
   * @returns {number} 1 if a page is crossed, else 0.
   */
  private ABX(): number {
    const low = this.bus.read(this.pc);
    const high = this.bus.read((this.pc + 1) & 0xffff);

    this.pc = (this.pc + 2) & 0xffff;
    this.addr = (((high << 8) | low) + this.x) & 0xffff;
    if (this.currentInstruction.instruction === 'STA') {
      return 0;
    }
    return (this.addr & 0xff00) === ((high << 8) & 0xff00) ? 0 : 1;
  }

  /**
   * Absolute with Y index Addressing mode.
   *
   * The address of the value that the instruction will use is located in the next to bytes.
   * @returns {number} 1 if a page is crossed, else 0.
   */
  private ABY(): number {
    const low = this.bus.read(this.pc);
    const high = this.bus.read((this.pc + 1) & 0xffff);

    this.pc = (this.pc + 2) & 0xffff;
    this.addr = (((high << 8) | low) + this.y) & 0xffff;
    if (this.currentInstruction.instruction === 'STA') {
      return 0;
    }
    return (this.addr & 0xff00) === high << 8 ? 0 : 1;
  }

  /**
   * Indirect Addressing mode.
   *
   * Read two bytes to form a 16 bits address. These two bytes are located
   * at the address that we get after reading the next two bytes.
   * @returns {number} 0, this addressing mode does not require additionnal clock cycles.
   */
  private IND(): number {
    const low = this.bus.read(this.pc);
    const high = this.bus.read((this.pc + 1) & 0xffff);
    const address = (high << 8) | low;

    this.pc = (this.pc + 2) & 0xffff;

    // Handle the page boundary bug
    const indirectLow = this.bus.read(address);
    const indirectHigh = this.bus.read((address & 0xff00) | ((address + 1) & 0x00ff));

    this.addr = (indirectHigh << 8) | indirectLow;
    return 0;
  }

  /**
   * Indirect with X index Addressing mode.
   *
   * Indirect with an offset equal to X.
   * @returns {number} 0, this addressing mode does not require additionnal clock cycles.
   */
  private IX(): number {
    const loc = this.bus.read(this.pc);

    this.pc = (this.pc + 1) & 0xffff;
    this.addr =
      (this.bus.read((loc + this.x + 1) & 0xff) << 8) | this.bus.read((loc + this.x) & 0xff);
    return 0;
  }

  /**
   * Indirect with Y index Addressing mode.
   *
   * Indirect with an offset equal to Y.
   * @returns {number} 0, this addressing mode does not require additionnal clock cycles.
   */
  private IY(): number {
    const loc = this.bus.read(this.pc);
    const baseLo = this.bus.read(loc & 0xff);
    const baseHi = this.bus.read((loc + 1) & 0xff);
    const baseAddr = (baseHi << 8) | baseLo;
    this.addr = (baseAddr + this.y) & 0xffff;
    this.pc = (this.pc + 1) & 0xffff;

    if (this.currentInstruction.instruction === 'STA') {
      return 0;
    }
    return (this.addr & 0xff00) === (baseAddr & 0xff00) ? 0 : 1;
  }

  /**
   * Relative Addressing mode.
   *
   * Used by branching instruction. A signed one byte offset is used to indicate the jump location.
   * @returns
   */
  private REL(): number {
    this.addr = this.bus.read(this.pc) & 0xff;
    this.pc = this.pc + 1;

    if (this.addr & 0x80) {
      this.addr = this.addr | 0xff00;
    }
    return 0;
  }

  /**
   * Zero Page Addressing mode.
   *
   * We assume that the value is located on page 0, at the offset indicated by the next byte.
   * @returns {number} 0, this addressing mode does not require additionnal clock cycles.
   */
  private ZP(): number {
    const low = this.bus.read(this.pc);

    this.addr = low & 0xff;
    this.pc = (this.pc + 1) & 0xffff;
    return 0;
  }

  /**
   * Zero Page with X index Addressing mode.
   *
   * We assume that the value is located on page 0, at the offset indicated by the next + x byte.
   * @returns {number} 0, this addressing mode does not require additionnal clock cycles.
   */
  private ZPX(): number {
    const base = this.bus.read(this.pc) & 0x00ff;
    this.addr = (base + this.x) & 0x00ff;
    this.pc = (this.pc + 1) & 0xffff;
    return 0;
  }

  /**
   * Zero Page with X index Addressing mode.
   *
   * We assume that the value is located on page 0, at the offset indicated by the next + y byte.
   * @returns {number} 0, this addressing mode does not require additionnal clock cycles.
   */
  private ZPY(): number {
    const base = this.bus.read(this.pc) & 0x00ff;
    this.addr = (base + this.y) & 0x00ff;
    this.pc = (this.pc + 1) & 0xffff;
    return 0;
  }

  /**
   * Instructions
   * reference: https://www.nesdev.org/obelisk-6502-guide/reference.html
   */

  private ADC(): number {
    const m = this.bus.read(this.addr);

    if (this.getFlag(Flags.D)) {
      let lowerNibble = (this.a & 0x0f) + (m & 0x0f) + this.getFlag(Flags.C);
      let upperNibble = (this.a >> 4) + (m >> 4);

      if (lowerNibble > 9) {
        lowerNibble -= 10;
        upperNibble += 1;
      }
      if (upperNibble > 9) {
        upperNibble -= 10;
        this.setFlag(Flags.C, true);
      } else {
        this.setFlag(Flags.C, false);
      }
      this.a = ((upperNibble << 4) | (lowerNibble & 0x0f)) & 0xff;
    } else {
      const result = this.a + m + this.getFlag(Flags.C);

      this.setFlag(Flags.V, ((this.a ^ result) & (m ^ result) & 0x80) !== 0);
      this.setFlag(Flags.C, result > 0xff);
      this.a = result & 0x00ff;
    }

    this.setFlag(Flags.Z, this.a === 0);
    this.setFlag(Flags.N, (this.a & 0x80) !== 0);
    return 0;
  }

  private AND(): number {
    const m = this.bus.read(this.addr);

    this.a = this.a & m;
    this.setFlag(Flags.Z, this.a === 0x00);
    this.setFlag(Flags.N, (this.a & 0x80) !== 0);
    return 0;
  }

  private ASL(): number {
    const implied: boolean = this.currentInstruction.addressing === 'ACC';
    const data: number = implied ? this.a : this.bus.read(this.addr);
    const result: number = (data << 1) & 0x00ff;

    this.setFlag(Flags.C, (data & 0x80) !== 0);
    this.setFlag(Flags.N, (result & 0x80) !== 0);
    this.setFlag(Flags.Z, (result & 0xff) === 0);

    if (implied === true) {
      this.a = result;
    } else {
      this.bus.write(this.addr, result);
    }
    return 0;
  }

  private BCC(): number {
    if (this.getFlag(Flags.C) === 1) {
      return 0;
    }
    const oldAddress = this.pc;

    this.pc = (oldAddress + this.addr) & 0xffff;
    return (this.pc & 0xff00) !== (oldAddress & 0xff00) ? 2 : 1;
  }

  private BCS(): number {
    if (this.getFlag(Flags.C) === 0) {
      return 0;
    }
    const oldAddress = this.pc;

    this.pc = (oldAddress + this.addr) & 0xffff;
    return (this.pc & 0xff00) !== (oldAddress & 0xff00) ? 2 : 1;
  }

  private BEQ(): number {
    if (this.getFlag(Flags.Z) === 0) {
      return 0;
    }
    const oldAddress = this.pc;

    this.pc = (oldAddress + this.addr) & 0xffff;
    return (this.pc & 0xff00) !== (oldAddress & 0xff00) ? 2 : 1;
  }

  private BIT(): number {
    const m = this.bus.read(this.addr);
    const result = this.a & m;

    this.setFlag(Flags.Z, result === 0x00);
    this.setFlag(Flags.V, (m & 0x40) !== 0);
    this.setFlag(Flags.N, (m & 0x80) !== 0);
    return 0;
  }

  private BMI(): number {
    if (this.getFlag(Flags.N) === 0) {
      return 0;
    }
    const oldAddress = this.pc;

    this.pc = (oldAddress + this.addr) & 0xffff;
    return (this.pc & 0xff00) !== (oldAddress & 0xff00) ? 2 : 1;
  }

  private BNE(): number {
    if (this.getFlag(Flags.Z) === 1) {
      return 0;
    }
    const oldAddress = this.pc;

    this.pc = (oldAddress + this.addr) & 0xffff;
    return (this.pc & 0xff00) !== (oldAddress & 0xff00) ? 2 : 1;
  }

  private BPL(): number {
    if (this.getFlag(Flags.N) === 1) {
      return 0;
    }
    const oldAddress = this.pc;

    this.pc = (oldAddress + this.addr) & 0xffff;
    return (this.pc & 0xff00) !== (oldAddress & 0xff00) ? 2 : 1;
  }

  private BRK(): number {
    //todo: find offset of stack
    const low = this.bus.read(0xfffe);
    const high = this.bus.read(0xffff);

    this.setFlag(Flags.B, true);
    this.pc = this.pc + 1;
    this.bus.write(0x100 + this.stkp, (this.pc >> 8) & 0x00ff);
    this.bus.write(0x100 + this.stkp - 1, this.pc & 0x00ff);
    this.bus.write(0x100 + this.stkp - 2, this.status);
    this.setFlag(Flags.I, true);
    this.stkp = this.stkp - 3;
    this.pc = ((high << 8) | low) & 0xffff;
    return 0;
  }

  private BVC(): number {
    if (this.getFlag(Flags.V) === 1) {
      return 0;
    }

    const oldAddress = this.pc;

    this.pc = (oldAddress + this.addr) & 0xffff;
    return (this.pc & 0xff00) !== (oldAddress & 0xff00) ? 2 : 1;
  }

  private BVS(): number {
    if (this.getFlag(Flags.V) === 0) {
      return 0;
    }
    const oldAddress = this.pc;

    this.pc = (oldAddress + this.addr) & 0xffff;
    return (this.pc & 0xff00) !== (oldAddress & 0xff00) ? 2 : 1;
  }

  private CLC(): number {
    this.setFlag(Flags.C, false);
    return 0;
  }

  private CLD(): number {
    this.setFlag(Flags.D, false);
    return 0;
  }

  private CLI(): number {
    this.setFlag(Flags.I, false);
    return 0;
  }

  private CLV(): number {
    this.setFlag(Flags.V, false);
    return 0;
  }

  private CMP(): number {
    const m = this.bus.read(this.addr);

    this.setFlag(Flags.Z, this.a === m);
    this.setFlag(Flags.C, this.a >= m);
    this.setFlag(Flags.N, ((this.a - m) & 0xff & 0x80) !== 0);
    return 0;
  }

  private CPX(): number {
    const m = this.bus.read(this.addr);

    this.setFlag(Flags.Z, this.x === m);
    this.setFlag(Flags.C, this.x >= m);
    this.setFlag(Flags.N, ((this.x - m) & 0xff & 0x80) !== 0);
    return 0;
  }

  private CPY(): number {
    const m = this.bus.read(this.addr);

    this.setFlag(Flags.Z, this.y === m);
    this.setFlag(Flags.C, this.y >= m);
    this.setFlag(Flags.N, ((this.y - m) & 0xff & 0x80) !== 0);
    return 0;
  }

  private DEC(): number {
    const m = this.bus.read(this.addr);
    const result = (m - 1) & 0x00ff;

    this.bus.write(this.addr, result);
    this.setFlag(Flags.Z, result === 0);
    this.setFlag(Flags.N, (result & 0x80) !== 0);
    return 0;
  }

  private DEX(): number {
    this.x = (this.x - 1) & 0x00ff;

    this.setFlag(Flags.Z, this.x === 0x00);
    this.setFlag(Flags.N, (this.x & 0x80) !== 0);
    return 0;
  }

  private DEY(): number {
    this.y = (this.y - 1) & 0x00ff;

    this.setFlag(Flags.Z, this.y === 0x00);
    this.setFlag(Flags.N, (this.y & 0x80) !== 0);
    return 0;
  }

  private EOR(): number {
    const m = this.bus.read(this.addr);

    this.a = this.a ^ m;
    this.setFlag(Flags.Z, this.a === 0x00);
    this.setFlag(Flags.N, (this.a & 0x80) !== 0);
    return 0;
  }

  private INC(): number {
    const m = this.bus.read(this.addr);
    const result = (m + 1) & 0xff;

    this.bus.write(this.addr, result);
    this.setFlag(Flags.Z, result == 0x00);
    this.setFlag(Flags.N, (result & 0x80) !== 0);
    return 0;
  }

  private INX(): number {
    this.x = (this.x + 1) & 0xff;

    this.setFlag(Flags.Z, this.x == 0x00);
    this.setFlag(Flags.N, (this.x & 0x80) !== 0);
    return 0;
  }

  private INY(): number {
    this.y = (this.y + 1) & 0xff;

    this.setFlag(Flags.Z, this.y == 0x00);
    this.setFlag(Flags.N, (this.y & 0x80) !== 0);
    return 0;
  }

  private JMP(): number {
    this.pc = this.addr;
    return 0;
  }

  private JSR(): number {
    this.pc = this.pc - 1;
    this.bus.write(0x100 + this.stkp, (this.pc >> 8) & 0x00ff);
    this.bus.write(0x100 + this.stkp - 1, this.pc & 0x00ff);
    this.stkp = this.stkp - 2;
    this.pc = this.addr;
    return 0;
  }

  private LDA(): number {
    this.a = this.bus.read(this.addr);
    this.setFlag(Flags.Z, this.a === 0x00);
    this.setFlag(Flags.N, (this.a & 0x80) !== 0);
    return 0;
  }

  private LDX(): number {
    this.x = this.bus.read(this.addr);
    this.setFlag(Flags.Z, this.x === 0x00);
    this.setFlag(Flags.N, (this.x & 0x80) !== 0);
    return 0;
  }

  private LDY(): number {
    this.y = this.bus.read(this.addr);
    this.setFlag(Flags.Z, this.y === 0x00);
    this.setFlag(Flags.N, (this.y & 0x80) !== 0);
    return 0;
  }

  private LSR(): number {
    const implied: boolean = this.currentInstruction.addressing === 'ACC';
    const data: number = (implied ? this.a : this.bus.read(this.addr)) & 0xff;
    const result: number = (data >> 1) & 0xff;

    this.setFlag(Flags.C, (data & 0x01) !== 0);
    this.setFlag(Flags.N, false);
    this.setFlag(Flags.Z, result === 0);
    if (implied === true) {
      this.a = result;
    } else {
      this.bus.write(this.addr, result);
    }
    return 0;
  }

  private NOP(): number {
    return 0;
  }

  private ORA(): number {
    const m = this.bus.read(this.addr);

    this.a = this.a | m;

    this.setFlag(Flags.Z, this.a === 0x00);
    this.setFlag(Flags.N, (this.a & 0x80) !== 0);
    return 0;
  }

  private PHA(): number {
    this.bus.write(0x100 + this.stkp, this.a);
    this.stkp = (this.stkp - 1) & 0xff;
    return 0;
  }

  private PHP(): number {
    this.bus.write(0x100 + this.stkp, this.status | 0x30);
    this.stkp = (this.stkp - 1) & 0xff;
    return 0;
  }

  private PLA(): number {
    this.stkp = this.stkp + 1;
    this.a = this.bus.read(0x100 + this.stkp);
    this.setFlag(Flags.Z, this.a === 0);
    this.setFlag(Flags.N, (this.a & 0x80) !== 0);
    return 0;
  }

  private PLP(): number {
    // break flag set and unused flag set
    this.stkp = (this.stkp + 1) & 0xff;
    this.status = this.bus.read(0x100 + this.stkp);
    this.setFlag(Flags.B, false);
    this.setFlag(Flags.A, true);
    return 0;
  }

  private ROL(): number {
    const m = this.currentInstruction.addressing === 'ACC' ? this.a : this.bus.read(this.addr);
    const result = (m << 1) | this.getFlag(Flags.C);

    this.setFlag(Flags.C, (result & 0x0100) != 0);
    this.setFlag(Flags.Z, (result & 0x00ff) === 0);
    this.setFlag(Flags.N, (result & 0x80) !== 0);
    if (this.currentInstruction.addressing === 'ACC') {
      this.a = result & 0x00ff;
    } else {
      this.bus.write(this.addr, result & 0x00ff);
    }
    return 0;
  }

  private ROR(): number {
    const m = this.currentInstruction.addressing === 'ACC' ? this.a : this.bus.read(this.addr);
    const result = (m >> 1) | (this.getFlag(Flags.C) << 7);

    this.setFlag(Flags.C, (m & 0x01) !== 0);
    this.setFlag(Flags.Z, (result & 0x00ff) === 0);
    this.setFlag(Flags.N, (result & 0x80) !== 0);
    if (this.currentInstruction.addressing === 'ACC') {
      this.a = result & 0x00ff;
    } else {
      this.bus.write(this.addr, result & 0x00ff);
    }
    return 0;
  }

  private RTI(): number {
    // to check back
    const lo = this.bus.read(0x100 + this.stkp + 2);
    const hi = this.bus.read(0x100 + this.stkp + 3);

    this.status = this.bus.read(0x100 + this.stkp + 1);
    this.setFlag(Flags.B, true);
    this.pc = (hi << 8) | lo;
    this.stkp = this.stkp + 3;
    return 0;
  }

  private RTS(): number {
    const lo = this.bus.read(0x100 + this.stkp + 1);
    const hi = this.bus.read(0x100 + this.stkp + 2);

    this.pc = ((hi << 8) | lo) + 1;
    this.stkp = (this.stkp + 2) & 0xff;
    return 0;
  }

  private SBC(): number {
    const m = this.bus.read(this.addr);
    const carry = this.getFlag(Flags.C) ? 1 : 0;
    const decimalMode = this.getFlag(Flags.D);
    let result: number;

    if (decimalMode) {
      let lowNibble = (this.a & 0x0f) - (m & 0x0f) - (1 - carry);
      let highNibble = (this.a >> 4) - (m >> 4);

      if (lowNibble < 0) {
        lowNibble -= 6;
        highNibble--;
      }

      if (highNibble < 0) {
        highNibble -= 6;
      }

      result = (highNibble << 4) | (lowNibble & 0x0f);
    } else {
      result = this.a - m - (1 - carry);
    }

    // Set Zero flag (Z)
    this.setFlag(Flags.Z, (result & 0x00ff) === 0);

    // Set Negative flag (N)
    this.setFlag(Flags.N, (result & 0x80) !== 0);

    // Set Overflow flag (V)
    this.setFlag(Flags.V, ((this.a ^ result) & (this.a ^ m) & 0x80) !== 0);

    // Set Carry flag (C)
    this.setFlag(Flags.C, result >= 0);

    this.a = result & 0xff;
    return 0;
  }

  private SEC(): number {
    this.setFlag(Flags.C, true);
    return 0;
  }

  private SED(): number {
    this.setFlag(Flags.D, true);
    return 0;
  }

  private SEI(): number {
    this.setFlag(Flags.I, true);
    return 0;
  }

  private STA(): number {
    this.bus.write(this.addr, this.a);
    return 0;
  }

  private STX(): number {
    this.bus.write(this.addr, this.x);
    return 0;
  }

  private STY(): number {
    this.bus.write(this.addr, this.y);
    return 0;
  }

  private TAX(): number {
    this.x = this.a;
    this.setFlag(Flags.Z, this.x === 0x00);
    this.setFlag(Flags.N, (this.x & 0x80) !== 0);
    return 0;
  }

  private TAY(): number {
    this.y = this.a;
    this.setFlag(Flags.Z, this.y === 0x00);
    this.setFlag(Flags.N, (this.y & 0x80) !== 0);
    return 0;
  }

  private TSX(): number {
    this.x = this.stkp;
    this.setFlag(Flags.Z, this.x === 0x00);
    this.setFlag(Flags.N, (this.x & 0x80) !== 0);
    return 0;
  }

  private TXA(): number {
    this.a = this.x;
    this.setFlag(Flags.Z, this.a === 0x00);
    this.setFlag(Flags.N, (this.a & 0x80) !== 0);
    return 0;
  }

  private TXS(): number {
    this.stkp = this.x;
    return 0;
  }

  private TYA(): number {
    this.a = this.y;
    this.setFlag(Flags.Z, this.a === 0x00);
    this.setFlag(Flags.N, (this.a & 0x80) !== 0);
    return 0;
  }

  private ILL(): number {
    return 0;
  }

  /**
   * Debug functions
   */

  private getProcessorStatus(start: number): ProcessorStatus {
    const info: Array<DebugInfo> = [];
    let pc = start;

    if (this.debug === false) {
      info.push(this.disass2(start).info);
    } else {
      while (pc < start + 16) {
        const data = this.disass2(pc);
        pc = data.pc;
        info.push(data.info);
      }
    }
    return {
      info,
      registers: {
        a: this.a,
        x: this.x,
        y: this.y,
        stkp: this.stkp,
        status: {
          n: this.getFlag(Flags.N),
          v: this.getFlag(Flags.V),
          d: this.getFlag(Flags.D),
          i: this.getFlag(Flags.I),
          z: this.getFlag(Flags.Z),
          c: this.getFlag(Flags.C),
        },
      },
    };
  }

  private disass2(pc: number) {
    const info: DebugInfo = {
      address: pc,
      instruction: [],
      disassembly: { operand: 0, addressingMode: 'IMP', instruction: '???' },
    };
    const opcode = this.bus.read(pc);
    const op = decode(opcode);

    info.instruction.push(opcode & 0xff);
    info.disassembly.instruction = op.instruction;
    info.disassembly.addressingMode = op.addressing;
    pc++;
    if (info.disassembly.instruction === 'BRK') {
      info.disassembly.operand = (this.bus.read(0xffff) << 8) | this.bus.read(0xfffe);
    }
    if (info.disassembly.addressingMode === 'IMM') {
      info.instruction.push(this.bus.read(pc));
      info.disassembly.operand = info.instruction[1];
      pc++;
    } else if (
      info.disassembly.addressingMode === 'ABS' ||
      info.disassembly.addressingMode === 'ABX' ||
      info.disassembly.addressingMode === 'ABY' ||
      info.disassembly.addressingMode === 'IND'
    ) {
      info.instruction.push(this.bus.read(pc));
      pc++;
      info.instruction.push(this.bus.read(pc));
      pc++;
      info.disassembly.operand = ((info.instruction[2] << 8) | info.instruction[1]) & 0xffff;
    } else if (
      info.disassembly.addressingMode === 'INX' ||
      info.disassembly.addressingMode === 'INY' ||
      info.disassembly.addressingMode === 'ZPI' ||
      info.disassembly.addressingMode === 'ZPX' ||
      info.disassembly.addressingMode === 'ZPY'
    ) {
      info.instruction.push(this.bus.read(pc));
      pc++;
      info.disassembly.operand = info.instruction[1];
    } else if (info.disassembly.addressingMode === 'REL') {
      info.instruction.push(this.bus.read(pc));
      pc++;
      const offset = info.instruction[1] > 127 ? info.instruction[1] - 256 : info.instruction[1];
      info.disassembly.operand = pc + offset;
    }
    return {
      info,
      pc,
    };
  }
}
