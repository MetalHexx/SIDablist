/**
 * The narrow seam between the timeline engine and whatever 6502 core drives it, designed from the
 * machine-image path — snapshot and restore — rather than from "run cycles". A cue hop is a
 * restore, so a port that cannot get and set CPU registers cannot serve one. This is what lets an
 * RSID-capable core drop in later without touching anything above it.
 */

/** The execution-state fields a machine image round-trips. Named, not positional, and readonly
 *  so an image cannot be edited in place after capture. Values are whatever the emulator holds
 *  in the fields `CPU_STATE_KEYS` names — carry the union across from the vendored source rather
 *  than narrowing it here; `currentInstruction` in particular is not a number or a boolean. */
export type CpuState = Readonly<Record<string, unknown>>;

/** The address space a `Cpu6502` reads and writes; the machine that owns the memory map implements it. */
export interface Cpu6502Bus {
  read(address: number): number;
  write(address: number, value: number): void;
}

/**
 * A cycle-stepped 6502 core.
 *
 * Cycle-stepped, not instruction-stepped: a caller drives `emulate()` once per cycle, incrementing
 * its own budget by one each call. An instruction-stepping port cannot express the per-cycle bus
 * expectations a caller like `C64Machine` rides its opcode classification and idle detection on.
 */
export interface Cpu6502 {
  /** Advances the core by exactly one cycle. The caller counts cycles against its own budget
   *  and sets up its per-cycle bus expectations before each call. */
  emulate(): void;
  /** Drives the reset vector; the bus supplies the vector bytes. */
  reset(): void;
  /** Decodes an opcode byte for the illegal-opcode table `C64Machine` builds at module load.
   *  Exposed because that table is built once, statically, and has no other route to `decode`. */
  decode(opcode: number): { readonly illegal: boolean };
  getState(): CpuState;
  setState(state: CpuState): void;
}
