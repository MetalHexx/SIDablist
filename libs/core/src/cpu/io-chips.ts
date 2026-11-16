import {
  CIA1_PAGE,
  CIA_CONTROL_A,
  CIA_CONTROL_A_CNT_BIT,
  CIA_CONTROL_B,
  CIA_CONTROL_FORCE_LOAD,
  CIA_CONTROL_ONE_SHOT,
  CIA_CONTROL_START,
  CIA_INTERRUPT_CONTROL,
  CIA_INTERRUPT_MASK,
  CIA_INTERRUPT_SET_BIT,
  CIA_INTERRUPT_TIMER_A_BIT,
  CIA_INTERRUPT_TIMER_B_BIT,
  CIA_TIMER_A_HIGH,
  CIA_TIMER_A_LOW,
  CIA_TIMER_B_HIGH,
  CIA_TIMER_B_LOW,
  CIA_TIMER_B_SOURCE_MASK,
  CIA_TIMER_B_SOURCE_PHI2,
  CIA_TIMER_B_SOURCE_SHIFT,
  CIA_TIMER_B_SOURCE_TIMER_A,
  CIA_TIMER_RESET_VALUE,
  CIA2_PAGE,
  VIC_INTERRUPT_ANY_BIT,
  VIC_INTERRUPT_ENABLE_MASK,
  VIC_INTERRUPT_ENABLE_REGISTER,
  VIC_INTERRUPT_ENABLE_UNUSED_BITS,
  VIC_INTERRUPT_STATUS_REGISTER,
  VIC_INTERRUPT_STATUS_UNUSED_BITS,
  VIC_RASTER_INTERRUPT_BIT,
} from './cpu-constants.js';

/** The VIC's raster interrupt raised the call: it starts with the raster flag set. */
export const CALL_RASTER = 0;
/** CIA 1 timer A's underflow raised the call: it starts with the timer just reloaded and its flag set. */
export const CALL_CIA = 1;
/** What raised a play call, which decides what the chips show when it starts. */
export type CallDrive = typeof CALL_RASTER | typeof CALL_CIA;

/*
 * The layout of `IoChips.state`, one `Float64Array` so a snapshot copies it whole with `set` and
 * allocates nothing. Every slot is an integer-valued number; cycle counts are plain numbers, exact to
 * 2^53, because a long tune passes 2^31 cycles in about 36 minutes.
 *
 *   0  CALL_START      cycle count at which the current (or last) play call started
 *   1  CALL_DUE        cycle count at which the next call falls due: its start plus its period
 *   2  CALL_END        cycle count at which the last call ended
 *   3  VIC_FLAG        the VIC's raster flag, 0 or 1
 *   4  VIC_ENABLE      `$D01A`'s four enable bits
 *   5  LATCH_WRITTEN   1 once the tune has written CIA 1 timer A's latch since init
 *   6  CIA 1           CIA_STRIDE slots, laid out as below
 *   20 CIA 2           the same
 *
 * A CIA block:
 *
 *   0  FLAGS           `$xD`'s underflow flags: bit 0 timer A, bit 1 timer B
 *   1  ENABLE          `$xD`'s enable bits
 *   2  timer A         TIMER_STRIDE slots, laid out as below
 *   8  timer B         the same
 *
 * A timer block. A timer is not stepped: its counter is true as of the cycle in SYNC, and an access
 * counts it on to the cycle it happens at.
 *
 *   0  COUNTER         the 16-bit count at SYNC
 *   1  LATCH           what an underflow reloads
 *   2  CONTROL         `$xE`/`$xF` as written, bit 4 (force load) never kept
 *   3  SYNC            the cycle COUNTER is true at
 *   4  UNDERFLOWS      every underflow since init; timer B in cascade counts timer A's
 *   5  SEEN            timer A's UNDERFLOWS already counted by timer B; unused in timer A's block
 */
const CALL_START = 0;
const CALL_DUE = 1;
const CALL_END = 2;
const VIC_FLAG = 3;
const VIC_ENABLE = 4;
const LATCH_WRITTEN = 5;
const CIA1 = 6;

const CIA_FLAGS = 0;
const CIA_ENABLE = 1;
const TIMER_A = 2;
const TIMER_B = 8;
const CIA_STRIDE = 14;
const CIA2 = CIA1 + CIA_STRIDE;

const COUNTER = 0;
const LATCH = 1;
const CONTROL = 2;
const SYNC = 3;
const UNDERFLOWS = 4;
const SEEN = 5;

/** The length of `IoChips.state`, and so of a snapshot's `chips`. */
export const CHIP_STATE_LENGTH = CIA2 + CIA_STRIDE;

/** Whether `register` is one of the CIA registers the model answers; the TOD clock and serial port are not. */
function isModelledCiaRegister(register: number): boolean {
  return (
    (register >= CIA_TIMER_A_LOW && register <= CIA_TIMER_B_HIGH) ||
    (register >= CIA_INTERRUPT_CONTROL && register <= CIA_CONTROL_B)
  );
}

/**
 * The VIC's raster flag and the two CIAs' timers, with just enough behaviour for a PSID player to
 * see what it would see when called on a real C64, and the cycle count that places each call in time.
 *
 * Time is one running cycle count. A play call starts one period after the last one started, or
 * when the last one ended if it ran past its period, so a call's own cycles count inside its period
 * and an overrun delays the next call while the timers count on through it. Everything is integer
 * cycles, so it stays deterministic.
 *
 * Nothing here is stepped per cycle and nothing allocates: a timer is counted on to the cycle of
 * each access, and `state` is the whole model, so a snapshot is a copy of one typed array.
 */
export class IoChips {
  /** The whole model, in the layout above. */
  readonly state = new Float64Array(CHIP_STATE_LENGTH);

  /**
   * @param cyclesPerFrame the period of a raster-driven call
   * @param defaultTimerALatch what CIA 1 timer A is latched at in the PSID default environment
   */
  constructor(
    private readonly cyclesPerFrame: number,
    private readonly defaultTimerALatch: number,
  ) {}

  /**
   * Puts the PSID default environment in place and the clock at cycle 0: the raster interrupt
   * enabled when the speed bit is 0; CIA 1 timer A latched at the default and running, its interrupt
   * enabled when the speed bit is 1; every other timer stopped and loaded with `$FFFF`.
   */
  reset(speedBit: number): void {
    const s = this.state;
    s.fill(0);
    s[VIC_ENABLE] = speedBit === 0 ? VIC_RASTER_INTERRUPT_BIT : 0;
    this.resetTimers(CIA1);
    this.resetTimers(CIA2);
    const timerA = CIA1 + TIMER_A;
    s[timerA + COUNTER] = this.defaultTimerALatch;
    s[timerA + LATCH] = this.defaultTimerALatch;
    s[timerA + CONTROL] = CIA_CONTROL_START;
    s[CIA1 + CIA_ENABLE] = speedBit === 1 ? CIA_INTERRUPT_TIMER_A_BIT : 0;
  }

  private resetTimers(cia: number): void {
    const s = this.state;
    for (const timer of [cia + TIMER_A, cia + TIMER_B]) {
      s[timer + COUNTER] = CIA_TIMER_RESET_VALUE;
      s[timer + LATCH] = CIA_TIMER_RESET_VALUE;
    }
  }

  /** The init routine has ended after `cyclesUsed` cycles; the first play call falls due right away. */
  endInit(cyclesUsed: number): void {
    this.state[CALL_END] = cyclesUsed;
    this.state[CALL_DUE] = cyclesUsed;
  }

  /**
   * A play call starts, at its due cycle or, when the last call ran past it, when that one ended.
   *
   * A raster-driven call sets the raster flag. A CIA-driven call is what timer A's underflow raised:
   * the underflow is flagged, and a call that starts on time finds the timer just reloaded. A late
   * one finds it as the overrun left it.
   */
  beginCall(drive: CallDrive): void {
    const s = this.state;
    const due = s[CALL_DUE];
    const start = Math.max(due, s[CALL_END]);
    s[CALL_START] = start;

    if (drive === CALL_RASTER) {
      s[VIC_FLAG] = 1;
      s[CALL_DUE] = start + this.cyclesPerFrame;
      return;
    }
    const timerA = CIA1 + TIMER_A;
    this.syncCia(CIA1, start);
    if (start === due) {
      s[timerA + COUNTER] = s[timerA + LATCH];
    }
    s[CIA1 + CIA_FLAGS] |= CIA_INTERRUPT_TIMER_A_BIT;
    s[CALL_DUE] = start + s[timerA + LATCH] + 1;
  }

  /** The call that `beginCall` started has ended after `cyclesUsed` cycles. */
  endCall(cyclesUsed: number): void {
    this.state[CALL_END] = this.state[CALL_START] + cyclesUsed;
  }

  /** What CIA 1 timer A's latch holds: the tune's own or, for one that wrote none, the default. */
  timerALatch(): number {
    return this.state[CIA1 + TIMER_A + LATCH];
  }

  /** Whether the tune has written CIA 1 timer A's latch since init. */
  timerALatchWritten(): boolean {
    return this.state[LATCH_WRITTEN] !== 0;
  }

  /** Whether CIA 1's interrupt for timer A is enabled. */
  timerAInterruptEnabled(): boolean {
    return (this.state[CIA1 + CIA_ENABLE] & CIA_INTERRUPT_TIMER_A_BIT) !== 0;
  }

  /**
   * What the tune reads at `address`, `elapsed` cycles into the current call, or -1 where the model
   * has no register and the address is plain memory. A read of `$xD` clears the flags it returns, so
   * a given read must be made exactly once.
   */
  read(address: number, elapsed: number): number {
    const s = this.state;
    if (address === VIC_INTERRUPT_STATUS_REGISTER) {
      const flag = s[VIC_FLAG];
      const enabled = (s[VIC_ENABLE] & VIC_RASTER_INTERRUPT_BIT) !== 0;
      return (
        VIC_INTERRUPT_STATUS_UNUSED_BITS |
        flag |
        (flag !== 0 && enabled ? VIC_INTERRUPT_ANY_BIT : 0)
      );
    }
    if (address === VIC_INTERRUPT_ENABLE_REGISTER) {
      return VIC_INTERRUPT_ENABLE_UNUSED_BITS | s[VIC_ENABLE];
    }
    const page = address >> 8;
    const register = address & 0xff;
    if ((page !== CIA1_PAGE && page !== CIA2_PAGE) || !isModelledCiaRegister(register)) {
      return -1;
    }
    const cia = page === CIA1_PAGE ? CIA1 : CIA2;
    this.syncCia(cia, s[CALL_START] + elapsed);

    switch (register) {
      case CIA_TIMER_A_LOW:
        return s[cia + TIMER_A + COUNTER] & 0xff;
      case CIA_TIMER_A_HIGH:
        return s[cia + TIMER_A + COUNTER] >> 8;
      case CIA_TIMER_B_LOW:
        return s[cia + TIMER_B + COUNTER] & 0xff;
      case CIA_TIMER_B_HIGH:
        return s[cia + TIMER_B + COUNTER] >> 8;
      case CIA_INTERRUPT_CONTROL: {
        const flags = s[cia + CIA_FLAGS];
        s[cia + CIA_FLAGS] = 0;
        return flags | ((flags & s[cia + CIA_ENABLE]) !== 0 ? CIA_INTERRUPT_SET_BIT : 0);
      }
      case CIA_CONTROL_A:
        return s[cia + TIMER_A + CONTROL];
      default:
        return s[cia + TIMER_B + CONTROL];
    }
  }

  /** A write of `value` at `address`, `elapsed` cycles into the current call. Registers the model has none of are ignored. */
  write(address: number, value: number, elapsed: number): void {
    const s = this.state;
    if (address === VIC_INTERRUPT_STATUS_REGISTER) {
      if ((value & VIC_RASTER_INTERRUPT_BIT) !== 0) {
        s[VIC_FLAG] = 0;
      }
      return;
    }
    if (address === VIC_INTERRUPT_ENABLE_REGISTER) {
      s[VIC_ENABLE] = value & VIC_INTERRUPT_ENABLE_MASK;
      return;
    }
    const page = address >> 8;
    const register = address & 0xff;
    if ((page !== CIA1_PAGE && page !== CIA2_PAGE) || !isModelledCiaRegister(register)) {
      return;
    }
    const cia = page === CIA1_PAGE ? CIA1 : CIA2;
    this.syncCia(cia, s[CALL_START] + elapsed);

    switch (register) {
      case CIA_TIMER_A_LOW:
      case CIA_TIMER_A_HIGH:
        if (cia === CIA1) {
          if (s[LATCH_WRITTEN] === 0) {
            // The play rate has always taken the half of this latch a tune never wrote as 0, not as
            // the default's, and the fingerprint check holds the model to that. Hardware keeps the
            // default's byte; changing this moves the rate of every tune that writes one half only.
            s[cia + TIMER_A + LATCH] = 0;
          }
          s[LATCH_WRITTEN] = 1;
        }
        this.writeLatchByte(cia + TIMER_A, register === CIA_TIMER_A_HIGH, value);
        break;
      case CIA_TIMER_B_LOW:
      case CIA_TIMER_B_HIGH:
        this.writeLatchByte(cia + TIMER_B, register === CIA_TIMER_B_HIGH, value);
        break;
      case CIA_INTERRUPT_CONTROL: {
        const bits = value & CIA_INTERRUPT_MASK;
        s[cia + CIA_ENABLE] =
          (value & CIA_INTERRUPT_SET_BIT) !== 0
            ? s[cia + CIA_ENABLE] | bits
            : s[cia + CIA_ENABLE] & ~bits;
        break;
      }
      case CIA_CONTROL_A:
        this.writeControl(cia + TIMER_A, value);
        break;
      default:
        this.writeControl(cia + TIMER_B, value);
    }
  }

  /** A latch byte. Writing the high byte of a stopped timer also loads its counter. */
  private writeLatchByte(timer: number, high: boolean, value: number): void {
    const s = this.state;
    if (!high) {
      s[timer + LATCH] = (s[timer + LATCH] & 0xff00) | value;
      return;
    }
    const latch = (s[timer + LATCH] & 0x00ff) | (value << 8);
    s[timer + LATCH] = latch;
    if ((s[timer + CONTROL] & CIA_CONTROL_START) === 0) {
      s[timer + COUNTER] = latch;
    }
  }

  private writeControl(timer: number, value: number): void {
    const s = this.state;
    s[timer + CONTROL] = value & ~CIA_CONTROL_FORCE_LOAD;
    if ((value & CIA_CONTROL_FORCE_LOAD) !== 0) {
      s[timer + COUNTER] = s[timer + LATCH];
    }
  }

  /**
   * Counts both timers of a CIA on to cycle `now`. Timer A counts φ2 cycles while it runs. Timer B
   * counts φ2 cycles too, or timer A's underflows in cascade mode; the CNT pin, which nothing here
   * drives, is a source neither counts from.
   */
  private syncCia(cia: number, now: number): void {
    const s = this.state;
    const timerA = cia + TIMER_A;
    const timerB = cia + TIMER_B;

    const elapsedA = now - s[timerA + SYNC];
    s[timerA + SYNC] = now;
    if ((s[timerA + CONTROL] & (CIA_CONTROL_START | CIA_CONTROL_A_CNT_BIT)) === CIA_CONTROL_START) {
      this.count(cia, timerA, elapsedA, CIA_INTERRUPT_TIMER_A_BIT);
    }

    const underflowsOfA = s[timerA + UNDERFLOWS];
    const cascaded = underflowsOfA - s[timerB + SEEN];
    s[timerB + SEEN] = underflowsOfA;
    const elapsedB = now - s[timerB + SYNC];
    s[timerB + SYNC] = now;
    const controlB = s[timerB + CONTROL];
    if ((controlB & CIA_CONTROL_START) !== 0) {
      const source = (controlB >> CIA_TIMER_B_SOURCE_SHIFT) & CIA_TIMER_B_SOURCE_MASK;
      if (source === CIA_TIMER_B_SOURCE_PHI2) {
        this.count(cia, timerB, elapsedB, CIA_INTERRUPT_TIMER_B_BIT);
      } else if (source === CIA_TIMER_B_SOURCE_TIMER_A) {
        this.count(cia, timerB, cascaded, CIA_INTERRUPT_TIMER_B_BIT);
      }
    }
  }

  /**
   * Counts a running timer down by `steps`. The step past zero is an underflow: the flag is set and
   * the counter reloads from the latch, so a timer's period is its latch plus one; a one-shot timer
   * stops instead of going on.
   */
  private count(cia: number, timer: number, steps: number, flagBit: number): void {
    const s = this.state;
    if (steps <= 0) {
      return;
    }
    const counter = s[timer + COUNTER];
    if (steps <= counter) {
      s[timer + COUNTER] = counter - steps;
      return;
    }

    s[cia + CIA_FLAGS] |= flagBit;
    const latch = s[timer + LATCH];
    if ((s[timer + CONTROL] & CIA_CONTROL_ONE_SHOT) !== 0) {
      s[timer + COUNTER] = latch;
      s[timer + CONTROL] &= ~CIA_CONTROL_START;
      s[timer + UNDERFLOWS] += 1;
      return;
    }
    const beyond = steps - counter - 1;
    const period = latch + 1;
    const reloads = Math.floor(beyond / period);
    s[timer + UNDERFLOWS] += 1 + reloads;
    s[timer + COUNTER] = latch - (beyond - reloads * period);
  }
}
