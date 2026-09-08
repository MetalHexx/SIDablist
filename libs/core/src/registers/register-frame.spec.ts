import { describe, it, expect, beforeAll } from 'vitest';
import { NTSC_PHI2_HZ, PAL_PHI2_HZ } from './clock-ratio.js';
import { createRegisterFrame } from './register-frame.js';
import type { RegisterFrame, ScaledRegisterGroup, SidFilterMode } from './register-frame.js';
import type { SidFrame } from './sid-frame.js';
import { SID_REGISTER_COUNT, VOICE_CONTROL_REGISTERS } from './sid-constants.js';
import { clamp } from '../common/math.js';
import { createC64Machine } from '../cpu/c64-machine.js';
import type { SidFile } from '../sid/sid-file.model.js';
import { parseSidFile } from '../sid/sid-file.parser.js';
import { BUNDLED_TUNES, decodeBundledTune } from '../sid/__fixtures__/index.js';

interface Write {
  readonly register: number;
  readonly value: number;
}

const ALL_REGISTERS = Array.from({ length: SID_REGISTER_COUNT }, (_, register) => register);

const SCALED_GROUPS: readonly ScaledRegisterGroup[] = [
  'volume',
  'cutoff',
  'resonance',
  'pulseWidth',
];

/** Every register a group owns — the `emittedValues()` tests use this to check that scaling one
 *  group leaves every other register's `sent` byte equal to `written`. */
const REGISTERS_BY_GROUP: Readonly<Record<ScaledRegisterGroup, readonly number[]>> = {
  volume: [24],
  cutoff: [21, 22],
  resonance: [23],
  pulseWidth: [2, 3, 9, 10, 16, 17],
};

/** [low, high] frequency register pairs per voice. */
const FREQUENCY_REGISTERS = [
  [0, 1],
  [7, 8],
  [14, 15],
];

describe('RegisterFrame', () => {
  it('emits a write naming the register the tune wrote, for every register', () => {
    for (const register of ALL_REGISTERS) {
      const frame = createRegisterFrame();
      frame.onSidWrite(register, 0x33);

      expect(writesOf(frame.takeSnapshot())).toEqual([{ register, value: 0x33 }]);
    }
  });

  it('carries the whole byte for a value at or above 0x80', () => {
    const frame = createRegisterFrame();
    frame.onSidWrite(2, 0xab);

    expect(writesOf(frame.takeSnapshot())).toEqual([{ register: 2, value: 0xab }]);
  });

  it("keeps the tune's own write order rather than register order", () => {
    const frame = createRegisterFrame();
    for (const register of [24, 0, 13, 7, 1]) {
      frame.onSidWrite(register, register);
    }

    expect(registersOf(frame.takeSnapshot())).toEqual([24, 0, 13, 7, 1]);
  });

  it('refills one frame object rather than building a new one per call', () => {
    const frame = createRegisterFrame();
    frame.onSidWrite(0, 0x10);
    const first = frame.takeSnapshot();
    frame.onSidWrite(1, 0x20);
    const second = frame.takeSnapshot();

    expect(second).toBe(first);
    expect(second.registers).toBe(first.registers);
    expect(second.values).toBe(first.values);
    expect(second.offsetsUs).toBe(first.offsetsUs);
    expect(writesOf(second)).toEqual([{ register: 1, value: 0x20 }]);
  });

  it.each([4, 11, 18])(
    'carries both writes to gate register %d in one frame, as two ordered writes',
    (register) => {
      const frame = createRegisterFrame();
      frame.onSidWrite(register, 0x10);
      frame.onSidWrite(register, 0x20);

      expect(writesOf(frame.takeSnapshot())).toEqual([
        { register, value: 0x10 },
        { register, value: 0x20 },
      ]);
      expect(frame.suppressedWriteCount).toBe(0);
    },
  );

  it('leaves a gate retrigger where the tune put it, between the writes around it', () => {
    const frame = createRegisterFrame();
    frame.onSidWrite(0, 0x01);
    frame.onSidWrite(4, 0x10);
    frame.onSidWrite(1, 0x02);
    frame.onSidWrite(4, 0x11);

    expect(writesOf(frame.takeSnapshot())).toEqual([
      { register: 0, value: 0x01 },
      { register: 4, value: 0x10 },
      { register: 1, value: 0x02 },
      { register: 4, value: 0x11 },
    ]);
  });

  it('folds a third write to a gate register into the retrigger already carried', () => {
    const frame = createRegisterFrame();
    frame.onSidWrite(4, 0x10);
    frame.onSidWrite(4, 0x20);
    frame.onSidWrite(4, 0x30);

    expect(writesOf(frame.takeSnapshot())).toEqual([
      { register: 4, value: 0x10 },
      { register: 4, value: 0x30 },
    ]);
  });

  it('overwrites a non-gate register in place on a second write, and counts it', () => {
    const frame = createRegisterFrame();
    frame.onSidWrite(5, 0x01);
    frame.onSidWrite(0, 0x10);
    frame.onSidWrite(0, 0x20);

    expect(writesOf(frame.takeSnapshot())).toEqual([
      { register: 5, value: 0x01 },
      { register: 0, value: 0x20 },
    ]);
    expect(frame.suppressedWriteCount).toBe(1);
  });

  it('accumulates the suppressed-write count across frames instead of resetting it on snapshot', () => {
    const frame = createRegisterFrame();
    frame.onSidWrite(0, 0x10);
    frame.onSidWrite(0, 0x20);
    frame.takeSnapshot();
    frame.onSidWrite(1, 0x10);
    frame.onSidWrite(1, 0x20);
    frame.takeSnapshot();

    expect(frame.suppressedWriteCount).toBe(2);
  });

  it('produces an empty frame for a frame with no writes', () => {
    const frame = createRegisterFrame();

    expect(frame.takeSnapshot().count).toBe(0);
  });

  it('clears dirty state on snapshot so an untouched next frame is empty again', () => {
    const frame = createRegisterFrame();
    frame.onSidWrite(0, 0x10);
    frame.takeSnapshot();

    expect(frame.takeSnapshot().count).toBe(0);
  });

  it('resets per-frame second-write tracking on snapshot, so the next frame is not suppressed', () => {
    const frame = createRegisterFrame();
    frame.onSidWrite(0, 0x10);
    frame.onSidWrite(0, 0x20);
    frame.takeSnapshot();

    frame.onSidWrite(0, 0x30);

    expect(writesOf(frame.takeSnapshot())).toEqual([{ register: 0, value: 0x30 }]);
    expect(frame.suppressedWriteCount).toBe(1);
  });

  it('resyncs all 25 registers, once each, in ascending order', () => {
    const frame = createRegisterFrame();

    frame.markAllDirty();
    const snapshot = frame.takeSnapshot();

    expect(registersOf(snapshot)).toEqual(ALL_REGISTERS);
    expect(writesOf(snapshot).every(({ value }) => value === 0)).toBe(true);
  });

  it('reflects a register value already written before a resync', () => {
    const frame = createRegisterFrame();
    frame.onSidWrite(24, 0x42);
    frame.takeSnapshot();

    frame.markAllDirty();

    expect(emittedValue(frame.takeSnapshot(), 24)).toBe(0x42);
  });

  it("puts a resync's forced writes after the tune's own, skipping what the tune already wrote", () => {
    const frame = createRegisterFrame();
    frame.markAllDirty();
    frame.onSidWrite(20, 0x77);
    frame.onSidWrite(3, 0x66);

    const registers = registersOf(frame.takeSnapshot());

    expect(registers.slice(0, 2)).toEqual([20, 3]);
    expect(registers.slice(2)).toEqual(
      ALL_REGISTERS.filter((register) => register !== 20 && register !== 3),
    );
  });

  it('fits a full resync alongside a retrigger of all three gate registers', () => {
    const frame = createRegisterFrame();
    frame.markAllDirty();
    for (const register of [4, 11, 18]) {
      frame.onSidWrite(register, 0x01);
      frame.onSidWrite(register, 0x02);
    }

    const snapshot = frame.takeSnapshot();

    expect(snapshot.count).toBe(SID_REGISTER_COUNT + 3);
    expect(writesOf(snapshot).filter(({ register }) => register === 4)).toEqual([
      { register: 4, value: 0x01 },
      { register: 4, value: 0x02 },
    ]);
  });

  describe('voice mute', () => {
    it('forces the control register to 0 in the very next frame on mute-engage', () => {
      const frame = createRegisterFrame();

      frame.setVoiceMuted(1, true);

      expect(writesOf(frame.takeSnapshot())).toEqual([{ register: 11, value: 0 }]);
    });

    it('suppresses further writes to a muted voice control register but not its sibling registers', () => {
      const frame = createRegisterFrame();

      frame.setVoiceMuted(1, true);
      frame.takeSnapshot();

      frame.onSidWrite(11, 0x41); // muted control register — dropped
      frame.onSidWrite(9, 0x77); // voice 1's pulse-width-lo register — unaffected

      expect(writesOf(frame.takeSnapshot())).toEqual([{ register: 9, value: 0x77 }]);
    });

    it('drops a retrigger to a muted voice as readily as the first write', () => {
      const frame = createRegisterFrame();

      frame.setVoiceMuted(1, true);
      frame.takeSnapshot();

      frame.onSidWrite(11, 0x41);
      frame.onSidWrite(11, 0x40);

      expect(frame.takeSnapshot().count).toBe(0);
    });

    it('lets a subsequent write through unmodified after unmuting', () => {
      const frame = createRegisterFrame();

      frame.setVoiceMuted(1, true);
      frame.takeSnapshot();
      frame.setVoiceMuted(1, false);

      frame.onSidWrite(11, 0x41);

      expect(writesOf(frame.takeSnapshot())).toEqual([{ register: 11, value: 0x41 }]);
    });

    it('unmuting forces no extra write of its own', () => {
      const frame = createRegisterFrame();

      frame.setVoiceMuted(1, true);
      frame.takeSnapshot();
      frame.setVoiceMuted(1, false);

      expect(frame.takeSnapshot().count).toBe(0);
    });

    it('muting an already-muted voice is a no-op', () => {
      const frame = createRegisterFrame();

      frame.setVoiceMuted(1, true);
      frame.takeSnapshot();
      frame.setVoiceMuted(1, true);

      expect(frame.takeSnapshot().count).toBe(0);
    });

    it('unmuting an already-unmuted voice is a no-op', () => {
      const frame = createRegisterFrame();

      frame.setVoiceMuted(1, false);

      expect(frame.takeSnapshot().count).toBe(0);
    });
  });

  describe('the register values snapshot', () => {
    it('round-trips all 25 registers through a snapshot and a restore', () => {
      const source = createRegisterFrame();
      for (const register of ALL_REGISTERS) {
        source.onSidWrite(register, byteFor(register));
      }
      const cue = source.snapshotValues();

      const target = createRegisterFrame();
      target.restoreValues(cue);
      target.markAllDirty();
      const snapshot = target.takeSnapshot();

      expect(cue.values).toHaveLength(SID_REGISTER_COUNT);
      for (const register of ALL_REGISTERS) {
        expect(emittedValue(snapshot, register)).toBe(byteFor(register));
      }
    });

    it('holds the voices muted now through a restore, whatever the cue captured', () => {
      const source = createRegisterFrame();
      source.onSidWrite(11, 0x41);
      const cue = source.snapshotValues();

      const target = createRegisterFrame();
      target.setVoiceMuted(1, true);
      target.takeSnapshot();
      target.restoreValues(cue);
      target.markAllDirty();

      expect(emittedValue(target.takeSnapshot(), 11)).toBe(0);
    });

    it('drops a half-built frame on restore', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(0, 0x10);

      frame.restoreValues(frame.snapshotValues());

      expect(frame.takeSnapshot().count).toBe(0);
    });
  });

  describe('voiceState', () => {
    it('decodes gate, waveform, frequency and envelope from the shadow, per voice', () => {
      for (let voice = 0; voice < 3; voice++) {
        const base = voice * 7;
        const frame = createRegisterFrame();
        frame.onSidWrite(base + 0, 0x34); // frequency low
        frame.onSidWrite(base + 1, 0x12); // frequency high
        frame.onSidWrite(VOICE_CONTROL_REGISTERS[voice], 0x41); // waveform 4, gate on
        frame.onSidWrite(base + 5, 0x0a); // attack/decay
        frame.onSidWrite(base + 6, 0x55); // sustain/release

        expect(frame.voiceState(voice)).toEqual({
          gate: true,
          waveform: 0x4,
          frequency: 0x1234,
          envelope: 0x0a55,
        });
      }
    });

    it('reads the gate bit and the waveform nibble independently of one another', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(VOICE_CONTROL_REGISTERS[0], 0x10); // waveform 1 (triangle), gate off
      expect(frame.voiceState(0)).toMatchObject({ gate: false, waveform: 0x1 });

      // A fresh frame between the writes, rather than a second write to the same gate register in
      // one frame — that would retrigger instead of replacing the shadow byte `voiceState` reads.
      frame.takeSnapshot();
      frame.onSidWrite(VOICE_CONTROL_REGISTERS[0], 0x81); // waveform 8 (noise), gate on
      expect(frame.voiceState(0)).toMatchObject({ gate: true, waveform: 0x8 });
    });

    it('decodes the raw shadow rather than a scaled one — a pitch correction never moves it', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(0, 0x00);
      frame.onSidWrite(1, 0x10); // frequency 0x1000
      frame.setVoicePitch(0, 2);
      frame.takeSnapshot(); // scaling only ever touches the emitted bytes, never the shadow

      expect(frame.voiceState(0).frequency).toBe(0x1000);
    });
  });

  describe('emittedValues', () => {
    it('matches written and sent everywhere when every control is at home', () => {
      const frame = createRegisterFrame();
      for (const register of ALL_REGISTERS) {
        frame.onSidWrite(register, byteFor(register));
      }

      const { written, sent } = frame.emittedValues();

      for (const register of ALL_REGISTERS) {
        expect(written[register]).toBe(byteFor(register));
        expect(sent[register]).toBe(byteFor(register));
      }
    });

    it.each(SCALED_GROUPS)(
      "differs from written on exactly %s's own registers once scaled off home",
      (group) => {
        const frame = createRegisterFrame();
        for (const register of ALL_REGISTERS) {
          frame.onSidWrite(register, byteFor(register));
        }
        frame.setRegisterScale(group, 0.5);

        const { written, sent } = frame.emittedValues();
        const scaled = new Set(REGISTERS_BY_GROUP[group]);

        for (const register of ALL_REGISTERS) {
          if (scaled.has(register)) {
            expect(sent[register]).not.toBe(written[register]);
          } else {
            expect(sent[register]).toBe(written[register]);
          }
        }
      },
    );

    it("differs from written only on the pitched voice's frequency pair once off home", () => {
      const frame = createRegisterFrame();
      for (const register of ALL_REGISTERS) {
        frame.onSidWrite(register, byteFor(register));
      }
      frame.setVoicePitch(1, 2);

      const { written, sent } = frame.emittedValues();
      const [low, high] = FREQUENCY_REGISTERS[1];

      for (const register of ALL_REGISTERS) {
        if (register === low || register === high) {
          expect(sent[register]).not.toBe(written[register]);
        } else {
          expect(sent[register]).toBe(written[register]);
        }
      }
    });

    it('leaves a forced filter mode visible on sent[24] with no coefficient off home', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(24, 0xba); // voice-3 mute set, tune's mode 0b011, volume 10
      frame.setFilterMode('lowPass');

      const { written, sent } = frame.emittedValues();

      expect(written[24]).toBe(0xba);
      expect(sent[24]).toBe(0x80 | (0b001 << 4) | 0x0a);
    });

    it('never perturbs what the next real frame emits — a pull is side-effect free', () => {
      const control = createRegisterFrame();
      control.onSidWrite(24, 0x2f);
      control.setOutputGain(0.5);
      const expected = writesOf(control.takeSnapshot());

      const observed = createRegisterFrame();
      observed.onSidWrite(24, 0x2f);
      observed.setOutputGain(0.5);
      observed.emittedValues();
      observed.emittedValues();

      expect(writesOf(observed.takeSnapshot())).toEqual(expected);
    });

    it('never consumes the one-shot restore a return home owes the next real frame', () => {
      const control = createRegisterFrame();
      control.onSidWrite(21, 0x07);
      control.onSidWrite(22, 0x64);
      control.setRegisterScale('cutoff', 0.5);
      control.takeSnapshot(); // consumes the initial off-home emission
      control.setRegisterScale('cutoff', 1); // arms the one-shot restore
      const expectedRestore = writesOf(control.takeSnapshot());

      const observed = createRegisterFrame();
      observed.onSidWrite(21, 0x07);
      observed.onSidWrite(22, 0x64);
      observed.setRegisterScale('cutoff', 0.5);
      observed.takeSnapshot();
      observed.setRegisterScale('cutoff', 1);
      observed.emittedValues(); // must not consume the restore before takeSnapshot() gets to it

      expect(writesOf(observed.takeSnapshot())).toEqual(expectedRestore);
    });
  });

  describe('output gain scaling ($D418, register 24)', () => {
    it('scales only the low nibble, leaving every filter-mode/voice-3-mute combination untouched', () => {
      for (let highNibble = 0; highNibble <= 0xf; highNibble++) {
        const frame = createRegisterFrame();
        frame.onSidWrite(24, (highNibble << 4) | 0x0a); // low nibble 10
        frame.setOutputGain(0.5);

        expect(emittedValue(frame.takeSnapshot(), 24)).toBe(
          (highNibble << 4) | Math.round(10 * 0.5),
        );
      }
    });

    it('rounds gain 0 to silence and leaves gain 1 byte-for-byte unchanged', () => {
      const silenced = createRegisterFrame();
      silenced.onSidWrite(24, 0x3f);
      silenced.setOutputGain(0);
      expect(emittedValue(silenced.takeSnapshot(), 24)).toBe(0x30);

      const unchanged = createRegisterFrame();
      unchanged.onSidWrite(24, 0x3f);
      unchanged.setOutputGain(1);
      expect(emittedValue(unchanged.takeSnapshot(), 24)).toBe(0x3f);
    });

    it('rounds a mid-gain value up when past the half boundary and down when short of it', () => {
      const roundsDown = createRegisterFrame();
      roundsDown.onSidWrite(24, 0x02); // low nibble 2 at gain 0.6 -> 1.2, rounds down to 1
      roundsDown.setOutputGain(0.6);
      expect(emittedValue(roundsDown.takeSnapshot(), 24)).toBe(1);

      const roundsUp = createRegisterFrame();
      roundsUp.onSidWrite(24, 0x03); // low nibble 3 at gain 0.6 -> 1.8, rounds up to 2
      roundsUp.setOutputGain(0.6);
      expect(emittedValue(roundsUp.takeSnapshot(), 24)).toBe(2);
    });

    it('carries the volume register with no $D418 write at all, once gain is off unity', () => {
      const frame = createRegisterFrame();
      frame.takeSnapshot(); // establish an empty frame — the raw value defaults to 0
      frame.setOutputGain(0.5);

      expect(writesOf(frame.takeSnapshot())).toEqual([{ register: 24, value: 0 }]);
    });

    it('keeps emitting the volume register every frame while gain stays off unity, with no rewrite', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(24, 0x2f); // written once, never rewritten again
      frame.setOutputGain(0.5);
      frame.takeSnapshot();

      for (const snapshot of [frame.takeSnapshot(), frame.takeSnapshot()]) {
        expect(emittedValue(snapshot, 24)).toBe(0x20 | Math.round(0x0f * 0.5));
      }
    });

    it('carries the volume register once more on the return to exactly unity, to restore the full value', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(24, 0x2f);
      frame.setOutputGain(0.5);
      frame.takeSnapshot(); // consumes the "off unity" emission

      frame.setOutputGain(1);
      expect(emittedValue(frame.takeSnapshot(), 24)).toBe(0x2f);
      expect(emittedValue(frame.takeSnapshot(), 24)).toBeUndefined();
    });

    it('never emits the volume register while the fader stays at unity', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(24, 0x2f);
      frame.takeSnapshot();

      expect(emittedValue(frame.takeSnapshot(), 24)).toBeUndefined();
    });

    it('survives a discarded snapshot between a gain change and the next emitted frame, without swallowing the fader move', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(24, 0x2f);
      frame.setOutputGain(0.5);

      // Mirrors a caller's reset pass — a takeSnapshot() made purely to clear per-frame
      // duplicate-write tracking, whose frame is thrown away.
      frame.takeSnapshot();

      expect(emittedValue(frame.takeSnapshot(), 24)).toBe(0x20 | Math.round(0x0f * 0.5));
    });

    it('leaves the suppressed-write count untouched across a swept fade', () => {
      const frame = createRegisterFrame();
      for (let i = 0; i < 5; i++) {
        frame.onSidWrite(24, 0x20 + i);
        frame.setOutputGain(i / 4);
        frame.takeSnapshot();
      }

      expect(frame.suppressedWriteCount).toBe(0);
    });

    it('keeps snapshotValues() raw, never gain-scaled', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(24, 0x2f);
      frame.setOutputGain(0.5);

      expect(frame.snapshotValues().values[24]).toBe(0x2f);
    });

    it('keeps a resync at one write per register with gain applied', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(24, 0x1f);
      frame.setOutputGain(0.5);

      frame.markAllDirty();
      const snapshot = frame.takeSnapshot();

      expect(registersOf(snapshot)).toEqual([24, ...ALL_REGISTERS.filter((r) => r !== 24)]);
      expect(emittedValue(snapshot, 24)).toBe(0x10 | Math.round(0x0f * 0.5));
    });

    it('does not double-apply gain to a cue captured at one fader position and re-entered at another', () => {
      const source = createRegisterFrame();
      source.onSidWrite(24, 0x2f);
      source.setOutputGain(0.5);
      const cue = source.snapshotValues(); // raw values only, per snapshotValues()'s own contract

      const target = createRegisterFrame();
      target.restoreValues(cue);
      target.setOutputGain(0.25);
      target.markAllDirty();

      expect(emittedValue(target.takeSnapshot(), 24)).toBe(0x20 | Math.round(0x0f * 0.25));
    });
  });

  describe('the generalized register scaling stage', () => {
    const CUTOFF_LOW = 21;
    const CUTOFF_HIGH = 22;
    const RESONANCE = 23;
    const VOLUME = 24;
    /** [low, high] register pairs per voice. */
    const PULSE_WIDTH_REGISTERS = [
      [2, 3],
      [9, 10],
      [16, 17],
    ];

    it('passes every register through byte-for-byte with every control at home', () => {
      const frame = createRegisterFrame();
      for (const register of ALL_REGISTERS) {
        frame.onSidWrite(register, byteFor(register));
      }

      const snapshot = frame.takeSnapshot();

      for (const register of ALL_REGISTERS) {
        expect(emittedValue(snapshot, register)).toBe(byteFor(register));
      }
    });

    it('combines the 11-bit cutoff, rounds it once and splits it back, sparing register 21s upper bits', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(CUTOFF_LOW, 0xff); // cutoff bits 0-2 = 7, upper five bits all set
      frame.onSidWrite(CUTOFF_HIGH, 0x65); // combined = (101 << 3) | 7 = 815

      frame.setRegisterScale('cutoff', 0.5);
      const snapshot = frame.takeSnapshot();

      // 815 * 0.5 = 407.5 -> 408. Scaling byte-at-a-time would land the low bits on 4, not 0.
      expect(emittedValue(snapshot, CUTOFF_HIGH)).toBe(0x33);
      expect(emittedValue(snapshot, CUTOFF_LOW)).toBe(0xf8);
    });

    it('saturates cutoff at its 11-bit ceiling rather than wrapping', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(CUTOFF_LOW, 0x00);
      frame.onSidWrite(CUTOFF_HIGH, 0xff); // combined = 2040

      frame.setRegisterScale('cutoff', 2); // 4080, wrapping would give 1008
      const snapshot = frame.takeSnapshot();

      expect(emittedValue(snapshot, CUTOFF_HIGH)).toBe(0xff);
      expect(emittedValue(snapshot, CUTOFF_LOW)).toBe(0x07);
    });

    it('keeps re-emitting both cutoff registers while off home, on a tune that wrote them once', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(CUTOFF_LOW, 0x07);
      frame.onSidWrite(CUTOFF_HIGH, 0x64); // combined = 807, halved = 404
      frame.setRegisterScale('cutoff', 0.5);
      frame.takeSnapshot();

      for (const snapshot of [frame.takeSnapshot(), frame.takeSnapshot()]) {
        expect(emittedValue(snapshot, CUTOFF_HIGH)).toBe(50);
        expect(emittedValue(snapshot, CUTOFF_LOW)).toBe(4);
      }
    });

    it('restores the raw cutoff bytes for exactly one frame on the return home', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(CUTOFF_LOW, 0xff);
      frame.onSidWrite(CUTOFF_HIGH, 0x65);
      frame.setRegisterScale('cutoff', 0.5);
      frame.takeSnapshot();

      frame.setRegisterScale('cutoff', 1);
      const restore = frame.takeSnapshot();
      expect(emittedValue(restore, CUTOFF_LOW)).toBe(0xff);
      expect(emittedValue(restore, CUTOFF_HIGH)).toBe(0x65);

      const next = frame.takeSnapshot();
      expect(emittedValue(next, CUTOFF_LOW)).toBeUndefined();
      expect(emittedValue(next, CUTOFF_HIGH)).toBeUndefined();
    });

    it('emits nothing when a coefficient is set to the value it already holds', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(CUTOFF_LOW, 0x05);
      frame.takeSnapshot();

      frame.setRegisterScale('cutoff', 1); // already home — must not arm the one-shot restore

      expect(frame.takeSnapshot().count).toBe(0);
    });

    it('scales register 23s resonance nibble without disturbing its filter-routing nibble', () => {
      for (let routing = 0; routing <= 0x0f; routing++) {
        const frame = createRegisterFrame();
        frame.onSidWrite(RESONANCE, 0xc0 | routing); // resonance 12
        frame.setRegisterScale('resonance', 0.5);

        expect(emittedValue(frame.takeSnapshot(), RESONANCE)).toBe(0x60 | routing);
      }
    });

    it.each([
      ['lowPass', 0b001],
      ['bandPass', 0b010],
      ['highPass', 0b100],
      ['off', 0b000],
    ] as const)(
      'replaces the volume registers mode bits with the forced %s mode alone',
      (mode, bits) => {
        const frame = createRegisterFrame();
        frame.onSidWrite(VOLUME, 0xba); // voice-3 mute set, tune's mode 0b011, volume 10

        frame.setFilterMode(mode);

        expect(emittedValue(frame.takeSnapshot(), VOLUME)).toBe(0x80 | (bits << 4) | 0x0a);
      },
    );

    it('composes gain and filter mode into one $D418 byte, neither clobbering the other', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(RESONANCE, 0xc9);
      frame.onSidWrite(VOLUME, 0xba);

      frame.setRegisterScale('resonance', 0.5);
      frame.setOutputGain(0.5);
      const snapshot = frame.takeSnapshot();

      expect(emittedValue(snapshot, VOLUME)).toBe(0x80 | 0x30 | 0x05);
      expect(emittedValue(snapshot, RESONANCE)).toBe(0x69);
    });

    it('holds the volume register emitted while a mode is forced and restores the raw byte once on release', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(VOLUME, 0xba);
      frame.setFilterMode('lowPass');
      frame.takeSnapshot();

      expect(emittedValue(frame.takeSnapshot(), VOLUME)).toBe(0x80 | 0x10 | 0x0a);

      frame.setFilterMode(null);
      expect(emittedValue(frame.takeSnapshot(), VOLUME)).toBe(0xba);
      expect(emittedValue(frame.takeSnapshot(), VOLUME)).toBeUndefined();
    });

    it('emits nothing when the filter mode is set to the one already held', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(VOLUME, 0x2f);
      frame.takeSnapshot();

      frame.setFilterMode(null); // already released

      expect(frame.takeSnapshot().count).toBe(0);
    });

    it('applies one pulse-width coefficient identically to all three voices, sparing the unused nibble', () => {
      const frame = createRegisterFrame();
      const raw = [
        [0x34, 0xf5],
        [0xcd, 0x3a],
        [0xff, 0x0f],
      ];
      const expected = [
        [0x9a, 0xf2], // 1332 -> 666
        [0x67, 0x35], // 2765 -> 1383
        [0x00, 0x08], // 4095 -> 2048
      ];
      PULSE_WIDTH_REGISTERS.forEach(([low, high], voice) => {
        frame.onSidWrite(low, raw[voice][0]);
        frame.onSidWrite(high, raw[voice][1]);
      });

      frame.setRegisterScale('pulseWidth', 0.5);
      const snapshot = frame.takeSnapshot();

      PULSE_WIDTH_REGISTERS.forEach(([low, high], voice) => {
        expect(emittedValue(snapshot, low)).toBe(expected[voice][0]);
        expect(emittedValue(snapshot, high)).toBe(expected[voice][1]);
      });
    });

    it('saturates pulse width at its 12-bit ceiling rather than wrapping', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(2, 0xff);
      frame.onSidWrite(3, 0xf8); // combined = 2303, upper nibble of the high register set

      frame.setRegisterScale('pulseWidth', 2); // 4606, wrapping would give 510
      const snapshot = frame.takeSnapshot();

      expect(emittedValue(snapshot, 2)).toBe(0xff);
      expect(emittedValue(snapshot, 3)).toBe(0xff);
    });

    it('applies a pitch coefficient to each voices whole 16-bit frequency value', () => {
      const frame = createRegisterFrame();
      const raw = [
        [0x34, 0x12],
        [0xcd, 0xab],
        [0x01, 0x00],
      ];
      const expected = [
        [0x1a, 0x09], // 0x1234 -> 0x091a
        [0xe7, 0x55], // 0xabcd -> 0x55e7
        [0x01, 0x00], // 1 -> 0.5, rounds back up to 1
      ];
      FREQUENCY_REGISTERS.forEach(([low, high], voice) => {
        frame.onSidWrite(low, raw[voice][0]);
        frame.onSidWrite(high, raw[voice][1]);
        frame.setVoicePitch(voice, 0.5);
      });

      const snapshot = frame.takeSnapshot();

      FREQUENCY_REGISTERS.forEach(([low, high], voice) => {
        expect(emittedValue(snapshot, low)).toBe(expected[voice][0]);
        expect(emittedValue(snapshot, high)).toBe(expected[voice][1]);
      });
    });

    it('saturates frequency at its 16-bit ceiling rather than wrapping', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(0, 0x00);
      frame.onSidWrite(1, 0x80); // 0x8000

      frame.setVoicePitch(0, 3); // 98304, wrapping would give 32768
      const snapshot = frame.takeSnapshot();

      expect(emittedValue(snapshot, 0)).toBe(0xff);
      expect(emittedValue(snapshot, 1)).toBe(0xff);
    });

    it('emits all six frequency registers every frame while off home, then restores them once', () => {
      const frame = createRegisterFrame();
      FREQUENCY_REGISTERS.forEach(([low, high], voice) => {
        frame.onSidWrite(low, 0x40);
        frame.onSidWrite(high, 0x20);
        frame.setVoicePitch(voice, 0.5);
      });
      frame.takeSnapshot();

      const held = frame.takeSnapshot();
      for (const [low, high] of FREQUENCY_REGISTERS) {
        expect(emittedValue(held, low)).toBe(0x20); // 0x2040 -> 0x1020
        expect(emittedValue(held, high)).toBe(0x10);
      }

      FREQUENCY_REGISTERS.forEach((_pair, voice) => frame.setVoicePitch(voice, 1));
      const restore = writesOf(frame.takeSnapshot());
      const settled = frame.takeSnapshot();
      for (const [low, high] of FREQUENCY_REGISTERS) {
        expect(valueFor(restore, low)).toBe(0x40);
        expect(valueFor(restore, high)).toBe(0x20);
        expect(emittedValue(settled, low)).toBeUndefined();
        expect(emittedValue(settled, high)).toBeUndefined();
      }
    });

    it('keeps snapshotValues() raw with every control off home', () => {
      const frame = createRegisterFrame();
      const raw: [number, number][] = [
        [CUTOFF_LOW, 0xff],
        [CUTOFF_HIGH, 0x65],
        [RESONANCE, 0xc9],
        [VOLUME, 0xba],
        [2, 0x34],
        [3, 0xf5],
        [0, 0x34],
        [1, 0x12],
      ];
      for (const [register, value] of raw) {
        frame.onSidWrite(register, value);
      }
      for (const group of SCALED_GROUPS) {
        frame.setRegisterScale(group, 0.5);
      }
      frame.setTargetClock(PAL_PHI2_HZ, NTSC_PHI2_HZ);
      frame.setVoicePitch(0, 0.5);
      frame.setFilterMode('highPass');

      const { values } = frame.snapshotValues();

      for (const [register, value] of raw) {
        expect(values[register]).toBe(value);
      }
    });

    it('scales a restored cue once at the receiving frames coefficient, never twice', () => {
      const source = createRegisterFrame();
      source.onSidWrite(CUTOFF_LOW, 0xff);
      source.onSidWrite(CUTOFF_HIGH, 0x65); // combined = 815
      source.setRegisterScale('cutoff', 0.5);
      const cue = source.snapshotValues();

      const target = createRegisterFrame();
      target.restoreValues(cue);
      target.setRegisterScale('cutoff', 0.25);
      target.markAllDirty();
      const snapshot = target.takeSnapshot();

      // 815 * 0.25 = 203.75 -> 204. Double-scaled (815 * 0.5 * 0.25) would land on 102.
      expect(emittedValue(snapshot, CUTOFF_HIGH)).toBe(204 >> 3);
      expect(emittedValue(snapshot, CUTOFF_LOW)).toBe(0xf8 | (204 & 0x07));
    });

    it('keeps a resync at one write per register with every active control applied', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(CUTOFF_LOW, 0xff);
      frame.onSidWrite(CUTOFF_HIGH, 0x65);
      frame.onSidWrite(RESONANCE, 0xc9);
      frame.onSidWrite(VOLUME, 0xba);
      frame.setRegisterScale('cutoff', 0.5);
      frame.setRegisterScale('resonance', 0.5);
      frame.setOutputGain(0.5);
      frame.setFilterMode('bandPass');

      frame.markAllDirty();
      const snapshot = frame.takeSnapshot();

      const written = [CUTOFF_LOW, CUTOFF_HIGH, RESONANCE, VOLUME];
      expect(registersOf(snapshot)).toEqual([
        ...written,
        ...ALL_REGISTERS.filter((register) => !written.includes(register)),
      ]);
      expect(emittedValue(snapshot, CUTOFF_LOW)).toBe(0xf8);
      expect(emittedValue(snapshot, CUTOFF_HIGH)).toBe(0x33);
      expect(emittedValue(snapshot, RESONANCE)).toBe(0x69);
      expect(emittedValue(snapshot, VOLUME)).toBe(0x80 | 0x20 | 0x05);
    });
  });

  describe('the target clock and the per-voice pitch', () => {
    it('scales a PAL tune down to hold its pitch on an NTSC machine', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(0, 0x34);
      frame.onSidWrite(1, 0x12); // 0x1234

      frame.setTargetClock(PAL_PHI2_HZ, NTSC_PHI2_HZ);
      const snapshot = frame.takeSnapshot();

      // 4660 onto a clock 3.804% faster is 4489.
      expect(emittedValue(snapshot, 0)).toBe(0x89);
      expect(emittedValue(snapshot, 1)).toBe(0x11);
    });

    it('emits the high byte the scaling moved, in a frame where the tune wrote only the low one', () => {
      const frame = createRegisterFrame();
      frame.setTargetClock(PAL_PHI2_HZ, NTSC_PHI2_HZ);
      frame.onSidWrite(0, 0x40);
      frame.onSidWrite(1, 0x02); // 0x0240 -> 0x022b
      frame.takeSnapshot();

      frame.onSidWrite(0, 0x00); // 0x0200 -> 0x01ed: the high byte falls, unwritten
      const snapshot = frame.takeSnapshot();

      expect(emittedValue(snapshot, 0)).toBe(0xed);
      expect(emittedValue(snapshot, 1)).toBe(0x01);
    });

    it('rounds the scaled value rather than truncating it', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(0, 0x01);
      frame.onSidWrite(1, 0x01); // 0x0101 = 257

      frame.setVoicePitch(0, 0.5); // 128.5 — truncating would land on 128
      const snapshot = frame.takeSnapshot();

      expect(emittedValue(snapshot, 0)).toBe(0x81);
      expect(emittedValue(snapshot, 1)).toBe(0x00);
    });

    it('clamps at the 16-bit ceiling when the two multipliers together overrun it', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(0, 0x00);
      frame.onSidWrite(1, 0xfc); // 0xfc00

      frame.setTargetClock(NTSC_PHI2_HZ, PAL_PHI2_HZ);
      frame.setVoicePitch(0, 1.5); // ~98000, wrapping would give 0x7f00
      const snapshot = frame.takeSnapshot();

      expect(emittedValue(snapshot, 0)).toBe(0xff);
      expect(emittedValue(snapshot, 1)).toBe(0xff);
    });

    it('reaches the same bytes whichever order the correction and the pitch arrive in', () => {
      const clockFirst = createRegisterFrame();
      clockFirst.onSidWrite(1, 0x40); // 0x4000
      clockFirst.setTargetClock(PAL_PHI2_HZ, NTSC_PHI2_HZ);
      clockFirst.setVoicePitch(0, 1.5);

      const pitchFirst = createRegisterFrame();
      pitchFirst.onSidWrite(1, 0x40);
      pitchFirst.setVoicePitch(0, 1.5);
      pitchFirst.setTargetClock(PAL_PHI2_HZ, NTSC_PHI2_HZ);

      const composed = writesOf(clockFirst.takeSnapshot());
      expect(composed).toEqual(writesOf(pitchFirst.takeSnapshot()));
      expect(valueFor(composed, 0)).toBe(0x7b); // 0x4000 -> 0x5c7b
      expect(valueFor(composed, 1)).toBe(0x5c);
    });

    it('holds the correction across a pitch move, and the pitch across a correction', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(1, 0x40); // 0x4000
      frame.setTargetClock(PAL_PHI2_HZ, NTSC_PHI2_HZ);
      frame.setVoicePitch(0, 1.5);
      frame.takeSnapshot();

      frame.setVoicePitch(0, 1);
      const correctionOnly = frame.takeSnapshot();
      expect(emittedValue(correctionOnly, 0)).toBe(0xa8); // 0x3da8
      expect(emittedValue(correctionOnly, 1)).toBe(0x3d);

      frame.setVoicePitch(0, 1.5);
      frame.setTargetClock(NTSC_PHI2_HZ, NTSC_PHI2_HZ);
      const pitchOnly = frame.takeSnapshot();
      expect(emittedValue(pitchOnly, 0)).toBe(0x00); // 0x6000
      expect(emittedValue(pitchOnly, 1)).toBe(0x60);
    });

    it('scales three voices by three coefficients of their own', () => {
      const frame = createRegisterFrame();
      FREQUENCY_REGISTERS.forEach(([low, high]) => {
        frame.onSidWrite(low, 0x34);
        frame.onSidWrite(high, 0x12); // 0x1234 on every voice
      });

      frame.setVoicePitch(0, 0.5);
      frame.setVoicePitch(1, 2);
      // Voice 2 stays at 1, with the clocks matched — its bytes must survive bit-for-bit.
      const snapshot = frame.takeSnapshot();

      expect(emittedValue(snapshot, 0)).toBe(0x1a); // 0x091a
      expect(emittedValue(snapshot, 1)).toBe(0x09);
      expect(emittedValue(snapshot, 7)).toBe(0x68); // 0x2468
      expect(emittedValue(snapshot, 8)).toBe(0x24);
      expect(emittedValue(snapshot, 14)).toBe(0x34);
      expect(emittedValue(snapshot, 15)).toBe(0x12);
    });

    it('leaves a voice at home out of the frame while a neighbour is scaled', () => {
      const frame = createRegisterFrame();
      FREQUENCY_REGISTERS.forEach(([low, high]) => {
        frame.onSidWrite(low, 0x34);
        frame.onSidWrite(high, 0x12);
      });
      frame.setVoicePitch(0, 0.5);
      frame.takeSnapshot(); // the frame the tune's own writes rode out in

      expect(registersOf(frame.takeSnapshot())).toEqual([0, 1]);
    });

    it('emits exactly what the tune wrote with the clocks matched and every pitch at 1', () => {
      const frame = createRegisterFrame();
      frame.setTargetClock(NTSC_PHI2_HZ, NTSC_PHI2_HZ);
      FREQUENCY_REGISTERS.forEach(([low, high], voice) => {
        frame.setVoicePitch(voice, 1);
        frame.onSidWrite(low, 0x11 * (voice + 1));
        frame.onSidWrite(high, 0x22 * (voice + 1));
      });

      expect(writesOf(frame.takeSnapshot())).toEqual([
        { register: 0, value: 0x11 },
        { register: 1, value: 0x22 },
        { register: 7, value: 0x22 },
        { register: 8, value: 0x44 },
        { register: 14, value: 0x33 },
        { register: 15, value: 0x66 },
      ]);
    });

    it('restores the raw frequency bytes for exactly one frame when the correction comes home', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(0, 0x34);
      frame.onSidWrite(1, 0x12);
      frame.setTargetClock(PAL_PHI2_HZ, NTSC_PHI2_HZ);
      frame.takeSnapshot();

      frame.setTargetClock(NTSC_PHI2_HZ, NTSC_PHI2_HZ);
      const restore = frame.takeSnapshot();
      expect(emittedValue(restore, 0)).toBe(0x34);
      expect(emittedValue(restore, 1)).toBe(0x12);

      expect(frame.takeSnapshot().count).toBe(0);
    });

    it('leaves every register but the frequency pairs byte-identical across a target-clock change', () => {
      const corrected = createRegisterFrame();
      const uncorrected = createRegisterFrame();
      corrected.setTargetClock(PAL_PHI2_HZ, NTSC_PHI2_HZ);
      for (const register of ALL_REGISTERS) {
        corrected.onSidWrite(register, byteFor(register));
        uncorrected.onSidWrite(register, byteFor(register));
      }

      const withCorrection = writesOf(corrected.takeSnapshot());
      const without = writesOf(uncorrected.takeSnapshot());
      const frequencyRegisters = FREQUENCY_REGISTERS.flat();

      for (const register of ALL_REGISTERS) {
        if (frequencyRegisters.includes(register)) continue;
        expect(valueFor(withCorrection, register)).toBe(valueFor(without, register));
      }
      // Guards the sweep above against passing on a correction that moved nothing at all.
      expect(
        frequencyRegisters.filter(
          (register) => valueFor(withCorrection, register) !== valueFor(without, register),
        ).length,
      ).toBeGreaterThan(0);
    });

    it('ignores an unusable clock pair, a voice outside the chip and a non-finite coefficient', () => {
      const frame = createRegisterFrame();
      frame.onSidWrite(0, 0x34);
      frame.onSidWrite(1, 0x12);

      frame.setTargetClock(0, NTSC_PHI2_HZ);
      frame.setTargetClock(PAL_PHI2_HZ, Number.NaN);
      frame.setVoicePitch(3, 0.5);
      frame.setVoicePitch(-1, 0.5);
      frame.setVoicePitch(0, Number.NaN);

      expect(writesOf(frame.takeSnapshot())).toEqual([
        { register: 0, value: 0x34 },
        { register: 1, value: 0x12 },
      ]);
    });

    it('addresses no register outside the shadows own range, whatever the writes and coefficients', () => {
      const frame = createRegisterFrame();
      frame.setTargetClock(NTSC_PHI2_HZ, PAL_PHI2_HZ);
      frame.setVoicePitch(0, 1e6);
      frame.setVoicePitch(1, 1e-6);
      frame.setVoicePitch(2, 0);

      const emitted = new Set<number>();
      let seed = 1;
      for (let index = 0; index < 2000; index++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        // Deliberately reaches past the register file as well as into it: bounding a malformed
        // file's writes is what stops one becoming an arbitrary write to attached hardware.
        frame.onSidWrite(seed % 64, (seed >> 8) & 0xff);
        if (index % 7 === 0) {
          for (const write of writesOf(frame.takeSnapshot())) emitted.add(write.register);
        }
      }

      expect(emitted.size).toBeGreaterThan(0);
      expect(
        [...emitted].filter((register) => register < 0 || register >= SID_REGISTER_COUNT),
      ).toEqual([]);
    });
  });

  describe('the generalized scaling against a real register stream (InSID3 Out)', () => {
    interface TuneRun {
      readonly frames: Write[][];
      readonly suppressedWrites: number;
    }

    /** Runs the bundled tune for `frames` play calls, calling `perFrame` before each one so a control
     *  can be swept exactly as a deck would move it. */
    function runTune(
      frames: number,
      perFrame?: (frame: RegisterFrame, index: number) => void,
    ): TuneRun {
      const frame = createRegisterFrame();
      const machine = createC64Machine(insid3Out(), frame);
      machine.initSubtune(1);

      const rendered: Write[][] = [];
      for (let i = 0; i < frames; i++) {
        perFrame?.(frame, i);
        machine.runFrame();
        // The frame's buffers are reused, so a run that keeps them has to copy.
        rendered.push(writesOf(frame.takeSnapshot()));
      }
      return { frames: rendered, suppressedWrites: frame.suppressedWriteCount };
    }

    const FRAMES = 600;
    const FILTER_MODE_SWEEP: (SidFilterMode | null)[] = [
      null,
      'lowPass',
      'bandPass',
      'highPass',
      'off',
    ];

    let baseline: TuneRun;

    beforeAll(() => {
      baseline = runTune(FRAMES);
    }, 30_000);

    it('leaves the whole register stream write-for-write identical with every control parked at home', () => {
      const home = runTune(FRAMES, (frame, index) => {
        if (index > 0) return;
        for (const group of SCALED_GROUPS) {
          frame.setRegisterScale(group, 1);
        }
        frame.setTargetClock(PAL_PHI2_HZ, PAL_PHI2_HZ);
        for (let voice = 0; voice < 3; voice++) {
          frame.setVoicePitch(voice, 1);
        }
        frame.setFilterMode(null);
      });

      expect(home.frames).toEqual(baseline.frames);
    });

    it('carries a gate retrigger the tune really makes as two ordered writes', () => {
      const retriggered = baseline.frames.filter((writes) =>
        [4, 11, 18].some((register) => writes.filter((w) => w.register === register).length === 2),
      );

      expect(retriggered.length).toBeGreaterThan(0);
    });

    it("halves the tune's own cutoff in every frame, tracking its real writes", () => {
      const scaled = runTune(FRAMES, (frame, index) => {
        if (index === 0) frame.setRegisterScale('cutoff', 0.5);
      });

      let rawLow = 0;
      let rawHigh = 0;
      let framesTheTuneWroteCutoff = 0;
      let framesTheCoefficientMovedTheBytes = 0;

      for (let i = 0; i < FRAMES; i++) {
        const lowWrite = valueFor(baseline.frames[i], 21);
        const highWrite = valueFor(baseline.frames[i], 22);
        if (lowWrite !== undefined || highWrite !== undefined) framesTheTuneWroteCutoff++;
        rawLow = lowWrite ?? rawLow;
        rawHigh = highWrite ?? rawHigh;

        const expected = clamp(Math.round(((rawHigh << 3) | (rawLow & 0x07)) * 0.5), 0, 0x7ff);
        const emittedLow = valueFor(scaled.frames[i], 21);
        const emittedHigh = valueFor(scaled.frames[i], 22);
        expect(emittedLow).toBe((rawLow & 0xf8) | (expected & 0x07));
        expect(emittedHigh).toBe((expected >> 3) & 0xff);
        if (emittedLow !== rawLow || emittedHigh !== rawHigh) framesTheCoefficientMovedTheBytes++;
      }

      // Guards the assertions above against passing vacuously on a cutoff the tune leaves at zero.
      expect(framesTheTuneWroteCutoff).toBeGreaterThan(0);
      expect(framesTheCoefficientMovedTheBytes).toBeGreaterThan(0);
    });

    it('leaves the suppressed-write count identical to the unscaled run across a full control sweep', () => {
      const swept = runTune(FRAMES, (frame, index) => {
        const t = index / (FRAMES - 1);
        frame.setOutputGain(t);
        frame.setRegisterScale('cutoff', 0.25 + t);
        frame.setRegisterScale('resonance', 1.5 - t);
        frame.setRegisterScale('pulseWidth', 0.5 + t);
        frame.setTargetClock(PAL_PHI2_HZ, PAL_PHI2_HZ + t * (NTSC_PHI2_HZ - PAL_PHI2_HZ));
        for (let voice = 0; voice < 3; voice++) {
          frame.setVoicePitch(voice, 0.9 + t * 0.2 + voice * 0.05);
        }
        frame.setFilterMode(FILTER_MODE_SWEEP[index % FILTER_MODE_SWEEP.length]);
      });

      expect(swept.suppressedWrites).toBe(baseline.suppressedWrites);
    });
  });

  describe('the output gain scaling against a real fade (InSID3 Out)', () => {
    /** Plays `frames` play calls with `gain` applied throughout, recording every frame's emitted
     *  $D418 byte by frame index, wherever register 24 went out that frame. */
    function recordVolumeByFrame(frames: number, gain: number): Map<number, number> {
      const frame = createRegisterFrame();
      const machine = createC64Machine(insid3Out(), frame);
      machine.initSubtune(1);
      frame.setOutputGain(gain);

      const byFrame = new Map<number, number>();
      for (let i = 0; i < frames; i++) {
        machine.runFrame();
        const emitted = emittedValue(frame.takeSnapshot(), 24);
        if (emitted !== undefined) {
          byFrame.set(i, emitted);
        }
      }
      return byFrame;
    }

    /** Long enough to run past the tune's own $D418 fade-to-silence and its loop restart back to
     *  full — empirically frames ~15,460-16,170 of subtune 1, at roughly one level every 48 play
     *  calls. */
    const FRAMES = 20_000;

    let raw: Map<number, number>;
    let scaled: Map<number, number>;

    beforeAll(() => {
      raw = recordVolumeByFrame(FRAMES, 1);
      scaled = recordVolumeByFrame(FRAMES, 0.5);
    }, 30_000);

    it("fades the low nibble down to silence in step with the tune's own ramp, holding the filter-mode nibble fixed", () => {
      const entries = [...raw.entries()].sort(([a], [b]) => a - b);

      // The first handful of frames carry the init routine's own bootstrap value ($D418=$0F, mode
      // 0), immediately superseded once the play routine starts writing its own mode nibble — the
      // dominant high nibble across the recording is that mode, not the bootstrap one.
      const highNibbleCounts = new Map<number, number>();
      for (const [, byte] of entries) {
        const high = byte & 0xf0;
        highNibbleCounts.set(high, (highNibbleCounts.get(high) ?? 0) + 1);
      }
      const [dominantHighNibble, dominantCount] = [...highNibbleCounts.entries()].sort(
        (a, b) => b[1] - a[1],
      )[0];
      expect(dominantCount / entries.length).toBeGreaterThan(0.99);

      const playing = entries.filter(([, byte]) => (byte & 0xf0) === dominantHighNibble);
      const lowNibbles: number[] = [];
      for (const [, byte] of playing) {
        const value = byte & 0x0f;
        if (lowNibbles[lowNibbles.length - 1] !== value) lowNibbles.push(value);
      }
      expect(lowNibbles).toContain(15);
      expect(lowNibbles).toContain(0);

      let longestDescent = 1;
      let current = 1;
      for (let i = 1; i < lowNibbles.length; i++) {
        current = lowNibbles[i] < lowNibbles[i - 1] ? current + 1 : 1;
        longestDescent = Math.max(longestDescent, current);
      }
      // A real fade steps down through most of the sixteen levels; a stray one-off dip elsewhere in
      // the stream could never produce a run this long.
      expect(longestDescent).toBeGreaterThanOrEqual(8);
    });

    it('scales every write of the real fade by a fixed gain, proportionally, without disturbing the mode nibble', () => {
      expect(raw.size).toBeGreaterThan(1);
      for (const [i, rawByte] of raw) {
        const scaledByte = scaled.get(i);
        expect(scaledByte).toBeDefined();
        expect((scaledByte as number) & 0xf0).toBe(rawByte & 0xf0);
        expect((scaledByte as number) & 0x0f).toBe(
          clamp(Math.round((rawByte & 0x0f) * 0.5), 0, 15),
        );
      }
    });
  });
});

/** An arbitrary but distinct byte per register, so a test that pins all 25 at once can tell them
 *  apart. */
function byteFor(register: number): number {
  return (register * 11 + 0x37) & 0xff;
}

/** The frame's writes as plain data. `takeSnapshot()` hands back reused buffers, so anything held
 *  past the next call has to be copied out like this. */
function writesOf(frame: SidFrame): Write[] {
  const writes: Write[] = [];
  for (let index = 0; index < frame.count; index++) {
    writes.push({ register: frame.registers[index], value: frame.values[index] });
  }
  return writes;
}

function registersOf(frame: SidFrame): number[] {
  return writesOf(frame).map(({ register }) => register);
}

/** The byte a register first went out with this frame, or undefined if it did not. */
function valueFor(writes: readonly Write[], register: number): number | undefined {
  return writes.find((write) => write.register === register)?.value;
}

function emittedValue(frame: SidFrame, register: number): number | undefined {
  for (let index = 0; index < frame.count; index++) {
    if (frame.registers[index] === register) return frame.values[index];
  }
  return undefined;
}

function insid3Out(): SidFile {
  const entry = BUNDLED_TUNES.find((candidate) => candidate.id === 'insid3-out');
  if (!entry) {
    throw new Error('bundled tune "insid3-out" not found');
  }
  return parseSidFile(decodeBundledTune(entry.base64));
}
