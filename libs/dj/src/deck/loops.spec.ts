import { describe, expect, it } from 'vitest';
import type { JumpTarget } from '../messages/commands.js';
import type { DeckEvent } from '../messages/reports.js';
import { Rig } from '../testing/harness.js';

/** Spec-only. Loops and cues on Still Time, whose delivered frame number is the playhead. */
const LOOP_A: JumpTarget = { startFrame: 500, endFrame: 520 };
const LOOP_B: JumpTarget = { startFrame: 1000, endFrame: 1010 };
const CUE: JumpTarget = { startFrame: 1500, endFrame: null };

const MUTE_VOICE_2 = [{ setting: 2, value: 1 }];
/** Voice 2's control register: the tune writes it every frame, and a muted voice writes none. */
const VOICE_2_CONTROL = 11;

type JumpLanded = Extract<DeckEvent, { kind: 'jump-landed' }>;

/** The stream frame of the next frame the rig's sink has not passed. */
function unsentOf(rig: Rig): number {
  const updates = rig.ofKind('update');
  return updates[updates.length - 1].streamFrame + 1 - (rig.sinks.get('a')?.holding ?? 0);
}

/** A playing deck on `tune` with `targets` declared and ready. */
async function playing(targets: readonly number[], tune = 'still-time'): Promise<Rig> {
  const rig = new Rig();
  rig.addDeck('a', { lookaheadMs: 60 });
  await rig.load('a', tune, { ends: 'playing' });
  rig.send({ kind: 'targets', deck: 'a', frames: [...targets] });
  await rig.settle();
  rig.advance(100);
  expect(rig.picture().readyFrames).toEqual(expect.arrayContaining([...targets]));
  return rig;
}

/**
 * Sends a command and lets the flush it scheduled run. A command sent after another one in the
 * same frame waits for the next wake instead (a rewind already ran since the sink last passed a
 * frame): `rig.advance(20)` between presses lets one through.
 */
async function send(rig: Rig, command: Parameters<Rig['send']>[0]): Promise<void> {
  rig.send(command);
  await rig.microtasks();
}

const key = (rig: Rig, target: JumpTarget): Promise<void> =>
  send(rig, { kind: 'hot-cue', deck: 'a', target });

/** The playhead of each delivered frame, from stream frame `from` up to `to`. */
function playhead(rig: Rig, from: number, to: number): number[] {
  return rig
    .frames()
    .slice(from, to)
    .map((frame) => frame.frameNumber);
}

/**
 * The value a delivered frame wrote to `register`, or null when it wrote none. A voice the deck
 * mutes has its control register zeroed once, as a jump lands, and written no more.
 */
function wrote(rig: Rig, frame: number, register: number): number | null {
  const delivered = rig.frames()[frame];
  const at = delivered.registers.indexOf(register);
  return at < 0 ? null : delivered.values[at];
}

function lastJumpLanded(rig: Rig): JumpLanded {
  const landed = rig.ofKind('jump-landed');
  return landed[landed.length - 1];
}

describe('a hot cue press', () => {
  it('resolves from the deck at its landing frame: start, queue, cancel and let go', async () => {
    const rig = await playing([500, 1500]);

    await key(rig, LOOP_A);
    rig.advance(100);
    expect(rig.landed('hot-cue')[0]).toMatchObject({ resolved: 'start' });
    expect(rig.picture().loop).toMatchObject({ startFrame: 500, endFrame: 520 });

    await key(rig, CUE);
    rig.advance(20);
    expect(rig.landed('hot-cue')[1]).toMatchObject({ resolved: 'queue' });
    expect(rig.picture().queued).toEqual(CUE);

    await key(rig, CUE);
    rig.advance(20);
    expect(rig.landed('hot-cue')[2]).toMatchObject({ resolved: 'cancel' });
    expect(rig.picture().queued).toBeNull();
    expect(rig.picture().loop).not.toBeNull();

    await key(rig, LOOP_A);
    rig.advance(20);
    expect(rig.landed('hot-cue')[3]).toMatchObject({ resolved: 'let-go' });
    expect(rig.picture().loop).toBeNull();
    expect(rig.warnings).toEqual([]);
    rig.dispose();
  });

  it('is fixed to the frame it landed on, whatever it resolved to, so it replays', async () => {
    const rig = await playing([500, 1500]);
    await key(rig, LOOP_A);
    rig.advance(100);
    await key(rig, CUE);
    rig.advance(20);

    for (const landed of rig.landed('hot-cue')) {
      expect(landed.fixed).toEqual({ at: 'frame', frame: landed.frame });
    }
    rig.dispose();
  });

  it('starts a deck that is stopped, and lands the loop on the first frame it plays', async () => {
    const rig = new Rig();
    rig.addDeck('a', { lookaheadMs: 60 });
    await rig.load('a', 'still-time', { ends: 'stopped' });
    rig.send({ kind: 'targets', deck: 'a', frames: [500] });
    await rig.settle();
    expect(rig.picture().transport).toBe('stopped');

    rig.send({ kind: 'hot-cue', deck: 'a', target: LOOP_A });
    await rig.settle();
    rig.advance(200);

    expect(rig.picture().transport).toBe('playing');
    expect(rig.landed('hot-cue')[0]).toMatchObject({ resolved: 'start' });
    expect(playhead(rig, 0, 1)[0]).toBe(500);
    expect(Math.max(...playhead(rig, 0, 10))).toBeLessThan(520);
    expect(rig.picture().loop).toMatchObject({ startFrame: 500, endFrame: 520 });
    rig.dispose();
  });

  it('queues a cue pressed in a loop for the end of the pass, and plays on from the cue', async () => {
    const rig = await playing([500, 1500]);
    await key(rig, LOOP_A);
    rig.advance(100);
    const pressed = rig.landed('hot-cue')[0].frame;
    await key(rig, CUE);
    rig.advance(20);
    expect(rig.landed('hot-cue')[1]).toMatchObject({ resolved: 'queue' });
    expect(rig.ofKind('jump-landed')).toEqual([]);

    rig.advance(600);
    const landing = lastJumpLanded(rig);
    expect(landing).toMatchObject({ via: 'pass-end', startFrame: 1500, endFrame: null });
    // Every frame up to the landing stayed inside the loop, and the first from it is the cue.
    const before = playhead(rig, pressed + 1, landing.frame);
    expect(Math.min(...before)).toBeGreaterThanOrEqual(500);
    expect(Math.max(...before)).toBeLessThan(520);
    expect(playhead(rig, landing.frame, landing.frame + 4)).toEqual([1500, 1500, 1501, 1502]);
    expect(rig.picture().loop).toBeNull();
    expect(rig.picture().queued).toBeNull();
    rig.dispose();
  });
});

describe('a queued target', () => {
  it('lands only at a wrap whose image is ready, and the laps go on until then', async () => {
    const rig = await playing([500]);
    await key(rig, LOOP_A);
    rig.advance(100);

    // The cue is declared and queued in one turn. One microtask runs the flush that queues it, and
    // the image it asks for is not built until the turns after: time passes first, laps and all.
    rig.send({ kind: 'targets', deck: 'a', frames: [500, 2500] });
    rig.send({ kind: 'hot-cue', deck: 'a', target: { startFrame: 2500, endFrame: null } });
    await Promise.resolve();
    expect(rig.picture().queued).toMatchObject({ startFrame: 2500 });
    expect(rig.picture().readyFrames).not.toContain(2500);
    rig.advance(300);
    expect(rig.picture().queued).toMatchObject({ startFrame: 2500 });
    expect(rig.ofKind('jump-landed')).toEqual([]);

    await rig.settle();
    expect(rig.picture().readyFrames).toContain(2500);
    rig.advance(500);
    const landing = lastJumpLanded(rig);
    const pressed = rig.landed('hot-cue')[1].frame;
    expect(landing).toMatchObject({ via: 'pass-end', startFrame: 2500 });
    expect(landing.frame).toBeGreaterThan(pressed + 20);
    // At a wrap, not when the image arrived: the frame before is the last one a lap plays.
    expect(rig.frames()[landing.frame - 1].frameNumber).toBe(518);
    expect(playhead(rig, pressed, landing.frame).every((at) => at >= 500 && at < 520)).toBe(true);
    rig.dispose();
  });

  it('is started on a deck that is paused, which plays first', async () => {
    const rig = await playing([500, 1500]);
    await key(rig, LOOP_A);
    rig.advance(100);
    await send(rig, { kind: 'pause', deck: 'a' });
    rig.advance(100);
    expect(rig.picture().transport).toBe('paused');

    rig.send({ kind: 'hot-cue', deck: 'a', target: CUE });
    await rig.settle();
    rig.advance(400);

    expect(rig.landed('hot-cue')[1]).toMatchObject({ resolved: 'queue' });
    expect(rig.picture().transport).toBe('playing');
    expect(lastJumpLanded(rig)).toMatchObject({ via: 'pass-end', startFrame: 1500 });
    rig.dispose();
  });

  it('is refused on a deck that is not ready for a press, like any press', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    rig.send({ kind: 'jump', deck: 'a', target: LOOP_A });
    rig.send({ kind: 'hot-cue', deck: 'a', target: LOOP_A });
    await rig.microtasks();

    expect(rig.warnings).toEqual([
      'dj: refused jump: jump on a deck that is empty',
      'dj: refused hot-cue: hot-cue on a deck that is empty',
    ]);
    expect(rig.landed()).toEqual([]);
    rig.dispose();
  });
});

describe('a jump', () => {
  it('lands now on the frame it lands on, replacing the loop that ran', async () => {
    const rig = await playing([500, 1000]);
    await key(rig, LOOP_A);
    rig.advance(100);

    await send(rig, { kind: 'jump', deck: 'a', target: LOOP_B });
    rig.advance(200);

    const landed = rig.landed('jump')[0];
    expect(playhead(rig, landed.frame - 1, landed.frame + 1)[1]).toBe(1000);
    expect(playhead(rig, landed.frame - 1, landed.frame)[0]).toBeLessThan(520);
    expect(rig.picture().loop).toMatchObject({ startFrame: 1000, endFrame: 1010 });
    const after = playhead(rig, landed.frame + 2, landed.frame + 40);
    expect(Math.min(...after)).toBeGreaterThanOrEqual(1000);
    expect(Math.max(...after)).toBeLessThan(1010);
    expect(rig.ofKind('jump-landed')).toEqual([]);
    rig.dispose();
  });

  it('queues at the end of the pass when sent for it, and reports where it queued', async () => {
    const rig = await playing([500, 1000]);
    await key(rig, LOOP_A);
    rig.advance(100);
    const from = unsentOf(rig);

    await send(rig, { kind: 'jump', deck: 'a', target: LOOP_B, when: { at: 'pass-end' } });
    rig.advance(20);
    const queued = rig.landed('jump')[0];
    expect(queued.fixed).toEqual({ at: 'pass-end', from });
    expect(queued.frame).toBe(from);
    expect(rig.picture().queued).toEqual(LOOP_B);

    rig.advance(600);
    const landing = lastJumpLanded(rig);
    expect(landing).toMatchObject({ via: 'pass-end', startFrame: 1000, endFrame: 1010 });
    expect(landing.frame).toBeGreaterThan(queued.frame);
    expect(playhead(rig, landing.frame, landing.frame + 1)).toEqual([1000]);
    rig.dispose();
  });

  it('lands now when sent for the end of the pass with nothing looping', async () => {
    const rig = await playing([1000]);
    const from = unsentOf(rig);

    await send(rig, { kind: 'jump', deck: 'a', target: LOOP_B, when: { at: 'pass-end' } });
    rig.advance(200);

    const landed = rig.landed('jump')[0];
    expect(landed.frame).toBe(from);
    expect(landed.fixed).toEqual({ at: 'pass-end', from });
    expect(rig.picture().loop).toMatchObject({ startFrame: 1000, endFrame: 1010 });
    expect(rig.picture().queued).toBeNull();
    rig.dispose();
  });

  it('restarts the running loop from its start as a stab, and keeps the target queued behind it', async () => {
    const rig = await playing([500, 1500]);
    await key(rig, LOOP_A);
    rig.advance(100);
    await key(rig, CUE);
    rig.advance(100);
    expect(rig.picture().queued).toEqual(CUE);

    await send(rig, { kind: 'jump', deck: 'a', target: LOOP_A });
    rig.advance(20);

    const stab = rig.landed('jump')[0];
    rig.advance(40);
    expect(playhead(rig, stab.frame, stab.frame + 3)).toEqual([500, 500, 501]);
    expect(rig.picture().queued).toEqual(CUE);

    rig.advance(600);
    const landing = lastJumpLanded(rig);
    expect(landing).toMatchObject({ via: 'pass-end', startFrame: 1500 });
    // The stab restarted the lap: the pass the cue lands at ends a whole loop after it.
    expect(landing.frame - stab.frame).toBe(20);
    expect(rig.warnings).toEqual([]);
    rig.dispose();
  });

  async function jumpToUndeclared(rewind: boolean): Promise<{ rig: Rig; jumpFrame: number }> {
    const rig = new Rig();
    rig.addDeck('a', { lookaheadMs: 60 });
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(300);
    await send(rig, { kind: 'jump', deck: 'a', target: { startFrame: 2000, endFrame: null } });
    const jumpFrame = unsentOf(rig);
    for (let i = 0; i < 2; i++) {
      rig.time.ms += 20;
      rig.wake.fire();
    }
    if (rewind) {
      rig.send({ kind: 'speed', deck: 'a', value: 1.1 });
      rig.wake.fire();
    }
    rig.advance(600);
    return { rig, jumpFrame };
  }

  it('waits until its target is ready and lands on the frame after the tick that sees it ready', async () => {
    const { rig, jumpFrame } = await jumpToUndeclared(false);

    const [landing] = rig.ofKind('jump-landed');
    expect(rig.ofKind('jump-landed')).toHaveLength(1);
    expect(landing).toMatchObject({ via: 'ready', startFrame: 2000, endFrame: null });
    expect(rig.landed('jump')[0].frame).toBe(jumpFrame);
    expect(landing.frame).toBeGreaterThan(jumpFrame);
    expect(rig.frames()[landing.frame - 1].frameNumber).toBeLessThan(2000);
    expect(rig.frames()[landing.frame].frameNumber).toBe(2000);
    expect(rig.picture().waiting).toBeNull();
    rig.dispose();
  });

  it('lands on the same frame again after a rewind across it, and says so once', async () => {
    const straight = await jumpToUndeclared(false);
    const rewound = await jumpToUndeclared(true);

    expect(rewound.rig.picture().timing.rewinds).toBeGreaterThan(0);
    const landed = rewound.rig.ofKind('jump-landed');
    expect(landed).toHaveLength(1);
    expect(landed[0].frame).toBe(straight.rig.ofKind('jump-landed')[0].frame);
    expect(rewound.rig.frames()[landed[0].frame].frameNumber).toBe(2000);
    expect(rewound.rig.landed('speed')[0].frame).toBe(rewound.jumpFrame);
    straight.rig.dispose();
    rewound.rig.dispose();
  });

  it('keeps the running loop while a target waits, and replaces it when the target lands', async () => {
    const rig = await playing([500]);
    await key(rig, LOOP_A);
    rig.advance(100);

    await send(rig, { kind: 'jump', deck: 'a', target: { startFrame: 3000, endFrame: 3010 } });
    expect(rig.picture().waiting).toMatchObject({ startFrame: 3000, endFrame: 3010 });
    expect(rig.picture().loop).toMatchObject({ startFrame: 500 });
    rig.advance(400);

    const landing = lastJumpLanded(rig);
    expect(landing).toMatchObject({ via: 'ready', startFrame: 3000, endFrame: 3010 });
    expect(rig.picture().loop).toMatchObject({ startFrame: 3000, endFrame: 3010 });
    expect(rig.picture().waiting).toBeNull();
    // The loop ran until the target landed.
    expect(playhead(rig, landing.frame - 20, landing.frame).every((at) => at < 520)).toBe(true);
    rig.dispose();
  });

  it('ignores a jump whose image was withdrawn when a rewind lands it again', async () => {
    const rig = await playing([500]);
    rig.send({ kind: 'jump', deck: 'a', target: LOOP_A });
    rig.send({ kind: 'targets', deck: 'a', frames: [] });
    await rig.microtasks();
    expect(rig.warnings).toEqual([]);

    // A press on the same frame is flushed before the sink passes it: the jump lands again.
    rig.send({ kind: 'nudge', deck: 'a', amount: 0 });
    rig.wake.fire();
    expect(rig.picture().timing.rewinds).toBeGreaterThan(0);
    expect(rig.warnings).toEqual(['dj: deck a: ignored a jump to 500: its image is not held']);
    rig.dispose();
  });

  it('refuses a loop too short to run, and leaves the deck as it was', async () => {
    const rig = await playing([500]);
    rig.warnings.length = 0;

    await send(rig, { kind: 'jump', deck: 'a', target: { startFrame: 500, endFrame: 501.5 } });
    rig.advance(100);

    expect(rig.warnings.length).toBe(1);
    expect(rig.warnings[0]).toContain('too short');
    expect(rig.picture().loop).toBeNull();
    rig.dispose();
  });
});

describe('leaving a loop', () => {
  it('lets go of the loop and the queue behind it, and plays on past the end', async () => {
    const rig = await playing([500, 1500]);
    await key(rig, LOOP_A);
    rig.advance(100);
    await key(rig, CUE);
    rig.advance(20);
    expect(rig.picture().queued).toEqual(CUE);

    await send(rig, { kind: 'let-go', deck: 'a' });
    rig.advance(600);

    const letGo = rig.landed('let-go')[0];
    expect(rig.picture().loop).toBeNull();
    expect(rig.picture().queued).toBeNull();
    expect(rig.ofKind('jump-landed')).toEqual([]);
    const after = playhead(rig, letGo.frame, letGo.frame + 60);
    expect(Math.max(...after)).toBeGreaterThan(520);
    expect(Math.max(...after)).toBeLessThan(1500);
    rig.dispose();
  });

  it('keeps a waiting target through a let-go, which still lands when ready', async () => {
    const rig = await playing([500]);
    await key(rig, LOOP_A);
    rig.advance(100);
    rig.send({ kind: 'jump', deck: 'a', target: { startFrame: 3000, endFrame: null } });
    rig.send({ kind: 'let-go', deck: 'a' });
    await rig.microtasks();
    expect(rig.picture().loop).toBeNull();
    expect(rig.picture().waiting).not.toBeNull();

    rig.advance(400);
    expect(lastJumpLanded(rig)).toMatchObject({ via: 'ready', startFrame: 3000 });
    rig.dispose();
  });

  it('cancels the queued and the waiting target, and does nothing with neither', async () => {
    const rig = await playing([500, 1500]);
    await key(rig, LOOP_A);
    rig.advance(100);
    // A target that waits for its image, and a cue queued behind the loop: one turn, one flush.
    rig.send({ kind: 'jump', deck: 'a', target: { startFrame: 3000, endFrame: null } });
    rig.send({ kind: 'hot-cue', deck: 'a', target: CUE });
    await rig.microtasks();
    expect(rig.picture().queued).toEqual(CUE);
    expect(rig.picture().waiting).not.toBeNull();

    rig.advance(20);
    await send(rig, { kind: 'cancel-queued', deck: 'a' });
    expect(rig.picture().queued).toBeNull();
    expect(rig.picture().waiting).toBeNull();
    await send(rig, { kind: 'cancel-queued', deck: 'a' });
    rig.advance(600);

    expect(rig.ofKind('jump-landed')).toEqual([]);
    expect(rig.picture().loop).toMatchObject({ startFrame: 500 });
    expect(rig.warnings).toEqual([]);
    rig.dispose();
  });

  it('cancels a waiting target with a hot cue on it', async () => {
    const rig = await playing([500]);
    await key(rig, LOOP_A);
    rig.advance(100);
    const waiting = { startFrame: 3000, endFrame: null };
    await send(rig, { kind: 'jump', deck: 'a', target: waiting });

    await key(rig, waiting);
    rig.advance(400);

    expect(rig.landed('hot-cue')[1]).toMatchObject({ resolved: 'cancel' });
    expect(rig.picture().waiting).toBeNull();
    expect(rig.ofKind('jump-landed')).toEqual([]);
    rig.dispose();
  });

  it('stops everything looping, and the playhead does not move', async () => {
    const rig = await playing([500, 1500]);
    await key(rig, LOOP_A);
    rig.advance(100);
    rig.send({ kind: 'jump', deck: 'a', target: { startFrame: 3000, endFrame: null } });
    rig.send({ kind: 'hot-cue', deck: 'a', target: CUE });
    rig.send({ kind: 'stop-loop', deck: 'a' });
    await rig.microtasks();
    rig.advance(600);

    const stopped = rig.landed('stop-loop')[0];
    expect(rig.picture()).toMatchObject({ loop: null, queued: null, waiting: null });
    const after = playhead(rig, stopped.frame, stopped.frame + 60);
    expect(after.map((at, i) => at - after[0] - i)).toEqual(after.map(() => 0));
    expect(Math.max(...after)).toBeGreaterThan(520);
    expect(rig.ofKind('jump-landed')).toEqual([]);
    rig.dispose();
  });
});

describe('editing a running loop', () => {
  it('waits for the end of the pass, then plays the new bounds', async () => {
    const rig = await playing([500]);
    await key(rig, LOOP_A);
    rig.advance(100);

    await send(rig, { kind: 'loop-bounds', deck: 'a', startFrame: 500, endFrame: 510 });
    expect(rig.picture().pendingBounds).toEqual({ startFrame: 500, endFrame: 510 });
    expect(rig.picture().loop).toMatchObject({ startFrame: 500, endFrame: 520 });
    rig.advance(40);
    const edit = rig.landed('loop-bounds')[0];
    // It stays pending through the rest of the lap, the old bounds still playing.
    expect(Math.max(...playhead(rig, edit.frame, edit.frame + 2))).toBeLessThan(520);

    rig.advance(600);
    expect(rig.picture().pendingBounds).toBeNull();
    expect(rig.picture().loop).toMatchObject({ startFrame: 500, endFrame: 510 });
    const late = playhead(rig, rig.frames().length - 60, rig.frames().length);
    expect(Math.max(...late)).toBeLessThan(510);
    expect(rig.warnings).toEqual([]);
    rig.dispose();
  });

  it('lets the loop go at once when it has no end', async () => {
    const rig = await playing([500]);
    await key(rig, LOOP_A);
    rig.advance(100);

    await send(rig, { kind: 'loop-bounds', deck: 'a', startFrame: 500, endFrame: null });
    rig.advance(600);

    const edit = rig.landed('loop-bounds')[0];
    expect(rig.picture().loop).toBeNull();
    expect(rig.picture().pendingBounds).toBeNull();
    expect(Math.max(...playhead(rig, edit.frame, edit.frame + 60))).toBeGreaterThan(520);
    rig.dispose();
  });

  it('cancels a change still pending when bounds equal to those playing are named', async () => {
    const rig = await playing([500]);
    await key(rig, LOOP_A);
    rig.advance(100);
    await send(rig, { kind: 'loop-bounds', deck: 'a', startFrame: 500, endFrame: 510 });
    expect(rig.picture().pendingBounds).not.toBeNull();

    rig.advance(20);
    await send(rig, { kind: 'loop-bounds', deck: 'a', startFrame: 500, endFrame: 520 });
    rig.advance(600);

    expect(rig.picture().pendingBounds).toBeNull();
    expect(rig.picture().loop).toMatchObject({ startFrame: 500, endFrame: 520 });
    rig.dispose();
  });

  it('does nothing when no loop runs', async () => {
    const rig = await playing([500]);

    await send(rig, { kind: 'loop-bounds', deck: 'a', startFrame: 500, endFrame: 510 });
    rig.advance(100);

    expect(rig.landed('loop-bounds')).toHaveLength(1);
    expect(rig.picture()).toMatchObject({ loop: null, pendingBounds: null });
    expect(rig.warnings).toEqual([]);
    rig.dispose();
  });

  it('keeps its loop and reports no pending bounds when the engine takes no change', async () => {
    const rig = await playing([500]);
    await key(rig, LOOP_A);
    rig.advance(100);
    rig.warnings.length = 0;

    // The engine holds no image for the new start.
    await send(rig, { kind: 'loop-bounds', deck: 'a', startFrame: 777, endFrame: 790 });
    rig.advance(300);

    expect(rig.picture().pendingBounds).toBeNull();
    expect(rig.picture().loop).toMatchObject({ startFrame: 500, endFrame: 520 });
    expect(rig.warnings).toEqual([
      'dj: deck a: kept its loop: the engine took no change to 777-790',
    ]);
    rig.dispose();
  });

  it('is dropped by a queued jump landing at the same wrap, which plays instead', async () => {
    const rig = await playing([500, 1000]);
    await key(rig, LOOP_A);
    rig.advance(100);
    await send(rig, { kind: 'loop-bounds', deck: 'a', startFrame: 500, endFrame: 510 });
    rig.advance(20);
    await key(rig, LOOP_B);
    expect(rig.picture().pendingBounds).not.toBeNull();
    expect(rig.picture().queued).toEqual(LOOP_B);

    rig.advance(600);

    expect(lastJumpLanded(rig)).toMatchObject({ via: 'pass-end', startFrame: 1000 });
    expect(rig.picture().pendingBounds).toBeNull();
    expect(rig.picture().loop).toMatchObject({ startFrame: 1000, endFrame: 1010 });
    expect(rig.picture().queued).toBeNull();
    rig.dispose();
  });

  it('names the queue and the change again after a change of wrap', async () => {
    const rig = await playing([500, 1500]);
    await key(rig, LOOP_A);
    rig.advance(100);
    await key(rig, CUE);
    rig.advance(20);
    await send(rig, { kind: 'loop-bounds', deck: 'a', startFrame: 500, endFrame: 510 });
    expect(rig.picture().loop?.wraps).toBe(false);

    rig.advance(20);
    await send(rig, { kind: 'loop-wraps', deck: 'a', wraps: true });
    expect(rig.picture().loop?.wraps).toBe(true);
    expect(rig.picture().queued).toEqual(CUE);
    expect(rig.picture().pendingBounds).toEqual({ startFrame: 500, endFrame: 510 });

    rig.advance(600);
    expect(lastJumpLanded(rig)).toMatchObject({ via: 'pass-end', startFrame: 1500 });
    expect(rig.picture().pendingBounds).toBeNull();
    expect(rig.warnings).toEqual([]);
    rig.dispose();
  });

  it('keeps the lap in progress when the wrap changes', async () => {
    const run = async (changeWrap: boolean): Promise<Rig> => {
      const rig = await playing([500]);
      await key(rig, LOOP_A);
      rig.advance(100);
      if (changeWrap) await send(rig, { kind: 'loop-wraps', deck: 'a', wraps: true });
      rig.advance(400);
      return rig;
    };
    const changed = await run(true);
    const untouched = await run(false);

    expect(changed.picture().loop).toMatchObject({ startFrame: 500, endFrame: 520, wraps: true });
    // The wrap is varispeed's to read: live play wraps on the frames it did without the change.
    const length = untouched.frames().length;
    expect(playhead(changed, 0, length)).toEqual(playhead(untouched, 0, length));
    changed.dispose();
    untouched.dispose();
  });
});

describe('capturing the playhead', () => {
  it('reports the frame it captured, which the host can then declare and jump to at once', async () => {
    const rig = await playing([500]);
    rig.advance(100);

    await send(rig, { kind: 'capture', deck: 'a' });
    rig.advance(20);
    const [captured] = rig.ofKind('captured');
    expect(captured.frame).toBe(rig.landed('capture')[0].frame);
    expect(Number.isInteger(captured.position)).toBe(true);
    expect(rig.frames()[captured.frame].frameNumber).toBe(captured.position);

    rig.send({ kind: 'targets', deck: 'a', frames: [500, captured.position] });
    await rig.microtasks();
    rig.advance(20);
    expect(rig.picture().readyFrames).toContain(captured.position);
    rig.dispose();
  });
});

describe('a loop with settings of its own', () => {
  const OWN: JumpTarget = { startFrame: 200, endFrame: 230, settings: MUTE_VOICE_2 };
  const SHARED: JumpTarget = { startFrame: 300, endFrame: 330 };

  /** Voice 2's control register on a frame: sounding writes it 65 every frame. */
  const control = (rig: Rig, frame: number): number | null => wrote(rig, frame, VOICE_2_CONTROL);
  const SOUNDING = 65;

  /** Where the voice is muted from: the landing zeroes its control register, and no write follows. */
  function expectMutedFrom(rig: Rig, landing: number): void {
    expect(control(rig, landing - 1)).toBe(SOUNDING);
    expect(control(rig, landing + 1)).toBe(0);
    expect(control(rig, landing + 3)).toBeNull();
    expect(control(rig, landing + 12)).toBeNull();
  }

  it('sounds its mutes from its landing frame and brings the main ones back on its let-go frame', async () => {
    const rig = await playing([200, 300], 'insid3-out');
    expect(control(rig, rig.frames().length - 2)).toBe(SOUNDING);

    await key(rig, OWN);
    rig.advance(400);
    expectMutedFrom(rig, rig.landed('hot-cue')[0].frame);
    expect(rig.picture().settingsInPlay).toBe('loop');
    expect(rig.picture().settings.loop?.find((s) => s.setting === 2)).toEqual({
      setting: 2,
      value: 1,
    });
    expect(rig.picture().settings.loop?.find((s) => s.setting === 1)).toBeUndefined();
    expect(rig.picture().settings.main).toEqual([]);

    await send(rig, { kind: 'let-go', deck: 'a' });
    rig.advance(200);
    const letGo = rig.landed('let-go')[0].frame;
    expect(control(rig, letGo - 1)).toBeNull();
    expect(control(rig, letGo)).toBe(SOUNDING);
    expect(rig.picture().settingsInPlay).toBe('main');
    expect(rig.picture().settings.loop).toBeNull();
    rig.dispose();
  });

  it('changes its own settings while they play, and leaves the main ones aside', async () => {
    const rig = await playing([200], 'insid3-out');
    await key(rig, OWN);
    rig.advance(100);

    await send(rig, { kind: 'setting', deck: 'a', setting: 1, value: 1 });
    rig.advance(100);

    expect(rig.landed('setting')[0].settingsIn).toBe('loop');
    expect(rig.picture().settings.loop?.find((s) => s.setting === 1)).toEqual({
      setting: 1,
      value: 1,
    });
    expect(rig.picture().settings.main).toEqual([]);

    await send(rig, { kind: 'stop-loop', deck: 'a' });
    rig.advance(20);
    await send(rig, { kind: 'setting', deck: 'a', setting: 3, value: 1 });
    rig.advance(100);
    expect(rig.landed('setting')[1].settingsIn).toBe('main');
    expect(rig.picture().settings.main.find((s) => s.setting === 3)).toEqual({
      setting: 3,
      value: 1,
    });
    rig.dispose();
  });

  it('carries the main settings into a target that has none of its own, on the jump frame', async () => {
    const rig = await playing([200, 300], 'insid3-out');
    await key(rig, OWN);
    rig.advance(200);
    expect(control(rig, rig.frames().length - 2)).toBeNull();

    await send(rig, { kind: 'jump', deck: 'a', target: SHARED });
    rig.advance(100);

    const jumped = rig.landed('jump')[0].frame;
    expect(control(rig, jumped - 1)).toBeNull();
    expect(control(rig, jumped + 1)).toBe(SOUNDING);
    expect(control(rig, jumped + 8)).toBe(SOUNDING);
    expect(rig.picture().settingsInPlay).toBe('main');
    rig.dispose();
  });

  it('carries the main settings into a shared target queued behind it, landing at the wrap', async () => {
    const rig = await playing([200, 300], 'insid3-out');
    await key(rig, OWN);
    rig.advance(100);
    await key(rig, SHARED);
    rig.advance(20);
    expect(rig.landed('hot-cue')[1]).toMatchObject({ resolved: 'queue' });
    expect(rig.picture().settingsInPlay).toBe('loop');

    rig.advance(600);
    const landing = lastJumpLanded(rig);
    expect(landing).toMatchObject({ via: 'pass-end', startFrame: 300 });
    expect(control(rig, landing.frame - 1)).toBeNull();
    expect(control(rig, landing.frame + 1)).toBe(SOUNDING);
    expect(rig.picture().settingsInPlay).toBe('main');
    rig.dispose();
  });

  it('plays its own settings from the queue, holding the main ones aside until it lets go', async () => {
    const rig = await playing([200, 300], 'insid3-out');
    await key(rig, SHARED);
    rig.advance(100);
    await key(rig, OWN);
    expect(rig.picture().settingsInPlay).toBe('main');

    rig.advance(600);
    expectMutedFrom(rig, lastJumpLanded(rig).frame);
    expect(rig.picture().settingsInPlay).toBe('loop');

    await send(rig, { kind: 'stop-loop', deck: 'a' });
    rig.advance(100);
    const stop = rig.landed('stop-loop')[0].frame;
    expect(control(rig, stop)).toBe(SOUNDING);
    expect(rig.picture().settingsInPlay).toBe('main');
    rig.dispose();
  });

  it('names a queued target again when the settings in play move under it', async () => {
    const rig = await playing([200, 300], 'insid3-out');
    await key(rig, OWN);
    rig.advance(100);
    await key(rig, SHARED);
    rig.advance(20);
    expect(rig.picture().queued).toEqual(SHARED);

    // The same loop pressed without its own settings: a stab that carries the main ones back,
    // after which the queued target has nothing to carry, and a main setting changed now is the
    // one that must still be sounding when it lands.
    await send(rig, { kind: 'jump', deck: 'a', target: { startFrame: 200, endFrame: 230 } });
    rig.advance(20);
    expect(rig.picture().settingsInPlay).toBe('main');
    await send(rig, { kind: 'setting', deck: 'a', setting: 3, value: 1 });
    rig.advance(600);

    const landing = lastJumpLanded(rig);
    expect(landing).toMatchObject({ via: 'pass-end', startFrame: 300 });
    const voice3 = (frame: number): number | null => wrote(rig, frame, 18);
    expect(voice3(landing.frame - 2)).toBeNull();
    expect(voice3(landing.frame + 3)).toBeNull();
    expect(control(rig, landing.frame + 3)).toBe(SOUNDING);
    rig.dispose();
  });

  it('gives the main settings back on a seek and on a load', async () => {
    const rig = await playing([200], 'insid3-out');
    await key(rig, OWN);
    rig.advance(100);
    expect(rig.picture().settingsInPlay).toBe('loop');

    await send(rig, { kind: 'seek', deck: 'a', frame: 200 });
    rig.advance(100);
    expect(rig.picture().settingsInPlay).toBe('main');
    expect(control(rig, rig.frames().length - 2)).toBe(SOUNDING);

    await key(rig, OWN);
    rig.advance(40);
    expect(rig.picture().settingsInPlay).toBe('loop');
    await rig.load('a', 'insid3-out', { ends: 'playing' });
    expect(rig.picture()).toMatchObject({ settingsInPlay: 'main', loop: null, queued: null });
    rig.dispose();
  });
});
