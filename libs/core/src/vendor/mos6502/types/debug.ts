/**
 * Vendored from mos6502 v1.1.1 <https://github.com/kgtrey1/mos6502>, MIT licensed, by Kevin Gouyet.
 * This file has been modified from the original upstream source; see ../README.md.
 */

import type { Instructions } from '../instructions.js';
import type { AddressingModes } from '../addressing.js';

export interface DebugInfo {
  address: number;
  instruction: Array<number>;
  disassembly: {
    instruction: Instructions;
    addressingMode: AddressingModes;
    operand: number;
  };
}
// ABX, no ()
// INX, ()

// IMM: #$1STBIT
//
