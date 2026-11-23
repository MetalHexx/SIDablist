import {
  FakeClock,
  FakeSink,
  PAL_PHI2_HZ,
  createSidPlayer,
  frames,
  milliseconds,
  parseSidFile,
} from '@sidablist/core';
import { describe, expect, it, vi } from 'vitest';
import { BUNDLED_TUNES, decodeBundledTune } from '../__fixtures__/index.js';
import { createInlineHeavyWork } from '../heavy-work/inline.js';
import type { DeckCommand } from '../messages/commands.js';
import { compareRewound } from '../testing/compare.js';
import { Rig, multiSongTune } from '../testing/harness.js';
import { HoldingSink } from '../testing/holding-sink.js';
import { LOG_CAPACITY } from './command-log.js';
import type { Deck } from './deck.js';

/** The stream frame of the next frame the rig's sink has not passed. */
function unsentOf(rig: Rig): number {
  const updates = rig.ofKind('update');
  return updates[updates.length - 1].streamFrame + 1 - (rig.sinks.get('a')?.holding ?? 0);
}

/** Presses a command on a deck of the package's own class, the way the package routes one. */
function press(deck: Deck, command: DeckCommand): void {
  expect(deck.refusal(command)).toBeNull();
  deck.receive(command);
}

describe('a deck with no commands', () => {
  for (const tune of BUNDLED_TUNES) {
    it(`delivers what a bare engine does on ${tune.id}, over 3,000 frames`, async () => {
      const rig = new Rig();
      rig.addDeck('a', { lookaheadMs: 60 });
      await rig.load('a', tune.id, { ends: 'playing' });
      rig.advance(61_500);
      const delivered = rig.frames().slice(0, 3000);
      expect(delivered).toHaveLength(3000);

      const sink = new FakeSink();
      const clock = new FakeClock();
      const player = createSidPlayer({
        sink,
        clock,
        replayRunner: createInlineHeavyWork().replayRunner(),
        time: { now: () => milliseconds(0) },
      });
      player.setRepeatTrack(true);
      player.loadTune(parseSidFile(decodeBundledTune(tune.base64)));
      player.setTargetClock(PAL_PHI2_HZ);
      await player.play();
      for (const frame of delivered) clock.tick(milliseconds(frame.dueAtMs));

      const bare = sink.deliveredFrames.map((item) => ({
        frameNumber: item.frameNumber,
        dueAtMs: item.dueAtMs,
        catchUpClamped: item.catchUpClamped,
        registers: Array.from(item.frame.registers.subarray(0, item.frame.count)),
        values: Array.from(item.frame.values.subarray(0, item.frame.count)),
      }));
      const deck = delivered.map((item) => ({
        frameNumber: item.frameNumber,
        dueAtMs: item.dueAtMs,
        catchUpClamped: item.catchUpClamped,
        registers: item.registers,
        values: item.values,
      }));
      expect(deck).toEqual(bare);
      rig.dispose();
    });
  }
});

describe('a deck driven by commands', () => {
  it('plays, pauses, stops, seeks, changes subtune and tempo, and reports what it does', async () => {
    const rig = new Rig();
    rig.addTune('three', multiSongTune(3));
    rig.addDeck('a');
    await rig.load('a', 'three', { ends: 'playing' });
    rig.advance(400);
    expect(rig.ofKind('loaded')).toMatchObject([{ tune: 'three', subtune: 1, subtuneCount: 3 }]);
    expect(rig.ofKind('update').length).toBeGreaterThan(10);

    rig.send({ kind: 'speed', deck: 'a', value: 1.5 });
    await rig.microtasks();
    rig.advance(100);
    rig.send({ kind: 'pause', deck: 'a' });
    await rig.microtasks();
    expect(rig.picture().transport).toBe('paused');
    expect(rig.picture().tempo.effective).toBe(1.5);

    rig.send({ kind: 'play', deck: 'a' });
    await rig.settle();
    rig.advance(200);
    expect(rig.picture().transport).toBe('playing');

    rig.send({ kind: 'stop', deck: 'a' });
    await rig.microtasks();
    expect(rig.picture().transport).toBe('stopped');

    rig.send({ kind: 'seek', deck: 'a', frame: 300 });
    await rig.settle();
    expect(rig.picture().transport).toBe('stopped');

    // Another subtune of the same tune keeps the transport and starts at its start.
    rig.send({ kind: 'play', deck: 'a' });
    await rig.settle();
    rig.advance(100);
    await rig.load('a', 'three', { subtune: 2 });
    rig.advance(300);
    expect(rig.picture().transport).toBe('playing');
    expect(rig.ofKind('loaded').map((event) => event.subtune)).toEqual([1, 2]);
    const second = rig.frames().slice(-5);
    expect(
      second.every(
        (frame) => frame.registers.includes(1) && frame.values[frame.registers.indexOf(1)] === 1,
      ),
    ).toBe(true);

    expect(rig.landed().map((event) => event.command.kind)).toEqual([
      'load',
      'speed',
      'pause',
      'play',
      'stop',
      'seek',
      'play',
      'load',
    ]);
    expect(rig.warnings).toEqual([]);
    rig.dispose();
  });
});

describe('loading', () => {
  it('lets the newest load win, and says nothing of one it overtook', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    const slow = rig.holdFetch('still-time');
    rig.send({ kind: 'load', deck: 'a', tune: 'still-time', subtune: 1, ends: 'playing' });
    await rig.microtasks();
    rig.send({ kind: 'load', deck: 'a', tune: 'insid3-out', subtune: 1, ends: 'playing' });
    await rig.settle();
    slow.release();
    await rig.settle();
    rig.advance(200);

    expect(rig.ofKind('loaded').map((event) => event.tune)).toEqual(['insid3-out']);
    expect(rig.ofKind('load-failed')).toEqual([]);
    expect(rig.picture()).toMatchObject({ transport: 'playing', tune: { tune: 'insid3-out' } });
    rig.dispose();
  });

  it('reports a failed fetch and leaves the deck failed, at home', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    await rig.load('a', 'not-a-tune', { speed: 1.4 });

    expect(rig.ofKind('load-failed')).toMatchObject([{ tune: 'not-a-tune' }]);
    expect(rig.ofKind('load-failed')[0].reason).toContain('no tune');
    expect(rig.picture()).toMatchObject({ transport: 'failed', tempo: { speed: 1, effective: 1 } });
    rig.dispose();
  });

  it('reports a file that is not a tune', async () => {
    const rig = new Rig();
    rig.addTune('junk', new Uint8Array([1, 2, 3]));
    rig.addDeck('a');
    await rig.load('a', 'junk');

    expect(rig.ofKind('load-failed')).toHaveLength(1);
    expect(rig.picture().transport).toBe('failed');
    rig.dispose();
  });

  it('lands on the next frame not yet sent when it is sent to a deck that is playing', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(300);
    const unsent = unsentOf(rig);

    rig.send({ kind: 'load', deck: 'a', tune: 'insid3-out', subtune: 1, ends: 'playing' });
    await rig.settle();
    rig.advance(400);

    const [load] = rig.landed('load').slice(-1);
    expect(load.frame).toBe(unsent);
    expect(rig.ofKind('loaded').map((event) => [event.tune, event.frame])).toEqual([
      ['still-time', 0],
      ['insid3-out', unsent],
    ]);
    const sent = rig.frames();
    // What the old tune had not yet sent is gone, and the new one starts at its first frame.
    expect(sent[unsent - 1].frameNumber).toBe(unsent - 1);
    expect(sent[unsent].frameNumber).toBe(0);
    expect(rig.picture()).toMatchObject({ transport: 'playing', tune: { tune: 'insid3-out' } });
    rig.dispose();
  });

  it('refuses a press while it waits, and lets a release through', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    const slow = rig.holdFetch('still-time');
    rig.send({ kind: 'load', deck: 'a', tune: 'still-time', subtune: 1, ends: 'playing' });
    await rig.microtasks();
    expect(rig.picture().transport).toBe('loading');

    rig.send({ kind: 'play', deck: 'a' });
    rig.send({ kind: 'seek', deck: 'a', frame: 10 });
    rig.send({ kind: 'nudge', deck: 'a', amount: 0 });
    await rig.microtasks();

    expect(rig.warnings).toEqual([
      'dj: refused play: play on a deck that is loading',
      'dj: refused seek: seek on a deck that is loading',
    ]);
    expect(rig.landed().map((event) => event.command.kind)).toEqual(['load', 'nudge']);
    slow.release();
    await rig.settle();
    rig.dispose();
  });

  it('ends paused at the start when the load says so', async () => {
    const rig = new Rig();
    const { sink } = rig.addDeck('a');
    await rig.load('a', 'still-time', { ends: 'paused' });
    rig.advance(300);

    expect(rig.picture().transport).toBe('paused');
    expect(rig.frames()).toEqual([]);
    expect(sink?.endCount).toBeGreaterThan(0);
    expect(rig.ofKind('loaded')).toHaveLength(1);
    rig.dispose();
  });

  it('keeps the transport it had when the load does not say where it ends', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    await rig.load('a', 'still-time', { ends: 'paused' });
    await rig.load('a', 'insid3-out');
    expect(rig.picture().transport).toBe('paused');

    rig.send({ kind: 'play', deck: 'a' });
    await rig.settle();
    await rig.load('a', 'still-time');
    expect(rig.picture().transport).toBe('playing');

    await rig.load('a', 'still-time', { ends: 'stopped' });
    await rig.load('a', 'insid3-out');
    expect(rig.picture().transport).toBe('stopped');
    rig.dispose();
  });

  it('goes home: the tempo, the mutes and the declared targets do not survive a load', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    await rig.load('a', 'still-time', { ends: 'paused' });
    rig.send({ kind: 'speed', deck: 'a', value: 1.3 });
    rig.send({ kind: 'speed-jump', deck: 'a', amount: 0.1 });
    rig.send({ kind: 'setting', deck: 'a', setting: 1, value: 1 });
    rig.send({ kind: 'targets', deck: 'a', frames: [500] });
    await rig.settle();
    expect(rig.picture().readyFrames).toEqual([500]);

    await rig.load('a', 'still-time', { ends: 'paused', settings: [{ setting: 3, value: 1 }] });
    const picture = rig.picture();
    expect(picture.tempo).toEqual({ speed: 1, nudge: 0, jump: 0, effective: 1 });
    expect(picture.settings.main).toEqual([
      { setting: 1, value: 0 },
      { setting: 2, value: 0 },
      { setting: 3, value: 1 },
    ]);
    expect(picture.readyFrames).toEqual([]);
    rig.dispose();
  });
});

describe('the gate on presses', () => {
  it('refuses a press on a deck that is empty, and changes nothing', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    rig.send({ kind: 'play', deck: 'a' });
    rig.send({ kind: 'speed', deck: 'a', value: 1.2 });
    rig.send({ kind: 'speed-jump', deck: 'a', amount: 0.2 });
    await rig.microtasks();

    expect(rig.warnings).toEqual([
      'dj: refused play: play on a deck that is empty',
      'dj: refused speed: speed on a deck that is empty',
      'dj: refused speed-jump: speed-jump on a deck that is empty',
    ]);
    expect(rig.landed()).toEqual([]);
    expect(rig.picture()).toMatchObject({ transport: 'empty', tempo: { speed: 1 } });
    rig.dispose();
  });

  it('refuses a press on a deck whose load failed, and lets a release and a new load through', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    await rig.load('a', 'not-a-tune');
    rig.warnings.length = 0;

    rig.send({ kind: 'pause', deck: 'a' });
    rig.send({ kind: 'nudge', deck: 'a', amount: 0 });
    rig.send({ kind: 'repeat', deck: 'a', on: false });
    rig.send({ kind: 'targets', deck: 'a', frames: [] });
    await rig.microtasks();

    expect(rig.warnings).toEqual(['dj: refused pause: pause on a deck that is failed']);
    expect(rig.landed().map((event) => event.command.kind)).toEqual([
      'load',
      'nudge',
      'repeat',
      'targets',
    ]);
    await rig.load('a', 'still-time', { ends: 'paused' });
    expect(rig.picture().transport).toBe('paused');
    rig.dispose();
  });

  it('holds a command sent while an engine call settles, and lands it in order afterwards', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    await rig.load('a', 'still-time', { ends: 'paused' });

    rig.send({ kind: 'play', deck: 'a' });
    rig.send({ kind: 'speed', deck: 'a', value: 1.25 });
    rig.send({ kind: 'pause', deck: 'a' });
    expect(rig.landed().map((event) => event.command.kind)).toEqual(['load', 'play']);
    await rig.settle();

    expect(rig.landed().map((event) => event.command.kind)).toEqual([
      'load',
      'play',
      'speed',
      'pause',
    ]);
    expect(rig.picture()).toMatchObject({ transport: 'paused', tempo: { effective: 1.25 } });
    expect(rig.frames()).toEqual([]);
    rig.dispose();
  });
});

describe('seeking', () => {
  it('lands a seek to an unprepared frame once its image is ready, at the frame it fixed', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(300);

    rig.send({ kind: 'seek', deck: 'a', frame: 2000 });
    await rig.microtasks();
    // The deck renders on without moving the sink's time, so everything it renders stays held.
    rig.time.ms += 20;
    rig.wake.fire();
    rig.time.ms += 20;
    rig.wake.fire();
    const landing = rig.ofKind('jump-landed');
    expect(landing).toEqual([]);

    rig.advance(400);
    const [jump] = rig.ofKind('jump-landed');
    expect(rig.ofKind('jump-landed')).toHaveLength(1);
    expect(jump).toMatchObject({ via: 'ready', startFrame: 2000, endFrame: null });
    const seek = rig.landed('seek')[0];
    expect(seek.frame).toBeLessThan(jump.frame);
    expect(rig.frames()[jump.frame].frameNumber).toBe(2000);
    expect(rig.frames()[jump.frame - 1].frameNumber).toBeLessThan(2000);
    expect(rig.picture().waiting).toBeNull();
    rig.dispose();
  });

  /**
   * A deck that took an unprepared seek, saw its image ready and fixed a landing, with the sink's
   * time standing still so every frame it rendered is held. With `rewind`, a press then lands on
   * the same frame the seek did and is flushed by a wake before the sink passes it, so the flush
   * restores the frame before the seek and re-applies it.
   */
  async function seekRun(rewind: boolean): Promise<{ rig: Rig; seekFrame: number }> {
    const rig = new Rig();
    rig.addDeck('a');
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(300);
    rig.send({ kind: 'seek', deck: 'a', frame: 2000 });
    await rig.microtasks();
    const seekFrame = unsentOf(rig);
    for (let i = 0; i < 2; i++) {
      rig.time.ms += 20;
      rig.wake.fire();
    }
    if (rewind) {
      rig.send({ kind: 'speed', deck: 'a', value: 1.1 });
      rig.wake.fire();
    }
    rig.advance(600);
    return { rig, seekFrame };
  }

  it('lands it at the same frame again after a rewind across that frame, and says so once', async () => {
    const straight = await seekRun(false);
    const rewound = await seekRun(true);

    expect(rewound.rig.picture().timing.rewinds).toBeGreaterThan(0);
    const jumps = rewound.rig.ofKind('jump-landed');
    expect(jumps).toHaveLength(1);
    expect(jumps[0].frame).toBe(straight.rig.ofKind('jump-landed')[0].frame);
    expect(jumps[0].frame).toBeGreaterThan(rewound.seekFrame + 1);
    // The press speeds the deck up, so it gets further in the same time: compare what both delivered.
    const numbers = (rig: Rig): number[] => rig.frames().map((frame) => frame.frameNumber);
    expect(numbers(rewound.rig).slice(0, 45)).toEqual(numbers(straight.rig).slice(0, 45));
    expect(rewound.rig.frames()[jumps[0].frame].frameNumber).toBe(2000);
    expect(rewound.rig.landed('speed')[0].frame).toBe(rewound.seekFrame);
    rewound.rig.dispose();
    straight.rig.dispose();
  });

  it('applies a seek that was not ready as it first answered, though its image has arrived since', async () => {
    const { rig, seekFrame } = await seekRun(true);

    const sent = rig.frames();
    expect(rig.landed('seek')[0].frame).toBe(seekFrame);
    expect(sent[seekFrame].frameNumber).not.toBe(2000);
    const jump = rig.ofKind('jump-landed')[0];
    expect(jump.frame).toBeGreaterThan(seekFrame);
    expect(sent[jump.frame].frameNumber).toBe(2000);
    rig.dispose();
  });

  it('collapses seeks held behind one that is settling to the latest', async () => {
    const rig = new Rig();
    const { deck } = rig.openDeck('a');
    press(deck, { kind: 'load', deck: 'a', tune: 'still-time', subtune: 1, ends: 'stopped' });
    await rig.settle();
    const seek = vi.spyOn(deck.player, 'seek');

    press(deck, { kind: 'seek', deck: 'a', frame: 100 });
    press(deck, { kind: 'seek', deck: 'a', frame: 200 });
    press(deck, { kind: 'seek', deck: 'a', frame: 300 });
    await rig.settle();

    expect(seek.mock.calls.map(([frame]) => frame)).toEqual([100, 300]);
    expect(deck.player.getPosition()).toBe(300);
    expect(rig.landed('seek')).toHaveLength(3);
    rig.dispose();
  });
});

describe('events', () => {
  it('go out at once from a deck that holds nothing', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    await rig.load('a', 'still-time', { ends: 'stopped' });
    expect(rig.ofKind('loaded')).toHaveLength(1);

    rig.send({ kind: 'speed', deck: 'a', value: 1.2 });
    expect(rig.landed('speed')).toHaveLength(1);

    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(300);
    rig.send({ kind: 'pause', deck: 'a' });
    await rig.microtasks();
    expect(rig.landed('pause')).toHaveLength(1);
    rig.send({ kind: 'speed', deck: 'a', value: 1.3 });
    expect(rig.landed('speed')).toHaveLength(2);
    rig.dispose();
  });

  it('wait for the sink to pass their frame while frames are held, and go out once', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(300);

    rig.send({ kind: 'speed', deck: 'a', value: 1.2 });
    await rig.microtasks();
    expect(rig.landed('speed')).toHaveLength(0);
    rig.advance(200);
    expect(rig.landed('speed')).toHaveLength(1);
    rig.advance(200);
    expect(rig.landed('speed')).toHaveLength(1);
    rig.dispose();
  });

  it('never report a landing a rewind undid', async () => {
    const rig = new Rig();
    rig.addDeck('a', { lookaheadMs: 120 });
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(300);
    const unsent = unsentOf(rig);

    rig.send({ kind: 'speed', deck: 'a', value: 1.4, when: { at: 'frame', frame: unsent + 4 } });
    await rig.microtasks();
    rig.send({ kind: 'pause', deck: 'a', when: { at: 'frame', frame: unsent + 2 } });
    await rig.microtasks();
    rig.advance(400);

    expect(rig.landed('pause')).toHaveLength(1);
    expect(rig.landed('pause')[0].frame).toBe(unsent + 2);
    expect(rig.landed('speed')).toEqual([]);
    expect(rig.picture()).toMatchObject({ transport: 'paused', tempo: { speed: 1 } });
    rig.dispose();
  });

  it('count a loaded and a jump-landed once through the rewinds across them', async () => {
    const rig = new Rig();
    rig.addDeck('a', { lookaheadMs: 120 });
    rig.send({ kind: 'load', deck: 'a', tune: 'still-time', subtune: 1, ends: 'playing' });
    await rig.settle();
    // A press on the frames right after the run began rewinds to its first frame.
    rig.wake.fire();
    rig.send({ kind: 'speed', deck: 'a', value: 1.1 });
    await rig.microtasks();
    rig.send({ kind: 'seek', deck: 'a', frame: 1800 });
    await rig.microtasks();
    for (let i = 0; i < 12; i++) {
      rig.time.ms += 20;
      rig.wake.fire();
      rig.send({ kind: 'nudge', deck: 'a', amount: i % 2 === 0 ? 0.01 : 0 });
      await rig.microtasks();
    }
    rig.advance(1500);

    expect(rig.ofKind('loaded')).toHaveLength(1);
    expect(rig.ofKind('jump-landed')).toHaveLength(1);
    const kinds = rig.landed().map((event) => event.command.kind);
    expect(kinds.filter((kind) => kind === 'seek')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'speed')).toHaveLength(1);
    expect(rig.picture().timing.rewinds).toBeGreaterThan(5);
    rig.dispose();
  });
});

describe('flushing', () => {
  it('costs one rewind a frame at most, however fast a control is turned', async () => {
    const rig = new Rig();
    rig.addDeck('a', { lookaheadMs: 120 });
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(300);
    const rewinds = (): number => rig.picture().timing.rewinds;
    const before = rewinds();

    for (let i = 1; i <= 5; i++) {
      rig.send({ kind: 'nudge', deck: 'a', amount: i / 100 });
      await rig.microtasks();
    }
    // The first press was flushed after its microtask; the sink has passed no frame since, so the
    // other four wait for the wake and are flushed together by one rewind.
    expect(rewinds() - before).toBe(1);
    rig.wake.fire();
    expect(rewinds() - before).toBe(2);

    rig.advance(300);
    const nudges = rig.landed('nudge');
    expect(nudges).toHaveLength(5);
    expect(new Set(nudges.map((event) => event.frame)).size).toBe(1);
    expect(rig.picture().tempo.nudge).toBe(0.05);
    rig.dispose();
  });
});

describe('the command log', () => {
  it('stays empty on a paused deck however many commands it takes', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    await rig.load('a', 'still-time', { ends: 'paused' });
    for (let i = 0; i < 1000; i++) {
      rig.send({ kind: 'speed', deck: 'a', value: i % 2 === 0 ? 1.2 : 0.9 });
    }
    await rig.microtasks();

    expect(rig.warnings).toEqual([]);
    expect(rig.landed('speed')).toHaveLength(1000);
    rig.dispose();
  });

  it('refuses a command once it is full', async () => {
    const rig = new Rig();
    rig.addDeck('a', { lookaheadMs: 120 });
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(300);
    // Every press lands on a frame the sink has not passed, so none can be dropped yet.
    for (let i = 0; i < 300; i++) rig.send({ kind: 'cancel-queued', deck: 'a' });
    await rig.microtasks();

    expect(rig.warnings.length).toBeGreaterThan(0);
    expect(rig.warnings[0]).toContain('the command log of deck a is full');
    rig.dispose();
  });

  it('keeps the latest value of a fast control once it is full', async () => {
    const rig = new Rig();
    rig.addDeck('a', { lookaheadMs: 120 });
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(300);
    for (let i = 0; i < LOG_CAPACITY + 44; i++) {
      rig.send({ kind: 'speed', deck: 'a', value: i === LOG_CAPACITY + 43 ? 1.5 : 0.5 + i / 1000 });
    }
    await rig.microtasks();

    expect(rig.warnings).toEqual([]);
    expect(rig.picture().tempo.speed).toBe(1.5);
    rig.dispose();
  });

  it("refuses a full log's command that is not the same control as the one before it", async () => {
    const rig = new Rig();
    rig.addDeck('a', { lookaheadMs: 120 });
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(300);
    for (let i = 0; i < LOG_CAPACITY - 1; i++) rig.send({ kind: 'cancel-queued', deck: 'a' });
    rig.send({ kind: 'setting', deck: 'a', setting: 1, value: 1 });
    rig.send({ kind: 'setting', deck: 'a', setting: 2, value: 1 });
    await rig.microtasks();

    expect(rig.warnings).toEqual(['dj: refused setting: the command log of deck a is full']);
    rig.dispose();
  });

  it('does not run a play twice when a flush lands on the frame right after its begin', async () => {
    const rig = new Rig();
    const { deck, sink } = rig.openDeck('a', 120);
    press(deck, { kind: 'load', deck: 'a', tune: 'still-time', subtune: 1, ends: 'paused' });
    await rig.settle();
    const play = vi.spyOn(deck.player, 'play');

    // A seek and a play on the same frame: both are in the restore point saved after the begin.
    press(deck, { kind: 'seek', deck: 'a', frame: 300 });
    await rig.settle();
    press(deck, { kind: 'play', deck: 'a' });
    await rig.settle();
    // Render ahead without moving the sink's time: the first frame of the run stays held.
    deck.wake(rig.time.ms);
    expect(sink.holding).toBeGreaterThan(3);
    press(deck, { kind: 'speed', deck: 'a', value: 1.25 });
    deck.wake(rig.time.ms);
    rig.advance(300);

    expect(play).toHaveBeenCalledTimes(1);
    expect(sink.beginCount).toBe(2);
    expect(rig.landed('play')).toHaveLength(1);
    expect(rig.landed('seek')).toHaveLength(1);
    expect(rig.landed('speed')).toHaveLength(1);
    expect(rig.ofKind('jump-landed')).toEqual([]);
    const sent = rig.frames();
    expect(sent.slice(0, 15).map((frame) => frame.frameNumber)).toEqual(
      Array.from({ length: 15 }, (_, i) => 300 + i),
    );
    expect(sent[1].dueAtMs - sent[0].dueAtMs).toBeCloseTo(19.95 / 1.25);
    rig.dispose();
  });
});

describe('halting', () => {
  it('lets the frames before an at-frame pause reach the sink, and drops none of them', async () => {
    const { rewound, landings, difference } = await compareRewound({
      lookaheadMs: 120,
      presses: [
        {
          atMs: 300,
          command: (deck, rig) => ({
            kind: 'pause',
            deck,
            when: { at: 'frame', frame: unsentOf(rig) + 3 },
          }),
        },
      ],
      runMs: 700,
    });

    expect(difference).toBeNull();
    const sent = rewound.frames();
    expect(sent).toHaveLength(landings[0]);
    expect(rewound.landed('pause')[0].frame).toBe(landings[0]);
    expect(rewound.picture().transport).toBe('paused');
  });
});

describe('the output', () => {
  it('re-renders the frames the old sink had not passed into the new one when it changes while playing', async () => {
    const straight = new Rig();
    straight.addDeck('a');
    await straight.load('a', 'still-time', { ends: 'playing' });
    straight.advance(700);

    const rig = new Rig();
    const { sink: first } = rig.addDeck('a');
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(300);
    const unsent = unsentOf(rig);
    const second = new HoldingSink();
    rig.sinks.set('second', second);
    rig.dj.setOutput('a', { sink: second, targetClockHz: PAL_PHI2_HZ, lookaheadMs: 60 });
    rig.advance(400);

    expect(first?.endCount).toBe(1);
    expect(second.beginCount).toBe(1);
    expect(rig.frames()).toHaveLength(unsent);
    const joined = [...rig.frames(), ...rig.frames('second')];
    expect(joined).toEqual(straight.frames().slice(0, joined.length));
    expect(joined.length).toBeGreaterThan(unsent + 10);
    rig.dispose();
    straight.dispose();
  });

  it('keeps rendering into nothing when the output is taken off, and again into a new one', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(200);
    const sent = rig.frames().length;

    rig.dj.setOutput('a', null);
    rig.advance(200);
    expect(rig.frames()).toHaveLength(sent);
    expect(rig.ofKind('update').length).toBeGreaterThan(sent + 5);
    expect(rig.picture().output).toBeNull();

    const next = new HoldingSink();
    rig.sinks.set('next', next);
    rig.dj.setOutput('a', { sink: next, targetClockHz: PAL_PHI2_HZ, lookaheadMs: 30 });
    rig.advance(200);
    expect(next.beginCount).toBe(1);
    expect(next.wire.some((item) => item.kind === 'frame')).toBe(true);
    expect(rig.picture().output?.lookaheadMs).toBe(30);
    rig.dispose();
  });

  it('rebuilds its ring for a new lookahead, and keeps restore points for the frames it re-renders', async () => {
    const rig = new Rig();
    const { sink } = rig.addDeck('a', { lookaheadMs: 60 });
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(300);
    const slots = rig.picture().output?.ringSlots ?? 0;

    rig.dj.setOutput('a', { sink: sink!, targetClockHz: PAL_PHI2_HZ, lookaheadMs: 150 });
    expect(rig.picture().output?.ringSlots).toBeGreaterThan(slots);
    const unsent = unsentOf(rig);

    rig.send({ kind: 'speed', deck: 'a', value: 1.25 });
    await rig.microtasks();
    rig.advance(300);
    expect(rig.landed('speed')[0].frame).toBe(unsent);
    expect(rig.picture().timing.ringShort).toBe(0);
    expect(rig.picture().tempo.effective).toBe(1.25);
    rig.dispose();
  });
});

describe('the end of a tune', () => {
  it('stops the wake and drops the held tail when repeat is off, and starts again from the top', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    await rig.load('a', 'still-time', {
      ends: 'paused',
      trackLoop: { loopStartFrame: null, loopPeriodFrames: null, endedAtFrame: 100 },
    });
    rig.send({ kind: 'repeat', deck: 'a', on: false });
    rig.send({ kind: 'play', deck: 'a' });
    await rig.settle();
    rig.advance(3000);

    expect(rig.picture().transport).toBe('ended');
    expect(rig.wake.running).toBe(false);
    expect(rig.frames().length).toBeLessThan(100);
    expect(rig.frames().length).toBeGreaterThan(90);

    rig.send({ kind: 'play', deck: 'a' });
    await rig.settle();
    rig.advance(200);
    const sent = rig.frames();
    expect(rig.picture().transport).toBe('playing');
    expect(sent[sent.length - 1].frameNumber).toBeLessThan(15);
    rig.dispose();
  });
});

describe('a deck with no output', () => {
  it('renders into nothing, says so once, and has nothing to rewind', async () => {
    const rig = new Rig();
    rig.addDeck('a', { sink: false });
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(500);

    expect(rig.warnings).toEqual(['dj: deck a has no output: its frames go nowhere']);
    expect(rig.ofKind('update').length).toBeGreaterThan(20);
    rig.send({ kind: 'speed', deck: 'a', value: 1.2 });
    expect(rig.landed('speed')).toHaveLength(1);
    const picture = rig.picture();
    expect(picture.output).toBeNull();
    expect(picture.timing.rewinds).toBe(0);
    rig.dispose();
  });
});

describe('the ring', () => {
  it('lands a command later than asked, and counts it, when more frames are held than it has slots', async () => {
    const rig = new Rig();
    const { sink } = rig.addDeck('a', { lookaheadMs: 60 });
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(300);
    // The sink's time stands still while the deck's runs on: far more frames are held than slots.
    for (let i = 0; i < 20; i++) {
      rig.time.ms += 20;
      rig.wake.fire();
    }
    const slots = rig.picture().output?.ringSlots ?? 0;
    expect(sink?.holding).toBeGreaterThan(slots);
    const unsent = unsentOf(rig);

    rig.send({ kind: 'speed', deck: 'a', value: 1.25 });
    await rig.microtasks();
    rig.advance(1000);

    const landed = rig.landed('speed')[0];
    expect(landed.frame).toBeGreaterThan(unsent);
    expect(rig.picture().timing.ringShort).toBe(1);
    const sent = rig.frames();
    expect(sent[landed.frame].dueAtMs - sent[landed.frame - 1].dueAtMs).toBeCloseTo(19.95);
    expect(sent[landed.frame + 1].dueAtMs - sent[landed.frame].dueAtMs).toBeCloseTo(19.95 / 1.25);
    rig.dispose();
  });
});

describe('falling behind', () => {
  it('skips ahead, marking the next frame, rather than render a burst of frames long past', async () => {
    const rig = new Rig();
    const { sink } = rig.addDeck('a');
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(200);
    const before = rig.frames().length;

    rig.time.ms += 5000;
    sink?.advanceTo(rig.time.ms);
    rig.wake.fire();
    rig.advance(100);

    const sent = rig.frames();
    const clamped = sent.filter((frame) => frame.catchUpClamped);
    expect(clamped).toHaveLength(1);
    expect(sent.length - before).toBeLessThan(12);
    const skipped = sent.indexOf(clamped[0]);
    expect(sent[skipped].dueAtMs).toBe(rig.time.ms - 100);
    rig.dispose();
  });
});

describe('the register record', () => {
  it('survives the next rewind when it arrives while frames are held', async () => {
    const rig = new Rig({ scan: 'held' });
    rig.addDeck('a', { lookaheadMs: 120 });
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(300);
    expect(rig.picture().tune?.recordReady).toBe(false);

    rig.releaseScans();
    await rig.microtasks();
    expect(rig.picture().tune?.recordReady).toBe(true);
    const rewinds = rig.picture().timing.rewinds;

    rig.send({ kind: 'speed', deck: 'a', value: 1.2 });
    await rig.microtasks();
    rig.advance(10);
    rig.send({ kind: 'nudge', deck: 'a', amount: 0.05 });
    await rig.microtasks();
    rig.advance(300);

    const picture = rig.picture();
    expect(picture.timing.rewinds).toBeGreaterThan(rewinds);
    expect(picture.tune?.recordReady).toBe(true);
    rig.dispose();
  });

  it('is left absent, with a line in the log, when the scan fails', async () => {
    const rig = new Rig();
    rig.addTune('junk', multiSongTune(1));
    rig.addDeck('a');
    // A tune whose scan cannot run: the play routine never writes, but the scan itself is fine, so break the scanner instead.
    const scan = vi
      .spyOn(rig.plugs.heavyWork.scanner, 'scan')
      .mockResolvedValue({ id: 1, kind: 'failed', error: 'no' });
    await rig.load('a', 'junk', { ends: 'paused' });

    expect(scan).toHaveBeenCalled();
    expect(rig.warnings.some((line) => line.includes('has no register record'))).toBe(true);
    expect(rig.picture().tune?.recordReady).toBe(false);
    rig.dispose();
  });
});

describe('the end of a pass', () => {
  /** A deck on Still Time with a ten-frame loop running from the start. */
  async function looping(rig: Rig): Promise<{ deck: Deck }> {
    const { deck } = rig.openDeck('a', 60);
    press(deck, { kind: 'load', deck: 'a', tune: 'still-time', subtune: 1, ends: 'paused' });
    await rig.settle();
    deck.player.setActiveLoop({ startFrame: frames(0), endFrame: frames(10) });
    await rig.settle();
    press(deck, { kind: 'play', deck: 'a' });
    await rig.settle();
    return { deck };
  }

  /** The stream frames on which the playhead moved back, from the latest update of each frame. */
  function wraps(rig: Rig): number[] {
    const latest = new Map<number, number>();
    for (const update of rig.ofKind('update')) latest.set(update.streamFrame, update.position);
    const found: number[] = [];
    for (const [frame, position] of latest) {
      const earlier = latest.get(frame - 1);
      if (earlier !== undefined && position < earlier) found.push(frame);
    }
    return found.sort((a, b) => a - b);
  }

  it('lands a pass-end command on the frame after a wrap that is already inside the held frames', async () => {
    const rig = new Rig();
    const { deck, sink } = await (async () => ({
      ...(await looping(rig)),
      sink: rig.sinks.get('a')!,
    }))();
    // Run until a wrap has rendered but not yet passed.
    let wrap = -1;
    for (let i = 0; i < 200 && wrap < 0; i++) {
      rig.advance(5);
      const frontier = rig.ofKind('update').at(-1)!.streamFrame + 1;
      const found = wraps(rig).find((frame) => frame >= frontier - sink.holding && frame > 0);
      if (found !== undefined) wrap = found;
    }
    expect(wrap).toBeGreaterThan(0);
    const unsent = unsentOf(rig);

    press(deck, { kind: 'speed', deck: 'a', value: 1.25, when: { at: 'pass-end' } });
    await rig.microtasks();
    rig.advance(300);

    const landed = rig.landed('speed')[0];
    expect(landed.fixed).toEqual({ at: 'pass-end', from: unsent });
    expect(landed.frame).toBe(wrap + 1);
    const sent = rig.frames();
    expect(sent[wrap + 2].dueAtMs - sent[wrap + 1].dueAtMs).toBeCloseTo(19.95 / 1.25);
    expect(sent[wrap].dueAtMs - sent[wrap - 1].dueAtMs).toBeCloseTo(19.95);
    rig.dispose();
  });

  it('applies a pass-end command at once when no loop runs', async () => {
    const rig = new Rig();
    const { deck } = rig.openDeck('a', 60);
    press(deck, { kind: 'load', deck: 'a', tune: 'still-time', subtune: 1, ends: 'playing' });
    await rig.settle();
    rig.advance(300);
    const unsent = unsentOf(rig);

    press(deck, { kind: 'speed', deck: 'a', value: 1.25, when: { at: 'pass-end' } });
    await rig.microtasks();
    rig.advance(200);

    expect(rig.landed('speed')[0].fixed).toEqual({ at: 'pass-end', from: unsent });
    expect(rig.landed('speed')[0].frame).toBe(unsent);
    rig.dispose();
  });

  it('applies a pass-end entry on the frame of the command that ended the loop first', async () => {
    const rig = new Rig();
    const { deck } = await looping(rig);
    // Just after a wrap, so the next one is not yet rendered.
    let wrap = -1;
    for (let i = 0; i < 400 && wrap < 0; i++) {
      rig.advance(5);
      const found = wraps(rig).at(-1);
      const frontier = rig.ofKind('update').at(-1)!.streamFrame;
      if (found !== undefined && found === frontier) wrap = found;
    }
    expect(wrap).toBeGreaterThan(0);

    press(deck, { kind: 'speed', deck: 'a', value: 1.25, when: { at: 'pass-end' } });
    await rig.microtasks();
    expect(rig.landed('speed')).toEqual([]);
    press(deck, { kind: 'seek', deck: 'a', frame: 3000 });
    await rig.microtasks();
    rig.advance(300);

    const [seek] = rig.landed('seek');
    const [speed] = rig.landed('speed');
    expect(speed.frame).toBe(seek.frame);
    expect(
      rig
        .landed()
        .map((event) => event.command.kind)
        .slice(-2),
    ).toEqual(['seek', 'speed']);
    rig.dispose();
  });

  it('applies it right after the command that ended the loop again when a flush re-renders that frame', async () => {
    const rig = new Rig();
    const { deck } = rig.openDeck('a', 60);
    press(deck, { kind: 'load', deck: 'a', tune: 'still-time', subtune: 1, ends: 'paused' });
    await rig.settle();
    press(deck, { kind: 'targets', deck: 'a', frames: [2000, 3000] });
    await rig.settle();
    deck.player.setActiveLoop({ startFrame: frames(0), endFrame: frames(10) });
    await rig.settle();
    press(deck, { kind: 'play', deck: 'a' });
    await rig.settle();
    // Just after a wrap has passed the sink, so the next is ten frames on and not yet rendered.
    for (let i = 0; i < 400; i++) {
      rig.advance(5);
      const wrap = wraps(rig).at(-1);
      const frontier = rig.ofKind('update').at(-1)!.streamFrame + 1;
      if (wrap !== undefined && wrap < unsentOf(rig) && frontier - wrap < 6) break;
    }

    // A seek at the end of the pass, then, a frame later, another: the second ends the loop and the
    // first follows it, so the playhead ends on the first's frame.
    press(deck, { kind: 'seek', deck: 'a', frame: 3000, when: { at: 'pass-end' } });
    await rig.microtasks();
    rig.advance(20);
    press(deck, { kind: 'seek', deck: 'a', frame: 2000 });
    await rig.microtasks();
    // A press on the same frame, flushed before the sink passes it, re-renders both.
    press(deck, { kind: 'speed', deck: 'a', value: 1.2 });
    deck.wake(rig.time.ms);
    rig.advance(300);

    const [first, second] = rig.landed('seek');
    expect(first.command).toMatchObject({ frame: 2000 });
    expect(second.command).toMatchObject({ frame: 3000 });
    expect(second.frame).toBe(first.frame);
    expect(rig.frames()[first.frame].frameNumber).toBe(3000);
    rig.dispose();
  });
});

describe('frames past the end of the tune', () => {
  const FAR = 5_000_000;

  it('refuses a seek, a jump, a key and a loop edit to one, and the deck keeps rendering', async () => {
    const rig = new Rig();
    rig.addDeck('a', { lookaheadMs: 120 });
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(100);

    rig.send({ kind: 'seek', deck: 'a', frame: FAR });
    rig.send({ kind: 'jump', deck: 'a', target: { startFrame: FAR, endFrame: null } });
    rig.send({ kind: 'key', deck: 'a', target: { startFrame: FAR, endFrame: FAR + 100 } });
    rig.send({ kind: 'loop-bounds', deck: 'a', startFrame: FAR, endFrame: FAR + 100 });
    await rig.microtasks();

    expect(rig.warnings).toHaveLength(4);
    for (const kind of ['seek', 'jump', 'key', 'loop-bounds']) {
      expect(rig.warnings.some((w) => w.startsWith(`dj: refused ${kind}: frame ${FAR}`))).toBe(
        true,
      );
    }
    expect(rig.landed().map((event) => event.command.kind)).toEqual(['load']);
    const before = rig.frames().length;
    rig.advance(100);
    expect(rig.frames().length).toBeGreaterThan(before);
    rig.dispose();
  });

  it('refuses a seek on a paused deck without settling on it', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    await rig.load('a', 'still-time', { ends: 'paused' });

    rig.send({ kind: 'seek', deck: 'a', frame: FAR });
    rig.send({ kind: 'seek', deck: 'a', frame: 300 });
    await rig.settle();

    expect(rig.warnings).toHaveLength(1);
    expect(rig.landed('seek').map((event) => event.command)).toEqual([
      { kind: 'seek', deck: 'a', frame: 300 },
    ]);
    rig.dispose();
  });

  it('drops the far frames of a target list and keeps the rest', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    await rig.load('a', 'still-time', { ends: 'paused' });

    rig.send({ kind: 'targets', deck: 'a', frames: [300, FAR, 600] });
    await rig.settle();

    expect(rig.warnings).toHaveLength(1);
    expect(rig.warnings[0]).toContain('dropped 1 frame(s)');
    expect(rig.landed('targets').map((event) => event.command)).toEqual([
      { kind: 'targets', deck: 'a', frames: [300, 600] },
    ]);
    rig.dispose();
  });
});
