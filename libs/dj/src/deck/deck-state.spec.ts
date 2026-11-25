import { describe, expect, it } from 'vitest';
import { DeckState, TAP_RUN_CAPACITY } from './deck-state.js';

describe('the run of taps in a deck state', () => {
  it('keeps the newest marks once it is full, and saves and restores the run it kept', () => {
    const state = new DeckState();
    for (let mark = 1; mark <= TAP_RUN_CAPACITY + 1; mark++) state.addTapMark(mark);

    expect(state.tapCount).toBe(TAP_RUN_CAPACITY);
    const run = state.tapRun();
    expect(run).toHaveLength(TAP_RUN_CAPACITY);
    expect(run[0]).toBe(2);
    expect(run[TAP_RUN_CAPACITY - 1]).toBe(TAP_RUN_CAPACITY + 1);

    const image = state.createState();
    state.saveInto(image);
    state.endTapRun();
    state.addTapMark(9000);
    expect(state.tapRun()).toEqual([9000]);

    state.restoreFrom(image);
    expect(state.tapCount).toBe(TAP_RUN_CAPACITY);
    expect(state.tapRun()).toEqual(run);
  });
});
