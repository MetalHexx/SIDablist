import { mos6502, decode as decodeOpcode } from '../vendor/mos6502/index.js';
import type { Cpu6502, Cpu6502Bus, CpuState } from './cpu-port.js';

const ILLEGAL_OPCODE_MNEMONIC = '???';

const IDLE_PROCESSOR_STATUS = { info: [], registers: null };

/**
 * `mos6502` with its per-instruction debug work removed.
 *
 * The base class disassembles the current instruction and snapshots the registers on every
 * instruction boundary even with debug output unused — several objects and extra bus reads, purely
 * to fill a return value nothing here reads. `emulate` dispatches on `this`, so shadowing the method
 * on the subclass prototype removes the whole path. It is shadowed rather than declared as an
 * `override` because the base class types it `private`, so TypeScript will not let a subclass
 * redeclare it. This is the one behavioural adjustment the vendoring makes, and it belongs here in
 * the adapter rather than in the vendored files, which the conversion task keeps to a pure port.
 */
class QuietMos6502 extends mos6502 {}
Object.defineProperty(QuietMos6502.prototype, 'getProcessorStatus', {
  value: () => IDLE_PROCESSOR_STATUS,
});

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
    // The core resets inside its own constructor, reading $FFFC/$FFFD back through this callback,
    // so the bus has to be ready before this runs.
    this.cpu = new QuietMos6502(
      (address: number): number => bus.read(address),
      (address: number, value: number): void => bus.write(address, value),
    );
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
    const record = this.cpu as unknown as Record<string, unknown>;
    const state: Record<string, unknown> = {};
    for (const key of CPU_STATE_KEYS) {
      state[key] = record[key];
    }
    return state;
  }

  setState(state: CpuState): void {
    const record = this.cpu as unknown as Record<string, unknown>;
    for (const key of CPU_STATE_KEYS) {
      record[key] = state[key];
    }
  }
}

/** Builds a `Cpu6502` over the vendored `mos6502` core, wired to `bus` for every read and write. */
export function createVendorCpu(bus: Cpu6502Bus): Cpu6502 {
  return new VendorCpu(bus);
}
