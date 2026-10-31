import { describe, expect, it } from 'vitest';
import type { SidFrame } from '../registers/sid-frame.js';
import { SID_REGISTER_COUNT, VOICE_COUNT } from '../registers/sid-constants.js';
import { DeliveryHistory, createDeliveryBatch } from './delivery-history.js';
import type { DeliveryBatch } from './delivery-history.js';

type Write = readonly [register: number, value: number];

function frameOf(...writes: Write[]): SidFrame {
  return {
    count: writes.length,
    registers: Uint8Array.from(writes, ([register]) => register),
    values: Uint8Array.from(writes, ([, value]) => value),
    offsetsUs: new Int32Array(writes.length),
  };
}

function drained(history: DeliveryHistory, capacity = 8): DeliveryBatch {
  const batch = createDeliveryBatch(capacity);
  history.drain(batch);
  return batch;
}

function registersOf(batch: DeliveryBatch, entry: number): number[] {
  return Array.from(
    batch.registers.slice(entry * SID_REGISTER_COUNT, (entry + 1) * SID_REGISTER_COUNT),
  );
}

function controlOf(batch: DeliveryBatch, entry: number, voice: number): number[] {
  const count = batch.controlCounts[entry * VOICE_COUNT + voice];
  const from = (entry * VOICE_COUNT + voice) * 2;
  return Array.from(batch.controlBytes.slice(from, from + count));
}

describe('DeliveryHistory', () => {
  it('drains nothing from an empty history', () => {
    const history = new DeliveryHistory(4);
    const batch = createDeliveryBatch(4);
    batch.count = 3;
    batch.dropped = 2;

    history.drain(batch);

    expect(batch.count).toBe(0);
    expect(batch.dropped).toBe(0);
    expect(batch.restarted).toBe(false);
  });

  it('returns deliveries oldest first, each carrying the chip as earlier writes left it', () => {
    const history = new DeliveryHistory(8);
    history.record(frameOf([0, 10]), 100);
    history.record(frameOf([1, 20]), 120);
    history.record(frameOf(), 140);

    const batch = drained(history);

    expect(batch.count).toBe(3);
    expect(Array.from(batch.timesMs.slice(0, 3))).toEqual([100, 120, 140]);
    expect(registersOf(batch, 0).slice(0, 2)).toEqual([10, 0]);
    expect(registersOf(batch, 1).slice(0, 2)).toEqual([10, 20]);
    expect(registersOf(batch, 2).slice(0, 2)).toEqual([10, 20]);
  });

  it('keeps every byte of a doubled control write, in order, with the second as the chip holds it', () => {
    const history = new DeliveryHistory(4);
    history.record(frameOf([4, 0x41], [4, 0x40], [11, 0x21]), 0);

    const batch = drained(history);

    expect(controlOf(batch, 0, 0)).toEqual([0x41, 0x40]);
    expect(controlOf(batch, 0, 1)).toEqual([0x21]);
    expect(controlOf(batch, 0, 2)).toEqual([]);
    expect(registersOf(batch, 0)[4]).toBe(0x40);
    expect(registersOf(batch, 0)[11]).toBe(0x21);
  });

  it('holds the second byte when it changes the waveform and keeps the gate open', () => {
    const history = new DeliveryHistory(4);
    history.record(frameOf([4, 0x41], [4, 0x21]), 0);

    const batch = drained(history);

    expect(controlOf(batch, 0, 0)).toEqual([0x41, 0x21]);
    expect(registersOf(batch, 0)[4]).toBe(0x21);
  });

  it('folds a stray third control write into the second', () => {
    const history = new DeliveryHistory(4);
    history.record(frameOf([18, 0x11], [18, 0x10], [18, 0x41]), 0);

    const batch = drained(history);

    expect(controlOf(batch, 0, 2)).toEqual([0x11, 0x41]);
    expect(registersOf(batch, 0)[18]).toBe(0x41);
  });

  it('reports no control bytes for a delivery that wrote none, while the chip keeps its gate', () => {
    const history = new DeliveryHistory(4);
    history.record(frameOf([4, 0x41]), 0);
    history.record(frameOf([0, 1]), 1);

    const batch = drained(history);

    expect(controlOf(batch, 1, 0)).toEqual([]);
    expect(registersOf(batch, 1)[4]).toBe(0x41);
  });

  it('keeps the newest entries once full, counting the rest as dropped', () => {
    const history = new DeliveryHistory(3);
    for (let value = 1; value <= 5; value++) history.record(frameOf([0, value]), value);

    const batch = drained(history);

    expect(batch.count).toBe(3);
    expect(batch.dropped).toBe(2);
    expect(Array.from(batch.timesMs.slice(0, 3))).toEqual([3, 4, 5]);
    expect([0, 1, 2].map((entry) => registersOf(batch, entry)[0])).toEqual([3, 4, 5]);
  });

  it('takes the newest entries into a batch smaller than what is pending and adds the rest to dropped', () => {
    const history = new DeliveryHistory(4);
    for (let value = 1; value <= 6; value++) history.record(frameOf([0, value]), value);

    const batch = drained(history, 2);

    expect(batch.count).toBe(2);
    expect(batch.dropped).toBe(4);
    expect([0, 1].map((entry) => registersOf(batch, entry)[0])).toEqual([5, 6]);
  });

  it('starts clean after a drain but keeps the chip image', () => {
    const history = new DeliveryHistory(4);
    history.record(frameOf([0, 7]), 1);
    history.record(frameOf([1, 8]), 2);
    drained(history);

    history.record(frameOf([2, 9]), 3);
    const batch = drained(history);

    expect(batch.count).toBe(1);
    expect(batch.dropped).toBe(0);
    expect(registersOf(batch, 0).slice(0, 3)).toEqual([7, 8, 9]);
    expect(drained(history).count).toBe(0);
  });

  it('keeps order when the ring has wrapped between drains', () => {
    const history = new DeliveryHistory(3);
    history.record(frameOf([0, 1]), 1);
    history.record(frameOf([0, 2]), 2);
    drained(history);
    for (let value = 3; value <= 5; value++) history.record(frameOf([0, value]), value);

    const batch = drained(history);

    expect([0, 1, 2].map((entry) => registersOf(batch, entry)[0])).toEqual([3, 4, 5]);
  });

  describe('restart', () => {
    it('empties the ring and zeroes the image, raising restarted until a drain consumes it', () => {
      const history = new DeliveryHistory(4);
      history.record(frameOf([0, 7]), 1);
      history.record(frameOf([1, 8]), 2);

      history.restart();
      history.record(frameOf([2, 9]), 3);
      const first = drained(history);
      history.record(frameOf([2, 9]), 4);
      const second = drained(history);

      expect(first.restarted).toBe(true);
      expect(first.count).toBe(1);
      expect(registersOf(first, 0).slice(0, 3)).toEqual([0, 0, 9]);
      expect(second.restarted).toBe(false);
    });

    it('forgets the drops counted before it', () => {
      const history = new DeliveryHistory(2);
      for (let value = 1; value <= 5; value++) history.record(frameOf([0, value]), value);

      history.restart();

      expect(drained(history).dropped).toBe(0);
    });

    it('reports restarted on a drain with nothing in it', () => {
      const history = new DeliveryHistory(2);
      history.restart();

      const batch = drained(history);

      expect(batch.count).toBe(0);
      expect(batch.restarted).toBe(true);
    });
  });

  describe('seed', () => {
    it('gives the first entry the registers the chip already held', () => {
      const history = new DeliveryHistory(4);
      const held = new Uint8Array(SID_REGISTER_COUNT);
      held[5] = 0xab;
      held[3] = 0x08;

      history.seed(held);
      history.record(frameOf([0, 1]), 0);

      const entry = registersOf(drained(history), 0);
      expect(entry[5]).toBe(0xab);
      expect(entry[3]).toBe(0x08);
      expect(entry[0]).toBe(1);
    });
  });

  it('refuses a capacity that is not a whole number of at least one', () => {
    expect(() => new DeliveryHistory(0)).toThrow(RangeError);
    expect(() => new DeliveryHistory(1.5)).toThrow(RangeError);
    expect(() => new DeliveryHistory(Number.NaN)).toThrow(RangeError);
  });
});

describe('createDeliveryBatch', () => {
  it('sizes every array to the capacity it was asked for', () => {
    const batch = createDeliveryBatch(5);

    expect(batch.capacity).toBe(5);
    expect(batch.registers.length).toBe(5 * SID_REGISTER_COUNT);
    expect(batch.timesMs.length).toBe(5);
    expect(batch.controlBytes.length).toBe(5 * VOICE_COUNT * 2);
    expect(batch.controlCounts.length).toBe(5 * VOICE_COUNT);
    expect(batch.count).toBe(0);
    expect(batch.dropped).toBe(0);
    expect(batch.restarted).toBe(false);
  });

  it('refuses a capacity that is not a whole, non-negative number', () => {
    expect(() => createDeliveryBatch(-1)).toThrow(RangeError);
    expect(() => createDeliveryBatch(2.5)).toThrow(RangeError);
    expect(() => createDeliveryBatch(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
