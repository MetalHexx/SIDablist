import {
  FakeClock,
  FakeSink,
  PAL_PHI2_HZ,
  createSidPlayer,
  milliseconds,
  parseSidFile,
} from '@sidablist/core';
import type { SidPlayer } from '@sidablist/core';
import { describe, expect, it } from 'vitest';
import { BUNDLED_TUNES, decodeBundledTune } from '../__fixtures__/index.js';
import { createInlineHeavyWork } from '../heavy-work/inline.js';
import type { DeckCommand, NumberedSetting } from '../messages/commands.js';
import { SETTING } from '../messages/setting-table.js';
import { firstFrameDifference } from '../testing/compare.js';
import { Rig } from '../testing/harness.js';
import type { WireEvent, WireFrame } from '../testing/holding-sink.js';

const FRAMES = 3000;

/**
 * Frames a bare engine delivered when ticked at `dueTimes`, in the shape the holding sink's far end
 * keeps. `shape` makes the engine calls a deck's settings stand for, after `loadTune`.
 */
async function bareFrames(
  tune: string,
  speed: number,
  dueTimes: readonly number[],
  shape?: (player: SidPlayer) => void,
): Promise<{ readonly frames: WireFrame[]; readonly effectiveIntervalUs: number }> {
  const sink = new FakeSink();
  const clock = new FakeClock();
  const player = createSidPlayer({
    sink,
    clock,
    replayRunner: createInlineHeavyWork().replayRunner(),
    time: { now: () => milliseconds(0) },
  });
  const bundled = BUNDLED_TUNES.find((item) => item.id === tune);
  if (bundled === undefined) throw new Error(`no bundled tune ${tune}`);
  player.setRepeatTrack(true);
  player.loadTune(parseSidFile(decodeBundledTune(bundled.base64)));
  shape?.(player);
  player.setTargetClock(PAL_PHI2_HZ);
  player.setTempo(speed);
  await player.play();
  const effectiveIntervalUs = player.getSnapshot().tempo.effectiveIntervalUs;
  for (const due of dueTimes) clock.tick(milliseconds(due));
  const frames = sink.deliveredFrames.map((item): WireFrame => ({
    kind: 'frame',
    frameNumber: item.frameNumber,
    dueAtMs: item.dueAtMs,
    catchUpClamped: item.catchUpClamped,
    registers: Array.from(item.frame.registers.subarray(0, item.frame.count)),
    values: Array.from(item.frame.values.subarray(0, item.frame.count)),
  }));
  return { frames, effectiveIntervalUs };
}

describe('a deck with no commands', () => {
  for (const tune of BUNDLED_TUNES) {
    for (const speed of [1, 1.3]) {
      it(`delivers what a bare engine does on ${tune.id} at ${speed}x, over ${FRAMES} frames`, async () => {
        const rig = new Rig();
        rig.addDeck('a', { lookaheadMs: 60 });
        await rig.load('a', tune.id, { ends: 'playing', speed });
        rig.advance(61_500);
        const delivered = rig.frames().slice(0, FRAMES);
        expect(delivered).toHaveLength(FRAMES);

        const { frames: bare, effectiveIntervalUs } = await bareFrames(
          tune.id,
          speed,
          delivered.map((frame) => frame.dueAtMs),
        );
        expect(firstFrameDifference(delivered, bare)).toBeNull();

        // The bare engine was ticked at the deck's own due times, so that half of the comparison
        // is circular; the engine's interval is the independent check on their spacing.
        let worst = 0;
        for (let i = 1; i < delivered.length; i++) {
          const step = delivered[i].dueAtMs - delivered[i - 1].dueAtMs;
          worst = Math.max(worst, Math.abs(step - effectiveIntervalUs / 1000));
        }
        expect(worst).toBeLessThan(1e-6);
        rig.dispose();
      });
    }
  }
});

const KEY = 3;
const COARSE = 7;
const FINE = 30;
/** A list off home in every way the engine takes: an offset, two holds, Key, a voice's tuning and a mute. */
const OFF_HOME: readonly NumberedSetting[] = [
  { setting: SETTING.CUTOFF_OFFSET, value: 300 },
  { setting: SETTING.VOICE_1_WAVEFORM_HOLD, value: 2 },
  { setting: SETTING.VOICE_2_PULSE_WIDTH_HOLD, value: 1024 },
  { setting: SETTING.KEY, value: KEY },
  { setting: SETTING.VOICE_2_COARSE, value: COARSE },
  { setting: SETTING.VOICE_2_FINE, value: FINE },
  { setting: SETTING.VOICE_3_MUTE, value: 1 },
];

/** The engine calls `OFF_HOME` stands for, made directly on a bare engine. */
function shapeLikeOffHome(player: SidPlayer): void {
  player.setFieldOffset({ name: 'cutoff' }, 300);
  player.holdField({ name: 'waveform', voice: 0 }, 2);
  player.holdField({ name: 'pulseWidth', voice: 1 }, 1024);
  for (let voice = 0; voice < 3; voice++) {
    const coarse = voice === 1 ? COARSE : 0;
    const fine = voice === 1 ? FINE : 0;
    player.setVoicePitch(voice, 2 ** ((KEY + coarse + fine / 100) / 12));
  }
  player.setVoiceMuted(2, true);
}

describe('a deck loaded with settings off home', () => {
  for (const tune of BUNDLED_TUNES) {
    it(`delivers what a bare engine given the same calls does on ${tune.id}, over ${FRAMES} frames`, async () => {
      const rig = new Rig();
      rig.addDeck('a', { lookaheadMs: 60 });
      await rig.load('a', tune.id, { ends: 'playing', settings: OFF_HOME });
      rig.advance(61_500);
      const delivered = rig.frames().slice(0, FRAMES);
      expect(delivered).toHaveLength(FRAMES);
      expect(rig.picture().settings.main).toHaveLength(OFF_HOME.length);

      const { frames: bare } = await bareFrames(
        tune.id,
        1,
        delivered.map((frame) => frame.dueAtMs),
        shapeLikeOffHome,
      );
      expect(firstFrameDifference(delivered, bare)).toBeNull();

      // The settings changed something: a deck with none gives other frames.
      const plain = new Rig();
      plain.addDeck('a', { lookaheadMs: 60 });
      await plain.load('a', tune.id, { ends: 'playing' });
      plain.advance(61_500);
      expect(firstFrameDifference(delivered, plain.frames().slice(0, FRAMES))).not.toBeNull();
      rig.dispose();
      plain.dispose();
    });
  }
});

/** What the two decks are told, each at a frame: tempo, a nudge, a mute, a seek and a speed jump. */
const AT_FRAMES: readonly (readonly [number, (deck: string) => DeckCommand])[] = [
  [150, (deck) => ({ kind: 'speed', deck, value: 1.3 })],
  [300, (deck) => ({ kind: 'nudge', deck, amount: 0.05 })],
  [400, (deck) => ({ kind: 'setting', deck, setting: 1, value: 1 })],
  [520, (deck) => ({ kind: 'nudge', deck, amount: 0 })],
  [600, (deck) => ({ kind: 'seek', deck, frame: 1500 })],
  [800, (deck) => ({ kind: 'speed-jump', deck, amount: -0.2 })],
  [900, (deck) => ({ kind: 'setting', deck, setting: 1, value: 0 })],
];

/** A deck told `AT_FRAMES` before it renders, run for `ms`; the wire it gave. */
async function runWithCommands(
  tune: string,
  commands: boolean,
  ms: number,
): Promise<readonly WireEvent[]> {
  const rig = new Rig();
  rig.addDeck('a', { lookaheadMs: 60 });
  await rig.load('a', tune, { ends: 'paused' });
  rig.send({ kind: 'targets', deck: 'a', frames: [1500] });
  await rig.settle();
  rig.send({ kind: 'play', deck: 'a' });
  await rig.settle();
  if (commands) {
    for (const [frame, make] of AT_FRAMES) {
      rig.send({ ...make('a'), when: { at: 'frame', frame } });
    }
  }
  rig.advance(ms);
  const wire = [...(rig.sinks.get('a')?.wire ?? [])];
  rig.dispose();
  return wire;
}

describe('two decks told the same commands at the same frames', () => {
  for (const tune of BUNDLED_TUNES) {
    it(`give the same output, due times included, on ${tune.id}`, async () => {
      const first = await runWithCommands(tune.id, true, 25_000);
      const second = await runWithCommands(tune.id, true, 25_000);
      const none = await runWithCommands(tune.id, false, 25_000);

      expect(first.filter((item) => item.kind === 'frame').length).toBeGreaterThan(1000);
      expect(firstFrameDifference(first, second)).toBeNull();
      // The commands did something: a deck told none gives other frames.
      expect(firstFrameDifference(first, none)).not.toBeNull();
    });
  }
});
