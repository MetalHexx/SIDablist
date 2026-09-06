/**
 * Vendored from mos6502 v1.1.1 <https://github.com/kgtrey1/mos6502>, MIT licensed, by Kevin Gouyet.
 * This file has been modified from the original upstream source; see ../README.md.
 */

export interface RegistersInfo {
  a: number;
  x: number;
  y: number;
  stkp: number;
  status: {
    n: number;
    v: number;
    d: number;
    i: number;
    z: number;
    c: number;
  };
}
