import { describe, it, expect, beforeAll } from 'vitest';
import { NTSC_PHI2_HZ, PAL_PHI2_HZ } from './clock-ratio.js';
import { createRegisterFrame } from './register-frame.js';
import type { SidFilterMode } from './register-frame.js';
import { createReferenceRegisterFrame } from './__reference__/register-frame.reference.js';
import type {
  RegisterFrame as ReferenceRegisterFrame,
  RegisterValuesSnapshot,
} from './__reference__/register-frame.reference.js';
import type { SidFrame } from './sid-frame.js';
import { SID_REGISTER_COUNT } from './sid-constants.js';
import { SID_FIELD_TABLE } from './sid-fields.js';
import type { SidField, SidFieldEntry } from './sid-fields.js';
import { createC64Machine } from '../cpu/c64-machine.js';
import type { SidWriteSink } from '../cpu/c64-machine.js';
import type { SidFile } from '../sid/sid-file.model.js';
import { parseSidFile } from '../sid/sid-file.parser.js';
import { BUNDLED_TUNES, decodeBundledTune } from '../sid/__fixtures__/index.js';

/**
 * Differential spec: the field-table output stage against a frozen copy of the implementation it
 * replaced. Every call the old stage accepted must still produce the same frames, byte for byte, in
 * the same order, with the same suppressed-write count.
 *
 * The rate pitch is new, so the reference has no such call: the reference is driven with each
 * voice's pitch multiplied by it instead, which is the equivalence the rate pitch promises.
 */

interface Write {
  readonly register: number;
  readonly value: number;
}

/** Applied identically to both frames. */
type Operation = (frame: ReferenceRegisterFrame) => void;

const PHASE_FRAMES = 50;
const FUZZ_SEEDS = [0x1badf00d, 0xc0ffee, 0x5eed5eed];
const FUZZ_FRAMES = 2000;
const FUZZ_OPERATION_PERIOD = 37;
const BOUNDARY_PERIOD = 50;

const FILTER_MODES: readonly SidFilterMode[] = ['lowPass', 'bandPass', 'highPass', 'off'];

/** Two frames fed the same writes and the same calls. The reference is the oracle. */
class Lockstep implements SidWriteSink {
  readonly reference = createReferenceRegisterFrame();
  readonly actual = createRegisterFrame();
  framesCompared = 0;
  private cue: { reference: RegisterValuesSnapshot; actual: RegisterValuesSnapshot } | null = null;
  private readonly voicePitches = [1, 1, 1];
  private ratePitch = 1;

  onSidWrite(register: number, value: number): void {
    this.reference.onSidWrite(register, value);
    this.actual.onSidWrite(register, value);
  }

  apply(operation: Operation): void {
    operation(this.reference);
    operation(this.actual);
  }

  /** Sets voice `voice`'s pitch on the actual frame, and its product with the rate pitch on the
   *  reference. Use with `setRatePitch` below, never mixed with `apply`-ed pitch calls. */
  setVoicePitch(voice: number, pitch: number): void {
    this.voicePitches[voice] = pitch;
    this.reference.setVoicePitch(voice, pitch * this.ratePitch);
    this.actual.setVoicePitch(voice, pitch);
  }

  setRatePitch(ratePitch: number): void {
    this.ratePitch = ratePitch;
    this.voicePitches.forEach((pitch, voice) =>
      this.reference.setVoicePitch(voice, pitch * ratePitch),
    );
    this.actual.setRatePitch(ratePitch);
  }

  saveCue(): void {
    this.cue = {
      reference: this.reference.snapshotValues(),
      actual: this.actual.snapshotValues(),
    };
  }

  restoreCue(): void {
    if (this.cue === null) return;
    this.reference.restoreValues(this.cue.reference);
    this.actual.restoreValues(this.cue.actual);
  }

  /** Delivers one frame from each and compares what they carried. */
  compareFrame(): void {
    const expected = writesOf(this.reference.takeSnapshot());
    expect(writesOf(this.actual.takeSnapshot())).toEqual(expected);
    this.framesCompared++;
  }

  /** The diagnostic view, and the allocation-free read that has to agree with it. */
  compareEmitted(): void {
    const expected = this.reference.emittedValues();
    const emitted = this.actual.emittedValues();
    expect(emitted.written).toEqual(expected.written);
    expect(emitted.sent).toEqual(expected.sent);

    const written = new Uint8Array(SID_REGISTER_COUNT);
    const sent = new Uint8Array(SID_REGISTER_COUNT);
    this.actual.readRegisters(written, sent);
    expect(written).toEqual(expected.written);
    expect(sent).toEqual(expected.sent);
  }

  compareSuppressedWrites(): void {
    expect(this.actual.suppressedWriteCount).toBe(this.reference.suppressedWriteCount);
  }
}

describe.each(BUNDLED_TUNES)(
  'the field-table output stage against the reference: $label',
  (tune) => {
    let file: SidFile;

    beforeAll(() => {
      file = parseSidFile(decodeBundledTune(tune.base64));
    }, 30_000);

    /** Runs `script` against a machine driving both frames, then checks the totals. */
    function drive(script: (lock: Lockstep, play: (frames?: number) => void) => void): void {
      const lock = new Lockstep();
      const machine = createC64Machine(file, lock);
      machine.initSubtune(1);

      const play = (frames = PHASE_FRAMES): void => {
        for (let index = 0; index < frames; index++) {
          machine.runFrame();
          lock.compareFrame();
        }
        lock.compareEmitted();
      };

      script(lock, play);

      lock.compareEmitted();
      lock.compareSuppressedWrites();
      // Guards against passing vacuously on an empty run.
      expect(lock.framesCompared).toBeGreaterThan(0);
    }

    it('matches at home', () => {
      drive((_lock, play) => play(100));
    }, 20_000);

    it('matches through output gain moves', () => {
      drive((lock, play) => {
        for (const gain of [0.5, 0, 1]) {
          lock.apply((frame) => frame.setOutputGain(gain));
          play();
        }
      });
    }, 20_000);

    it('matches through cutoff, resonance and pulse-width scales', () => {
      drive((lock, play) => {
        const steps = [
          ['cutoff', [0.25, 2.7, 16, 1]],
          ['resonance', [0.5, 4, 1]],
          ['pulseWidth', [1 / 16, 16, 1]],
        ] as const;
        for (const [group, coefficients] of steps) {
          for (const coefficient of coefficients) {
            lock.apply((frame) => frame.setRegisterScale(group, coefficient));
            play();
          }
        }
      });
    }, 20_000);

    it('matches through clock corrections, unusable pairs and an equal pair', () => {
      drive((lock, play) => {
        const pairs: readonly (readonly [number, number])[] = [
          [PAL_PHI2_HZ, NTSC_PHI2_HZ],
          [NTSC_PHI2_HZ, PAL_PHI2_HZ],
          [PAL_PHI2_HZ, Number.NaN],
          [0, NTSC_PHI2_HZ],
          [PAL_PHI2_HZ, PAL_PHI2_HZ],
        ];
        for (const [source, target] of pairs) {
          lock.apply((frame) => frame.setTargetClock(source, target));
          play();
        }
      });
    }, 20_000);

    it('matches through per-voice pitch with a clock correction in force', () => {
      drive((lock, play) => {
        lock.apply((frame) => frame.setTargetClock(PAL_PHI2_HZ, NTSC_PHI2_HZ));
        play();
        for (let voice = 0; voice < 3; voice++) {
          for (const steps of [-12, -1, 1, 7, 12]) {
            lock.apply((frame) => frame.setVoicePitch(voice, 2 ** (steps / 12)));
            play(20);
          }
          lock.apply((frame) => frame.setVoicePitch(voice, 1));
          play(20);
        }
        lock.apply((frame) => frame.setTargetClock(PAL_PHI2_HZ, PAL_PHI2_HZ));
        play();
      });
    }, 20_000);

    it('matches through rate pitch with a clock correction and voice pitch in force', () => {
      drive((lock, play) => {
        lock.apply((frame) => frame.setTargetClock(PAL_PHI2_HZ, NTSC_PHI2_HZ));
        lock.setVoicePitch(0, 2 ** (7 / 12));
        lock.setVoicePitch(2, 0.5);
        play();
        // Powers of two keep the product of the three factors exact in either order of association.
        for (const ratePitch of [0.5, 2, 4, 0, 1, 0.25, 1]) {
          lock.setRatePitch(ratePitch);
          play(20);
        }
        lock.setVoicePitch(0, 1);
        lock.setVoicePitch(2, 1);
        play(20);
      });
    }, 20_000);

    it('matches through any rate pitch with the clocks matched, and across a mute and a cue', () => {
      drive((lock, play) => {
        lock.setVoicePitch(1, 1.5);
        for (const ratePitch of [0, 0.3, 1, 1.5, 3.3, 1000, 1]) {
          lock.setRatePitch(ratePitch);
          play(15);
        }

        lock.setRatePitch(2.7);
        lock.apply((frame) => frame.setVoiceMuted(2, true));
        play(20);
        lock.saveCue();
        play();
        lock.setRatePitch(0.6);
        lock.restoreCue();
        lock.apply((frame) => frame.setVoiceMuted(2, false));
        play(20);
        lock.setRatePitch(1);
        play(20);
      });
    }, 20_000);

    it('matches through filter modes and holds', () => {
      drive((lock, play) => {
        for (const mode of [...FILTER_MODES, null]) {
          lock.apply((frame) => frame.setFilterMode(mode));
          play(20);
        }
        lock.apply((frame) => frame.holdField({ name: 'cutoff' }, 300, 0.5));
        play();
        lock.apply((frame) => frame.holdField({ name: 'waveform', voice: 1 }, 1));
        play();
        lock.apply((frame) => frame.releaseField({ name: 'waveform', voice: 1 }));
        play();
        lock.apply((frame) => frame.releaseField({ name: 'cutoff' }));
        play();
      });
    }, 20_000);

    it('matches across a mute, a resync and a cue restored while scales are off home', () => {
      drive((lock, play) => {
        lock.apply((frame) => {
          frame.setOutputGain(0.5);
          frame.setRegisterScale('cutoff', 2);
          frame.setVoicePitch(1, 2 ** (7 / 12));
        });
        play();

        lock.apply((frame) => frame.setVoiceMuted(0, true));
        play(20);
        lock.apply((frame) => frame.setVoiceMuted(0, false));
        play(20);

        lock.apply((frame) => frame.markAllDirty());
        play(20);

        lock.saveCue();
        play();
        lock.restoreCue();
        play();
      });
    }, 20_000);

    it('matches with every control moved at once', () => {
      drive((lock, play) => {
        lock.apply((frame) => {
          frame.setOutputGain(0.75);
          frame.setRegisterScale('cutoff', 1.5);
          frame.setRegisterScale('resonance', 2);
          frame.setRegisterScale('pulseWidth', 0.5);
          frame.setTargetClock(PAL_PHI2_HZ, NTSC_PHI2_HZ);
          frame.setVoicePitch(0, 2 ** (-1 / 12));
          frame.setVoicePitch(2, 2 ** (12 / 12));
          frame.setFilterMode('bandPass');
          frame.holdField({ name: 'cutoff' }, 700, 0.25);
          frame.holdField({ name: 'frequency', voice: 1 }, 0x1234, 0.5);
        });
        play(100);

        lock.saveCue();
        lock.apply((frame) => frame.setVoiceMuted(1, true));
        play(100);
        lock.restoreCue();
        lock.apply((frame) => frame.markAllDirty());
        play(100);

        lock.apply((frame) => {
          frame.setOutputGain(1);
          frame.setRegisterScale('cutoff', 1);
          frame.setRegisterScale('resonance', 1);
          frame.setRegisterScale('pulseWidth', 1);
          frame.setTargetClock(PAL_PHI2_HZ, PAL_PHI2_HZ);
          frame.setVoicePitch(0, 1);
          frame.setVoicePitch(2, 1);
          frame.setFilterMode(null);
          frame.releaseField({ name: 'cutoff' });
          frame.releaseField({ name: 'frequency', voice: 1 });
          frame.setVoiceMuted(1, false);
        });
        play(100);
      });
    }, 20_000);
  },
);

describe('the field-table output stage against the reference: synthetic write streams', () => {
  /** A scripted call, drawn at random and applied to both frames. */
  type Perform = (lock: Lockstep, random: () => number) => void;

  const COEFFICIENTS = [0, 0.25, 0.5, 1, 1, 1, 1.5, 2.7, 16];
  const PITCHES = [2 ** (-12 / 12), 2 ** (-1 / 12), 1, 1, 2 ** (1 / 12), 2 ** (7 / 12), 2, 0];
  const CLOCK_PAIRS: readonly (readonly [number, number])[] = [
    [PAL_PHI2_HZ, NTSC_PHI2_HZ],
    [NTSC_PHI2_HZ, PAL_PHI2_HZ],
    [PAL_PHI2_HZ, PAL_PHI2_HZ],
    [PAL_PHI2_HZ, 0],
  ];
  const AMOUNTS = [0, 0.25, 0.5, 1, 1];

  const PERFORMS: readonly Perform[] = [
    (lock, random) => {
      const gain = pick(COEFFICIENTS, random);
      lock.apply((frame) => frame.setOutputGain(gain));
    },
    (lock, random) => {
      const coefficient = pick(COEFFICIENTS, random);
      lock.apply((frame) => frame.setRegisterScale('cutoff', coefficient));
    },
    (lock, random) => {
      const coefficient = pick(COEFFICIENTS, random);
      lock.apply((frame) => frame.setRegisterScale('resonance', coefficient));
    },
    (lock, random) => {
      const coefficient = pick(COEFFICIENTS, random);
      lock.apply((frame) => frame.setRegisterScale('pulseWidth', coefficient));
    },
    (lock, random) => {
      const [source, target] = pick(CLOCK_PAIRS, random);
      lock.apply((frame) => frame.setTargetClock(source, target));
    },
    (lock, random) => {
      const voice = Math.floor(random() * 3);
      const coefficient = pick(PITCHES, random);
      lock.apply((frame) => frame.setVoicePitch(voice, coefficient));
    },
    (lock, random) => {
      const mode = pick([...FILTER_MODES, null], random);
      lock.apply((frame) => frame.setFilterMode(mode));
    },
    (lock, random) => {
      const entry = pick(SID_FIELD_TABLE, random);
      const value = Math.floor(random() * (entry.ceiling + 1));
      const amount = pick(AMOUNTS, random);
      lock.apply((frame) => frame.holdField(fieldOf(entry), value, amount));
    },
    (lock, random) => {
      const entry = pick(SID_FIELD_TABLE, random);
      lock.apply((frame) => frame.releaseField(fieldOf(entry)));
    },
    (lock, random) => {
      const voice = Math.floor(random() * 3);
      const muted = random() < 0.5;
      lock.apply((frame) => frame.setVoiceMuted(voice, muted));
    },
    (lock) => lock.apply((frame) => frame.markAllDirty()),
    (lock) => lock.saveCue(),
    (lock) => lock.restoreCue(),
  ];

  it.each(FUZZ_SEEDS)(
    'matches frame for frame on seed %i',
    (seed) => {
      const random = mulberry32(seed);
      const lock = new Lockstep();

      for (let frame = 0; frame < FUZZ_FRAMES; frame++) {
        if (frame % FUZZ_OPERATION_PERIOD === 0) {
          pick(PERFORMS, random)(lock, random);
        }

        const writes = Math.floor(random() * 9);
        for (let write = 0; write < writes; write++) {
          const register = Math.floor(random() * SID_REGISTER_COUNT);
          const value = Math.floor(random() * 256);
          lock.onSidWrite(register, value);
          if ([4, 11, 18].includes(register) && random() < 0.5) {
            lock.onSidWrite(register, Math.floor(random() * 256));
          }
        }

        lock.compareFrame();
        if (frame % BOUNDARY_PERIOD === 0) lock.compareEmitted();
      }

      lock.compareEmitted();
      lock.compareSuppressedWrites();
      // Guards against passing vacuously on an empty run.
      expect(lock.framesCompared).toBe(FUZZ_FRAMES);
    },
    20_000,
  );
});

/** The public identifier a table entry stands for. */
function fieldOf(entry: SidFieldEntry): SidField {
  return (
    entry.voice < 0 ? { name: entry.name } : { name: entry.name, voice: entry.voice }
  ) as SidField;
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)];
}

/** A small seeded generator, so a failing seed reproduces exactly. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The frame's writes as plain data; `takeSnapshot()` hands back reused buffers. */
function writesOf(frame: SidFrame): Write[] {
  const writes: Write[] = [];
  for (let index = 0; index < frame.count; index++) {
    writes.push({ register: frame.registers[index], value: frame.values[index] });
  }
  return writes;
}
