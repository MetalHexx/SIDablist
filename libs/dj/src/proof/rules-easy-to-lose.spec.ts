import { loopStartAtOrBefore } from '@sidablist/analysis';
import { describe, expect, it } from 'vitest';
import type { DeckCommand, Grid, JumpTarget } from '../messages/commands.js';
import { Rig, multiSongTune } from '../testing/harness.js';

/**
 * Behaviours a DJ would notice missing, each in its own spec and written to fail when the rule is
 * dropped. They run on Still Time, whose delivered frame number is the playhead, unless said.
 */

const LOOP_A: JumpTarget = { startFrame: 500, endFrame: 520 };
const LOOP_B: JumpTarget = { startFrame: 1000, endFrame: 1010 };
const CUE: JumpTarget = { startFrame: 1500, endFrame: null };
const VOICE_2_CONTROL = 11;
const VOICE_3_CONTROL = 18;
const SOUNDING = 65;

/** A playing deck with `targets` declared and ready. */
async function playing(
  targets: readonly number[],
  options: { tune?: string; grid?: Grid; slip?: boolean; playMs?: number } = {},
): Promise<Rig> {
  const rig = new Rig();
  rig.addDeck('a', { lookaheadMs: 60 });
  await rig.load('a', options.tune ?? 'still-time', {
    ends: 'playing',
    ...(options.grid === undefined ? {} : { grid: options.grid }),
  });
  rig.send({ kind: 'targets', deck: 'a', frames: [...targets] });
  if (options.slip === true) rig.send({ kind: 'slip', deck: 'a', on: true });
  await rig.settle();
  rig.advance(options.playMs ?? 100);
  return rig;
}

/** Sends a command and lets the flush it scheduled run. */
async function send(rig: Rig, command: DeckCommand): Promise<void> {
  rig.send(command);
  await rig.microtasks();
}

/** The playhead of each delivered frame from stream frame `from` up to `to`. */
function playhead(rig: Rig, from: number, to: number): number[] {
  return rig
    .frames()
    .slice(from, to)
    .map((frame) => frame.frameNumber);
}

/** What a delivered frame wrote to `register`, or null when it wrote none. */
function wrote(rig: Rig, frame: number, register: number): number | null {
  const delivered = rig.frames()[frame];
  const at = delivered.registers.indexOf(register);
  return at < 0 ? null : delivered.values[at];
}

describe('presses and releases', () => {
  const RELEASES: DeckCommand[] = [
    { kind: 'nudge', deck: 'a', amount: 0 },
    { kind: 'hand-lift', deck: 'a', atMs: 0, gripSeconds: 0.25 },
    { kind: 'stop-loop', deck: 'a' },
  ];
  const PRESSES: DeckCommand[] = [
    { kind: 'play', deck: 'a' },
    { kind: 'speed', deck: 'a', value: 1.2 },
    { kind: 'nudge', deck: 'a', amount: 0.05 },
    { kind: 'key', deck: 'a', target: LOOP_A },
    { kind: 'hand-touch', deck: 'a', atMs: 0 },
  ];

  it('land only on a settled deck, while a release goes through on an empty, a loading and a failed one', async () => {
    const empty = new Rig();
    empty.addDeck('a');
    const loading = new Rig();
    loading.addDeck('a');
    const slow = loading.holdFetch('still-time');
    loading.send({ kind: 'load', deck: 'a', tune: 'still-time', subtune: 1 });
    await loading.microtasks();
    const failed = new Rig();
    failed.addDeck('a');
    await failed.load('a', 'not-a-tune');
    // A deck that holds a tune and is loading another: only its phase refuses a press.
    const reloading = await playing([500]);
    const swap = reloading.holdFetch('insid3-out');
    reloading.send({ kind: 'load', deck: 'a', tune: 'insid3-out', subtune: 1, ends: 'playing' });
    await reloading.microtasks();

    for (const [name, rig] of [
      ['empty', empty],
      ['loading', loading],
      ['loading', reloading],
      ['failed', failed],
    ] as const) {
      expect(rig.picture().transport, name).toBe(name);
      rig.warnings.length = 0;
      for (const command of RELEASES) rig.send(command);
      await rig.microtasks();
      expect(
        rig.warnings.filter((line) => line.includes('refused')),
        `a release on a deck that is ${name}`,
      ).toEqual([]);
      for (const command of PRESSES) rig.send(command);
      await rig.microtasks();
      expect(
        rig.warnings.filter((line) => line.includes('refused')).length,
        `presses on a deck that is ${name}`,
      ).toBe(PRESSES.length);
    }
    slow.release();
    swap.release();
    await loading.settle();
    await reloading.settle();

    // A settled deck takes the presses.
    const settled = await playing([500]);
    settled.warnings.length = 0;
    for (const command of PRESSES.slice(1, 4)) await send(settled, command);
    expect(settled.warnings).toEqual([]);
    for (const rig of [empty, loading, reloading, failed, settled]) rig.dispose();
  });
});

describe('a load', () => {
  it('resets before its first wait, so a load that fails or is overtaken ends at home', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    await rig.load('a', 'still-time', {
      ends: 'playing',
      speed: 1.3,
      settings: [{ setting: 1, value: 1 }],
    });
    rig.send({ kind: 'targets', deck: 'a', frames: [500] });
    await rig.settle();
    rig.advance(100);
    expect(rig.picture().tempo.effective).toBe(1.3);
    // The hand goes down before the loop starts, so both are in play at the load.
    await send(rig, { kind: 'hand-touch', deck: 'a', atMs: rig.time.ms });
    rig.advance(60);
    await send(rig, { kind: 'key', deck: 'a', target: LOOP_A });
    rig.advance(100);
    expect(rig.picture()).toMatchObject({ hand: 'down', loop: { startFrame: 500, endFrame: 520 } });

    const slow = rig.holdFetch('insid3-out');
    rig.send({ kind: 'load', deck: 'a', tune: 'insid3-out', subtune: 1, ends: 'playing' });
    await rig.microtasks();
    rig.advance(100);
    // Still waiting on the fetch: nothing of the old tune's tempo, mutes or targets is left.
    const waiting = rig.picture();
    expect(waiting.transport).toBe('loading');
    expect(waiting.tempo).toEqual({ speed: 1, nudge: 0, jump: 0, effective: 1 });
    expect(waiting.settings.main.every((setting) => setting.value === 0)).toBe(true);
    expect(waiting.readyFrames).toEqual([]);
    expect(waiting.loop).toBeNull();
    expect(waiting.hand).toBe('up');

    slow.fail(new Error('gone'));
    await rig.settle();
    const failed = rig.picture();
    expect(failed.transport).toBe('failed');
    expect(failed.tempo.effective).toBe(1);
    expect(failed.loop).toBeNull();
    expect(failed.hand).toBe('up');
    expect(failed.settings.main.every((setting) => setting.value === 0)).toBe(true);
    rig.dispose();
  });
});

describe('a subtune change on a paused deck', () => {
  it('holds at the new subtune’s start, and plays it from there', async () => {
    const rig = new Rig();
    rig.addTune('three', multiSongTune(3));
    rig.addDeck('a');
    await rig.load('a', 'three', { ends: 'playing' });
    rig.advance(300);
    rig.send({ kind: 'pause', deck: 'a' });
    await rig.microtasks();
    rig.advance(100);
    const before = rig.frames().length;

    await rig.load('a', 'three', { subtune: 2 });
    rig.advance(300);
    expect(rig.picture()).toMatchObject({ transport: 'paused', tune: { subtune: 2 } });
    expect(rig.frames()).toHaveLength(before);

    rig.send({ kind: 'play', deck: 'a' });
    await rig.settle();
    rig.advance(200);
    const first = rig.frames()[before];
    expect(first.frameNumber).toBe(0);
    expect(first.values[first.registers.indexOf(1)]).toBe(1);
    rig.dispose();
  });
});

describe('a cue fired in a loop', () => {
  it('waits for the end of the pass, which plays on until then', async () => {
    const rig = await playing([500, 1500]);
    await send(rig, { kind: 'key', deck: 'a', target: LOOP_A });
    rig.advance(100);
    await send(rig, { kind: 'key', deck: 'a', target: CUE });
    rig.advance(600);
    const pressed = rig.landed('key')[1];

    expect(pressed).toMatchObject({ resolved: 'queue' });
    const landing = rig.ofKind('jump-landed')[0];
    expect(landing).toMatchObject({ via: 'pass-end', startFrame: 1500 });
    const inside = playhead(rig, pressed.frame, landing.frame);
    expect(inside.length).toBeGreaterThan(0);
    expect(Math.min(...inside)).toBeGreaterThanOrEqual(500);
    expect(Math.max(...inside)).toBeLessThan(520);
    expect(playhead(rig, landing.frame, landing.frame + 1)[0]).toBe(1500);
    rig.dispose();
  });
});

describe('an edit to a running loop', () => {
  it('waits for the end of the pass, while WRAP changes at once and no end lets it go at once', async () => {
    const rig = await playing([500]);
    await send(rig, { kind: 'key', deck: 'a', target: LOOP_A });
    rig.advance(100);

    await send(rig, { kind: 'loop-bounds', deck: 'a', startFrame: 500, endFrame: 510 });
    expect(rig.picture().loop).toMatchObject({ startFrame: 500, endFrame: 520 });
    expect(rig.picture().pendingBounds).toEqual({ startFrame: 500, endFrame: 510 });
    rig.advance(20);
    const edit = rig.landed('loop-bounds')[0];
    expect(Math.max(...playhead(rig, edit.frame, edit.frame + 2))).toBeLessThan(520);

    rig.advance(100);
    // The loop does not wrap until now; the change shows on the picture with the edit still pending.
    expect(rig.picture().loop?.wraps).toBe(false);
    await send(rig, { kind: 'loop-wraps', deck: 'a', wraps: true });
    expect(rig.picture().loop?.wraps).toBe(true);
    expect(rig.picture().pendingBounds).not.toBeNull();

    rig.advance(600);
    expect(rig.picture().loop).toMatchObject({ startFrame: 500, endFrame: 510 });
    expect(rig.picture().pendingBounds).toBeNull();

    await send(rig, { kind: 'loop-bounds', deck: 'a', startFrame: 500, endFrame: null });
    expect(rig.picture().loop).toBeNull();
    rig.advance(300);
    const letGo = rig.landed('loop-bounds')[1];
    expect(Math.max(...playhead(rig, letGo.frame, letGo.frame + 15))).toBeGreaterThan(510);
    rig.dispose();
  });
});

describe('the live looper', () => {
  const GRID: Grid = { beatFrames: 20, beatOneFrame: 0 };

  /** A deck with a grid, a size and a live loop pushed in one turn; the frame the push landed on. */
  async function pushed(grid: Grid, lengthFrames: number): Promise<{ rig: Rig; landed: number }> {
    const rig = await playing([100], { grid, playMs: 800 });
    rig.send({ kind: 'live-loop-size', deck: 'a', lengthFrames });
    rig.send({ kind: 'live-loop', deck: 'a' });
    await rig.microtasks();
    rig.advance(60);
    return { rig, landed: rig.landed('live-loop')[0].frame };
  }

  it('starts on the last line at or behind the frame one past the playhead', async () => {
    const probe = await pushed(GRID, 20);
    // Still Time plays straight from 0, so the playhead at the push is the frame it landed on.
    const ahead = probe.landed + 1;
    probe.rig.dispose();

    for (const behind of [0, 1, 7]) {
      const run = await pushed({ beatFrames: 20, beatOneFrame: ahead - behind }, 20);
      const expected = loopStartAtOrBefore(
        { beatFrames: 20, beatOneFrame: ahead - behind },
        20,
        ahead,
      );
      expect(expected).toBe(ahead - behind);
      expect(run.rig.picture().loop, `${behind} behind`).toMatchObject({
        startFrame: ahead - behind,
        endFrame: ahead - behind + 20,
        live: true,
        wraps: true,
      });
      run.rig.dispose();
    }
  });

  it('applies a shrink at once only while the playhead is two frames or more short of the new end', async () => {
    const probe = await pushed(GRID, 60);
    const start = probe.rig.picture().loop?.startFrame ?? -1;
    probe.rig.advance(900);
    await send(probe.rig, { kind: 'live-loop-size', deck: 'a', lengthFrames: 10 });
    probe.rig.advance(20);
    const pressed = probe.rig.landed('live-loop-size').at(-1)?.frame ?? -1;
    const position = probe.rig
      .ofKind('update')
      .filter((update) => update.streamFrame === pressed - 1)
      .at(-1)?.position;
    probe.rig.dispose();
    expect(position).toBeDefined();

    // With the playhead at `position`, the last size that applies at once is `position - start + 2`.
    const lastAtOnce = Math.floor(position ?? 0) - start + 2;
    expect(lastAtOnce).toBeGreaterThanOrEqual(3);
    for (const [length, waits] of [
      [lastAtOnce, false],
      [lastAtOnce - 1, true],
    ] as const) {
      const run = await pushed(GRID, 60);
      run.rig.advance(900);
      await send(run.rig, { kind: 'live-loop-size', deck: 'a', lengthFrames: length });
      run.rig.advance(20);
      const live = run.rig.picture().liveLoop;
      expect(live?.pendingEndFrame, `a shrink to ${length} frames`).toBe(
        waits ? start + length : null,
      );
      run.rig.dispose();
    }
  });

  it('puts the loop underneath back before landing when it ends, so its count does not start again', async () => {
    const UNDER: JumpTarget = { startFrame: 100, endFrame: 117.4 };
    const rig = new Rig();
    for (const id of ['a', 'c']) {
      rig.addDeck(id, { lookaheadMs: 60 });
      await rig.load(id, 'still-time', { ends: 'playing', ...(id === 'a' ? { grid: GRID } : {}) });
      rig.send({ kind: 'targets', deck: id, frames: [100, 300] });
    }
    await rig.settle();
    rig.send({ kind: 'slip', deck: 'a', on: true });
    rig.advance(300);
    for (const id of ['a', 'c']) rig.send({ kind: 'key', deck: id, target: UNDER });
    await rig.microtasks();
    rig.advance(200);
    rig.send({ kind: 'live-loop-size', deck: 'a', lengthFrames: 60 });
    rig.send({ kind: 'live-loop', deck: 'a' });
    await rig.microtasks();
    rig.advance(300);
    expect(rig.picture('a')).toMatchObject({ liveLoop: { overLoop: true } });

    rig.send({ kind: 'live-loop-end', deck: 'a' });
    await rig.microtasks();
    rig.advance(1300);

    // The deck that ended the live loop carries on exactly where the one that only lapped it is.
    // The loop's length is not whole, so a count started again shows in the frames that follow.
    const ended = rig.landed('live-loop-end')[0].frame;
    const heads = (id: string): Map<number, number> =>
      new Map(rig.ofKind('update', id).map((update) => [update.streamFrame, update.position]));
    const mine = heads('a');
    const theirs = heads('c');
    for (let frame = ended + 1; frame < ended + 60; frame++) {
      expect(mine.get(frame), `frame ${frame}`).toBeDefined();
      expect(mine.get(frame), `frame ${frame}`).toBe(theirs.get(frame));
    }
    expect(rig.picture('a')).toMatchObject({
      liveLoop: null,
      loop: { startFrame: 100, endFrame: 117.4 },
    });
    rig.dispose();
  });
});

describe('what the package does without the engine’s help', () => {
  it('tells a landing by `jump-landed`, and says nothing of a queue that goes without landing', async () => {
    const rig = await playing([500, 1000, 1500]);
    await send(rig, { kind: 'key', deck: 'a', target: LOOP_A });
    rig.advance(100);
    await send(rig, { kind: 'key', deck: 'a', target: LOOP_B });
    expect(rig.picture().queued).toEqual(LOOP_B);
    await send(rig, { kind: 'cancel-queued', deck: 'a' });
    rig.advance(300);
    expect(rig.picture().queued).toBeNull();
    expect(rig.ofKind('jump-landed')).toEqual([]);

    await send(rig, { kind: 'key', deck: 'a', target: CUE });
    rig.advance(600);
    const landed = rig.ofKind('jump-landed');
    expect(landed).toHaveLength(1);
    expect(landed[0]).toMatchObject({ via: 'pass-end', startFrame: 1500 });
    expect(rig.picture().queued).toBeNull();
    rig.dispose();
  });

  it('keeps a queued jump and a pending edit together, and plays the jump at the wrap', async () => {
    const rig = await playing([500, 1000]);
    await send(rig, { kind: 'key', deck: 'a', target: LOOP_A });
    rig.advance(100);
    await send(rig, { kind: 'loop-bounds', deck: 'a', startFrame: 500, endFrame: 510 });
    rig.advance(20);
    await send(rig, { kind: 'key', deck: 'a', target: LOOP_B });
    expect(rig.picture().queued).toEqual(LOOP_B);
    expect(rig.picture().pendingBounds).toEqual({ startFrame: 500, endFrame: 510 });

    rig.advance(600);
    expect(rig.ofKind('jump-landed')).toMatchObject([{ via: 'pass-end', startFrame: 1000 }]);
    expect(rig.picture().loop).toMatchObject({ startFrame: 1000, endFrame: 1010 });
    expect(rig.picture().pendingBounds).toBeNull();
    rig.dispose();
  });

  it('puts back at a queued landing the main mutes that were in play before it', async () => {
    const OWN: JumpTarget = {
      startFrame: 200,
      endFrame: 230,
      settings: [{ setting: 2, value: 1 }],
    };
    const SHARED: JumpTarget = { startFrame: 300, endFrame: 330 };
    const rig = await playing([200, 300], { tune: 'insid3-out' });
    // The main settings mute voice 3; the loop's own mute voice 2 instead.
    await send(rig, { kind: 'setting', deck: 'a', setting: 3, value: 1 });
    await send(rig, { kind: 'key', deck: 'a', target: OWN });
    rig.advance(100);
    await send(rig, { kind: 'key', deck: 'a', target: SHARED });
    rig.advance(600);

    const landing = rig.ofKind('jump-landed').at(-1);
    expect(landing).toMatchObject({ via: 'pass-end', startFrame: 300 });
    const frame = (landing?.frame ?? 0) + 3;
    // Voice 2 sounds again, and voice 3 stays muted: the mutes of the main track, not the loop's.
    expect(wrote(rig, frame, VOICE_2_CONTROL)).toBe(SOUNDING);
    expect(wrote(rig, frame, VOICE_3_CONTROL)).toBeNull();
    expect(rig.picture()).toMatchObject({ settingsInPlay: 'main' });
    expect(rig.picture().settings.main).toEqual([
      { setting: 1, value: 0 },
      { setting: 2, value: 0 },
      { setting: 3, value: 1 },
    ]);
    rig.dispose();
  });
});
