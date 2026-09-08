/**
 * Vendored from mos6502 v1.1.1 <https://github.com/kgtrey1/mos6502>, MIT licensed, by Kevin Gouyet.
 * This file has been modified from the original upstream source; see ./README.md.
 */

import type { AddressingModes } from './addressing.js';

export type Instructions =
  | 'ADC'
  | 'AND'
  | 'ASL'
  | 'BCC'
  | 'BCS'
  | 'BEQ'
  | 'BIT'
  | 'BMI'
  | 'BNE'
  | 'BPL'
  | 'BRK'
  | 'BVC'
  | 'BVS'
  | 'CLC'
  | 'CLD'
  | 'CLI'
  | 'CLV'
  | 'CMP'
  | 'CPX'
  | 'CPY'
  | 'DEC'
  | 'DEX'
  | 'DEY'
  | 'EOR'
  | 'INC'
  | 'INX'
  | 'INY'
  | 'JMP'
  | 'JSR'
  | 'LDA'
  | 'LDX'
  | 'LDY'
  | 'LSR'
  | 'NOP'
  | 'ORA'
  | 'PHA'
  | 'PHP'
  | 'PLA'
  | 'PLP'
  | 'ROL'
  | 'ROR'
  | 'RTI'
  | 'RTS'
  | 'SBC'
  | 'SEC'
  | 'SED'
  | 'SEI'
  | 'STA'
  | 'STX'
  | 'STY'
  | 'TAX'
  | 'TAY'
  | 'TSX'
  | 'TXA'
  | 'TXS'
  | 'TYA'
  | '???';

export interface Instruction {
  instruction: Instructions;
  addressing: AddressingModes;
  cycles: number;
}

export type InstructionsMap = { [code in Instructions]: () => number };
