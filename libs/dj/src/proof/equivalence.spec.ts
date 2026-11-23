import {
  FakeClock,
  FakeSink,
  PAL_PHI2_HZ,
  createSidPlayer,
  milliseconds,
  parseSidFile,
} from '@sidablist/core';
import { describe, expect, it } from 'vitest';
import { BUNDLED_TUNES, decodeBundledTune } from '../__fixtures__/index.js';
import { createInlineHeavyWork } from '../heavy-work/inline.js';
import type { DeckCommand } from '../messages/commands.js';
import { firstFrameDifference } from '../testing/compare.js';
import { Rig } from '../testing/harness.js';
import type { WireEvent, WireFrame } from '../testing/holding-sink.js';

const FRAMES = 3000;

/** Frames a bare engine delivered when ticked at `dueTimes`, in the shape the holding sink's far end keeps. */
async function bareFrames(
  tune: string,
  speed: number,
  dueTimes: readonly number[],
): Promise<WireFrame[]> {
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
  player.setTargetClock(PAL_PHI2_HZ);
  player.setTempo(speed);
  await player.play();
  for (const due of dueTimes) clock.tick(milliseconds(due));
  return sink.deliveredFrames.map((item): WireFrame => ({
    kind: 'frame',
    frameNumber: item.frameNumber,
    dueAtMs: item.dueAtMs,
    catchUpClamped: item.catchUpClamped,
    registers: Array.from(item.frame.registers.subarray(0, item.frame.count)),
    values: Array.from(item.frame.values.subarray(0, item.frame.count)),
  }));
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

        const bare = await bareFrames(
          tune.id,
          speed,
          delivered.map((frame) => frame.dueAtMs),
        );
        expect(firstFrameDifference(delivered, bare)).toBeNull();
        rig.dispose();
      });
    }
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
