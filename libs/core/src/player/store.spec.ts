import { describe, expect, it } from 'vitest';
import { frames, microseconds } from '../units.js';
import type { PlayerSnapshot } from './snapshot.js';
import { createPlayerSnapshotStore } from './store.js';

/** A minimal, always-fresh `PlayerSnapshot` — a new object every call, so a test proving identity
 *  stability actually exercises the store's own comparison rather than reusing one reference. */
function baseSnapshot(): PlayerSnapshot {
  return {
    transport: 'stopped',
    tune: null,
    tempo: {
      multiplier: 1,
      effectiveIntervalUs: microseconds(20_000),
      nominalIntervalUs: microseconds(20_000),
      callsPerFrame: 1,
      rate: { callsPerFrame: 1, exactCallsPerFrame: 1, roundedCallsPerFrame: 1, mode: 'exact' },
      timingMode: 'exact',
    },
    loop: null,
    voices: [
      { muted: false, held: false },
      { muted: false, held: false },
      { muted: false, held: false },
    ],
    basis: { positionBasisFrames: frames(0), ceilingFrames: frames(0), trackEndFrame: null },
    repeatTrack: false,
    error: null,
  };
}

describe('createPlayerSnapshotStore', () => {
  it('keeps the same snapshot reference when markDirty produces an equal value', () => {
    const store = createPlayerSnapshotStore(baseSnapshot());
    const before = store.getSnapshot();

    store.markDirty(() => baseSnapshot());

    expect(store.getSnapshot()).toBe(before);
  });

  it('replaces the snapshot reference the moment a discrete field changes', () => {
    const store = createPlayerSnapshotStore(baseSnapshot());
    const before = store.getSnapshot();

    store.markDirty(() => ({ ...baseSnapshot(), transport: 'playing' }));

    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.transport).toBe('playing');
  });

  it('notifies subscribers only when the recomputed snapshot actually differs', () => {
    const store = createPlayerSnapshotStore(baseSnapshot());
    let calls = 0;
    store.subscribe(() => calls++);

    store.markDirty(() => baseSnapshot());
    expect(calls).toBe(0);

    store.markDirty(() => ({ ...baseSnapshot(), transport: 'playing' }));
    expect(calls).toBe(1);
  });

  it('stops notifying a listener once its unsubscribe has been called', () => {
    const store = createPlayerSnapshotStore(baseSnapshot());
    let calls = 0;
    const unsubscribe = store.subscribe(() => calls++);

    unsubscribe();
    store.markDirty(() => ({ ...baseSnapshot(), transport: 'playing' }));

    expect(calls).toBe(0);
  });

  it('skips a listener unsubscribed mid-notification without skipping the ones after it', () => {
    const store = createPlayerSnapshotStore(baseSnapshot());
    const calledOrder: string[] = [];
    let unsubscribeSecond: () => void = () => undefined;

    store.subscribe(() => {
      calledOrder.push('first');
      unsubscribeSecond();
    });
    unsubscribeSecond = store.subscribe(() => calledOrder.push('second'));
    store.subscribe(() => calledOrder.push('third'));

    store.markDirty(() => ({ ...baseSnapshot(), transport: 'playing' }));

    expect(calledOrder).toEqual(['first', 'third']);
  });
});
