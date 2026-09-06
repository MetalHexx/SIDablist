/**
 * Vendored from mos6502 v1.1.1 <https://github.com/kgtrey1/mos6502>, MIT licensed, by Kevin Gouyet.
 * This file has been modified from the original upstream source; see ./README.md.
 */

export type AddressingModes =
  | 'ACC'
  | 'IMP'
  | 'IMM'
  | 'ABS'
  | 'ABX'
  | 'ABY'
  | 'IND'
  | 'INX'
  | 'INY'
  | 'REL'
  | 'ZPI'
  | 'ZPX'
  | 'ZPY';

export type AddressingModesMap = { [code in AddressingModes]: () => number };
