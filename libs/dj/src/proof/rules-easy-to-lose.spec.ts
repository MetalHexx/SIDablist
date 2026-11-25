import { loopStartAtOrBefore } from '@sidablist/analysis';
import { readSidField } from '@sidablist/core';
import type { SidField } from '@sidablist/core';
import { describe, expect, it } from 'vitest';
import type { DeckCommand, Grid, JumpTarget } from '../messages/commands.js';
import { SETTING, SETTING_NUMBERS, describeSetting } from '../messages/setting-table.js';
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
    { kind: 'voice-hold', deck: 'a', voice: 0, held: false },
    { kind: 'tap-end', deck: 'a' },
    // A host's panic is always accepted.
    {
      kind: 'settings',
      deck: 'a',
      settingsIn: 'main',
      changes: [{ setting: SETTING.KEY, value: 1 }],
    },
  ];
  const PRESSES: DeckCommand[] = [
    { kind: 'play', deck: 'a' },
    { kind: 'speed', deck: 'a', value: 1.2 },
    { kind: 'nudge', deck: 'a', amount: 0.05 },
    { kind: 'hot-cue', deck: 'a', target: LOOP_A },
    { kind: 'hand-touch', deck: 'a', atMs: 0 },
    { kind: 'setting', deck: 'a', setting: SETTING.KEY, value: 2 },
    { kind: 'flip-lock', deck: 'a', setting: SETTING.VOICE_1_GATE_HOLD },
    { kind: 'voice-hold', deck: 'a', voice: 0, held: true },
    { kind: 'tap', deck: 'a', atMs: 0 },
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
    await send(rig, { kind: 'hot-cue', deck: 'a', target: LOOP_A });
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
    expect(waiting.settings.main).toEqual([]);
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
    expect(failed.settings.main).toEqual([]);
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
    await send(rig, { kind: 'hot-cue', deck: 'a', target: LOOP_A });
    rig.advance(100);
    await send(rig, { kind: 'hot-cue', deck: 'a', target: CUE });
    rig.advance(600);
    const pressed = rig.landed('hot-cue')[1];

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
    await send(rig, { kind: 'hot-cue', deck: 'a', target: LOOP_A });
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
    for (const id of ['a', 'c']) rig.send({ kind: 'hot-cue', deck: id, target: UNDER });
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
    await send(rig, { kind: 'hot-cue', deck: 'a', target: LOOP_A });
    rig.advance(100);
    await send(rig, { kind: 'hot-cue', deck: 'a', target: LOOP_B });
    expect(rig.picture().queued).toEqual(LOOP_B);
    await send(rig, { kind: 'cancel-queued', deck: 'a' });
    rig.advance(300);
    expect(rig.picture().queued).toBeNull();
    expect(rig.ofKind('jump-landed')).toEqual([]);

    await send(rig, { kind: 'hot-cue', deck: 'a', target: CUE });
    rig.advance(600);
    const landed = rig.ofKind('jump-landed');
    expect(landed).toHaveLength(1);
    expect(landed[0]).toMatchObject({ via: 'pass-end', startFrame: 1500 });
    expect(rig.picture().queued).toBeNull();
    rig.dispose();
  });

  it('keeps a queued jump and a pending edit together, and plays the jump at the wrap', async () => {
    const rig = await playing([500, 1000]);
    await send(rig, { kind: 'hot-cue', deck: 'a', target: LOOP_A });
    rig.advance(100);
    await send(rig, { kind: 'loop-bounds', deck: 'a', startFrame: 500, endFrame: 510 });
    rig.advance(20);
    await send(rig, { kind: 'hot-cue', deck: 'a', target: LOOP_B });
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
    await send(rig, { kind: 'hot-cue', deck: 'a', target: OWN });
    rig.advance(100);
    await send(rig, { kind: 'hot-cue', deck: 'a', target: SHARED });
    rig.advance(600);

    const landing = rig.ofKind('jump-landed').at(-1);
    expect(landing).toMatchObject({ via: 'pass-end', startFrame: 300 });
    const frame = (landing?.frame ?? 0) + 3;
    // Voice 2 sounds again, and voice 3 stays muted: the mutes of the main track, not the loop's.
    expect(wrote(rig, frame, VOICE_2_CONTROL)).toBe(SOUNDING);
    expect(wrote(rig, frame, VOICE_3_CONTROL)).toBeNull();
    expect(rig.picture()).toMatchObject({ settingsInPlay: 'main' });
    const main = rig.picture().settings.main;
    expect(main.find((s) => s.setting === 3)).toEqual({ setting: 3, value: 1 });
    expect(main.find((s) => s.setting === 2)).toBeUndefined();
    rig.dispose();
  });
});

/** A PSID whose play routine is `code`, at $1010, with `table` at $1020 for it to read. */
function psid(code: readonly number[], table: readonly number[] = []): Uint8Array {
  const header = new Uint8Array(0x7c);
  const view = new DataView(header.buffer);
  header.set([0x50, 0x53, 0x49, 0x44]);
  view.setUint16(0x04, 2);
  view.setUint16(0x06, 0x7c);
  view.setUint16(0x08, 0x1000);
  view.setUint16(0x0a, 0x1000);
  view.setUint16(0x0c, 0x1010);
  view.setUint16(0x0e, 1);
  view.setUint16(0x10, 1);
  const payload = new Uint8Array(0x40);
  payload[0] = 0x60;
  payload.set(code, 0x10);
  payload.set(table, 0x20);
  const bytes = new Uint8Array(header.length + payload.length);
  bytes.set(header);
  bytes.set(payload, header.length);
  return bytes;
}

/** Copies the 25 bytes at $1020 to the chip every frame: LDX #24; LDA $1020,X; STA $D400,X; DEX; BPL; RTS. */
const COPY_TABLE = [0xa2, 0x18, 0xbd, 0x20, 0x10, 0x9d, 0x00, 0xd4, 0xca, 0x10, 0xf7, 0x60];
/** Every voice pulse and gated, a low-pass filter at cutoff 256 on all three, full volume; never moves. */
const STEADY = [
  0x45, 0x1d, 0x00, 0x08, 0x41, 0x29, 0xa4, 0x00, 0x20, 0x00, 0x08, 0x41, 0x29, 0xa4, 0x00, 0x30,
  0x00, 0x08, 0x41, 0x29, 0xa4, 0x00, 0x20, 0x47, 0x1f,
];
/** Writes voice 1's gate high from the 30th play call on: INC $FB; LDA $FB; CMP #30; LDA #0; ROL A; STA $D404; RTS. */
const GATE_RISES = [0xe6, 0xfb, 0xa5, 0xfb, 0xc9, 0x1e, 0xa9, 0x00, 0x2a, 0x8d, 0x04, 0xd4, 0x60];
const CONTROL = [4, 11, 18];
const CUTOFF: SidField = { name: 'cutoff' };
const frequency = (voice: number): SidField => ({ name: 'frequency', voice });

/** A deck on the steady tune, loaded with `load` and playing. */
async function shaped(load: Partial<Extract<DeckCommand, { kind: 'load' }>> = {}): Promise<Rig> {
  const rig = new Rig();
  rig.addTune('steady', psid(COPY_TABLE, STEADY));
  rig.addDeck('a');
  await rig.load('a', 'steady', { ends: 'playing', ...load });
  rig.advance(200);
  return rig;
}

/** The chip's registers as the tune wrote them and as they are sent, at the render frontier. */
function chip(rig: Rig): { written: Uint8Array; sent: Uint8Array } {
  rig.send({ kind: 'registers', deck: 'a' });
  const answers = rig.ofKind('registers');
  return answers[answers.length - 1];
}

describe('a load that is overtaken', () => {
  it('leaves nothing of the shaping behind: offsets, holds, pitch, mutes and a voice hold are home', async () => {
    const rig = await shaped({
      settings: [
        { setting: SETTING.CUTOFF_OFFSET, value: 100 },
        { setting: SETTING.VOICE_2_FREQUENCY_HOLD, value: 900 },
        { setting: SETTING.KEY, value: 5 },
        { setting: SETTING.VOICE_3_MUTE, value: 1 },
      ],
    });
    await send(rig, { kind: 'voice-hold', deck: 'a', voice: 0, held: true });
    rig.advance(100);
    const before = chip(rig);
    expect(Array.from(before.sent)).not.toEqual(Array.from(before.written));
    expect(before.sent[CONTROL[0]]).toBe(0);

    rig.addTune('steady-b', psid(COPY_TABLE, STEADY));
    rig.addTune('steady-c', psid(COPY_TABLE, STEADY));
    const slow = rig.holdFetch('steady-b');
    rig.send({ kind: 'load', deck: 'a', tune: 'steady-b', subtune: 1, ends: 'playing' });
    await rig.microtasks();
    // Reset before the first wait: the picture and the engine are home while the fetch is out.
    expect(rig.picture().settings.main).toEqual([]);
    const waiting = chip(rig);
    expect(Array.from(waiting.sent)).toEqual(Array.from(waiting.written));

    rig.send({ kind: 'load', deck: 'a', tune: 'steady-c', subtune: 1, ends: 'playing' });
    await rig.settle();
    slow.release();
    await rig.settle();
    rig.advance(200);

    const now = chip(rig);
    expect(rig.picture().tune?.tune).toBe('steady-c');
    expect(rig.picture().settings.main).toEqual([]);
    expect(Array.from(now.sent)).toEqual(Array.from(now.written));
    expect(now.sent[CONTROL[0]]).toBe(0x41);
    rig.dispose();
  });
});

describe('a voice hold', () => {
  const OWN: JumpTarget = {
    startFrame: 100,
    endFrame: 130,
    settings: [{ setting: SETTING.VOICE_2_MUTE, value: 1 }],
  };

  it('is never carried: it outlives a loop’s own settings and a let-go untouched, and a load releases it', async () => {
    const rig = await shaped({ settings: [{ setting: SETTING.VOICE_3_MUTE, value: 1 }] });
    rig.send({ kind: 'targets', deck: 'a', frames: [100] });
    await rig.settle();
    rig.advance(100);

    await send(rig, { kind: 'voice-hold', deck: 'a', voice: 0, held: true });
    rig.advance(100);
    await send(rig, { kind: 'hot-cue', deck: 'a', target: OWN });
    rig.advance(100);
    // The loop's list swapped the mutes under the hold: voice 2 muted, voice 3 sounding, voice 1 still held.
    let now = chip(rig);
    expect(rig.picture().settingsInPlay).toBe('loop');
    expect(now.sent[CONTROL[0]]).toBe(0);
    expect(now.sent[CONTROL[1]]).toBe(0);
    expect(now.sent[CONTROL[2]]).toBe(0x41);
    expect(rig.picture().settings.loop).toEqual([{ setting: SETTING.VOICE_2_MUTE, value: 1 }]);

    await send(rig, { kind: 'voice-hold', deck: 'a', voice: 0, held: false });
    now = chip(rig);
    expect(now.sent[CONTROL[0]]).toBe(0x41);

    await send(rig, { kind: 'voice-hold', deck: 'a', voice: 0, held: true });
    rig.advance(100);
    await send(rig, { kind: 'let-go', deck: 'a' });
    rig.advance(100);
    now = chip(rig);
    expect(rig.picture().settingsInPlay).toBe('main');
    expect(now.sent[CONTROL[0]]).toBe(0);
    expect(now.sent[CONTROL[1]]).toBe(0x41);
    expect(now.sent[CONTROL[2]]).toBe(0);

    // Let go, the voice sounds as its list says: the hold left no mute in either list.
    await send(rig, { kind: 'voice-hold', deck: 'a', voice: 0, held: false });
    now = chip(rig);
    expect(now.sent[CONTROL[0]]).toBe(0x41);
    expect(rig.picture().settings.main).toEqual([{ setting: SETTING.VOICE_3_MUTE, value: 1 }]);

    await send(rig, { kind: 'voice-hold', deck: 'a', voice: 0, held: true });
    rig.advance(100);
    expect(chip(rig).sent[CONTROL[0]]).toBe(0);
    await rig.load('a', 'steady', { ends: 'playing' });
    rig.advance(200);
    now = chip(rig);
    expect(now.sent[CONTROL[0]]).toBe(0x41);
    expect(rig.picture().settings.main).toEqual([]);
    rig.dispose();
  });
});

describe('a settings list that names the list that has just stopped playing', () => {
  it('is dropped, and not applied to the one that took its place', async () => {
    const OWN: JumpTarget = {
      startFrame: 100,
      endFrame: 130,
      settings: [{ setting: SETTING.VOICE_2_MUTE, value: 1 }],
    };
    const rig = await shaped();
    rig.send({ kind: 'targets', deck: 'a', frames: [100] });
    await rig.settle();
    rig.advance(100);

    // The loop's own list is in play from the frame before the list is sent, as seen by a host a frame behind.
    const updates = rig.ofKind('update');
    const at = updates[updates.length - 1].streamFrame + 1 - (rig.sinks.get('a')?.holding ?? 0) + 2;
    rig.send({ kind: 'hot-cue', deck: 'a', target: OWN, when: { at: 'frame', frame: at } });
    rig.send({
      kind: 'settings',
      deck: 'a',
      settingsIn: 'main',
      changes: [{ setting: SETTING.CUTOFF_OFFSET, value: 100 }],
      when: { at: 'frame', frame: at + 1 },
    });
    await rig.microtasks();
    rig.advance(100);

    const [late] = rig.landed('settings');
    expect(late).toMatchObject({ dropped: true, frame: at + 1 });
    expect(rig.picture()).toMatchObject({
      settingsInPlay: 'loop',
      settings: { main: [], loop: [{ setting: SETTING.VOICE_2_MUTE, value: 1 }] },
    });
    const now = chip(rig);
    expect(readSidField(now.sent, CUTOFF)).toBe(readSidField(now.written, CUTOFF));
    rig.dispose();
  });
});

describe('a lock flip', () => {
  /** A deck on the tune whose gate rises in a known play call, paused with a flip waiting at stream frame `at`. */
  async function flippedAt(at: number): Promise<Rig> {
    const rig = new Rig();
    rig.addTune('rises', psid(GATE_RISES));
    rig.addDeck('a');
    await rig.load('a', 'rises', { ends: 'paused' });
    rig.send({
      kind: 'flip-lock',
      deck: 'a',
      setting: SETTING.VOICE_1_GATE_HOLD,
      when: { at: 'frame', frame: at },
    });
    await rig.microtasks();
    rig.send({ kind: 'play', deck: 'a' });
    await rig.settle();
    rig.advance(1500);
    return rig;
  }

  const gate = (rig: Rig, frame: number): number => (wrote(rig, frame, 4) ?? -1) & 1;

  it('reads the tune as it stands on its landing frame: the frame before it, not the last one a host saw', async () => {
    const probe = new Rig();
    probe.addTune('rises', psid(GATE_RISES));
    probe.addDeck('a');
    await probe.load('a', 'rises', { ends: 'playing' });
    probe.advance(1500);
    const rise = probe
      .frames()
      .findIndex((frame) => (frame.values[frame.registers.indexOf(4)] & 1) === 1);
    probe.dispose();
    expect(rise).toBeGreaterThan(2);

    // The tune writes the new gate in frame `rise`. A flip landing on the next frame locks to the opposite of it.
    const after = await flippedAt(rise + 1);
    expect(after.landed('flip-lock')[0].frame).toBe(rise + 1);
    expect(after.picture().settings.main).toEqual([
      { setting: SETTING.VOICE_1_GATE_HOLD, value: 0 },
    ]);
    expect(gate(after, rise)).toBe(1);
    expect(gate(after, rise + 1)).toBe(0);
    after.dispose();

    // Landing on `rise` itself, it reads the frame before, which still wrote the old gate.
    const on = await flippedAt(rise);
    expect(on.picture().settings.main).toEqual([{ setting: SETTING.VOICE_1_GATE_HOLD, value: 1 }]);
    expect(gate(on, rise - 1)).toBe(0);
    expect(gate(on, rise)).toBe(1);
    on.dispose();
  });
});

describe('a panic', () => {
  it('is one settings list at home: the panel goes home on one frame, and mutes and speed stay', async () => {
    const rig = await shaped({
      speed: 1.3,
      settings: [
        { setting: SETTING.VOICE_2_MUTE, value: 1 },
        { setting: SETTING.KEY, value: 5 },
        { setting: SETTING.CUTOFF_OFFSET, value: 100 },
        { setting: SETTING.VOICE_1_WAVEFORM_HOLD, value: 2 },
        { setting: SETTING.VOICE_3_COARSE, value: -7 },
        { setting: SETTING.VOICE_2_FINE, value: 40 },
      ],
    });
    const shapedChip = chip(rig);
    expect(readSidField(shapedChip.sent, frequency(0))).not.toBe(
      readSidField(shapedChip.written, frequency(0)),
    );

    // What panic puts back is the host's list: every setting but the mutes, at its home.
    const changes = SETTING_NUMBERS.flatMap((setting) => {
      const info = describeSetting(setting);
      return info === null || info.kind === 'mute' ? [] : [{ setting, value: info.home }];
    });
    await send(rig, { kind: 'settings', deck: 'a', settingsIn: 'main', changes });
    rig.advance(100);

    const [panic] = rig.landed('settings');
    expect(panic.settingsIn).toBe('main');
    const now = chip(rig);
    const homeSent = Array.from(now.written);
    homeSent[CONTROL[1]] = 0;
    expect(Array.from(now.sent)).toEqual(homeSent);
    expect(rig.picture().settings.main).toEqual([{ setting: SETTING.VOICE_2_MUTE, value: 1 }]);
    expect(rig.picture().tempo.speed).toBe(1.3);
    // One frame: everything but the mutes is home from the landing frame on, and was shaped the frame before.
    for (const register of [0, 1, 22]) {
      expect(wrote(rig, panic.frame, register)).toBe(STEADY[register]);
      expect(wrote(rig, panic.frame - 1, register)).not.toBe(STEADY[register]);
    }
    rig.dispose();
  });
});
