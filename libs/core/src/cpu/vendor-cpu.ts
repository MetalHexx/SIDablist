import { mos6502, decode as decodeOpcode } from '../vendor/mos6502/index.js';
import type { Cpu6502, Cpu6502Bus, CpuState } from './cpu-port.js';

const ILLEGAL_OPCODE_MNEMONIC = '???';

/** The instance shape `mos6502` describes. */
type Mos6502Instance = InstanceType<typeof mos6502>;

/**
 * The `mos6502` instance fields carrying execution state.
 *
 * The core declares every one of them `private` and its own `getState()` returns a differently
 * shaped debug snapshot with no matching setter, so a restore has to assign these directly — they
 * are ordinary runtime properties whatever TypeScript says. `assertCpuStateKeys` turns a future
 * upstream rename of one of them into a loud failure at construction, instead of a cue hop that
 * restores incomplete CPU state and plays silence with no error.
 */
const CPU_STATE_KEYS = [
  'a',
  'x',
  'y',
  'pc',
  'stkp',
  'status',
  'addr',
  'currentInstruction',
  'cycle',
] as const;

/**
 * Throws when `record` is missing any field `CPU_STATE_KEYS` names. Exported so the guard can be
 * exercised directly against a deliberately incomplete object, rather than requiring a real
 * `mos6502` instance to be broken to prove it fires.
 */
export function assertCpuStateKeys(record: Record<string, unknown>): void {
  const missing = CPU_STATE_KEYS.filter((key) => !(key in record));
  if (missing.length > 0) {
    throw new Error(
      `mos6502 no longer exposes ${missing.join(', ')} — cue snapshots would restore incomplete CPU ` +
        `state without saying so. Check the pinned mos6502 version before changing CPU_STATE_KEYS.`,
    );
  }
}

/** The adapter over the vendored `mos6502` core. Unexported: construct only through `createVendorCpu`. */
class VendorCpu implements Cpu6502 {
  private readonly cpu: Mos6502Instance;

  constructor(bus: Cpu6502Bus) {
    // The core resets inside its own constructor, reading $FFFC/$FFFD back through the bus, so the
    // bus has to be ready before this runs. It is handed over as it is: the core calls it directly
    // at every access, with no wrapper between. Built without `debug`, so a step does none of the
    // core's disassembly or register snapshotting.
    this.cpu = new mos6502(bus);
    assertCpuStateKeys(this.cpu as unknown as Record<string, unknown>);
  }

  emulate(): void {
    this.cpu.emulate();
  }

  reset(): void {
    this.cpu.reset();
  }

  decode(opcode: number): { readonly illegal: boolean } {
    return { illegal: decodeOpcode(opcode).instruction === ILLEGAL_OPCODE_MNEMONIC };
  }

  getState(): CpuState {
    const state: Record<string, unknown> = {};
    const record = this.cpu as unknown as Record<string, unknown>;
    for (const key of CPU_STATE_KEYS) {
      state[key] = record[key];
    }
    return state;
  }

  /**
   * Written out field by field rather than looped over `CPU_STATE_KEYS`: a keyed load of a field the
   * core holds as a double (`addr`, `cycle`) boxes a fresh number on every call, and a capture on the
   * frame path copies this every few frames. Keep it in step with `CPU_STATE_KEYS`;
   * `vendor-cpu.spec.ts` compares the two.
   */
  copyStateInto(target: Record<string, unknown>): void {
    const cpu = this.cpu as unknown as Record<string, unknown>;
    target.a = cpu.a;
    target.x = cpu.x;
    target.y = cpu.y;
    target.pc = cpu.pc;
    target.stkp = cpu.stkp;
    target.status = cpu.status;
    target.addr = cpu.addr;
    target.currentInstruction = cpu.currentInstruction;
    target.cycle = cpu.cycle;
  }

  /** Field by field for the reason `copyStateInto` is: a lap and a hand-off restore on the frame
   *  path. Keep it in step with `CPU_STATE_KEYS`. */
  setState(state: CpuState): void {
    const cpu = this.cpu as unknown as Record<string, unknown>;
    cpu.a = state.a;
    cpu.x = state.x;
    cpu.y = state.y;
    cpu.pc = state.pc;
    cpu.stkp = state.stkp;
    cpu.status = state.status;
    cpu.addr = state.addr;
    cpu.currentInstruction = state.currentInstruction;
    cpu.cycle = state.cycle;
  }
}

/** A record carrying every `CPU_STATE_KEYS` field, for `copyStateInto` to fill in place. Allocated
 *  with all its keys so the copy itself only assigns. */
export function createCpuStateRecord(): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  for (const key of CPU_STATE_KEYS) {
    state[key] = 0;
  }
  return state;
}

/** Builds a `Cpu6502` over the vendored `mos6502` core, wired to `bus` for every read and write. */
export function createVendorCpu(bus: Cpu6502Bus): Cpu6502 {
  return new VendorCpu(bus);
}
