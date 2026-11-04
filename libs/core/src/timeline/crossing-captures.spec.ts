import { describe, expect, it } from 'vitest';
import { frames } from '../units.js';
import {
  copyImageBuffer,
  createCrossingCaptures,
  createImageBuffer,
  type CrossingCaptures,
  type CrossingLines,
  type ImageBuffer,
} from './crossing-captures.js';

const lines = (originFrame: number, periodFrames: number, keep: number): CrossingLines => ({
  originFrame,
  periodFrames,
  keep,
});

/** Crosses every frame in `from..to` the way a tick loop would, collecting the buffers handed out. */
function cross(pool: CrossingCaptures, from: number, to: number): (ImageBuffer | null)[] {
  const taken: (ImageBuffer | null)[] = [];
  for (let frame = from; frame <= to; frame++) taken.push(pool.take(frame));
  return taken;
}

const taken = (buffers: (ImageBuffer | null)[]): ImageBuffer[] =>
  buffers.filter((buffer): buffer is ImageBuffer => buffer !== null);

const heldFrames = (pool: CrossingCaptures, from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index).filter(
    (frame) => pool.imageAt(frame) !== null,
  );

describe('createCrossingCaptures', () => {
  describe('which frames are on a line', () => {
    it.each([
      { name: 'whole lines', set: lines(0, 10, 9), onLine: [10, 20, 30, 40, 90] },
      { name: 'an origin past zero', set: lines(7, 10, 9), onLine: [7, 17, 27, 37, 87] },
      { name: 'lines before the origin', set: lines(100, 10, 12), onLine: [0, 10, 50, 100] },
      // 12.4 × k rounds to 0, 12, 25, 37, 50, 62: round-to-nearest, not floor.
      { name: 'a fractional period', set: lines(0, 12.4, 9), onLine: [0, 12, 25, 37, 50, 62] },
      // 3 + 12.5 × k: 15.5 and 40.5 round up to 16 and 41.
      { name: 'half-frame lines', set: lines(3, 12.5, 9), onLine: [3, 16, 28, 41, 53] },
      { name: 'a fractional origin', set: lines(2.4, 10, 9), onLine: [2, 12, 22] },
    ])('takes $name at exactly their rounded frames', ({ set, onLine }) => {
      const pool = createCrossingCaptures();
      pool.declare([set]);

      const crossed = cross(pool, 0, 100)
        .map((buffer, frame) => (buffer === null ? null : frame))
        .filter((frame): frame is number => frame !== null);

      expect(crossed).toEqual(expect.arrayContaining(onLine));
      const expected = new Set<number>();
      for (let k = -200; k <= 200; k++) {
        const line = Math.round(set.originFrame + k * set.periodFrames);
        if (line >= 0 && line <= 100) expected.add(line);
      }
      expect(crossed).toEqual([...expected].sort((a, b) => a - b));
    });

    it('takes nothing when no lines are declared', () => {
      const pool = createCrossingCaptures();

      expect(cross(pool, 0, 50).every((buffer) => buffer === null)).toBe(true);
    });
  });

  describe('what a set keeps', () => {
    it('keeps its most recent crossings and lets the oldest go', () => {
      const pool = createCrossingCaptures();
      pool.declare([lines(0, 10, 3)]);

      cross(pool, 0, 45);

      expect(heldFrames(pool, 0, 45)).toEqual([20, 30, 40]);
    });

    it('holds a frame on several sets once, for as long as any set keeps it', () => {
      const pool = createCrossingCaptures();
      pool.declare([lines(0, 10, 2), lines(0, 20, 2), lines(0, 5, 4)]);

      const shared = pool.take(20);
      cross(pool, 21, 40);

      // Tens keep 30 and 40, twenties keep 20 and 40, fives keep 25, 30, 35 and 40.
      expect(heldFrames(pool, 0, 40)).toEqual([20, 25, 30, 35, 40]);
      expect(pool.imageAt(20)).toBe(shared);
    });

    it('hands back the buffer already holding a frame crossed again, and disturbs no other', () => {
      const pool = createCrossingCaptures();
      pool.declare([lines(0, 10, 3)]);
      cross(pool, 0, 35);
      const before = new Map([10, 20, 30].map((frame) => [frame, pool.imageAt(frame)]));

      const again = pool.take(20);

      expect(again).toBe(before.get(20));
      expect([10, 20, 30].map((frame) => pool.imageAt(frame))).toEqual([...before.values()]);
    });

    it('counts a re-crossed frame as the newest, so it outlives older ones', () => {
      const pool = createCrossingCaptures();
      pool.declare([lines(0, 10, 3)]);
      cross(pool, 0, 35);

      pool.take(10);
      cross(pool, 36, 45);

      expect(heldFrames(pool, 0, 45)).toEqual([10, 30, 40]);
    });
  });

  describe('the pool', () => {
    it('hands out only the buffers it allocated when the lines were declared, however long it runs', () => {
      const pool = createCrossingCaptures();
      pool.declare([lines(0, 2, 3), lines(0, 3, 2)]);

      const seen = new Set(taken(cross(pool, 0, 3000)));

      // Five kept crossings and the one spare that is always free.
      expect(seen.size).toBeLessThanOrEqual(6);
      expect(seen.size).toBeGreaterThan(1);
    });

    it('keeps every buffer’s memory for good: later crossings write into the arrays already there', () => {
      const pool = createCrossingCaptures();
      pool.declare([lines(0, 5, 2)]);
      const memories = new Set(taken(cross(pool, 0, 200)).map((buffer) => buffer.machine.memory));

      const later = taken(cross(pool, 201, 4000)).map((buffer) => buffer.machine.memory);

      expect(later.every((memory) => memories.has(memory))).toBe(true);
    });

    it('reuses its buffers when the lines are declared again, and keeps the images on lines that remain', () => {
      const pool = createCrossingCaptures();
      pool.declare([lines(0, 10, 3)]);
      const firstPool = new Set(taken(cross(pool, 0, 405)));
      const [at380, at390, at400] = [380, 390, 400].map((frame) => pool.imageAt(frame));

      pool.declare([lines(0, 10, 3), lines(5, 20, 1)]);

      expect([380, 390, 400].map((frame) => pool.imageAt(frame))).toEqual([at380, at390, at400]);
      const afterwards = new Set(taken(cross(pool, 406, 2000)));
      // Five buffers now, four of them the first declaration's.
      expect(afterwards.size).toBeLessThanOrEqual(5);
      expect([...afterwards].filter((buffer) => !firstPool.has(buffer))).toHaveLength(1);
    });

    it('lets an image go when no new set has its frame on a line, or room for it', () => {
      const pool = createCrossingCaptures();
      pool.declare([lines(0, 10, 3)]);
      cross(pool, 0, 35);

      pool.declare([lines(0, 20, 1), lines(5, 10, 1)]);

      // 20 is the newest on the twenties; the fives-and-ones set has none of 10, 20 or 30.
      expect(heldFrames(pool, 0, 35)).toEqual([20]);
    });

    it('frees every image, and takes nothing, when declared empty', () => {
      const pool = createCrossingCaptures();
      pool.declare([lines(0, 10, 3)]);
      cross(pool, 0, 35);

      pool.declare([]);

      expect(heldFrames(pool, 0, 35)).toEqual([]);
      expect(cross(pool, 36, 60).every((buffer) => buffer === null)).toBe(true);
    });

    it('lets go of the images on request and keeps the lines', () => {
      const pool = createCrossingCaptures();
      pool.declare([lines(0, 10, 3)]);
      cross(pool, 0, 35);

      pool.clearImages();

      expect(heldFrames(pool, 0, 35)).toEqual([]);
      cross(pool, 36, 45);
      expect(heldFrames(pool, 0, 45)).toEqual([40]);
    });
  });
});

describe('image buffers', () => {
  it('copies the frame, the machine and the registers over another buffer', () => {
    const from = createImageBuffer();
    const to = createImageBuffer();
    from.frame = frames(321);
    from.machine.memory[0x1234] = 0xab;
    from.machine.playAddress = 0x1010;
    from.machine.timerALatch = 19655;
    from.machine.cpu['a'] = 7;
    from.registers.values[4] = 0x41;

    copyImageBuffer(from, to);

    expect(to.frame).toBe(321);
    expect(to.machine.memory[0x1234]).toBe(0xab);
    expect(to.machine.playAddress).toBe(0x1010);
    expect(to.machine.timerALatch).toBe(19655);
    expect(to.machine.cpu['a']).toBe(7);
    expect(to.registers.values[4]).toBe(0x41);
    expect(to.machine.memory).not.toBe(from.machine.memory);
  });
});
