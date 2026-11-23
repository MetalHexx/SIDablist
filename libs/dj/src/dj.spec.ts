import { describe, expect, it } from 'vitest';
import { Rig } from './testing/harness.js';

describe('the desk', () => {
  it('makes decks on demand and keeps them by id, with no pair assumed', async () => {
    const rig = new Rig();
    rig.addDeck('x');
    rig.addDeck('y');
    rig.addDeck('z');
    await rig.load('y', 'still-time', { ends: 'playing' });
    rig.advance(200);

    expect(rig.ofKind('loaded').map((event) => event.deck)).toEqual(['y']);
    expect(rig.picture('x').transport).toBe('empty');
    expect(rig.picture('y').transport).toBe('playing');
    expect(rig.picture('z').transport).toBe('empty');
    rig.dispose();
  });

  it('refuses a duplicate deck, an unknown deck and a malformed message, and logs why', () => {
    const rig = new Rig();
    rig.addDeck('a');
    rig.reports.length = 0;

    rig.send({ kind: 'add-deck', deck: 'a' });
    rig.send({ kind: 'play', deck: 'nobody' });
    rig.send({ kind: 'remove-deck', deck: 'nobody' });
    rig.send({ kind: 'describe', deck: 'nobody' });
    rig.send({ kind: 'speed', deck: 'a', value: -1 });
    rig.send({ kind: 'warp', deck: 'a' } as never);

    expect(rig.warnings).toHaveLength(6);
    expect(rig.warnings.every((line) => line.startsWith('dj: refused '))).toBe(true);
    expect(rig.warnings[0]).toContain('already exists');
    expect(rig.warnings[1]).toContain('unknown deck nobody');
    expect(rig.reports).toEqual([]);
    rig.dispose();
  });

  it('refuses a command it cannot carry out yet, and changes nothing', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    await rig.load('a', 'still-time', { ends: 'paused' });

    rig.send({ kind: 'jump', deck: 'a', target: { startFrame: 10, endFrame: 20 } });
    rig.send({ kind: 'slip', deck: 'a', on: true });
    await rig.microtasks();

    expect(rig.warnings).toEqual([
      'dj: refused jump: jump is not available yet',
      'dj: refused slip: slip is not available yet',
    ]);
    expect(rig.landed().map((event) => event.command.kind)).toEqual(['load']);
    rig.dispose();
  });

  it('ignores setOutput on an unknown deck, with a line in the log', () => {
    const rig = new Rig();
    rig.dj.setOutput('nobody', null);

    expect(rig.warnings).toEqual(['dj: setOutput on unknown deck nobody ignored']);
    rig.dispose();
  });

  it('takes effect when add-deck and remove-deck arrive', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(100);
    expect(rig.wake.running).toBe(true);

    rig.send({ kind: 'remove-deck', deck: 'a' });
    expect(rig.wake.running).toBe(false);
    rig.send({ kind: 'play', deck: 'a' });
    expect(rig.warnings).toEqual(['dj: refused play: unknown deck a']);
    rig.addDeck('a');
    expect(rig.picture('a').transport).toBe('empty');
    rig.dispose();
  });
});

describe('the wake', () => {
  it('runs while any deck renders, at a third of the shortest lookahead within 1 and 10 ms, and stops with the last', async () => {
    const rig = new Rig();
    rig.addDeck('a', { lookaheadMs: 15 });
    rig.addDeck('b', { lookaheadMs: 60 });
    expect(rig.wake.running).toBe(false);

    await rig.load('b', 'still-time', { ends: 'playing' });
    expect(rig.wake.periodUs).toBe(10_000);

    await rig.load('a', 'still-time', { ends: 'playing' });
    expect(rig.wake.periodUs).toBe(5_000);

    rig.send({ kind: 'pause', deck: 'a' });
    await rig.microtasks();
    expect(rig.wake.periodUs).toBe(10_000);
    rig.advance(100);
    rig.send({ kind: 'pause', deck: 'b' });
    await rig.microtasks();
    rig.advance(5);
    expect(rig.wake.running).toBe(false);

    rig.addDeck('c', { lookaheadMs: 1 });
    await rig.load('c', 'still-time', { ends: 'playing' });
    expect(rig.wake.periodUs).toBe(1_000);
    rig.dispose();
  });

  it('renders every deck in the order they were added, whatever order they started in', async () => {
    const rig = new Rig();
    rig.addDeck('first');
    rig.addDeck('second');
    rig.addDeck('third');
    await rig.load('third', 'still-time', { ends: 'playing' });
    await rig.load('first', 'still-time', { ends: 'playing' });
    await rig.load('second', 'still-time', { ends: 'playing' });
    rig.reports.length = 0;

    const order = ['first', 'second', 'third'];
    let rendered = 0;
    for (let step = 0; step < 20; step++) {
      const before = rig.reports.length;
      rig.time.ms += 5;
      rig.tick();
      const decks = rig.reports
        .slice(before)
        .filter((report) => report.kind === 'update')
        .map((report) => report.deck);
      const seen = [...new Set(decks)];
      rendered += seen.length;
      expect(seen).toEqual(order.filter((deck) => seen.includes(deck)));
    }
    expect(rendered).toBeGreaterThan(10);
    rig.dispose();
  });

  it('does nothing more once disposed, and disposes every deck', async () => {
    const rig = new Rig();
    const { sink } = rig.addDeck('a');
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(100);

    rig.dj.dispose();
    const reports = rig.reports.length;
    rig.dj.send({ kind: 'describe', deck: 'a' });
    rig.dj.setOutput('a', null);
    rig.dj.dispose();
    rig.advance(100);

    expect(rig.wake.running).toBe(false);
    expect(rig.reports).toHaveLength(reports);
    expect(sink?.endCount).toBeGreaterThan(0);
  });
});

describe('requests', () => {
  it('answer with a picture, the registers and the deliveries, and change nothing', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.send({ kind: 'keep-deliveries', deck: 'a', capacity: 16 });
    rig.advance(300);

    rig.send({ kind: 'registers', deck: 'a' });
    rig.send({ kind: 'deliveries', deck: 'a' });
    const registers = rig.ofKind('registers')[0];
    const deliveries = rig.ofKind('deliveries')[0];

    expect(registers.written).toHaveLength(25);
    expect(registers.sent).toHaveLength(25);
    expect(deliveries.batch.capacity).toBe(16);
    expect(deliveries.batch.count).toBe(16);
    const picture = rig.picture();
    expect(picture.tune).toMatchObject({ tune: 'still-time', subtune: 1, subtuneCount: 1 });
    expect(picture.output?.lookaheadMs).toBe(60);
    expect(picture.output?.ringSlots).toBeGreaterThan(2);
    expect(picture.output?.ringBytes).toBe(((picture.output?.ringSlots ?? 0) + 1) * 136 * 1024);
    expect(picture.timing.framesDelivered).toBeGreaterThan(10);
    expect(picture.rate?.nominalIntervalUs).toBe(19950);
    rig.dispose();
  });

  it('send a picture when something it holds changes, and not on a frame where nothing did', async () => {
    const rig = new Rig();
    rig.addDeck('a');
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(200);
    const before = rig.ofKind('picture').length;

    rig.advance(400);
    expect(rig.ofKind('picture')).toHaveLength(before);

    rig.send({ kind: 'speed', deck: 'a', value: 1.2 });
    rig.advance(100);
    const after = rig.ofKind('picture');
    expect(after.length).toBeGreaterThan(before);
    expect(after[after.length - 1].tempo.speed).toBe(1.2);
    rig.dispose();
  });
});
