import type { SidFile } from '../sid/sid-file.model.js';
import { cycles, type Cycles } from '../units.js';
import { createCpuStateRecord, createVendorCpu } from './vendor-cpu.js';
import type { Cpu6502, Cpu6502Bus, CpuState } from './cpu-port.js';
import {
  BRK_HANDLER_STUB,
  CHIP_REGISTERS_FIRST,
  CHIP_REGISTERS_LAST,
  CIA1_INTERRUPT_CONTROL,
  CIA2_INTERRUPT_CONTROL,
  CIA_INTERRUPT_TIMER_A_SET,
  FIRST_RELOCATABLE_PAGE,
  INIT_BUDGET_FRAMES,
  INTERRUPT_CONTINUATION_LENGTH,
  INTERRUPT_ENTRY_EXTRA_CYCLES_HARDWARE,
  INTERRUPT_ENTRY_EXTRA_CYCLES_KERNAL,
  INTERRUPT_STATUS_BYTE,
  IO_FIRST_PAGE,
  IO_LAST_PAGE,
  IRQ_ACKNOWLEDGE_STUB,
  IRQ_HANDLER_STUB,
  IRQ_RESTORE_STUB,
  IRQ_VECTOR_HARDWARE,
  IRQ_VECTOR_KERNAL,
  KERNAL_STUB_ADDRESSES,
  LAST_RELOCATABLE_PAGE,
  MAX_CALLS_PER_FRAME,
  MEMORY_SIZE,
  NTSC_CYCLES_PER_FRAME,
  NTSC_CYCLES_PER_RASTER_LINE,
  NTSC_RASTER_LINES,
  OPCODE_JMP_ABSOLUTE,
  OPCODE_JSR_ABSOLUTE,
  OPCODE_LDA_ABSOLUTE,
  OPCODE_LDA_IMMEDIATE,
  OPCODE_PHA,
  OPCODE_PLA,
  OPCODE_RTI,
  OPCODE_RTS,
  OPCODE_TAX,
  OPCODE_TAY,
  PAL_CYCLES_PER_FRAME,
  PAL_CYCLES_PER_RASTER_LINE,
  PAL_RASTER_LINES,
  PLAY_BUDGET_FRAMES,
  PSID_DEFAULT_TIMER_A_LATCH_NTSC,
  PSID_DEFAULT_TIMER_A_LATCH_PAL,
  RESET_VECTOR,
  SID_LAST_AUDIBLE_REGISTER,
  SID_RANGE_END,
  SID_RANGE_START,
  SID_REGISTER_MASK,
  TRAMPOLINE_BASE,
  TRAMPOLINE_IDLE_OFFSET,
  TRAMPOLINE_INIT_OFFSET,
  TRAMPOLINE_INTERRUPT_HANDLER_OFFSET,
  TRAMPOLINE_INTERRUPT_HARDWARE_OFFSET,
  TRAMPOLINE_INTERRUPT_KERNAL_OFFSET,
  TRAMPOLINE_INTERRUPT_LENGTH,
  TRAMPOLINE_INTERRUPT_TAIL_OFFSET,
  TRAMPOLINE_LENGTH,
  TRAMPOLINE_PLAY_OFFSET,
  TRAMPOLINE_PLAY_TARGET_OFFSET,
  VIC_CONTROL_IDLE_BITS,
  VIC_CONTROL_REGISTER,
  VIC_RASTER_REGISTER,
} from './cpu-constants.js';
import { CALL_CIA, CALL_RASTER, CHIP_STATE_LENGTH, IoChips } from './io-chips.js';

/** Receives every write a tune makes into the SID's address range. */
export interface SidWriteSink {
  /** `register` is 0..24 — the audible registers. Writes to 25..31 never reach here. */
  onSidWrite(register: number, value: number): void;
}

/** The outcome of one emulated routine call. */
export interface FrameResult {
  readonly cyclesUsed: number;
  /** `false` means the cycle budget ran out before the routine returned — the tune is broken. */
  readonly completed: boolean;
}

/** Thrown when a tune exposes no usable play address, so there is nothing to call each frame. */
export class UnplayableTuneError extends Error {}

/** One entry per opcode byte, 1 where the core's decoder falls through to its 2-cycle no-op. */
function buildIllegalOpcodeTable(cpu: Cpu6502): Uint8Array {
  const table = new Uint8Array(256);
  for (let opcode = 0; opcode < table.length; opcode++) {
    table[opcode] = cpu.decode(opcode).illegal ? 1 : 0;
  }
  return table;
}

/**
 * Everything about a running machine that changes as it runs.
 *
 * Configuration fixed at construction — the file, the sink, the clock-derived cycle counts — is
 * deliberately absent: a snapshot is only ever restored into the machine it was taken from.
 */
export interface MachineSnapshot {
  readonly memory: Uint8Array;
  readonly cpu: CpuState;
  readonly trampoline: number;
  readonly idleAddress: number;
  readonly playAddress: number;
  /**
   * The VIC's raster flag and enables, both CIAs' counters, latches, controls, flags and enables,
   * and the cycle count placing each call in time, in the fixed layout `io-chips.ts` documents. The
   * play rate is read from it. A typed array, so a snapshot still structured-clones to and from the
   * replay worker and a capture copies it with `set`.
   */
  readonly chips: Float64Array;
  /** The played song's bit of the header's speed word, the other input of the play rate. */
  readonly speedBit: number;
  readonly cyclesThisCall: number;
  readonly reachedIdle: boolean;
  readonly expectingOpcodeFetch: boolean;
  readonly illegalOpcodes: number;
}

/**
 * A `MachineSnapshot` the holder may refill in place — what `snapshotInto` writes, and what a pool
 * of images allocates once. Structurally a `MachineSnapshot`, so it restores like any other.
 */
export interface WritableMachineSnapshot {
  readonly memory: Uint8Array;
  readonly cpu: Record<string, unknown>;
  trampoline: number;
  idleAddress: number;
  playAddress: number;
  readonly chips: Float64Array;
  speedBit: number;
  cyclesThisCall: number;
  reachedIdle: boolean;
  expectingOpcodeFetch: boolean;
  illegalOpcodes: number;
}

/** An image holding nothing yet, for `snapshotInto` or `copyMachineImage` to fill. Allocates the
 *  64 KB address space and the chip state, so call it off the frame path and keep what it returns. */
export function createMachineImage(): WritableMachineSnapshot {
  return {
    memory: new Uint8Array(MEMORY_SIZE),
    cpu: createCpuStateRecord(),
    trampoline: 0,
    idleAddress: 0,
    playAddress: 0,
    chips: new Float64Array(CHIP_STATE_LENGTH),
    speedBit: 0,
    cyclesThisCall: 0,
    reachedIdle: false,
    expectingOpcodeFetch: false,
    illegalOpcodes: 0,
  };
}

/** Copies `source` over `target` field by field. Not for the frame path: the CPU record is copied
 *  by enumeration. */
export function copyMachineImage(source: MachineSnapshot, target: WritableMachineSnapshot): void {
  target.memory.set(source.memory);
  Object.assign(target.cpu, source.cpu);
  target.trampoline = source.trampoline;
  target.idleAddress = source.idleAddress;
  target.playAddress = source.playAddress;
  target.chips.set(source.chips);
  target.speedBit = source.speedBit;
  target.cyclesThisCall = source.cyclesThisCall;
  target.reachedIdle = source.reachedIdle;
  target.expectingOpcodeFetch = source.expectingOpcodeFetch;
  target.illegalOpcodes = source.illegalOpcodes;
}

/**
 * A 64 KB address space with just enough faked C64 hardware — a VIC raster flag, both CIAs' timers,
 * a moving raster counter and ROM vector stubs — for a tune's `init` and `play` routines to run to
 * completion. Every write the tune makes to the SID's address range is handed to the sink.
 */
export interface C64Machine {
  /**
   * Cycles between play calls when CIA 1 timer A sets the rate — its latch plus one, the latch being
   * the tune's own or, for a CIA-timed PSID that wrote none, the PSID default; `null` when the tune
   * plays once per frame. Read live from the chip model: a latch or interrupt-enable write takes
   * effect from the next call.
   */
  readonly cyclesPerPlayCall: number | null;

  /**
   * How many play calls a second of this tune wants per frame, 1..16. This is advice for the
   * caller's clock — `runFrame` still calls the play routine exactly once. A timer slower than a
   * frame still reads 1 here; `exactCallsPerFrame` is the one that follows it below 1.
   */
  readonly callsPerFrame: number;

  /**
   * The same rate as `callsPerFrame`, but unrounded — the fractional play rate the CIA timer latch
   * actually describes. At most 16, and below 1 for a timer slower than a frame.
   *
   * A tune programs timer A to whatever period it wants, and that period is under no obligation to
   * divide the frame evenly: rates like 2.4 calls per frame are ordinary, and so is 0.5. `callsPerFrame`
   * rounds, which is right for the integer "how many calls does a frame want" question its name asks,
   * but wrong as a divisor for the inter-call interval — rounding 2.4 to 2 paces the stream 20% slow,
   * and the tune plays at the wrong tempo. Use this wherever the answer feeds a duration or a clock;
   * use `callsPerFrame` only where an integer count is genuinely what is wanted.
   */
  readonly exactCallsPerFrame: number;

  /**
   * The cycle ceiling a `runFrame` call is allowed — `cyclesPerFrame * PLAY_BUDGET_FRAMES`, PAL or
   * NTSC depending on this tune's own clock. What a headroom figure divides `FrameResult.cyclesUsed`
   * against.
   */
  readonly frameCycleBudget: Cycles;

  /** The address `runFrame` calls: the header's play address, or the vector an RSID installed. */
  readonly resolvedPlayAddress: number;

  /** Where the entry trampoline was written — moved off the default page when the tune covers it. */
  readonly trampolineBase: number;

  /** Undocumented opcodes executed since the last `initSubtune`; each ran as a 2-cycle no-op. */
  readonly illegalOpcodeCount: number;

  /**
   * A complete, detached copy of the machine's mutable state: 64 KB of address space, the CPU's
   * execution state, and this class's own bookkeeping.
   *
   * The point of it is `restore` — a position captured here can be returned to in constant time
   * rather than by re-emulating the tune from `init`, which is what makes a cue hop free of the
   * main-thread stall that a replay of the same distance costs.
   */
  snapshot(): MachineSnapshot;

  /**
   * `snapshot` written over an image the caller already holds — memory copied with `set`, the rest
   * assigned — so a capture on the frame path allocates nothing. `target` must come from
   * `createMachineImage` (or be a `snapshot()` result), which gives its CPU record every key.
   */
  snapshotInto(target: WritableMachineSnapshot): void;

  /**
   * Puts the machine back exactly where `snapshot` was taken.
   *
   * Restoring the entire address space is what makes this safe to run on the *live* machine rather
   * than a throwaway one: nothing of wherever playback currently is survives the call, so there is no
   * RAM left to bleed into the restored position.
   */
  restore(snapshot: MachineSnapshot): void;

  /**
   * Resets the address space, reloads the tune and runs its init routine for the given 1-based
   * subtune, then resolves the play address an RSID installs during init.
   *
   * @throws {RangeError} when `song` is outside the tune's subtune range.
   * @throws {UnplayableTuneError} when init finished but left no play address to call.
   */
  initSubtune(song: number): FrameResult;

  /**
   * Runs the play routine exactly once. Batching several calls into one frame would collapse them
   * downstream, which is precisely the data a multispeed tune exists to deliver.
   *
   * @throws {UnplayableTuneError} when no play address has been resolved.
   */
  runFrame(): FrameResult;
}

/** Builds a `C64Machine` for `file`, streaming every SID write it makes to `sink`. */
export function createC64Machine(file: SidFile, sink: SidWriteSink): C64Machine {
  return new C64MachineImpl(file, sink);
}

class C64MachineImpl implements C64Machine {
  private readonly file: SidFile;
  private readonly sink: SidWriteSink;
  private readonly memory: Uint8Array;
  private readonly cpu: Cpu6502;

  /**
   * The CPU's bus. A class, not a literal of arrows, because a literal builds a fresh `read` and a
   * fresh `write` closure for every machine: the CPU's call sites see a second target once a second
   * machine exists, lose the inlining they had on the first, and stay slower for the life of the
   * process. A class's methods are one function shared by every machine.
   *
   * Each access looks `read` and `write` up on the machine instance, never binds or captures them,
   * so a diagnostic that wraps them on the instance sees every access.
   */
  private static readonly Bus = class implements Cpu6502Bus {
    constructor(private readonly machine: C64MachineImpl) {}

    read(address: number): number {
      return this.machine.read(address);
    }

    write(address: number, value: number): void {
      this.machine.write(address, value);
    }
  };

  private readonly illegalOpcodeTable: Uint8Array;
  private readonly cyclesPerFrame: number;
  private readonly cyclesPerRasterLine: number;
  private readonly rasterLineCount: number;
  /** The VIC flag and the CIAs, and the cycle count that places each call in time. */
  private readonly chips: IoChips;
  /** A PSID's reads of the chip registers come from the model; an RSID keeps plain memory and a constant `$DC0D`/`$DD0D`. */
  private readonly modelsChipReads: boolean;
  /** A PSID with header play address 0: the play call enters the tune's own handler as an interrupt. */
  private readonly entersAsInterrupt: boolean;
  /** What `$FFFE` holds until a tune installs its own handler. */
  private readonly defaultHardwareVector: number;

  private trampoline = TRAMPOLINE_BASE;
  private idleAddress = TRAMPOLINE_BASE + TRAMPOLINE_IDLE_OFFSET;
  private playAddress = 0;
  /** The played song's bit of the header's speed word, set by `initSubtune`. */
  private speedBit = 0;
  private cyclesThisCall = 0;
  private reachedIdle = false;
  private expectingOpcodeFetch = false;
  private illegalOpcodes = 0;
  /** Cycles the interrupt entry spent past a `JSR`'s, left uncounted when the handler's first opcode is fetched. */
  private pendingEntryCredit = 0;

  constructor(file: SidFile, sink: SidWriteSink) {
    this.file = file;
    this.sink = sink;
    this.memory = new Uint8Array(MEMORY_SIZE);
    this.entersAsInterrupt = file.format === 'PSID' && file.playAddress === 0;
    this.defaultHardwareVector = file.format === 'PSID' ? BRK_HANDLER_STUB : IRQ_HANDLER_STUB;

    this.modelsChipReads = file.format === 'PSID';

    const ntsc = file.clock === 'ntsc';
    this.cyclesPerFrame = ntsc ? NTSC_CYCLES_PER_FRAME : PAL_CYCLES_PER_FRAME;
    this.cyclesPerRasterLine = ntsc ? NTSC_CYCLES_PER_RASTER_LINE : PAL_CYCLES_PER_RASTER_LINE;
    this.rasterLineCount = ntsc ? NTSC_RASTER_LINES : PAL_RASTER_LINES;
    this.chips = new IoChips(
      this.cyclesPerFrame,
      ntsc ? PSID_DEFAULT_TIMER_A_LATCH_NTSC : PSID_DEFAULT_TIMER_A_LATCH_PAL,
    );

    // The core resets inside its own constructor, reading $FFFC/$FFFD back through the bus, so the
    // address space has to exist first. The PC it lands on is meaningless — every entry re-points
    // the reset vector and resets again.
    this.cpu = createVendorCpu(new C64MachineImpl.Bus(this));
    this.illegalOpcodeTable = buildIllegalOpcodeTable(this.cpu);
  }

  snapshot(): MachineSnapshot {
    return {
      memory: this.memory.slice(),
      cpu: this.cpu.getState(),
      trampoline: this.trampoline,
      idleAddress: this.idleAddress,
      playAddress: this.playAddress,
      chips: this.chips.state.slice(),
      speedBit: this.speedBit,
      cyclesThisCall: this.cyclesThisCall,
      reachedIdle: this.reachedIdle,
      expectingOpcodeFetch: this.expectingOpcodeFetch,
      illegalOpcodes: this.illegalOpcodes,
    };
  }

  snapshotInto(target: WritableMachineSnapshot): void {
    target.memory.set(this.memory);
    this.cpu.copyStateInto(target.cpu);
    target.trampoline = this.trampoline;
    target.idleAddress = this.idleAddress;
    target.playAddress = this.playAddress;
    target.chips.set(this.chips.state);
    target.speedBit = this.speedBit;
    target.cyclesThisCall = this.cyclesThisCall;
    target.reachedIdle = this.reachedIdle;
    target.expectingOpcodeFetch = this.expectingOpcodeFetch;
    target.illegalOpcodes = this.illegalOpcodes;
  }

  restore(snapshot: MachineSnapshot): void {
    this.memory.set(snapshot.memory);
    this.cpu.setState(snapshot.cpu);
    this.trampoline = snapshot.trampoline;
    this.idleAddress = snapshot.idleAddress;
    this.playAddress = snapshot.playAddress;
    this.chips.state.set(snapshot.chips);
    this.speedBit = snapshot.speedBit;
    this.cyclesThisCall = snapshot.cyclesThisCall;
    this.reachedIdle = snapshot.reachedIdle;
    this.expectingOpcodeFetch = snapshot.expectingOpcodeFetch;
    this.illegalOpcodes = snapshot.illegalOpcodes;
  }

  get cyclesPerPlayCall(): number | null {
    if (!this.timerAGovernsRate()) {
      return null;
    }
    return this.chips.timerALatch() + 1;
  }

  get callsPerFrame(): number {
    const cyclesPerCall = this.cyclesPerPlayCall;
    if (cyclesPerCall === null || cyclesPerCall >= this.cyclesPerFrame) {
      return 1;
    }
    return Math.min(
      MAX_CALLS_PER_FRAME,
      Math.max(1, Math.round(this.cyclesPerFrame / cyclesPerCall)),
    );
  }

  get exactCallsPerFrame(): number {
    const cyclesPerCall = this.cyclesPerPlayCall;
    if (cyclesPerCall === null) {
      return 1;
    }
    return Math.min(MAX_CALLS_PER_FRAME, this.cyclesPerFrame / cyclesPerCall);
  }

  /**
   * Whether CIA 1 timer A's rate, rather than one call per frame, is the tune's play rate.
   *
   * A PSID with a play address follows its speed bit, whatever the tune writes to the CIA. One
   * without installed its own handler: the speed bits are ignored and the rate is whatever interrupt
   * the tune has enabled in CIA 1. An RSID keeps the rule it always had, that a tune which wrote the
   * latch is CIA-timed.
   */
  private timerAGovernsRate(): boolean {
    if (this.file.format === 'RSID') {
      return this.chips.timerALatchWritten();
    }
    return this.entersAsInterrupt ? this.chips.timerAInterruptEnabled() : this.speedBit === 1;
  }

  /**
   * The played song's bit of the header's speed word. Version 1 files and PSIDs flagged PlaySID
   * specific repeat the 32 bits across songs; a later version without the flag gives every song past
   * the 32nd the last bit.
   */
  private speedBitFor(song: number): number {
    const { version, speedFlags, psidSpecific } = this.file;
    const index = version === 1 || psidSpecific === true ? (song - 1) % 32 : Math.min(song - 1, 31);
    return (speedFlags >>> index) & 1;
  }

  get frameCycleBudget(): Cycles {
    return cycles(this.cyclesPerFrame * PLAY_BUDGET_FRAMES);
  }

  get resolvedPlayAddress(): number {
    return this.playAddress;
  }

  get trampolineBase(): number {
    return this.trampoline;
  }

  get illegalOpcodeCount(): number {
    return this.illegalOpcodes;
  }

  initSubtune(song: number): FrameResult {
    const subtunes = Math.max(1, this.file.songs);
    if (!Number.isInteger(song) || song < 1 || song > subtunes) {
      throw new RangeError(`subtune ${song} is outside 1..${subtunes}`);
    }

    this.memory.fill(0);
    this.speedBit = this.speedBitFor(song);
    this.chips.reset(this.speedBit);
    this.illegalOpcodes = 0;

    this.installRomStubs();
    this.loadTune();
    this.writeTrampoline(song);

    const result = this.runRoutine(
      this.trampoline + TRAMPOLINE_INIT_OFFSET,
      this.cyclesPerFrame * INIT_BUDGET_FRAMES,
    );
    this.chips.endInit(result.cyclesUsed);

    this.playAddress = this.resolvePlayAddress();
    this.patchPlayTarget();

    if (result.completed && this.playAddress === 0) {
      throw new UnplayableTuneError(
        'the tune installed no interrupt vector during init, so it exposes no play routine',
      );
    }
    return result;
  }

  runFrame(): FrameResult {
    if (this.playAddress === 0) {
      throw new UnplayableTuneError('no play address has been resolved — run initSubtune first');
    }
    this.chips.beginCall(this.timerAGovernsRate() ? CALL_CIA : CALL_RASTER);
    const result = this.runRoutine(
      this.trampoline + TRAMPOLINE_PLAY_OFFSET,
      this.cyclesPerFrame * PLAY_BUDGET_FRAMES,
      this.interruptEntryCredit(),
    );
    this.chips.endCall(result.cyclesUsed);
    return result;
  }

  /** `entryCredit` cycles are dropped from the count when the handler's first opcode is fetched. */
  private runRoutine(entryAddress: number, budget: number, entryCredit = 0): FrameResult {
    this.writeWord(RESET_VECTOR, entryAddress);
    this.pendingEntryCredit = entryCredit;
    this.cyclesThisCall = 0;
    this.reachedIdle = false;
    this.expectingOpcodeFetch = false;
    this.cpu.reset();

    while (!this.reachedIdle && this.cyclesThisCall < budget) {
      // Every read the core makes on a given cycle either starts an instruction or belongs to one
      // already decoded, and only the first read of a cycle can be the opcode fetch.
      this.expectingOpcodeFetch = true;
      this.cpu.emulate();
      this.cyclesThisCall++;
    }

    return { cyclesUsed: this.cyclesThisCall, completed: this.reachedIdle };
  }

  /**
   * The read side of the CPU's bus.
   *
   * The `$01` banking register is stored as ordinary RAM and ignored for decoding: the ranges below
   * always decode as I/O whatever a tune banks in. That is a deliberate simplification, not an
   * oversight — no KERNAL or BASIC ROM image ships here. It has a cost since the chips went live:
   * a tune that banks the I/O out to read the RAM under `$D019`–`$DD0F` reads the chips instead.
   * `Snow_Strike` is the known case.
   */
  private read(address: number): number {
    const fetchingOpcode = this.expectingOpcodeFetch;
    this.expectingOpcodeFetch = false;

    if (address === this.idleAddress) {
      // The only reason the CPU ever fetches from the idle block is that the routine returned.
      // Detecting it here keeps the hot loop free of the allocations `getState()` would cost.
      this.reachedIdle = true;
    }
    if (this.pendingEntryCredit !== 0 && fetchingOpcode && address === this.playAddress) {
      this.cyclesThisCall -= this.pendingEntryCredit;
      this.pendingEntryCredit = 0;
    }

    const value = this.readBus(address);
    if (fetchingOpcode && this.illegalOpcodeTable[value] === 1) {
      this.illegalOpcodes++;
    }
    return value;
  }

  private readBus(address: number): number {
    switch (address) {
      case VIC_CONTROL_REGISTER:
        return VIC_CONTROL_IDLE_BITS | ((this.rasterLine() & 0x100) >> 1);
      case VIC_RASTER_REGISTER:
        return this.rasterLine() & 0xff;
    }
    if (address >= CHIP_REGISTERS_FIRST && address <= CHIP_REGISTERS_LAST) {
      return this.readChipRegister(address);
    }
    return this.memory[address & 0xffff];
  }

  /**
   * A read in the range the chip model covers. Some of these reads change the model — `$xD` clears
   * the flags it returns — so `read` is the only caller, and it calls once per bus access.
   */
  private readChipRegister(address: number): number {
    if (this.modelsChipReads) {
      const value = this.chips.read(address, this.cyclesThisCall);
      if (value >= 0) {
        return value;
      }
    } else if (address === CIA1_INTERRUPT_CONTROL || address === CIA2_INTERRUPT_CONTROL) {
      return CIA_INTERRUPT_TIMER_A_SET;
    }
    return this.memory[address & 0xffff];
  }

  /**
   * The write side of the CPU's bus. See `read` for why banking is ignored.
   *
   * Every register the machine reacts to lies between `$D019` and `$DD0F`, so one range test lets an
   * ordinary RAM store skip the rest.
   */
  private write(address: number, value: number): void {
    const byte = value & 0xff;
    this.memory[address & 0xffff] = byte;

    if (address < CHIP_REGISTERS_FIRST || address > CHIP_REGISTERS_LAST) {
      return;
    }

    if (address >= SID_RANGE_START && address <= SID_RANGE_END) {
      if (!this.isSecondOrThirdSidAddress(address)) {
        const register = address & SID_REGISTER_MASK;
        if (register <= SID_LAST_AUDIBLE_REGISTER) {
          this.sink.onSidWrite(register, byte);
        }
      }
      return;
    }

    this.chips.write(address, byte, this.cyclesThisCall);
  }

  /**
   * Whether `address` falls in the 32-byte mirrored block of a v3/v4 header's second or third SID
   * address. Those chips are reported to the caller, not emulated, so their writes still land in
   * `this.memory` (above) but must never reach the sink alongside the first chip's registers.
   */
  private isSecondOrThirdSidAddress(address: number): boolean {
    const block = address & ~SID_REGISTER_MASK;
    const { secondSidAddress, thirdSidAddress } = this.file;
    return (
      (secondSidAddress !== null && block === (secondSidAddress & ~SID_REGISTER_MASK)) ||
      (thirdSidAddress !== null && block === (thirdSidAddress & ~SID_REGISTER_MASK))
    );
  }

  /** Players poll the raster in a spin loop, so a frozen value hangs them. */
  private rasterLine(): number {
    return ((this.cyclesThisCall / this.cyclesPerRasterLine) | 0) % this.rasterLineCount;
  }

  /**
   * A PSID gets the KERNAL's real IRQ exits — `$EA31` jumps to `$EA7E`, which acknowledges the CIA
   * and falls into `$EA81`, which pops Y, X, A and returns — and a separate `RTI` for `BRK` behind
   * `$FFFE`. An RSID keeps one `RTI` at `$EA31` for both vectors.
   */
  private installRomStubs(): void {
    for (const address of KERNAL_STUB_ADDRESSES) {
      this.memory[address] = OPCODE_RTS;
    }
    this.writeWord(IRQ_VECTOR_KERNAL, IRQ_HANDLER_STUB);
    this.writeWord(IRQ_VECTOR_HARDWARE, this.defaultHardwareVector);

    if (this.file.format !== 'PSID') {
      this.memory[IRQ_HANDLER_STUB] = OPCODE_RTI;
      return;
    }
    this.memory.set(
      [OPCODE_JMP_ABSOLUTE, IRQ_ACKNOWLEDGE_STUB & 0xff, IRQ_ACKNOWLEDGE_STUB >> 8],
      IRQ_HANDLER_STUB,
    );
    this.memory.set(
      [OPCODE_LDA_ABSOLUTE, CIA1_INTERRUPT_CONTROL & 0xff, CIA1_INTERRUPT_CONTROL >> 8],
      IRQ_ACKNOWLEDGE_STUB,
    );
    this.memory.set(
      [OPCODE_PLA, OPCODE_TAY, OPCODE_PLA, OPCODE_TAX, OPCODE_PLA, OPCODE_RTI],
      IRQ_RESTORE_STUB,
    );
    this.memory[BRK_HANDLER_STUB] = OPCODE_RTI;
  }

  /** Copies the payload over the stubs, so the tune wins any overlap. */
  private loadTune(): void {
    const available = MEMORY_SIZE - this.file.loadAddress;
    const length = Math.min(this.file.data.length, Math.max(0, available));
    this.memory.set(this.file.data.subarray(0, length), this.file.loadAddress);
  }

  /**
   * Writes the entry trampoline the CPU takes out of reset. The core keeps its registers private,
   * so the accumulator's subtune number and the entry addresses have to come from real code:
   *
   * ```
   * base+0x00:  LDA #(song - 1)   ; the PSID convention is zero-based in A
   * base+0x02:  JSR initAddress
   * base+0x05:  JMP idle
   * base+0x08:  JSR playAddress   ; target patched once an RSID's vector is known
   * base+0x0B:  JMP idle
   * base+0x0E:  JMP idle          ; branches to itself
   * ```
   *
   * A PSID with play address 0 enters its handler as an interrupt instead. `base+0x08` becomes a
   * `JMP` to one of two entries, picked after init by which vector holds the handler. Both push
   * a hardware frame — return PC `P:P`, status `$0A`, with `P` the trampoline's page — and the
   * `$0314` entry also pushes A, X, Y as the KERNAL's `$FF48` does. The shared tail then zeroes
   * A, X and Y, as a `JSR` entry leaves them, and jumps to the handler:
   *
   * ```
   * base+0x11:  LDA #P / PHA / PHA / LDA #$0A / PHA        ; $0314 entry: PCH, PCL, status
   * base+0x18:  PHA / LDA #P / PHA / LDA #$0A / PHA         ; A = $0A, X = P, Y = $0A
   * base+0x1F:  JMP tail
   * base+0x22:  LDA #P / PHA / PHA / LDA #$0A / PHA        ; $FFFE entry: the frame alone
   * base+0x29:  LDA #0 / TAX / TAY / JMP handler           ; handler patched after init
   * P:P:        JMP idle                                    ; where an RTI lands
   * ```
   *
   * An `RTI` pulls status `$0A` and goes to `P:P`. An `RTS` pulls the top two bytes as a low and
   * high address byte — Y and X on the `$0314` path, status and PCL on the `$FFFE` path — which
   * are `$0A` and `P` either way, and goes to `base+0x0B`. Both end in `JMP idle`.
   */
  private writeTrampoline(song: number): void {
    this.trampoline = this.chooseTrampolineBase();
    this.idleAddress = this.trampoline + TRAMPOLINE_IDLE_OFFSET;

    const idleLow = this.idleAddress & 0xff;
    const idleHigh = (this.idleAddress >> 8) & 0xff;
    const initLow = this.file.initAddress & 0xff;
    const initHigh = (this.file.initAddress >> 8) & 0xff;

    this.memory.set(
      [
        OPCODE_LDA_IMMEDIATE,
        (song - 1) & 0xff,
        OPCODE_JSR_ABSOLUTE,
        initLow,
        initHigh,
        OPCODE_JMP_ABSOLUTE,
        idleLow,
        idleHigh,
        this.entersAsInterrupt ? OPCODE_JMP_ABSOLUTE : OPCODE_JSR_ABSOLUTE,
        0x00,
        0x00,
        OPCODE_JMP_ABSOLUTE,
        idleLow,
        idleHigh,
        OPCODE_JMP_ABSOLUTE,
        idleLow,
        idleHigh,
      ],
      this.trampoline,
    );

    if (this.entersAsInterrupt) {
      this.writeInterruptEntry(idleLow, idleHigh);
    }
  }

  /** Writes everything past `base+0x11` that `writeTrampoline`'s doc comment lays out. */
  private writeInterruptEntry(idleLow: number, idleHigh: number): void {
    const page = this.trampoline >> 8;
    const tail = this.trampoline + TRAMPOLINE_INTERRUPT_TAIL_OFFSET;
    const pushFrame = [
      OPCODE_LDA_IMMEDIATE,
      page,
      OPCODE_PHA,
      OPCODE_PHA,
      OPCODE_LDA_IMMEDIATE,
      INTERRUPT_STATUS_BYTE,
      OPCODE_PHA,
    ];
    const pushRegisters = [
      OPCODE_PHA,
      OPCODE_LDA_IMMEDIATE,
      page,
      OPCODE_PHA,
      OPCODE_LDA_IMMEDIATE,
      INTERRUPT_STATUS_BYTE,
      OPCODE_PHA,
    ];

    this.memory.set(
      [...pushFrame, ...pushRegisters, OPCODE_JMP_ABSOLUTE, tail & 0xff, tail >> 8],
      this.trampoline + TRAMPOLINE_INTERRUPT_KERNAL_OFFSET,
    );
    this.memory.set(
      [
        ...pushFrame,
        OPCODE_LDA_IMMEDIATE,
        0x00,
        OPCODE_TAX,
        OPCODE_TAY,
        OPCODE_JMP_ABSOLUTE,
        0x00,
        0x00,
      ],
      this.trampoline + TRAMPOLINE_INTERRUPT_HARDWARE_OFFSET,
    );
    this.memory.set(
      [OPCODE_JMP_ABSOLUTE, idleLow, idleHigh],
      this.interruptContinuation(this.trampoline),
    );
  }

  /** Where an `RTI` out of a handler lands: `P:P`, a page byte that also serves as `RTS`'s high byte. */
  private interruptContinuation(base: number): number {
    const page = base >> 8;
    return (page << 8) | page;
  }

  /**
   * Points the play entry at what init resolved: the handler itself for a `JSR` entry, otherwise
   * the interrupt entry for the vector that holds it, with the handler patched into its tail.
   */
  private patchPlayTarget(): void {
    if (!this.entersAsInterrupt) {
      this.writeWord(this.trampoline + TRAMPOLINE_PLAY_TARGET_OFFSET, this.playAddress);
      return;
    }
    const entryOffset = this.handlerIsOnKernalVector()
      ? TRAMPOLINE_INTERRUPT_KERNAL_OFFSET
      : TRAMPOLINE_INTERRUPT_HARDWARE_OFFSET;
    this.writeWord(this.trampoline + TRAMPOLINE_PLAY_TARGET_OFFSET, this.trampoline + entryOffset);
    this.writeWord(this.trampoline + TRAMPOLINE_INTERRUPT_HANDLER_OFFSET, this.playAddress);
  }

  /** Cycles to leave uncounted on this call: what the entry costs beyond a `JSR`. */
  private interruptEntryCredit(): number {
    if (!this.entersAsInterrupt) {
      return 0;
    }
    const entry = this.readWord(this.trampoline + TRAMPOLINE_PLAY_TARGET_OFFSET);
    return entry === this.trampoline + TRAMPOLINE_INTERRUPT_KERNAL_OFFSET
      ? INTERRUPT_ENTRY_EXTRA_CYCLES_KERNAL
      : INTERRUPT_ENTRY_EXTRA_CYCLES_HARDWARE;
  }

  /**
   * The base the trampoline goes at: the default page, else the first one clear of the tune. An
   * interrupt-entry tune's continuation must be clear too, and must lie past the trampoline.
   */
  private chooseTrampolineBase(): number {
    const start = this.file.loadAddress;
    const end = Math.min(start + this.file.data.length, MEMORY_SIZE);
    const overlapsTune = (at: number, length: number): boolean => at < end && start < at + length;
    const fits = (base: number): boolean => {
      if (!this.entersAsInterrupt) {
        return !overlapsTune(base, TRAMPOLINE_LENGTH);
      }
      const continuation = this.interruptContinuation(base);
      return (
        continuation >= base + TRAMPOLINE_INTERRUPT_LENGTH &&
        !overlapsTune(base, TRAMPOLINE_INTERRUPT_LENGTH) &&
        !overlapsTune(continuation, INTERRUPT_CONTINUATION_LENGTH)
      );
    };

    if (fits(TRAMPOLINE_BASE)) {
      return TRAMPOLINE_BASE;
    }
    for (let page = FIRST_RELOCATABLE_PAGE; page <= LAST_RELOCATABLE_PAGE; page++) {
      if (page >= IO_FIRST_PAGE && page <= IO_LAST_PAGE) {
        continue;
      }
      const base = page << 8;
      if (fits(base)) {
        return base;
      }
    }
    throw new UnplayableTuneError(
      'the tune covers every page — there is nowhere for the trampoline',
    );
  }

  /**
   * A header play address of 0 means the tune installed its own interrupt handler during init.
   * Returns 0 when neither vector moved off its default stub, rather than jumping to address 0.
   */
  private resolvePlayAddress(): number {
    if (this.file.playAddress !== 0) {
      return this.file.playAddress;
    }
    if (this.handlerIsOnKernalVector()) {
      return this.readWord(IRQ_VECTOR_KERNAL);
    }
    const hardwareVector = this.readWord(IRQ_VECTOR_HARDWARE);
    return hardwareVector === this.defaultHardwareVector ? 0 : hardwareVector;
  }

  private handlerIsOnKernalVector(): boolean {
    return this.readWord(IRQ_VECTOR_KERNAL) !== IRQ_HANDLER_STUB;
  }

  private readWord(address: number): number {
    return this.memory[address] | (this.memory[address + 1] << 8);
  }

  private writeWord(address: number, value: number): void {
    this.memory[address] = value & 0xff;
    this.memory[address + 1] = (value >> 8) & 0xff;
  }
}
