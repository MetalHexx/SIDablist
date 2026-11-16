import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { recordFromTune } from '../registers/__fixtures__/record-from-tune.js';
import type { SidFrame } from '../registers/sid-frame.js';
import { SID_REGISTER_COUNT } from '../registers/sid-constants.js';
import type { ReplayRequest, ReplayResponse, ReplayRunner } from '../replay/replay-runner.js';
import { replayToFrame } from '../replay/replay-to-frame.js';
import type { SidFile } from '../sid/sid-file.model.js';
import type { ShadowCount } from '../timeline/shadow-position.js';
import { FakeClock } from '../testing/fake-clock.js';
import { FakeSink } from '../testing/fake-sink.js';
import { frames, milliseconds } from '../units.js';
import { createSidPlayer } from './create-sid-player.js';
import type { SidPlayer, VarispeedRateSource } from './sid-player.js';
import type { JumpSettings } from './snapshot.js';

const RTS = 0x60;
const INTERVAL_MS = 19.95;

function tune(play: readonly number[], init: readonly number[] = [RTS], songs = 1): SidFile {
  const data = new Uint8Array(0x10 + play.length);
  data.set(init, 0);
  data.set(play, 0x10);
  return {
    format: 'PSID',
    version: 2,
    loadAddress: 0x1000,
    initAddress: 0x1000,
    playAddress: 0x1010,
    songs,
    startSong: 1,
    speedFlags: 0,
    name: '',
    author: '',
    released: '',
    clock: 'pal',
    model: 'unknown',
    secondSidAddress: null,
    thirdSidAddress: null,
    data,
  };
}

/** Every frame the counter at $FB moves and rides out on frequency, filter and volume registers
 *  while each voice's control register is rewritten, so a missed machine restore, an output stage
 *  left behind or a mute that did not come back all show in the frames. */
const chordTune = (): SidFile =>
  tune([
    ...[0xe6, 0xfb, 0xa5, 0xfb], // INC $FB; LDA $FB
    ...[0x8d, 0x00, 0xd4, 0x8d, 0x01, 0xd4], // STA $D400; STA $D401
    ...[0x8d, 0x07, 0xd4, 0x8d, 0x0e, 0xd4], // STA $D407; STA $D40E
    ...[0x8d, 0x16, 0xd4, 0x29, 0x0f, 0x8d, 0x18, 0xd4], // STA $D416; AND #$0F; STA $D418
    ...[0xa9, 0x41, 0x8d, 0x04, 0xd4, 0x8d, 0x0b, 0xd4, 0x8d, 0x12, 0xd4], // voices' control
    RTS,
  ]);

/** Voice 0's control register is written once, by init: a state taken with that voice muted holds it
 *  at 0 until something rewrites it, which nothing does. */
const heldNoteTune = (): SidFile =>
  tune(
    [0xe6, 0xfb, 0xa5, 0xfb, 0x8d, 0x00, 0xd4, RTS],
    [0xa9, 0x41, 0x8d, 0x04, 0xd4, RTS], // LDA #$41; STA $D404; RTS
  );

/** Plays at once a frame until the thirty-second call, which programs CIA 1 timer A for two a frame. */
const rateChangeTune = (): SidFile => {
  const file = tune([
    ...[0xe6, 0xfb, 0xa5, 0xfb, 0x8d, 0x00, 0xd4], // INC $FB; LDA $FB; STA $D400
    ...[0xc9, 0x20, 0xd0, 0x0a], // CMP #$20; BNE past the four writes below
    ...[0xa9, 0x63, 0x8d, 0x04, 0xdc, 0xa9, 0x26, 0x8d, 0x05, 0xdc],
    RTS,
  ]);
  return { ...file, speedFlags: 1 };
};

/** Answers every request against the real replay at once; held, it never answers, which leaves a
 *  loop with no entry image to find. */
class Replayer implements ReplayRunner {
  held = false;

  run(request: ReplayRequest): Promise<ReplayResponse> {
    if (this.held) return new Promise<ReplayResponse>(() => undefined);
    return Promise.resolve({
      id: request.id,
      ok: true,
      result: replayToFrame(
        request.file,
        request.subtune,
        request.targetFrame,
        request.mutes,
        request.start,
      ),
    });
  }

  dispose(): void {
    // nothing is held open
  }
}

interface Observation {
  readonly position: number;
  readonly transport: string;
  readonly varispeed: boolean;
  readonly shadow: ShadowCount | null;
  readonly lapPhase: number | null;
  readonly loop: unknown;
  readonly voices: unknown;
  readonly handOffs: number | undefined;
}

interface Mark {
  readonly delivered: number;
  readonly immediate: number;
  readonly observed: number;
}

/** What a player did after a mark, register for register: each delivered frame's number, due time
 *  and writes in order, each immediate frame's writes, and what the player read like after each
 *  tick. */
interface Trace {
  readonly delivered: readonly {
    readonly frameNumber: number;
    readonly dueAtMs: number;
    readonly catchUpClamped: boolean;
    readonly writes: readonly (readonly [number, number])[];
  }[];
  readonly immediate: readonly (readonly (readonly [number, number])[])[];
  readonly observed: readonly Observation[];
}

const writesOf = (frame: SidFrame): [number, number][] =>
  Array.from({ length: frame.count }, (_, index): [number, number] => [
    frame.registers[index],
    frame.values[index],
  ]);

/** A player on a fake clock whose due times are a count it can be set back to, which is what lets a
 *  rewound player and an undisturbed one be ticked identically. */
class Rig {
  readonly sink = new FakeSink();
  readonly clock = new FakeClock();
  readonly replay = new Replayer();
  readonly player: SidPlayer;
  ticks = 0;
  private readonly observed: Observation[] = [];

  constructor(readonly file: SidFile) {
    this.player = createSidPlayer({
      sink: this.sink,
      clock: this.clock,
      replayRunner: this.replay,
    });
    this.player.loadTune(file);
  }

  static async playing(file: SidFile): Promise<Rig> {
    const rig = new Rig(file);
    await rig.player.play();
    return rig;
  }

  run(count: number): void {
    for (let index = 0; index < count; index++) {
      this.clock.tick(milliseconds(++this.ticks * INTERVAL_MS));
      this.observed.push(this.observe());
    }
  }

  private observe(): Observation {
    const snapshot = this.player.getSnapshot();
    return {
      position: this.player.getPosition(),
      transport: snapshot.transport,
      varispeed: snapshot.tempo.varispeed,
      shadow: this.player.getShadowCount(),
      lapPhase: this.player.getLapPhase(),
      loop: snapshot.loop,
      voices: snapshot.voices,
      handOffs: snapshot.tune?.handOffs,
    };
  }

  mark(): Mark {
    return {
      delivered: this.sink.deliveredFrames.length,
      immediate: this.sink.deliveredNowFrames.length,
      observed: this.observed.length,
    };
  }

  since(mark: Mark): Trace {
    return {
      delivered: this.sink.deliveredFrames.slice(mark.delivered).map((entry) => ({
        frameNumber: entry.frameNumber,
        dueAtMs: entry.dueAtMs,
        catchUpClamped: entry.catchUpClamped,
        writes: writesOf(entry.frame),
      })),
      immediate: this.sink.deliveredNowFrames.slice(mark.immediate).map(writesOf),
      observed: this.observed.slice(mark.observed),
    };
  }

  /** The registers as written and as sent, as the chip would hold them now. */
  registers(): { readonly written: number[]; readonly sent: number[] } {
    const written = new Uint8Array(SID_REGISTER_COUNT);
    const sent = new Uint8Array(SID_REGISTER_COUNT);
    this.player.readRegisters(written, sent);
    return { written: Array.from(written), sent: Array.from(sent) };
  }
}

/** What a refused restore must leave alone. */
function untouched(rig: Rig): unknown {
  return {
    snapshot: rig.player.getSnapshot(),
    position: rig.player.getPosition(),
    registers: rig.registers(),
    shadow: rig.player.getShadowCount(),
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

type Step = (rig: Rig) => void | Promise<void>;

interface Rewind {
  readonly tune?: SidFile;
  /** Applied to both players before either ticks. */
  readonly setup?: Step;
  /** Ticks both players play before the save. The rewound one saves after every tick, as a host
   *  keeping a restore point every frame does. */
  readonly until: number;
  /** What only the rewound player does between its last save and the restore. */
  readonly detour: Step;
  /** What both do from the saved moment on: the undisturbed player from where it stands, the
   *  rewound one from the restore. Plays at least as many ticks as `detour`. */
  readonly onward: Step;
  /** The detour changes nothing a delivered frame or a reading shows, only the clock's pace, and
   *  the spec says for itself that it did. */
  readonly unseen?: boolean;
}

/**
 * The reference test: player A plays straight through; player B saves at frame k, plays on with
 * different commands, restores, and plays on. B's frames after the restore must equal A's from k,
 * register for register, with the same frame numbers and due times.
 */
async function expectRewindExact(spec: Rewind): Promise<{ a: Rig; b: Rig }> {
  const file = spec.tune ?? chordTune();
  const a = await Rig.playing(file);
  const b = await Rig.playing(file);
  await spec.setup?.(a);
  await spec.setup?.(b);

  a.run(spec.until);
  const state = b.player.createSavedState();
  for (let tick = 0; tick < spec.until; tick++) {
    b.run(1);
    b.player.saveState(state);
  }
  const savedTick = b.ticks;
  const markA = a.mark();

  const beforeDetour = b.mark();
  await spec.detour(b);
  const detoured = b.since(beforeDetour);
  b.player.restoreState(state);
  b.ticks = savedTick;
  const markB = b.mark();

  await spec.onward(a);
  await spec.onward(b);

  const expected = a.since(markA);
  const actual = b.since(markB);
  expect(expected.delivered.length).toBeGreaterThan(0);
  expect(actual).toEqual(expected);
  expect(b.registers()).toEqual(a.registers());
  expect(b.player.getSnapshot()).toEqual(a.player.getSnapshot());
  if (spec.unseen !== true) {
    // The detour has to have gone somewhere else, or the rewind proved nothing.
    const compared = Math.min(detoured.delivered.length, expected.delivered.length);
    expect(compared).toBeGreaterThan(0);
    const readings = (trace: Trace) => ({
      delivered: trace.delivered.slice(0, compared),
      observed: trace.observed.slice(0, compared),
    });
    expect(readings(detoured)).not.toEqual(readings(expected));
  }
  return { a, b };
}

const LOOP = { startFrame: frames(10), endFrame: frames(26) };
const SWEEP: VarispeedRateSource = (position) => Math.sin(position / 3) * 2;

describe('restoring a saved state', () => {
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('plays on as a player that never left', () => {
    it('in plain play, whatever was commanded in between', () =>
      expectRewindExact({
        until: 12,
        detour: (rig) => {
          rig.player.setVoiceMuted(0, true);
          rig.player.setVoiceHeld(1, true);
          rig.player.setOutputGain(0.4);
          rig.player.setRegisterScale('cutoff', 0.5);
          rig.player.setVoicePitch(2, 1.5);
          rig.run(15);
        },
        onward: (rig) => rig.run(25),
      }));

    it('with a loop running, crossing a wrap after the restore', () =>
      expectRewindExact({
        setup: (rig) => rig.player.setActiveLoop(LOOP),
        until: 18,
        detour: (rig) => {
          // A loop starting later takes the loop-entry buffer over: the wrap has to find the first
          // loop's start image back in it.
          rig.player.setActiveLoop({ startFrame: frames(22), endFrame: frames(40) });
          rig.run(30);
        },
        onward: (rig) => rig.run(45),
      }));

    it('with a loop whose length is not whole frames, in the lap it was saved in', () =>
      expectRewindExact({
        setup: (rig) =>
          rig.player.setActiveLoop({
            startFrame: frames(10),
            endFrame: frames(21.5),
            lapPhase: 0.25,
          }),
        until: 30,
        detour: (rig) => {
          rig.player.setActiveLoop({ startFrame: frames(12), endFrame: frames(30) });
          rig.run(40);
        },
        onward: (rig) => rig.run(60),
      }));

    it('with a queued loop hand-off pending', () =>
      expectRewindExact({
        setup: async (rig) => {
          rig.player.setActiveLoop(LOOP);
          rig.player.queueJump({ startFrame: frames(60), endFrame: frames(80) });
          await settle();
        },
        until: 18,
        detour: (rig) => {
          rig.player.queueJump(null);
          rig.run(12);
        },
        onward: (rig) => rig.run(40),
      }));

    it('with a gate-off owed to the lap just taken', () =>
      expectRewindExact({
        setup: (rig) => rig.player.setActiveLoop(LOOP),
        until: 25,
        detour: (rig) => {
          rig.run(1);
          rig.player.setVoiceMuted(1, true);
          rig.run(20);
        },
        onward: (rig) => rig.run(30),
      }));

    it('with a hand-off just landed and its gate-off owed', () =>
      expectRewindExact({
        setup: async (rig) => {
          rig.player.setActiveLoop(LOOP);
          rig.player.queueJump({ startFrame: frames(60), endFrame: frames(80) });
          await settle();
        },
        until: 25,
        detour: (rig) => {
          rig.run(1);
          rig.player.setVoiceMuted(1, true);
          rig.run(30);
        },
        onward: (rig) => rig.run(60),
      }));

    it('with a jump queued with settings, which land when it does', () => {
      const settings: JumpSettings = {
        voiceMutes: [true, false, false],
        voicePitch: [1.5, 1, 1],
        fieldOffsets: [{ field: { name: 'frequency', voice: 1 }, amount: 50 }],
        fieldHolds: [{ field: { name: 'volume' }, value: 7, amount: 0.5 }],
      };
      return expectRewindExact({
        setup: async (rig) => {
          rig.player.setActiveLoop(LOOP);
          rig.player.queueJump({
            startFrame: frames(60),
            endFrame: frames(80),
            settings,
          });
          await settle();
        },
        until: 18,
        detour: async (rig) => {
          // Another jump, with no settings, lands at the wrap the queued one was waiting for.
          rig.player.queueJump({ startFrame: frames(90), endFrame: frames(100) });
          await settle();
          rig.run(12);
        },
        onward: (rig) => rig.run(40),
      });
    });

    it('with a loop change named for a coming lap', () =>
      expectRewindExact({
        setup: async (rig) => {
          rig.player.setActiveLoop(LOOP);
          rig.player.setJumpTargets([frames(60)]);
          await settle();
          expect(
            rig.player.changeLoopAt(frames(26), { startFrame: frames(60), endFrame: frames(70) }),
          ).toBe(true);
        },
        until: 18,
        detour: (rig) => {
          rig.player.setActiveLoop(null);
          rig.run(12);
        },
        onward: (rig) => rig.run(40),
      }));

    it('with the hand on the record', () => {
      const file = chordTune();
      return expectRewindExact({
        tune: file,
        setup: (rig) => {
          rig.player.setRegisterRecord(recordFromTune(file, 1, 400));
          rig.run(2);
          expect(rig.player.enterVarispeed(SWEEP)).toBe(true);
        },
        until: 14,
        detour: (rig) => {
          rig.player.enterVarispeed(() => 3);
          rig.run(10);
        },
        onward: (rig) => rig.run(30),
      });
    });

    it('with the hand lifted between the save and the restore', () => {
      const file = chordTune();
      return expectRewindExact({
        tune: file,
        setup: (rig) => {
          rig.player.setRegisterRecord(recordFromTune(file, 1, 400));
          rig.run(2);
          rig.player.enterVarispeed(SWEEP);
        },
        until: 14,
        detour: async (rig) => {
          rig.player.leaveVarispeed();
          await settle();
          rig.run(130);
          expect(rig.player.getSnapshot().tempo.varispeed).toBe(false);
        },
        onward: (rig) => rig.run(140),
      });
    });

    it('with the hand lowered between the save and the restore', () => {
      const file = chordTune();
      return expectRewindExact({
        tune: file,
        setup: (rig) => rig.player.setRegisterRecord(recordFromTune(file, 1, 400)),
        until: 14,
        detour: (rig) => {
          expect(rig.player.enterVarispeed(() => 1.5)).toBe(true);
          rig.run(10);
        },
        onward: (rig) => rig.run(30),
      });
    });

    it('with mutes latched and held, and a mute let go of afterwards', () =>
      expectRewindExact({
        setup: (rig) => {
          rig.player.setVoiceMuted(0, true);
          rig.player.setVoiceHeld(1, true);
        },
        until: 12,
        detour: (rig) => {
          rig.player.clearVoiceMutes();
          rig.player.setVoiceHeld(1, false);
          rig.run(15);
        },
        onward: (rig) => {
          rig.run(10);
          rig.player.setVoiceMuted(0, false);
          rig.run(10);
          rig.player.setVoiceHeld(1, false);
          rig.run(10);
        },
      }));

    it('with a tempo change after the save, and a retime back', async () => {
      const { a, b } = await expectRewindExact({
        setup: (rig) => rig.player.setTempo(1.25),
        until: 12,
        detour: (rig) => {
          const before = rig.clock.stats.nominalIntervalUs;
          rig.player.setTempo(0.5);
          rig.run(15);
          expect(rig.clock.stats.nominalIntervalUs).not.toBe(before);
        },
        onward: (rig) => rig.run(20),
        unseen: true,
      });

      expect(b.clock.stats.nominalIntervalUs).toBe(a.clock.stats.nominalIntervalUs);
      expect(b.sink.retimeCalls.at(-1)).toBe(a.sink.retimeCalls.at(-1));
      expect(b.sink.retimeCalls).toHaveLength(a.sink.retimeCalls.length + 2);
    });

    it('with field holds and offsets, and the ones set after the save gone', () =>
      expectRewindExact({
        setup: (rig) => {
          rig.player.holdField({ name: 'volume' }, 5, 0.5);
          rig.player.holdField({ name: 'resonance' }, 9);
          rig.player.setFieldOffset({ name: 'frequency', voice: 0 }, 100);
        },
        until: 12,
        detour: (rig) => {
          rig.player.releaseField({ name: 'volume' });
          rig.player.clearFieldOffset({ name: 'frequency', voice: 0 });
          rig.player.setFieldOffset({ name: 'cutoff' }, 30);
          rig.run(15);
        },
        onward: (rig) => {
          rig.run(10);
          rig.player.releaseField({ name: 'resonance' });
          rig.run(10);
        },
      }));

    it('with the shadow running, lapping a loop', () =>
      expectRewindExact({
        setup: (rig) => {
          rig.player.setActiveLoop(LOOP);
          rig.player.startShadow(LOOP);
        },
        until: 18,
        detour: (rig) => {
          rig.player.stopShadow();
          rig.run(12);
          rig.player.startShadow(null);
        },
        onward: (rig) => rig.run(45),
      }));

    it('with a tune that changed its own rate after the save, re-timing the clock and not the sink', async () => {
      const { a, b } = await expectRewindExact({
        tune: rateChangeTune(),
        until: 20,
        detour: (rig) => {
          const before = rig.clock.stats.nominalIntervalUs;
          rig.run(25);
          expect(rig.clock.stats.nominalIntervalUs).not.toBe(before);
        },
        onward: (rig) => rig.run(30),
        unseen: true,
      });

      expect(b.clock.stats.nominalIntervalUs).toBe(a.clock.stats.nominalIntervalUs);
      expect(b.sink.retimeCalls).toEqual(a.sink.retimeCalls);
    });

    it('with a crossing capture taken between the save and the restore, and a landing that wants the one it recycled', async () => {
      const { a, b } = await expectRewindExact({
        setup: (rig) =>
          rig.player.setCrossingCaptures([{ originFrame: 0, periodFrames: 20, keep: 1 }]),
        until: 45,
        detour: (rig) => {
          // Two further crossings: the second refills the slot the frame-40 image was held in.
          rig.run(45);
          expect(rig.player.holdsImageAt(frames(40))).toBe(false);
        },
        onward: (rig) => {
          expect(rig.player.holdsImageAt(frames(40))).toBe(true);
          rig.player.setActiveLoop({ startFrame: frames(40), endFrame: frames(70) });
          rig.run(80);
        },
      });

      expect(b.player.getSnapshot().loop).toEqual(a.player.getSnapshot().loop);
    });

    it('with a loop re-entered on the anchor ring after crossings recorded under a mute', async () => {
      const { a, b } = await expectRewindExact({
        tune: heldNoteTune(),
        until: 300,
        detour: async (rig) => {
          rig.player.setVoiceMuted(0, true);
          await rig.player.seek(frames(110));
          rig.run(30);
        },
        onward: (rig) => {
          // Nothing answers, so the loop's first lap re-enters along the ring: from an anchor the
          // muted detour recorded, a voice would stay at 0 until the tune writes it again.
          rig.replay.held = true;
          rig.player.setActiveLoop({ startFrame: frames(190), endFrame: frames(230) });
          rig.run(60);
        },
      });

      expect(b.registers().sent[4]).toBe(a.registers().sent[4]);
    });
  });

  describe('carries the restored settings into the next load', () => {
    it('as a player that was never disturbed does', async () => {
      const commands = (rig: Rig): void => {
        rig.player.setOutputGain(0.75);
        rig.player.setRegisterScale('cutoff', 0.5);
        rig.player.holdField({ name: 'resonance' }, 9, 0.5);
        rig.player.setFieldOffset({ name: 'frequency', voice: 1 }, 40);
        rig.player.setVoicePitch(2, 1.25);
        rig.player.setTargetClock(1_022_730);
      };
      const a = await Rig.playing(chordTune());
      const b = await Rig.playing(chordTune());
      commands(a);
      commands(b);
      const state = b.player.createSavedState();
      b.player.saveState(state);
      b.player.setOutputGain(0.1);
      b.player.setRegisterScale('cutoff', 0.9);
      b.player.holdField({ name: 'resonance' }, 3);
      b.player.clearFieldOffset({ name: 'frequency', voice: 1 });
      b.player.setVoicePitch(2, 1);
      b.player.setTargetClock(null);

      b.player.restoreState(state);
      for (const rig of [a, b]) {
        rig.player.loadTune(chordTune());
        await rig.player.play();
        rig.run(3);
      }

      expect(b.registers()).toEqual(a.registers());
      expect(b.since({ delivered: 0, immediate: 0, observed: 0 }).delivered).toEqual(
        a.since({ delivered: 0, immediate: 0, observed: 0 }).delivered,
      );
    });
  });

  describe('crossing varispeed', () => {
    it('asks again for the image of a handback it was saved waiting on', async () => {
      const file = chordTune();
      const [a, b] = await Promise.all([Rig.playing(file), Rig.playing(file)]);
      for (const rig of [a, b]) {
        rig.player.setRegisterRecord(recordFromTune(file, 1, 400));
        rig.run(2);
      }
      // Nothing answers B's first request, so it is saved with the landing's handback still waiting
      // on its image and its gate-off owed.
      b.replay.held = true;
      for (const rig of [a, b]) expect(rig.player.land(frames(50))).toBe(true);
      await settle();
      const state = b.player.createSavedState();
      b.player.saveState(state);
      b.run(30);
      expect(b.player.getSnapshot().tempo.varispeed).toBe(true);
      b.replay.held = false;
      b.player.restoreState(state);
      await settle();
      b.ticks = a.ticks;

      const [markA, markB] = [a.mark(), b.mark()];
      a.run(150);
      b.run(150);

      expect(b.since(markB)).toEqual(a.since(markA));
      expect(a.player.getSnapshot().tempo.varispeed).toBe(false);
      expect(b.player.getSnapshot().tempo.varispeed).toBe(false);
    });

    it('stops the clock a non-playing varispeed owned when a live state comes back', async () => {
      const file = chordTune();
      const rig = await Rig.playing(file);
      rig.player.setRegisterRecord(recordFromTune(file, 1, 200));
      rig.run(5);
      const state = rig.player.createSavedState();
      rig.player.saveState(state);
      rig.player.pause();
      rig.player.enterVarispeed(() => 1);
      await settle();
      rig.run(3);
      const ended = rig.sink.endCallCount;

      rig.player.restoreState(state);

      expect(rig.player.getSnapshot().tempo.varispeed).toBe(false);
      expect(rig.player.getSnapshot().transport).toBe('paused');
      expect(rig.player.getPosition()).toBe(5);
      expect(rig.sink.endCallCount).toBe(ended + 1);
      expect(() => rig.clock.tick(milliseconds(9_999))).toThrow();
    });

    it('refuses a state taken in varispeed while the player is paused, changing nothing', async () => {
      const file = chordTune();
      const rig = await Rig.playing(file);
      rig.player.setRegisterRecord(recordFromTune(file, 1, 200));
      rig.run(2);
      rig.player.enterVarispeed(() => 1);
      rig.run(4);
      const state = rig.player.createSavedState();
      rig.player.saveState(state);
      rig.player.leaveVarispeed();
      await settle();
      rig.player.pause();
      rig.run(0);
      const before = untouched(rig);

      rig.player.restoreState(state);

      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/^SID player: ignoring a saved state taken in varispeed/),
      );
      expect(untouched(rig)).toEqual(before);
    });
  });

  describe('refuses a state it cannot restore exactly', () => {
    it('from another load of the same file, and from another file', async () => {
      const rig = await Rig.playing(chordTune());
      rig.run(8);
      const state = rig.player.createSavedState();
      rig.player.saveState(state);
      rig.run(5);

      for (const next of [chordTune(), heldNoteTune()]) {
        rig.player.loadTune(next);
        await rig.player.play();
        rig.run(3);
        const before = untouched(rig);
        warn.mockClear();

        rig.player.restoreState(state);

        expect(warn).toHaveBeenCalledWith(
          'SID player: ignoring a saved state taken on another load.',
        );
        expect(untouched(rig)).toEqual(before);
        expect(rig.player.getSnapshot()).toBe((before as { snapshot: unknown }).snapshot);
      }
    });

    it('from another subtune', async () => {
      const rig = await Rig.playing(tune([RTS], [RTS], 2));
      rig.run(4);
      const state = rig.player.createSavedState();
      rig.player.saveState(state);
      rig.player.selectSubtune(2);
      rig.run(2);
      const before = untouched(rig);

      rig.player.restoreState(state);

      expect(warn).toHaveBeenCalledWith(
        'SID player: ignoring a saved state taken on another subtune.',
      );
      expect(untouched(rig)).toEqual(before);
    });

    it('that another player made, or that was never saved into', async () => {
      const rig = await Rig.playing(chordTune());
      const other = await Rig.playing(chordTune());
      rig.run(3);
      other.run(3);
      const foreign = other.player.createSavedState();
      other.player.saveState(foreign);
      const empty = rig.player.createSavedState();
      const before = untouched(rig);

      rig.player.restoreState(foreign);
      rig.player.restoreState(empty);
      rig.player.saveState(foreign);

      expect(warn).toHaveBeenCalledWith(
        'SID player: ignoring a saved state that this player did not make.',
      );
      expect(warn).toHaveBeenCalledWith(
        'SID player: ignoring a saved state that was never saved into.',
      );
      expect(warn).toHaveBeenCalledWith(
        'SID player: ignoring a save into a state this player did not make.',
      );
      expect(untouched(rig)).toEqual(before);
    });

    it('made for other crossing lines, which a save is ignored for too', async () => {
      const rig = await Rig.playing(chordTune());
      rig.player.setCrossingCaptures([{ originFrame: 0, periodFrames: 10, keep: 2 }]);
      rig.run(25);
      const state = rig.player.createSavedState();
      rig.player.saveState(state);
      rig.run(5);
      rig.player.setCrossingCaptures([{ originFrame: 0, periodFrames: 10, keep: 3 }]);
      const before = untouched(rig);

      rig.player.restoreState(state);
      rig.player.saveState(state);

      expect(warn).toHaveBeenCalledWith(
        'SID player: ignoring a saved state made for other crossing lines.',
      );
      expect(warn).toHaveBeenCalledWith(
        'SID player: ignoring a save into a state made for other crossing lines.',
      );
      expect(untouched(rig)).toEqual(before);
    });

    it('with nothing loaded, where there is nothing to save', () => {
      const player = createSidPlayer({
        sink: new FakeSink(),
        clock: new FakeClock(),
        replayRunner: new Replayer(),
      });

      player.saveState(player.createSavedState());

      expect(warn).toHaveBeenCalledWith('SID player: ignoring a save with no tune loaded.');
    });
  });
});
