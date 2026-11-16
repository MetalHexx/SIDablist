import { describe, it, expect } from 'vitest';
import { CALL_CIA, CALL_RASTER, CHIP_STATE_LENGTH, IoChips } from './io-chips.js';
import { NTSC_CYCLES_PER_FRAME, PAL_CYCLES_PER_FRAME } from './cpu-constants.js';

const CIA1_TIMER_A_LOW = 0xdc04;
const CIA1_TIMER_A_HIGH = 0xdc05;
const CIA1_TIMER_B_LOW = 0xdc06;
const CIA1_TIMER_B_HIGH = 0xdc07;
const CIA1_INTERRUPTS = 0xdc0d;
const CIA1_CONTROL_A = 0xdc0e;
const CIA1_CONTROL_B = 0xdc0f;
const CIA2_TIMER_A_LOW = 0xdd04;
const CIA2_TIMER_A_HIGH = 0xdd05;
const CIA2_TIMER_B_LOW = 0xdd06;
const CIA2_TIMER_B_HIGH = 0xdd07;
const CIA2_INTERRUPTS = 0xdd0d;
const CIA2_CONTROL_A = 0xdd0e;
const CIA2_CONTROL_B = 0xdd0f;
const VIC_STATUS = 0xd019;
const VIC_ENABLES = 0xd01a;

const START = 0x01;
const ONE_SHOT = 0x08;
const FORCE_LOAD = 0x10;
/** Start, force load, and timer B counting timer A's underflows — what *Crosshatch*'s init writes. */
const CASCADE = 0x55;

function chips(speedBit = 0, clock: 'pal' | 'ntsc' = 'pal'): IoChips {
  const pal = clock === 'pal';
  const result = new IoChips(
    pal ? PAL_CYCLES_PER_FRAME : NTSC_CYCLES_PER_FRAME,
    pal ? 0x4025 : 0x4295,
  );
  result.reset(speedBit);
  return result;
}

/** A 16-bit timer value read at `at` cycles: low byte, then high byte, at the same cycle. */
function word(chip: IoChips, low: number, at: number): number {
  return chip.read(low, at) | (chip.read(low + 1, at) << 8);
}

/** Latches CIA 2 timer A at `latch`, which loads its counter while it is stopped, then starts it. */
function startedTimer(latch: number, control = START): IoChips {
  const chip = chips();
  chip.write(CIA2_TIMER_A_LOW, latch & 0xff, 0);
  chip.write(CIA2_TIMER_A_HIGH, latch >> 8, 0);
  chip.write(CIA2_CONTROL_A, control, 0);
  return chip;
}

/** *Crosshatch*'s setup: CIA 1 timer A latched at `$0033` and force-loaded, timer B counting its underflows. */
function cascade(): IoChips {
  const chip = chips();
  chip.write(CIA1_TIMER_A_LOW, 0x33, 0);
  chip.write(CIA1_TIMER_A_HIGH, 0x00, 0);
  chip.write(CIA1_CONTROL_A, START | FORCE_LOAD, 0);
  chip.write(CIA1_CONTROL_B, CASCADE, 0);
  return chip;
}

describe('IoChips', () => {
  describe('the PSID default environment', () => {
    it.each([
      ['PAL', 'pal' as const, 0x4025],
      ['NTSC', 'ntsc' as const, 0x4295],
    ])('latches CIA 1 timer A at 60 Hz of the %s clock and runs it', (_name, clock, latch) => {
      const chip = chips(0, clock);

      expect(chip.timerALatch()).toBe(latch);
      expect(word(chip, CIA1_TIMER_A_LOW, 0)).toBe(latch);
      expect(word(chip, CIA1_TIMER_A_LOW, 5)).toBe(latch - 5);
      expect(chip.read(CIA1_CONTROL_A, 5)).toBe(START);
    });

    it.each([0, 1])(
      'stops every other timer and loads it with $FFFF, with speed bit %i',
      (speedBit) => {
        const chip = chips(speedBit);

        for (const low of [CIA1_TIMER_B_LOW, CIA2_TIMER_A_LOW, CIA2_TIMER_B_LOW]) {
          expect(word(chip, low, 1000)).toBe(0xffff);
        }
        for (const control of [CIA1_CONTROL_B, CIA2_CONTROL_A, CIA2_CONTROL_B]) {
          expect(chip.read(control, 1000)).toBe(0);
        }
      },
    );

    it('enables the raster interrupt when the speed bit is 0 and CIA 1 timer A when it is 1', () => {
      const vertical = chips(0);
      const cia = chips(1);

      expect(vertical.read(VIC_ENABLES, 0)).toBe(0xf1);
      expect(vertical.timerAInterruptEnabled()).toBe(false);
      expect(cia.read(VIC_ENABLES, 0)).toBe(0xf0);
      expect(cia.timerAInterruptEnabled()).toBe(true);
    });

    it('flags timer A when it first underflows, and reports the flag enabled only with speed bit 1', () => {
      expect(chips(0).read(CIA1_INTERRUPTS, 0x4026)).toBe(0x01);
      expect(chips(1).read(CIA1_INTERRUPTS, 0x4026)).toBe(0x81);
      expect(chips(1).read(CIA1_INTERRUPTS, 0x4025)).toBe(0x00);
    });

    it.each([
      ['PAL', 'pal' as const, 0x25, 0x40],
      ['NTSC', 'ntsc' as const, 0x95, 0x42],
    ])(
      "keeps the default's byte of CIA 1 timer A's latch for a half the tune never wrote, on %s",
      (_name, clock, defaultLow, defaultHigh) => {
        const high = chips(1, clock);
        high.write(CIA1_TIMER_A_HIGH, 0x20, 0);
        const low = chips(1, clock);
        low.write(CIA1_TIMER_A_LOW, 0x20, 0);
        const both = chips(1, clock);
        both.write(CIA1_TIMER_A_LOW, 0x20, 0);
        both.write(CIA1_TIMER_A_HIGH, 0x30, 0);
        both.write(CIA1_TIMER_A_LOW, 0x40, 0);

        expect(high.timerALatch()).toBe((0x20 << 8) | defaultLow);
        expect(low.timerALatch()).toBe((defaultHigh << 8) | 0x20);
        expect(both.timerALatch()).toBe(0x3040);
        expect(chips(1, clock).timerALatchWritten()).toBe(false);
        expect(high.timerALatchWritten()).toBe(true);
      },
    );

    it('leaves the addresses it has no register at to plain memory', () => {
      const chip = chips();

      expect(chip.read(0xdc00, 0)).toBe(-1);
      expect(chip.read(0xdc08, 0)).toBe(-1);
      expect(chip.read(0xdc0c, 0)).toBe(-1);
      expect(chip.read(0xd01b, 0)).toBe(-1);
    });
  });

  describe('a timer', () => {
    it('counts down one a cycle while it runs', () => {
      const chip = startedTimer(0x0100);

      expect(word(chip, CIA2_TIMER_A_LOW, 10)).toBe(0x00f6);
      expect(word(chip, CIA2_TIMER_A_LOW, 30)).toBe(0x00e2);
    });

    it('is read from the cycle count when read, so two reads differ by the cycles between them', () => {
      const chip = startedTimer(0xffff);

      const first = chip.read(CIA2_TIMER_A_LOW, 100);
      const second = chip.read(CIA2_TIMER_A_LOW, 108);

      expect((first - second + 256) % 256).toBe(8);
    });

    it('does not count while it is stopped, and starts counting from when it is started', () => {
      const chip = chips();
      chip.write(CIA2_TIMER_A_LOW, 0x00, 0);
      chip.write(CIA2_TIMER_A_HIGH, 0x01, 0);
      expect(word(chip, CIA2_TIMER_A_LOW, 100)).toBe(0x0100);

      chip.write(CIA2_CONTROL_A, START, 100);

      expect(word(chip, CIA2_TIMER_A_LOW, 110)).toBe(0x00f6);
    });

    it('keeps the other byte of the latch when one is written', () => {
      const chip = chips();
      chip.write(CIA2_TIMER_A_HIGH, 0x12, 0);
      chip.write(CIA2_TIMER_A_LOW, 0x56, 0);
      chip.write(CIA2_CONTROL_A, FORCE_LOAD, 0);

      expect(word(chip, CIA2_TIMER_A_LOW, 0)).toBe(0x1256);
    });

    it('loads its counter when the high latch byte is written while stopped, and not while running', () => {
      const stopped = chips();
      stopped.write(CIA2_TIMER_A_HIGH, 0x12, 0);
      const running = startedTimer(0x0100);
      running.write(CIA2_TIMER_A_HIGH, 0x20, 4);

      expect(word(stopped, CIA2_TIMER_A_LOW, 0)).toBe(0x12ff);
      expect(word(running, CIA2_TIMER_A_LOW, 4)).toBe(0x00fc);
    });

    it('writing the low latch byte of a stopped timer does not load the counter', () => {
      const chip = chips();
      chip.write(CIA2_TIMER_A_LOW, 0x10, 0);

      expect(word(chip, CIA2_TIMER_A_LOW, 0)).toBe(0xffff);
    });

    it('reloads from the latch on underflow, a period of the latch plus one', () => {
      const chip = startedTimer(9);

      expect(chip.read(CIA2_TIMER_A_LOW, 9)).toBe(0);
      expect(chip.read(CIA2_TIMER_A_LOW, 10)).toBe(9);
      expect(chip.read(CIA2_TIMER_A_LOW, 15)).toBe(4);
    });

    it.each([1, 7, 37, 38, 39, 1000, 12345, 1_000_005])(
      'is where stepping it a cycle at a time would leave it, read after %i cycles',
      (cycles) => {
        const chip = startedTimer(37);

        expect(chip.read(CIA2_TIMER_A_LOW, cycles)).toBe(37 - (cycles % 38));
      },
    );

    it('stops on underflow when it is one-shot, loaded with its latch', () => {
      const chip = startedTimer(9, START | ONE_SHOT);

      expect(chip.read(CIA2_TIMER_A_LOW, 10)).toBe(9);
      expect(chip.read(CIA2_TIMER_A_LOW, 500)).toBe(9);
      expect(chip.read(CIA2_CONTROL_A, 500)).toBe(ONE_SHOT);
      expect(chip.read(CIA2_INTERRUPTS, 500)).toBe(0x01);
    });

    it('loads from its latch on a force load, and reads the control back without that bit', () => {
      const chip = startedTimer(0x0100);

      chip.write(CIA2_CONTROL_A, START | FORCE_LOAD, 50);

      expect(word(chip, CIA2_TIMER_A_LOW, 50)).toBe(0x0100);
      expect(chip.read(CIA2_CONTROL_A, 50)).toBe(START);
    });

    it('does not count from the CNT pin, which nothing drives', () => {
      const chip = startedTimer(0x0100, START | 0x20);

      expect(word(chip, CIA2_TIMER_A_LOW, 50)).toBe(0x0100);
    });
  });

  describe('timer B', () => {
    it('counts φ2 cycles when its source bits are 00', () => {
      const chip = chips();
      chip.write(CIA1_TIMER_B_LOW, 0x00, 0);
      chip.write(CIA1_TIMER_B_HIGH, 0x10, 0);
      chip.write(CIA1_CONTROL_B, START, 0);

      expect(word(chip, CIA1_TIMER_B_LOW, 100)).toBe(0x1000 - 100);
    });

    it('drops by one every 52 cycles in cascade with timer A latched at $0033', () => {
      const chip = cascade();

      expect(word(chip, CIA1_TIMER_B_LOW, 51)).toBe(0xffff);
      expect(word(chip, CIA1_TIMER_B_LOW, 52)).toBe(0xfffe);
      expect(word(chip, CIA1_TIMER_B_LOW, 103)).toBe(0xfffe);
      expect(word(chip, CIA1_TIMER_B_LOW, 104)).toBe(0xfffd);
      expect(word(chip, CIA1_TIMER_B_LOW, 520)).toBe(0xfff5);
      expect(word(chip, CIA1_TIMER_B_LOW, 520 + 520)).toBe(0xffeb);
    });

    it('follows timer A as its latch changes: the period in force finishes, then the new one runs', () => {
      const chip = cascade();
      chip.write(CIA1_TIMER_A_LOW, 0x09, 20);

      expect(word(chip, CIA1_TIMER_B_LOW, 51)).toBe(0xffff);
      expect(word(chip, CIA1_TIMER_B_LOW, 52)).toBe(0xfffe);
      expect(word(chip, CIA1_TIMER_B_LOW, 62)).toBe(0xfffd);
      expect(word(chip, CIA1_TIMER_B_LOW, 72)).toBe(0xfffc);
    });

    it('stands still when timer A is stopped', () => {
      const chip = cascade();
      chip.write(CIA1_CONTROL_A, 0, 104);

      expect(word(chip, CIA1_TIMER_B_LOW, 104)).toBe(0xfffd);
      expect(word(chip, CIA1_TIMER_B_LOW, 5000)).toBe(0xfffd);
    });

    it('does not count from the CNT pin, which nothing drives', () => {
      const chip = cascade();
      chip.write(CIA1_CONTROL_B, START | 0x20, 0);

      expect(word(chip, CIA1_TIMER_B_LOW, 520)).toBe(0xffff);
    });

    it('flags its own underflow in bit 1 when it runs out of timer A underflows', () => {
      const underflowed = (at: number): number => {
        const chip = chips();
        chip.write(CIA1_TIMER_A_LOW, 0x09, 0);
        chip.write(CIA1_TIMER_A_HIGH, 0x00, 0);
        chip.write(CIA1_CONTROL_A, START | FORCE_LOAD, 0);
        chip.write(CIA1_TIMER_B_LOW, 0x03, 0);
        chip.write(CIA1_TIMER_B_HIGH, 0x00, 0);
        chip.write(CIA1_CONTROL_B, 0x40 | START | FORCE_LOAD, 0);
        return chip.read(CIA1_INTERRUPTS, at);
      };

      // Timer A underflows at 10, 20, 30 and 40; timer B, loaded with 3, underflows on the fourth.
      expect(underflowed(39) & 0x02).toBe(0);
      expect(underflowed(40) & 0x02).toBe(0x02);
    });
  });

  describe('the interrupt register', () => {
    it('returns the timer A underflow flag and clears it on the read', () => {
      const chip = startedTimer(0x10);

      expect(chip.read(CIA2_INTERRUPTS, 16)).toBe(0x00);
      expect(chip.read(CIA2_INTERRUPTS, 17)).toBe(0x01);
      expect(chip.read(CIA2_INTERRUPTS, 17)).toBe(0x00);
    });

    it('sets the flag again at the next underflow', () => {
      const chip = startedTimer(0x10);
      chip.read(CIA2_INTERRUPTS, 17);

      expect(chip.read(CIA2_INTERRUPTS, 33)).toBe(0x00);
      expect(chip.read(CIA2_INTERRUPTS, 34)).toBe(0x01);
    });

    it('sets bit 7 when a flagged interrupt is enabled', () => {
      const chip = startedTimer(0x10);
      chip.write(CIA2_INTERRUPTS, 0x81, 0);

      expect(chip.read(CIA2_INTERRUPTS, 17)).toBe(0x81);
      expect(chip.read(CIA2_INTERRUPTS, 17)).toBe(0x00);
    });

    it('clears the enable bits a write with bit 7 clear names, and only those', () => {
      const chip = startedTimer(0x10);
      chip.write(CIA2_INTERRUPTS, 0x83, 0);
      chip.write(CIA2_INTERRUPTS, 0x02, 0);

      expect(chip.read(CIA2_INTERRUPTS, 17)).toBe(0x81);
      chip.write(CIA2_INTERRUPTS, 0x01, 17);
      expect(chip.read(CIA2_INTERRUPTS, 34)).toBe(0x01);
    });

    it('does not enable timer A by an enable write that names timer B alone', () => {
      const chip = startedTimer(0x10);
      chip.write(CIA2_INTERRUPTS, 0x82, 0);

      expect(chip.read(CIA2_INTERRUPTS, 17)).toBe(0x01);
    });

    it('keeps each CIA to its own flags', () => {
      const chip = startedTimer(0x10);

      expect(chip.read(CIA1_INTERRUPTS, 100)).toBe(0x00);
      expect(chip.read(CIA2_INTERRUPTS, 100)).toBe(0x01);
    });

    it('flags timer B in bit 1 of CIA 2 as it does in CIA 1', () => {
      const chip = chips();
      chip.write(CIA2_TIMER_B_LOW, 0x05, 0);
      chip.write(CIA2_TIMER_B_HIGH, 0x00, 0);
      chip.write(CIA2_CONTROL_B, START, 0);
      chip.write(CIA2_INTERRUPTS, 0x82, 0);

      expect(chip.read(CIA2_INTERRUPTS, 5)).toBe(0x00);
      expect(chip.read(CIA2_INTERRUPTS, 6)).toBe(0x82);
    });
  });

  describe('the VIC raster flag', () => {
    it('is set at the start of a raster-driven call, and read with bit 7 while the raster interrupt is enabled', () => {
      const chip = chips(0);
      chip.endInit(100);
      expect(chip.read(VIC_STATUS, 0)).toBe(0x70);

      chip.beginCall(CALL_RASTER);

      expect(chip.read(VIC_STATUS, 0)).toBe(0xf1);
    });

    it('is read without bit 7 while the raster interrupt is disabled', () => {
      const chip = chips(0);
      chip.endInit(100);
      chip.write(VIC_ENABLES, 0x00, 50);
      chip.beginCall(CALL_RASTER);

      expect(chip.read(VIC_STATUS, 0)).toBe(0x71);
    });

    it('is cleared by writing a 1 to bit 0 and by nothing else', () => {
      const chip = chips(0);
      chip.endInit(100);
      chip.beginCall(CALL_RASTER);

      chip.write(VIC_STATUS, 0xfe, 4);
      expect(chip.read(VIC_STATUS, 8)).toBe(0xf1);
      chip.write(VIC_STATUS, 0x01, 8);
      expect(chip.read(VIC_STATUS, 12)).toBe(0x70);
    });

    it('is set again by the next raster-driven call', () => {
      const chip = chips(0);
      chip.endInit(100);
      chip.beginCall(CALL_RASTER);
      chip.write(VIC_STATUS, 0x01, 4);
      chip.endCall(30);

      chip.beginCall(CALL_RASTER);

      expect(chip.read(VIC_STATUS, 0)).toBe(0xf1);
    });

    it('is left alone by a CIA-driven call', () => {
      const chip = chips(1);
      chip.endInit(100);

      chip.beginCall(CALL_CIA);

      expect(chip.read(VIC_STATUS, 0)).toBe(0x70);
    });

    it('holds the four enable bits a write sets, over the unused ones that read as 1', () => {
      const chip = chips(0);
      chip.write(VIC_ENABLES, 0xa3, 0);

      expect(chip.read(VIC_ENABLES, 0)).toBe(0xf3);
    });
  });

  describe('the calls in time', () => {
    /** The cycle count a call started at, read off CIA 2 timer A counting down from $FFFF since cycle 0. */
    function startOfCall(chip: IoChips): number {
      return 0xffff - word(chip, CIA2_TIMER_A_LOW, 0);
    }
    function clocked(speedBit = 0): IoChips {
      const chip = chips(speedBit);
      chip.write(CIA2_CONTROL_A, START, 0);
      return chip;
    }

    it('starts the first play call when init ends', () => {
      const chip = clocked();
      chip.endInit(100);

      chip.beginCall(CALL_RASTER);

      expect(startOfCall(chip)).toBe(100);
    });

    it('starts a raster-driven call a frame after the last one started, whatever the last one used', () => {
      const chip = clocked();
      chip.endInit(100);
      chip.beginCall(CALL_RASTER);
      chip.endCall(500);

      chip.beginCall(CALL_RASTER);
      expect(startOfCall(chip)).toBe(100 + PAL_CYCLES_PER_FRAME);
      chip.endCall(20);

      chip.beginCall(CALL_RASTER);
      expect(startOfCall(chip)).toBe(100 + 2 * PAL_CYCLES_PER_FRAME);
    });

    it('starts the next call when a call that ran past its period ends', () => {
      const chip = clocked();
      chip.endInit(100);
      chip.beginCall(CALL_RASTER);
      chip.endCall(25_000);

      chip.beginCall(CALL_RASTER);
      expect(startOfCall(chip)).toBe(100 + 25_000);
      chip.endCall(20);

      chip.beginCall(CALL_RASTER);
      expect(startOfCall(chip)).toBe(100 + 25_000 + PAL_CYCLES_PER_FRAME);
    });

    it('starts a CIA-driven call the latch plus one cycles after the last one started', () => {
      const chip = clocked(1);
      chip.write(CIA1_TIMER_A_LOW, 0xff, 50);
      chip.write(CIA1_TIMER_A_HIGH, 0x0f, 50);
      chip.endInit(100);
      chip.beginCall(CALL_CIA);
      chip.endCall(10);

      chip.beginCall(CALL_CIA);

      expect(startOfCall(chip)).toBe(100 + 0x1000);
    });

    it('takes the period from the latch in force when the call started, not one the call writes', () => {
      const chip = clocked(1);
      chip.write(CIA1_TIMER_A_LOW, 0xff, 50);
      chip.write(CIA1_TIMER_A_HIGH, 0x0f, 50);
      chip.endInit(100);
      chip.beginCall(CALL_CIA);
      chip.write(CIA1_TIMER_A_HIGH, 0x01, 5);
      chip.endCall(10);

      chip.beginCall(CALL_CIA);

      expect(startOfCall(chip)).toBe(100 + 0x1000);
    });

    it('starts a CIA-driven call that is on time with timer A just reloaded and its underflow flagged', () => {
      const chip = chips(1);
      chip.write(CIA1_TIMER_A_LOW, 0xff, 50);
      chip.write(CIA1_TIMER_A_HIGH, 0x0f, 50);
      chip.endInit(100);

      for (let call = 0; call < 3; call++) {
        chip.beginCall(CALL_CIA);
        expect(word(chip, CIA1_TIMER_A_LOW, 0)).toBe(0x0fff);
        expect(chip.read(CIA1_INTERRUPTS, 0)).toBe(0x81);
        chip.endCall(10);
      }
    });

    it('finds timer A as the overrun left it when a CIA-driven call starts late', () => {
      const chip = chips(1);
      chip.write(CIA1_TIMER_A_LOW, 0xff, 50);
      chip.write(CIA1_TIMER_A_HIGH, 0x0f, 50);
      chip.endInit(100);
      chip.beginCall(CALL_CIA);
      chip.endCall(6000);

      chip.beginCall(CALL_CIA);

      // Reloaded at 100 + 4096, then 6000 - 4096 cycles into the next period.
      expect(word(chip, CIA1_TIMER_A_LOW, 0)).toBe(0x0fff - (6000 - 0x1000));
      expect(chip.read(CIA1_INTERRUPTS, 0)).toBe(0x81);
    });
  });

  it('keeps everything it knows in its state, so a copy of it carries on the same', () => {
    const chip = cascade();
    chip.write(CIA2_TIMER_A_LOW, 0x20, 10);
    chip.write(CIA2_TIMER_A_HIGH, 0x01, 10);
    chip.write(CIA2_CONTROL_A, START | ONE_SHOT, 10);
    chip.write(CIA1_INTERRUPTS, 0x81, 10);
    chip.endInit(300);
    chip.beginCall(CALL_RASTER);
    chip.read(CIA1_TIMER_B_LOW, 123);
    const copy = new IoChips(PAL_CYCLES_PER_FRAME, 0x4025);

    copy.state.set(chip.state);

    expect(copy.state).toHaveLength(CHIP_STATE_LENGTH);
    for (const at of [200, 1000, 40_000]) {
      for (const low of [CIA1_TIMER_A_LOW, CIA1_TIMER_B_LOW, CIA2_TIMER_A_LOW, CIA2_TIMER_B_LOW]) {
        expect(word(copy, low, at)).toBe(word(chip, low, at));
      }
      expect(copy.read(CIA1_INTERRUPTS, at)).toBe(chip.read(CIA1_INTERRUPTS, at));
      expect(copy.read(CIA2_INTERRUPTS, at)).toBe(chip.read(CIA2_INTERRUPTS, at));
    }
  });
});
