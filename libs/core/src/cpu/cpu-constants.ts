/** Timing, memory map and stub-code constants for the faked C64 that tune code runs on. */

export const PAL_CYCLES_PER_FRAME = 19656;
export const NTSC_CYCLES_PER_FRAME = 17095;

export const PAL_CYCLES_PER_RASTER_LINE = 63;
export const PAL_RASTER_LINES = 312;
export const NTSC_CYCLES_PER_RASTER_LINE = 65;
export const NTSC_RASTER_LINES = 263;

/**
 * Init routines legitimately spend a long time relocating and precomputing tables. A real PSID driver
 * lets init run until it returns, so there is no cap on hardware; this one stops an init that never
 * returns. Of the PSIDs in HVSC #85, five take longer than 100 frames to return and none more than
 * 167.5, so 200 lets every init that returns return; 93 never return, whatever the budget up to 3,000.
 * A stuck init costs its whole budget once per load.
 */
export const INIT_BUDGET_FRAMES = 200;
export const PLAY_BUDGET_FRAMES = 2;

/** A multispeed rate above this is not worth chasing; ASID sends one play call per packet. */
export const MAX_CALLS_PER_FRAME = 16;

/** The 64 KB address space a tune addresses. */
export const MEMORY_SIZE = 0x10000;

/** The 6510's on-chip port: `$00` is its data direction register and `$01` its data register. */
export const PORT_DDR = 0x00;
export const PORT_DATA = 0x01;
/** What the KERNAL's reset leaves: `$2F` for the direction and `$37` for the data — BASIC, I/O and KERNAL all in. */
export const PORT_DDR_DEFAULT = 0x2f;
export const PORT_DATA_DEFAULT = 0x37;
/** What the port's input lines read: the pull-ups of LORAM, HIRAM and CHAREN and the cassette sense line. */
export const PORT_PULLUPS = 0x17;
/** The port's three banking lines: LORAM, HIRAM and CHAREN. */
export const PORT_BANK_MASK = 0x07;
export const PORT_HIRAM_LORAM_MASK = 0x03;
export const PORT_CHAREN_BIT = 0x04;

/** `$D000-$DFFF`: the chips, or the RAM under them when the port banks them out. */
export const IO_START = 0xd000;
export const IO_SIZE = 0x1000;
/** The RAM under I/O is kept past `$FFFF`, so `memory[$D000-$DFFF]` stays the I/O view. */
export const MACHINE_MEMORY_SIZE = MEMORY_SIZE + IO_SIZE;

/** What a PSID driver writes to `$01` before calling `address` (the PSID file format's rule). */
export function psidBankFor(address: number): number {
  if (address < 0xa000) {
    return 0x37;
  }
  if (address < IO_START) {
    return 0x36;
  }
  return address >= 0xe000 ? 0x35 : 0x34;
}

export const SID_RANGE_START = 0xd400;
export const SID_RANGE_END = 0xd7ff;
/** The SID decodes only five address lines, which is what makes the `$D420` tunes work. */
export const SID_REGISTER_MASK = 0x1f;
export const SID_LAST_AUDIBLE_REGISTER = 24;

export const VIC_CONTROL_REGISTER = 0xd011;
export const VIC_RASTER_REGISTER = 0xd012;
/** Screen on, 25 rows, no scroll — the bits a player expects around the raster line's bit 8. */
export const VIC_CONTROL_IDLE_BITS = 0x1b;

/** `$D019`: the interrupt flags. Bit 0 is the raster flag, and a write of 1 to a flag clears it. */
export const VIC_INTERRUPT_STATUS_REGISTER = 0xd019;
/** `$D01A`: the interrupt enables, four bits; the rest read as 1. */
export const VIC_INTERRUPT_ENABLE_REGISTER = 0xd01a;
/** Bit 0 of `$D019` and `$D01A`: the raster-compare interrupt. */
export const VIC_RASTER_INTERRUPT_BIT = 0x01;
export const VIC_INTERRUPT_ENABLE_MASK = 0x0f;
export const VIC_INTERRUPT_ENABLE_UNUSED_BITS = 0xf0;
export const VIC_INTERRUPT_STATUS_UNUSED_BITS = 0x70;
/** Bit 7 of `$D019`: a flagged interrupt is also enabled. */
export const VIC_INTERRUPT_ANY_BIT = 0x80;

/** The first and last register the chip model answers: `$D019` through CIA 2's timer B control. */
export const CHIP_REGISTERS_FIRST = VIC_INTERRUPT_STATUS_REGISTER;
export const CHIP_REGISTERS_LAST = 0xdd0f;

export const CIA1_PAGE = 0xdc;
export const CIA2_PAGE = 0xdd;
/** The CIA registers the model answers, as offsets within a CIA's page: `$x4`–`$xF`. */
export const CIA_TIMER_A_LOW = 0x04;
export const CIA_TIMER_A_HIGH = 0x05;
export const CIA_TIMER_B_LOW = 0x06;
export const CIA_TIMER_B_HIGH = 0x07;
export const CIA_INTERRUPT_CONTROL = 0x0d;
export const CIA_CONTROL_A = 0x0e;
export const CIA_CONTROL_B = 0x0f;

export const CIA1_INTERRUPT_CONTROL = 0xdc0d;
export const CIA2_INTERRUPT_CONTROL = 0xdd0d;
/** `$xD`: bit 0 is timer A's underflow, bit 1 timer B's. A write sets the enable bits it names when bit 7 is 1 and clears them when it is 0. */
export const CIA_INTERRUPT_TIMER_A_BIT = 0x01;
export const CIA_INTERRUPT_TIMER_B_BIT = 0x02;
export const CIA_INTERRUPT_MASK = 0x1f;
/** Bit 7 of `$xD`: on a write, set versus clear; on a read, a flagged interrupt is also enabled. */
export const CIA_INTERRUPT_SET_BIT = 0x80;
/** `$xE` and `$xF`: bit 0 starts the timer, bit 3 makes it one-shot, bit 4 forces a load and reads as 0. */
export const CIA_CONTROL_START = 0x01;
export const CIA_CONTROL_ONE_SHOT = 0x08;
export const CIA_CONTROL_FORCE_LOAD = 0x10;
/** `$xF` bits 6:5 pick timer B's count source: `00` counts φ2 cycles, `10` counts timer A's underflows. */
export const CIA_TIMER_B_SOURCE_SHIFT = 5;
export const CIA_TIMER_B_SOURCE_MASK = 0x03;
export const CIA_TIMER_B_SOURCE_PHI2 = 0;
export const CIA_TIMER_B_SOURCE_TIMER_A = 2;
/** `$xE` bit 5 picks timer A's: clear counts φ2 cycles, set counts the CNT pin, which nothing here drives. */
export const CIA_CONTROL_A_CNT_BIT = 0x20;
/** What a stopped timer holds in the PSID default environment, and a timer's latch after a reset. */
export const CIA_TIMER_RESET_VALUE = 0xffff;
/**
 * The latch CIA 1 timer A holds in the PSID default environment — 60 Hz of the tune's own clock,
 * `$4025` + 1 PAL cycles and `$4295` + 1 NTSC — which is the rate of a CIA-timed tune that never
 * programs the timer.
 */
export const PSID_DEFAULT_TIMER_A_LATCH_PAL = 0x4025;
export const PSID_DEFAULT_TIMER_A_LATCH_NTSC = 0x4295;
/** What an RSID's `$DC0D` and `$DD0D` read, always: timer A underflow flagged and enabled, so a player polling the CIA proceeds instead of spinning forever. */
export const CIA_INTERRUPT_TIMER_A_SET = 0x81;

/** The KERNAL's IRQ exit, and the default `$0314` vector. A PSID gets `JMP $EA7E` here; an RSID an `RTI`. */
export const IRQ_HANDLER_STUB = 0xea31;
/** `LDA $DC0D` — acknowledges the CIA — and falls into `IRQ_RESTORE_STUB`. */
export const IRQ_ACKNOWLEDGE_STUB = 0xea7e;
/** `PLA TAY PLA TAX PLA RTI` — pops what the KERNAL's IRQ entry pushed, then returns. */
export const IRQ_RESTORE_STUB = 0xea81;
/** A lone `RTI`: what a PSID's `BRK` runs through the default `$FFFE`. */
export const BRK_HANDLER_STUB = 0xfe66;
export const IRQ_VECTOR_KERNAL = 0x0314;
export const RESET_VECTOR = 0xfffc;
export const IRQ_VECTOR_HARDWARE = 0xfffe;

/**
 * The KERNAL entry points tunes call most often. Real KERNAL and BASIC ROM images are copyrighted
 * and are not shipped here, so each of these gets an `RTS` and the call becomes a no-op.
 */
export const KERNAL_STUB_ADDRESSES: readonly number[] = [
  0xffd2, 0xffe4, 0xffcf, 0xff81, 0xff84, 0xff8a, 0xffe7, 0xff90, 0xffb1,
];

export const OPCODE_RTS = 0x60;
export const OPCODE_RTI = 0x40;
export const OPCODE_LDA_IMMEDIATE = 0xa9;
export const OPCODE_JSR_ABSOLUTE = 0x20;
export const OPCODE_JMP_ABSOLUTE = 0x4c;
export const OPCODE_LDA_ABSOLUTE = 0xad;
export const OPCODE_PHA = 0x48;
export const OPCODE_PLA = 0x68;
export const OPCODE_TAX = 0xaa;
export const OPCODE_TAY = 0xa8;

export const TRAMPOLINE_BASE = 0xea00;
/** `base+0x00` through `base+0x10` inclusive — the final `JMP idle` occupies three of them. */
export const TRAMPOLINE_LENGTH = 0x11;
export const TRAMPOLINE_INIT_OFFSET = 0x00;
export const TRAMPOLINE_PLAY_OFFSET = 0x08;
export const TRAMPOLINE_PLAY_TARGET_OFFSET = 0x09;
/**
 * The address the `JSR play` pushes, its last byte: an `RTS` from the play routine lands one byte on,
 * at the `JMP idle`, and only an `RTI` that pulls the `JSR`'s frame as its PC lands here.
 */
export const TRAMPOLINE_PLAY_RETURN_OFFSET = 0x0a;
export const TRAMPOLINE_IDLE_OFFSET = 0x0e;

/**
 * An interrupt-entry tune's trampoline grows past `TRAMPOLINE_LENGTH`: `base+0x11` through
 * `base+0x2f`, plus a continuation at `(page << 8) | page` that the tune's `RTI` lands on.
 */
export const TRAMPOLINE_INTERRUPT_LENGTH = 0x30;
/** Pushes a frame and the KERNAL's A/X/Y, then continues at the tail. */
export const TRAMPOLINE_INTERRUPT_KERNAL_OFFSET = 0x11;
/** Pushes a frame only, then falls into the tail. */
export const TRAMPOLINE_INTERRUPT_HARDWARE_OFFSET = 0x22;
/** `LDA #0 / TAX / TAY / JMP handler` — the registers a `JSR` entry gives, then the handler. */
export const TRAMPOLINE_INTERRUPT_TAIL_OFFSET = 0x29;
export const TRAMPOLINE_INTERRUPT_HANDLER_OFFSET = 0x2e;
/** The continuation is one `JMP idle`. */
export const INTERRUPT_CONTINUATION_LENGTH = 3;
/** The pushed status byte; read as `RTS` operand bytes it lands on `base+0x0b`, the `JMP idle` a `JSR` entry returns to. */
export const INTERRUPT_STATUS_BYTE = 0x0a;
/**
 * Cycles the interrupt entry spends beyond today's 6-cycle `JSR`, left out of the call's cycle count
 * so the handler sees the raster and budget a `JSR` entry would give it. The `$0314` entry runs 41
 * cycles to the handler's first instruction, the `$FFFE` entry 25.
 */
export const INTERRUPT_ENTRY_EXTRA_CYCLES_KERNAL = 35;
export const INTERRUPT_ENTRY_EXTRA_CYCLES_HARDWARE = 19;

/** Relocation skips the zero page, the stack page and the vector page at the top of memory. */
export const FIRST_RELOCATABLE_PAGE = 0x02;
export const LAST_RELOCATABLE_PAGE = 0xfe;
/** `$D000-$DFFF` is I/O or the RAM under it depending on the port, so the trampoline never lives there. */
export const IO_FIRST_PAGE = 0xd0;
export const IO_LAST_PAGE = 0xdf;
/**
 * The pages a PSID player puts its driver in: `$04` (past the zero page, the stack and the KERNAL's
 * work area) to `$CF` (below the I/O and the KERNAL), skipping the BASIC ROM's `$A0`–`$BF`. A tune's
 * init may overwrite the RAM under the KERNAL, so the driver never goes there.
 */
export const DRIVER_FIRST_PAGE = 0x04;
export const DRIVER_LAST_PAGE = 0xcf;
export const BASIC_ROM_FIRST_PAGE = 0xa0;
export const BASIC_ROM_LAST_PAGE = 0xbf;
/** A header start page of `$FF` says the tune leaves no room for a driver at all. */
export const RELOC_NO_ROOM_PAGE = 0xff;
