/**
 * Vendored from mos6502 v1.1.1 <https://github.com/kgtrey1/mos6502>, MIT licensed, by Kevin Gouyet.
 * This file has been modified from the original upstream source; see ./README.md.
 */

import type { DebugInfo } from './types/debug.js';
import type { RegistersInfo } from './types/register.js';

export const hex = (value: number, padding: number = 2): string => {
  let h = value.toString(16);

  if (h.length < padding) {
    const length = h.length;

    for (let i = 0; i + length < padding; i++) {
      h = '0' + h;
    }
  }
  return h.toUpperCase();
};

const adjustColumn = (content: string, minLength: number): string => {
  if (content.length === minLength) {
    return content;
  }
  for (let i = 0; content.length < minLength; i++) {
    content += ' ';
  }
  return content;
};

export const formatRegisters = (el: RegistersInfo) => {
  let register = `|${hex(el.a)} ${hex(el.x)} ${hex(el.y)} ${hex(el.stkp)}|`;
  let status = `${el.status.n}${el.status.v}${el.status.d}${el.status.i}${el.status.z}${el.status.c}|`;

  return register + status;
};

export const formatDisassembly = (el: DebugInfo) => {
  let instruction = '';
  let disass = '';

  for (const byte of el.instruction) {
    instruction += `${hex(byte)} `;
  }
  disass += `${el.disassembly.instruction} `;

  if (el.disassembly.addressingMode === 'ACC') {
    disass += `A`;
  } else if (el.disassembly.addressingMode === 'IMM') {
    disass += `#$${hex(el.instruction[1], 2)}`;
  } else if (
    el.disassembly.addressingMode === 'ZPI' ||
    el.disassembly.addressingMode === 'ZPX' ||
    el.disassembly.addressingMode === 'ZPY'
  ) {
    let index = '';

    if (el.disassembly.addressingMode !== 'ZPI') {
      index = el.disassembly.addressingMode === 'ZPX' ? ',X' : ',Y';
    }
    disass += `$${hex(el.instruction[1], 2)}${index}`;
  } else if (
    el.disassembly.addressingMode === 'ABS' ||
    el.disassembly.addressingMode === 'REL' ||
    el.disassembly.addressingMode === 'IND'
  ) {
    if (el.disassembly.instruction === 'JMP' && el.disassembly.addressingMode === 'IND') {
      disass += `($${hex(el.disassembly.operand, 4)})`;
    } else {
      disass += `$${hex(el.disassembly.operand, 4)}`;
    }
  } else if (el.disassembly.addressingMode === 'ABX' || el.disassembly.addressingMode === 'ABY') {
    disass += `$${hex(el.disassembly.operand, 4)}${el.disassembly.addressingMode === 'ABX' ? ',X' : ',Y'}`;
  } else if (el.disassembly.addressingMode === 'INX' || el.disassembly.addressingMode === 'INY') {
    disass += `($${hex(el.instruction[1], 2)}${el.disassembly.addressingMode === 'INX' ? ',X)' : '),Y'}`;
  }
  return `${hex(el.address, 4)} ${adjustColumn(instruction, 9)} ${adjustColumn(disass, 14)}`;
};

// 0401 A2 FF     LDX #$FF      |00 FF 00 FF|100100|2 - IMM - done

// 26E6 6E 03 02  ROR $0203     |00 03 04 FF|100000|6 - ABS - done
// 3802 BD 02 01  LDA $0102,X   |FF FB B1 FB|111101|4 - ABX - done
// 0E65 D9 17 02  CMP $0217,Y   |82 82 01 FE|000011|4 - ABY - done

// 045F 4C E5 04  JMP $04E5     |00 FD FD FF|000110|3 - IND - done
// 179F A1 24     LDA ($24,X)   |00 06 03 FF|000010|6 - INX
// 179F A1 24     LDA ($24,Y)   |00 06 03 FF|000010|6 - INY

// 0433 D0 F4     BNE $0429     |00 05 00 FF|000100|3 - REL - done

// 2AE9 85 0C     STA $0C       |81 01 04 FF|111101|3 - ZPI - done
// 2BB7 95 0C     STA $0C,X     |7F 01 04 FF|100000|4 - ZPX - done
// 2BB7 95 0C     STA $0C,Y     |7F 01 04 FF|100000|4 - ZPY? - done

// No ZPY
