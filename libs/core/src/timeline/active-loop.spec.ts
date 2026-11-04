import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createC64Machine, type C64Machine, type MachineSnapshot } from '../cpu/c64-machine.js';
import {
  createRegisterFrame,
  type RegisterFrame,
  type RegisterValuesSnapshot,
} from '../registers/register-frame.js';
import { runFramesTo } from '../replay/run-frames.js';
import type { SidFile } from '../sid/sid-file.model.js';
import { frames, type Frames } from '../units.js';
import { createAnchorRing, type AnchorRing, type PositionAnchor } from './anchor-ring.js';
import {
  createActiveLoopTracker,
  isUsableLoopLength,
  lapLength,
  lapPhaseAfter,
  lapSpan,
  lapsWithin,
  reduceLapPhase,
  type ActiveLoopTracker,
} from './active-loop.js';
import { createTrackStructure, type TrackStructure } from './track-structure.js';

const RTS = 0x60;

/** play counts up in zero page and writes the count to $D400, so no two frames of this tune leave
 *  the machine or the registers in the same state — which is what makes a landing checkable. */
function counterTune(): SidFile {
  const data = new Uint8Array(0x18);
  data[0x00] = RTS; // init
  data.set([0xe6, 0xfb, 0xa5, 0xfb, 0x8d, 0x00, 0xd4, RTS], 0x10); // INC $FB; LDA $FB; STA $D400
  return {
    format: 'PSID',
    version: 2,
    loadAddress: 0x1000,
    initAddress: 0x1000,
    playAddress: 0x1010,
    songs: 1,
    startSong: 1,
    speedFlags: 0,
    name: '',
    author: '',
    released: '',
    clock: 'pal',
    model: 'unknown',
    secondSidAddress: null,
    thirdSidAddress: null,
    data,
  };
}

interface State {
  readonly machine: MachineSnapshot;
  readonly registers: RegisterValuesSnapshot;
}

/** Where an unbroken run from `init` stands at `target` — the control a re-entry is measured
 *  against. */
function runUnbrokenTo(target: Frames): State {
  const registers = createRegisterFrame();
  const machine = createC64Machine(counterTune(), registers);
  machine.initSubtune(1);
  runFramesTo(machine, frames(0), target, () => {
    registers.takeSnapshot();
  });
  return { machine: machine.snapshot(), registers: registers.snapshotValues() };
}

describe('createActiveLoopTracker', () => {
  let registers: RegisterFrame;
  let machine: C64Machine;
  let ring: AnchorRing;
  let track: TrackStructure;
  let tracker: ActiveLoopTracker;
  let position: number;

  beforeEach(() => {
    registers = createRegisterFrame();
    machine = createC64Machine(counterTune(), registers);
    machine.initSubtune(1);
    ring = createAnchorRing(() => frames(50)); // an anchor every 25 frames
    ring.record(machine, registers, frames(0)); // the frame-0 seed a load takes
    track = createTrackStructure();
    tracker = createActiveLoopTracker();
    position = 0;
  });

  /** Drives the live pair the way a tick loop would, offering the ring an anchor each frame. */
  function play(count: number): void {
    for (let i = 0; i < count; i++) {
      machine.runFrame();
      registers.takeSnapshot();
      position++;
      ring.maybeRecord(machine, registers, frames(position));
    }
  }

  function liveState(): State {
    return { machine: machine.snapshot(), registers: registers.snapshotValues() };
  }

  it('does nothing before the active loop reaches its end', () => {
    tracker.set({ startFrame: frames(10), endFrame: frames(140) });
    play(100);

    const result = tracker.advance(machine, registers, ring, track, frames(100));

    expect(result).toEqual({ action: 'none' });
    expect(tracker.get()).toEqual({ startFrame: 10, endFrame: 140 });
  });

  it('reports the start as due, the pair untouched, when entering it would replay frames', () => {
    tracker.set({ startFrame: frames(75), endFrame: frames(140) });
    play(140);
    const before = liveState();

    const result = tracker.advance(machine, registers, ring, track, frames(140));

    expect(result).toEqual({ action: 'due-unheld', frame: 75 });
    expect(liveState()).toEqual(before);
    expect(tracker.get()).toEqual({ startFrame: 75, endFrame: 140 });
  });

  it('re-enters through the anchor ring when the anchor already sits at the start', () => {
    tracker.set({ startFrame: frames(0), endFrame: frames(140) });
    play(140);

    const result = tracker.advance(machine, registers, ring, track, frames(140));

    expect(result).toEqual({ action: 'looped', frame: 0 });
    expect(liveState()).toEqual(runUnbrokenTo(frames(0)));
  });

  it('prefers the held entry image over the anchor ring for re-entry', () => {
    // Captured at a frame the ring would never select on its own, so landing there proves the
    // image was used rather than a seek along the anchor path.
    const stateAtTen = runUnbrokenTo(frames(10));
    const entryImage: PositionAnchor = { frame: frames(10), ...stateAtTen };
    tracker.setEntryImage(entryImage);
    tracker.set({ startFrame: frames(75), endFrame: frames(140) });
    play(140);

    const result = tracker.advance(machine, registers, ring, track, frames(140));

    expect(result).toEqual({ action: 'looped', frame: 10 });
    expect(liveState()).toEqual(stateAtTen);
  });

  it('leaves the pair and the active loop untouched when the ring has nothing to seek from', () => {
    tracker.set({ startFrame: frames(75), endFrame: frames(140) });
    play(140);
    ring.reset();
    const before = liveState();

    const result = tracker.advance(machine, registers, ring, track, frames(140));

    expect(result).toEqual({ action: 'none' });
    expect(liveState()).toEqual(before);
    expect(tracker.get()).toEqual({ startFrame: 75, endFrame: 140 });
  });

  it('does nothing with no active loop and no detected track end', () => {
    play(50);

    const result = tracker.advance(machine, registers, ring, track, frames(50));

    expect(result).toEqual({ action: 'none' });
    expect(tracker.get()).toBeNull();
  });

  it('stops without moving the pair when the track ends and repeat is off', () => {
    track.setTrackStructure({
      loopStartFrame: null,
      loopPeriodFrames: frames(50),
      endedAtFrame: null,
    });
    play(50);
    const before = liveState();

    const result = tracker.advance(machine, registers, ring, track, frames(50));

    expect(result).toEqual({ action: 'stopped' });
    expect(liveState()).toEqual(before);
    expect(tracker.get()).toBeNull();
  });

  it("arms the track's own loop when it ends and repeat is on, reporting its start as due", () => {
    track.setTrackStructure({
      loopStartFrame: frames(20),
      loopPeriodFrames: frames(80),
      endedAtFrame: null,
    });
    track.setRepeatEnabled(true);
    play(100); // trackEndFrame is 20 + 80
    const before = liveState();

    const result = tracker.advance(machine, registers, ring, track, frames(100));

    expect(result).toEqual({ action: 'due-unheld', frame: 20 });
    expect(tracker.get()).toEqual({ startFrame: 20, endFrame: 100 });
    expect(liveState()).toEqual(before);
  });

  it("enters the track's own loop through its entry image once one is held", () => {
    const stateAtTwenty = runUnbrokenTo(frames(20));
    tracker.setEntryImage({ frame: frames(20), ...stateAtTwenty });
    track.setTrackStructure({
      loopStartFrame: frames(20),
      loopPeriodFrames: frames(80),
      endedAtFrame: null,
    });
    track.setRepeatEnabled(true);
    play(100);

    const result = tracker.advance(machine, registers, ring, track, frames(100));

    expect(result).toEqual({ action: 'looped', frame: 20 });
    expect(tracker.get()).toEqual({ startFrame: 20, endFrame: 100 });
    expect(liveState()).toEqual(stateAtTwenty);
  });

  it('replays from the top when a repeated track only ever ended, with no loop of its own', () => {
    track.setTrackStructure({
      loopStartFrame: null,
      loopPeriodFrames: null,
      endedAtFrame: frames(60),
    });
    track.setRepeatEnabled(true);
    play(60);

    const result = tracker.advance(machine, registers, ring, track, frames(60));

    expect(result).toEqual({ action: 'looped', frame: 0 });
    expect(tracker.get()).toEqual({ startFrame: 0, endFrame: 60 });
    expect(liveState()).toEqual(runUnbrokenTo(frames(0)));
  });

  it('keeps enforcing the armed track loop on every later lap', () => {
    track.setTrackStructure({
      loopStartFrame: frames(20),
      loopPeriodFrames: frames(80),
      endedAtFrame: null,
    });
    track.setRepeatEnabled(true);
    play(100);
    tracker.advance(machine, registers, ring, track, frames(100));

    const result = tracker.advance(machine, registers, ring, track, frames(100));

    expect(result).toEqual({ action: 'due-unheld', frame: 20 });
  });

  describe('a queued hand-off', () => {
    /** The image of `at`, taken from an unbroken run. */
    function imageAt(at: number): PositionAnchor {
      return { frame: frames(at), ...runUnbrokenTo(frames(at)) };
    }

    it('lands the queued loop at the wrap instead of re-entering the running one', () => {
      tracker.set({ startFrame: frames(10), endFrame: frames(100) });
      const next = { startFrame: frames(60), endFrame: frames(90) };
      const image = imageAt(60);
      tracker.queue({ startFrame: frames(60), loop: next });
      tracker.setQueuedImage(image);
      play(100);

      const result = tracker.advance(machine, registers, ring, track, frames(100));

      expect(result).toEqual({ action: 'handed-off', frame: 60 });
      expect(tracker.get()).toBe(next);
      expect(tracker.entryImage()).toBe(image);
      expect(liveState()).toEqual(runUnbrokenTo(frames(60)));
    });

    it('empties the queue on landing, so the next wrap is an ordinary lap of the new loop', () => {
      tracker.set({ startFrame: frames(10), endFrame: frames(100) });
      tracker.queue({
        startFrame: frames(60),
        loop: { startFrame: frames(60), endFrame: frames(90) },
      });
      tracker.setQueuedImage(imageAt(60));
      play(100);
      tracker.advance(machine, registers, ring, track, frames(100));

      play(30);
      const result = tracker.advance(machine, registers, ring, track, frames(90));

      expect(result).toEqual({ action: 'looped', frame: 60 });
    });

    it('lands a cue by clearing the loop and leaving the entry image alone', () => {
      const entry = imageAt(10);
      tracker.set({ startFrame: frames(10), endFrame: frames(100) });
      tracker.setEntryImage(entry);
      tracker.queue({ startFrame: frames(60), loop: null });
      tracker.setQueuedImage(imageAt(60));
      play(100);

      const result = tracker.advance(machine, registers, ring, track, frames(100));

      expect(result).toEqual({ action: 'handed-off', frame: 60 });
      expect(tracker.get()).toBeNull();
      expect(tracker.entryImage()).toBe(entry);
    });

    it('re-enters the running loop while the queued target has no image', () => {
      tracker.set({ startFrame: frames(10), endFrame: frames(100) });
      tracker.queue({
        startFrame: frames(60),
        loop: { startFrame: frames(60), endFrame: frames(90) },
      });
      play(100);

      const result = tracker.advance(machine, registers, ring, track, frames(100));

      expect(result).toEqual({ action: 'due-unheld', frame: 10 });
      expect(tracker.get()).toEqual({ startFrame: 10, endFrame: 100 });

      play(90);
      tracker.setQueuedImage(imageAt(60));
      expect(tracker.advance(machine, registers, ring, track, frames(100))).toEqual({
        action: 'handed-off',
        frame: 60,
      });
    });

    it('drops the queue on set and on cancel, and a replace forgets the old image', () => {
      tracker.set({ startFrame: frames(10), endFrame: frames(100) });
      tracker.queue({ startFrame: frames(60), loop: null });
      tracker.setQueuedImage(imageAt(60));
      tracker.set({ startFrame: frames(10), endFrame: frames(100) });
      play(100);
      expect(tracker.advance(machine, registers, ring, track, frames(100)).action).toBe(
        'due-unheld',
      );

      tracker.queue({ startFrame: frames(60), loop: null });
      tracker.setQueuedImage(imageAt(60));
      tracker.queue(null);
      play(90);
      expect(tracker.advance(machine, registers, ring, track, frames(100)).action).toBe(
        'due-unheld',
      );

      tracker.queue({ startFrame: frames(70), loop: null });
      tracker.setQueuedImage(imageAt(60));
      tracker.queue({ startFrame: frames(80), loop: null });
      play(90);
      expect(tracker.advance(machine, registers, ring, track, frames(100)).action).toBe(
        'due-unheld',
      );
    });
  });

  describe('with a wrap lead', () => {
    // The player's lead: one frame, the gate-off a re-entry owes, which takes the loop's last slot.
    beforeEach(() => {
      tracker = createActiveLoopTracker({ wrapLeadFrames: 1 });
    });

    it('falls due one frame before the active loop’s end, and not before', () => {
      tracker.set({ startFrame: frames(75), endFrame: frames(140) });
      play(138);
      expect(tracker.advance(machine, registers, ring, track, frames(138))).toEqual({
        action: 'none',
      });

      play(1);
      const result = tracker.advance(machine, registers, ring, track, frames(139));

      expect(result).toEqual({ action: 'due-unheld', frame: 75 });
    });

    it('lands a queued hand-off at the same point', () => {
      tracker.set({ startFrame: frames(10), endFrame: frames(100) });
      tracker.queue({
        startFrame: frames(60),
        loop: { startFrame: frames(60), endFrame: frames(90) },
      });
      tracker.setQueuedImage({ frame: frames(60), ...runUnbrokenTo(frames(60)) });
      play(99);

      expect(tracker.advance(machine, registers, ring, track, frames(99))).toEqual({
        action: 'handed-off',
        frame: 60,
      });
    });

    it('wraps a repeating track one frame early, on its first pass and every lap after', () => {
      track.setTrackStructure({
        loopStartFrame: frames(20),
        loopPeriodFrames: frames(80),
        endedAtFrame: null,
      });
      track.setRepeatEnabled(true);
      play(98);
      expect(tracker.advance(machine, registers, ring, track, frames(98)).action).toBe('none');

      play(1);
      expect(tracker.advance(machine, registers, ring, track, frames(99))).toEqual({
        action: 'due-unheld',
        frame: 20,
      });
      expect(tracker.get()).toEqual({ startFrame: 20, endFrame: 100 });

      expect(tracker.advance(machine, registers, ring, track, frames(99))).toEqual({
        action: 'due-unheld',
        frame: 20,
      });
    });

    it('stops a track with repeat off only at its true end, since a stop owes the stream nothing', () => {
      track.setTrackStructure({
        loopStartFrame: null,
        loopPeriodFrames: frames(50),
        endedAtFrame: null,
      });
      play(49);
      expect(tracker.advance(machine, registers, ring, track, frames(49)).action).toBe('none');

      play(1);
      expect(tracker.advance(machine, registers, ring, track, frames(50)).action).toBe('stopped');
    });

    it('still renders the start frame of a loop too short to give one up', () => {
      tracker.set({ startFrame: frames(10), endFrame: frames(11) });
      play(10);
      expect(tracker.advance(machine, registers, ring, track, frames(10)).action).toBe('none');

      play(1);
      expect(tracker.advance(machine, registers, ring, track, frames(11))).toEqual({
        action: 'due-unheld',
        frame: 10,
      });
    });
  });

  describe('a change of loop named for a lap', () => {
    // With the player's lead, as the lap it changes is timed exactly like any other.
    beforeEach(() => {
      tracker = createActiveLoopTracker({ wrapLeadFrames: 1 });
    });

    const next = { startFrame: frames(60), endFrame: frames(90) };
    const imageAt = (at: number): PositionAnchor => ({
      frame: frames(at),
      ...runUnbrokenTo(frames(at)),
    });

    it('is refused when no loop is running', () => {
      expect(tracker.changeAt(frames(100), next, imageAt(60))).toBe(false);
      expect(tracker.pendingChange()).toBeNull();
      expect(tracker.get()).toBeNull();
    });

    it('ends the running loop at the named frame at once, leaving its entry image and queue alone', () => {
      const entry = imageAt(10);
      tracker.set({ startFrame: frames(10), endFrame: frames(200), varispeedStart: 'stop' });
      tracker.setEntryImage(entry);
      tracker.queue({ startFrame: frames(80), loop: null });

      expect(tracker.changeAt(frames(100), next, imageAt(60))).toBe(true);

      expect(tracker.get()).toEqual({ startFrame: 10, endFrame: 100, varispeedStart: 'stop' });
      expect(tracker.pendingChange()).toEqual({ atFrame: 100, loop: next });
      expect(tracker.entryImage()).toBe(entry);
    });

    it('wraps one frame before the named frame into the new loop’s start, as a lap', () => {
      tracker.set({ startFrame: frames(10), endFrame: frames(200) });
      tracker.changeAt(frames(100), next, imageAt(60));
      play(98);
      expect(tracker.advance(machine, registers, ring, track, frames(98))).toEqual({
        action: 'none',
      });

      play(1);
      const result = tracker.advance(machine, registers, ring, track, frames(99));

      expect(result).toEqual({ action: 'looped', frame: 60 });
      expect(liveState()).toEqual(runUnbrokenTo(frames(60)));
      expect(tracker.get()).toEqual(next);
      expect(tracker.pendingChange()).toBeNull();
      expect(tracker.entryImage()?.frame).toBe(60);
    });

    it('laps the new loop through the image it took over with', () => {
      tracker.set({ startFrame: frames(10), endFrame: frames(200) });
      tracker.changeAt(frames(100), next, imageAt(60));
      play(99);
      tracker.advance(machine, registers, ring, track, frames(99));
      play(29); // 60 up to the frame before the new loop's end, one lead short of it

      const result = tracker.advance(machine, registers, ring, track, frames(89));

      expect(result).toEqual({ action: 'looped', frame: 60 });
      expect(liveState()).toEqual(runUnbrokenTo(frames(60)));
    });

    it('lands on the next advance when it is named at or behind the wrap point', () => {
      tracker.set({ startFrame: frames(10), endFrame: frames(200) });
      play(150);

      tracker.changeAt(frames(100), next, imageAt(60));

      expect(tracker.advance(machine, registers, ring, track, frames(150))).toEqual({
        action: 'looped',
        frame: 60,
      });
    });

    it('is replaced by a change named later, which the lap then follows', () => {
      const later = { startFrame: frames(30), endFrame: frames(50) };
      tracker.set({ startFrame: frames(10), endFrame: frames(200) });
      tracker.changeAt(frames(100), next, imageAt(60));
      tracker.changeAt(frames(120), later, imageAt(30));
      play(99);
      expect(tracker.advance(machine, registers, ring, track, frames(99)).action).toBe('none');

      play(20);
      const result = tracker.advance(machine, registers, ring, track, frames(119));

      expect(result).toEqual({ action: 'looped', frame: 30 });
      expect(tracker.get()).toEqual(later);
    });

    it('gives way to a queued jump, which lands in its place and drops it', () => {
      tracker.set({ startFrame: frames(10), endFrame: frames(200) });
      tracker.queue({
        startFrame: frames(80),
        loop: { startFrame: frames(80), endFrame: frames(95) },
      });
      tracker.setQueuedImage(imageAt(80));
      tracker.changeAt(frames(100), next, imageAt(60));
      play(99);

      const result = tracker.advance(machine, registers, ring, track, frames(99));

      expect(result).toEqual({ action: 'handed-off', frame: 80 });
      expect(tracker.get()).toEqual({ startFrame: 80, endFrame: 95 });
      expect(tracker.pendingChange()).toBeNull();
    });

    it('is dropped by set', () => {
      tracker.set({ startFrame: frames(10), endFrame: frames(200) });
      tracker.changeAt(frames(100), next, imageAt(60));

      tracker.set({ startFrame: frames(10), endFrame: frames(150) });

      expect(tracker.pendingChange()).toBeNull();
      play(120);
      expect(tracker.advance(machine, registers, ring, track, frames(120)).action).toBe('none');
    });

    it('is cancelled by giving the loop back the end it had before the first change', () => {
      tracker.set({ startFrame: frames(10), endFrame: frames(200) });
      tracker.changeAt(frames(100), next, imageAt(60));
      tracker.changeAt(frames(120), next, imageAt(60));

      tracker.cancelChange();

      expect(tracker.pendingChange()).toBeNull();
      expect(tracker.get()).toEqual({ startFrame: 10, endFrame: 200 });
      tracker.cancelChange();
      expect(tracker.get()).toEqual({ startFrame: 10, endFrame: 200 });
    });
  });

  describe('a queued hand-off’s beforeLanding', () => {
    const imageAt = (at: number): PositionAnchor => ({
      frame: frames(at),
      ...runUnbrokenTo(frames(at)),
    });

    it('is called once, before the queued image is restored, and not on a lap of the new loop', () => {
      const restore = vi.spyOn(machine, 'restore');
      const restoreValues = vi.spyOn(registers, 'restoreValues');
      const beforeLanding = vi.fn();
      tracker.set({ startFrame: frames(10), endFrame: frames(100) });
      tracker.queue({
        startFrame: frames(60),
        loop: { startFrame: frames(60), endFrame: frames(90) },
        beforeLanding,
      });
      tracker.setQueuedImage(imageAt(60));
      play(100);

      const result = tracker.advance(machine, registers, ring, track, frames(100));

      expect(result).toEqual({ action: 'handed-off', frame: 60 });
      expect(beforeLanding).toHaveBeenCalledTimes(1);
      expect(beforeLanding.mock.invocationCallOrder[0]).toBeLessThan(
        restore.mock.invocationCallOrder[0],
      );
      expect(beforeLanding.mock.invocationCallOrder[0]).toBeLessThan(
        restoreValues.mock.invocationCallOrder[0],
      );

      play(30);
      expect(tracker.advance(machine, registers, ring, track, frames(90)).action).toBe('looped');
      expect(beforeLanding).toHaveBeenCalledTimes(1);
    });

    it('is not called on a lap while the queued target has no image, only on the landing', () => {
      const beforeLanding = vi.fn();
      tracker.set({ startFrame: frames(10), endFrame: frames(100) });
      tracker.queue({ startFrame: frames(60), loop: null, beforeLanding });
      play(100);

      expect(tracker.advance(machine, registers, ring, track, frames(100)).action).toBe(
        'due-unheld',
      );
      expect(beforeLanding).not.toHaveBeenCalled();

      play(90);
      tracker.setQueuedImage(imageAt(60));
      expect(tracker.advance(machine, registers, ring, track, frames(100)).action).toBe(
        'handed-off',
      );
      expect(beforeLanding).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['a cancel', (next: ActiveLoopTracker) => next.queue(null)],
      [
        'a replace',
        (next: ActiveLoopTracker) => next.queue({ startFrame: frames(70), loop: null }),
      ],
      [
        'a set',
        (next: ActiveLoopTracker) => next.set({ startFrame: frames(10), endFrame: frames(100) }),
      ],
    ])('is never called once the queue that carried it has gone to %s', (_, drop) => {
      const beforeLanding = vi.fn();
      tracker.set({ startFrame: frames(10), endFrame: frames(100) });
      tracker.queue({ startFrame: frames(60), loop: null, beforeLanding });
      tracker.setQueuedImage(imageAt(60));

      drop(tracker);
      tracker.setQueuedImage(imageAt(70));
      play(100);
      tracker.advance(machine, registers, ring, track, frames(100));

      expect(beforeLanding).not.toHaveBeenCalled();
    });
  });

  describe('a loop whose length is not a whole number of frames', () => {
    // With the player's lead: every lap's gate-off takes its last slot, so a lap takes as many
    // ticks as it has frames.
    beforeEach(() => {
      tracker = createActiveLoopTracker({ wrapLeadFrames: 1 });
    });

    const imageAt = (at: number): PositionAnchor => ({
      frame: frames(at),
      ...runUnbrokenTo(frames(at)),
    });

    /** The playhead at frame 10 with the loop just entered there: held for its gate-off. */
    function enteredAtTen(): void {
      play(10);
      tracker.setEntryImage(imageAt(10));
    }

    /**
     * Ticks the way the player does — the tick after a wrap is the gate-off its re-entry owes, which
     * plays nothing — from a lap's start, held, until `laps` wraps have happened. Returns the ticks
     * each lap took.
     */
    function ticksPerLap(laps: number): number[] {
      const taken: number[] = [];
      let ticks = 0;
      let gateOff = true;
      while (taken.length < laps && ticks < 1000) {
        ticks++;
        if (gateOff) {
          gateOff = false;
          continue;
        }
        play(1);
        const result = tracker.advance(machine, registers, ring, track, frames(position));
        if (result.action === 'looped' || result.action === 'handed-off') {
          taken.push(ticks);
          ticks = 0;
          gateOff = true;
          position = result.frame;
        }
      }
      return taken;
    }

    it.each([
      [0, [4, 3, 4, 3, 4, 3]],
      [0.5, [3, 4, 3, 4, 3, 4]],
      [31.5, [3, 4, 3, 4, 3, 4]],
      [0.25, [4, 3, 4, 3, 4, 3]],
      [0.75, [3, 4, 3, 4, 3, 4]],
    ])('laps 3.5 frames at lap phase %s as alternating whole laps', (lapPhase, laps) => {
      enteredAtTen();
      tracker.set({ startFrame: frames(10), endFrame: frames(13.5), lapPhase });

      expect(ticksPerLap(6)).toEqual(laps);
      expect(tracker.get()).toEqual({ startFrame: 10, endFrame: 13.5, lapPhase });
    });

    it('takes exactly eight laps’ worth of ticks over eight laps, and so on for every length', () => {
      for (const [length, laps, ticks] of [
        [3.5, 8, 28],
        [3.5, 16, 56],
        [2.75, 4, 11],
        [2.5, 2, 5],
        [3.125, 8, 25],
        [6.25, 4, 25],
      ] as const) {
        tracker = createActiveLoopTracker({ wrapLeadFrames: 1 });
        position = 10;
        tracker.setEntryImage(imageAt(10));
        tracker.set({ startFrame: frames(10), endFrame: frames(10 + length) });

        const taken = ticksPerLap(laps);
        expect(taken.reduce((sum, lap) => sum + lap, 0)).toBe(ticks);
        // And each lap ends on the frame the grid's own line rounds to.
        let at = 0;
        taken.forEach((lap, index) => {
          at += lap;
          expect(at).toBe(Math.round((index + 1) * length));
        });
      }
    });

    it('laps a whole length as it always has, whatever the lap phase', () => {
      enteredAtTen();
      tracker.set({ startFrame: frames(10), endFrame: frames(14), lapPhase: 0.5 });

      expect(ticksPerLap(4)).toEqual([4, 4, 4, 4]);
      expect(tracker.lapPhase()).toBe(0.5);
    });

    it('moves the lap phase on by the length with each lap it takes, and reports it', () => {
      enteredAtTen();
      tracker.set({ startFrame: frames(10), endFrame: frames(12.75), lapPhase: 0.25 });

      expect(tracker.lapPhase()).toBe(0.25);
      ticksPerLap(1);
      expect(tracker.lapPhase()).toBe(0);
      ticksPerLap(1);
      expect(tracker.lapPhase()).toBe(0.75);
      tracker.set(null);
      expect(tracker.lapPhase()).toBeNull();
    });

    it('moves the lap phase on for a lap due with no image held, and not for a seek that failed', () => {
      tracker.set({ startFrame: frames(80), endFrame: frames(83.5) });
      play(83);

      expect(tracker.advance(machine, registers, ring, track, frames(83))).toEqual({
        action: 'due-unheld',
        frame: 80,
      });
      expect(tracker.lapPhase()).toBe(0.5);

      ring.reset();
      expect(tracker.advance(machine, registers, ring, track, frames(83))).toEqual({
        action: 'none',
      });
      expect(tracker.lapPhase()).toBe(0.5);
    });

    it('starts lap 0 again on set, from the phase the new loop carries', () => {
      enteredAtTen();
      tracker.set({ startFrame: frames(10), endFrame: frames(13.5) });
      expect(ticksPerLap(1)).toEqual([4]);

      // Carried on, the next lap would be 3, 4, 3.
      tracker.set({ startFrame: frames(10), endFrame: frames(13.5), lapPhase: 0.25 });
      expect(tracker.lapPhase()).toBe(0.25);
      expect(ticksPerLap(3)).toEqual([4, 3, 4]);

      tracker.set({ startFrame: frames(10), endFrame: frames(20.5) });
      expect(ticksPerLap(2)).toEqual([11, 10]);
      tracker.set({ startFrame: frames(10), endFrame: frames(13.5) });
      expect(ticksPerLap(2)).toEqual([4, 3]);
    });

    it('keeps the lap in progress when the loop already running is set again', () => {
      enteredAtTen();
      tracker.set({ startFrame: frames(10), endFrame: frames(13.5), varispeedStart: 'stop' });
      expect(ticksPerLap(1)).toEqual([4]);

      tracker.set({ startFrame: frames(10), endFrame: frames(13.5), varispeedStart: 'wrap' });

      expect(tracker.lapPhase()).toBe(0.5);
      expect(ticksPerLap(2)).toEqual([3, 4]);
      expect(tracker.get()?.varispeedStart).toBe('wrap');
    });

    it('puts the lap in progress where a landing says', () => {
      enteredAtTen();
      tracker.set({ startFrame: frames(10), endFrame: frames(13.5) });

      tracker.setLapPhase(2.5);
      tracker.setLapPhase(Number.NaN);

      expect(tracker.lapPhase()).toBe(0.5);
      expect(ticksPerLap(3)).toEqual([3, 4, 3]);
    });

    describe('a queued loop landing', () => {
      /** 2.75 frames at 60, queued at a lap phase of a quarter: from there it would lap 3, 3, 3, 2. */
      const next = { startFrame: frames(60), endFrame: frames(62.75), lapPhase: 0.25 };

      function queueNext(): void {
        tracker.queue({ startFrame: frames(60), loop: next });
        tracker.setQueuedImage(imageAt(60));
      }

      it('laps on from the lap the running loop would have begun, not from its own phase', () => {
        enteredAtTen();
        tracker.set({ startFrame: frames(10), endFrame: frames(13.5) });
        queueNext();

        expect(ticksPerLap(1)).toEqual([4]);
        // The 3.5 lap of 4 at phase 0 would have been followed by one at a half.
        expect(tracker.lapPhase()).toBe(0.5);
        // 2.75 from a half: 2, 3, 3, 3 — still eleven frames in four laps.
        expect(ticksPerLap(4)).toEqual([2, 3, 3, 3]);
      });

      it('reports the queued loop as it was handed in, and set of it carries the lap on', () => {
        enteredAtTen();
        tracker.set({ startFrame: frames(10), endFrame: frames(13.5) });
        queueNext();
        ticksPerLap(1);

        expect(tracker.get()).toBe(next);
        expect(tracker.lapPhaseOf({ startFrame: frames(60), endFrame: frames(62.75) })).toBe(0.5);

        tracker.set({ ...next, varispeedStart: 'wrap' });

        expect(tracker.lapPhase()).toBe(0.5);
        expect(ticksPerLap(4)).toEqual([2, 3, 3, 3]);
      });

      it('carries a whole running loop’s phase on as it stands', () => {
        enteredAtTen();
        tracker.set({ startFrame: frames(10), endFrame: frames(14), lapPhase: 0.5 });
        queueNext();

        expect(ticksPerLap(1)).toEqual([4]);
        expect(tracker.lapPhase()).toBe(0.5);
        expect(ticksPerLap(4)).toEqual([2, 3, 3, 3]);
      });

      it('laps a whole length as it always has, whatever phase it takes', () => {
        enteredAtTen();
        tracker.set({ startFrame: frames(10), endFrame: frames(13.5) });
        tracker.queue({
          startFrame: frames(60),
          loop: { startFrame: frames(60), endFrame: frames(67) },
        });
        tracker.setQueuedImage(imageAt(60));

        expect(ticksPerLap(4)).toEqual([4, 7, 7, 7]);
        expect(tracker.lapPhase()).toBe(0.5);
      });

      it('lands in place of a change named, from the change’s own phase', () => {
        enteredAtTen();
        tracker.set({ startFrame: frames(10), endFrame: frames(17) });
        tracker.changeAt(
          frames(14),
          { startFrame: frames(10), endFrame: frames(13.5), lapPhase: 0.5 },
          imageAt(10),
        );
        queueNext();

        expect(ticksPerLap(1)).toEqual([4]);
        expect(tracker.get()).toBe(next);
        expect(tracker.pendingChange()).toBeNull();
        expect(tracker.lapPhase()).toBe(0.5);
        expect(ticksPerLap(4)).toEqual([2, 3, 3, 3]);
      });

      it("starts at lap 0 of its own phase when it lands from the track's own loop", () => {
        track.setTrackStructure({
          loopStartFrame: null,
          loopPeriodFrames: null,
          endedAtFrame: frames(20),
        });
        track.setRepeatEnabled(true);
        play(19);
        expect(tracker.advance(machine, registers, ring, track, frames(19))).toEqual({
          action: 'looped',
          frame: 0,
        });
        position = 0;
        queueNext();

        expect(ticksPerLap(1)).toEqual([20]);
        expect(tracker.get()).toBe(next);
        expect(tracker.lapPhase()).toBe(0.25);
        expect(ticksPerLap(4)).toEqual([3, 3, 3, 2]);
      });
    });

    describe('a change named for a lap', () => {
      const next = { startFrame: frames(10), endFrame: frames(17) };

      it('ends the lap in progress at the frame it is named for', () => {
        enteredAtTen();
        tracker.set({ startFrame: frames(10), endFrame: frames(13.5), lapPhase: 0.5 });

        expect(tracker.changeAt(frames(12), next, imageAt(10))).toBe(true);

        expect(tracker.get()).toEqual({ startFrame: 10, endFrame: 12 });
        expect(tracker.pendingChange()).toEqual({ atFrame: 12, loop: next });
        expect(ticksPerLap(3)).toEqual([2, 7, 7]);
        expect(tracker.get()).toBe(next);
      });

      it('lands at the end of the lap in progress when it is named past it', () => {
        enteredAtTen();
        tracker.set({ startFrame: frames(10), endFrame: frames(13.5), lapPhase: 0.5 });

        expect(tracker.changeAt(frames(14), next, imageAt(10))).toBe(true);

        expect(tracker.get()).toEqual({ startFrame: 10, endFrame: 13 });
        expect(tracker.pendingChange()).toEqual({ atFrame: 13, loop: next });
        expect(ticksPerLap(2)).toEqual([3, 7]);
      });

      it('starts the new loop at lap 0 of its own phase as it lands', () => {
        enteredAtTen();
        tracker.set({ startFrame: frames(10), endFrame: frames(17) });

        tracker.changeAt(
          frames(14),
          { startFrame: frames(10), endFrame: frames(13.5), lapPhase: 0.5 },
          imageAt(10),
        );

        expect(ticksPerLap(4)).toEqual([4, 3, 4, 3]);
      });

      it('never clamps a whole-length loop, which reads as ending at the frame named', () => {
        tracker.set({ startFrame: frames(10), endFrame: frames(14) });

        tracker.changeAt(frames(16), next, imageAt(10));

        expect(tracker.get()).toEqual({ startFrame: 10, endFrame: 16 });
        expect(tracker.pendingChange()).toEqual({ atFrame: 16, loop: next });
      });

      it('is cancelled back to the loop it changed and the lap that loop was in', () => {
        enteredAtTen();
        const running = { startFrame: frames(10), endFrame: frames(13.5) };
        tracker.set(running);
        expect(ticksPerLap(1)).toEqual([4]);

        tracker.changeAt(frames(12), next, imageAt(10));
        tracker.cancelChange();

        expect(tracker.get()).toBe(running);
        expect(tracker.pendingChange()).toBeNull();
        expect(tracker.lapPhase()).toBe(0.5);
        expect(ticksPerLap(3)).toEqual([3, 4, 3]);
      });
    });

    it('refuses a length under two frames that is not whole, changing nothing', () => {
      const running = { startFrame: frames(10), endFrame: frames(20) };
      tracker.set(running);

      expect(tracker.set({ startFrame: frames(10), endFrame: frames(11.5) })).toBe(false);
      expect(tracker.get()).toBe(running);
      expect(
        tracker.changeAt(
          frames(15),
          { startFrame: frames(10), endFrame: frames(11.75) },
          imageAt(10),
        ),
      ).toBe(false);
      expect(tracker.pendingChange()).toBeNull();
      expect(
        tracker.queue({
          startFrame: frames(60),
          loop: { startFrame: frames(60), endFrame: frames(61.5) },
        }),
      ).toBe(false);
      expect(tracker.get()).toBe(running);

      // A whole length runs as it always has, a one-frame loop included.
      expect(tracker.set({ startFrame: frames(10), endFrame: frames(11) })).toBe(true);
      expect(tracker.set({ startFrame: frames(10), endFrame: frames(12) })).toBe(true);
    });
  });
});

describe('lap arithmetic', () => {
  it('gives each lap its whole frames, telescoping to the rounded total', () => {
    expect([0, 1, 2, 3].map((lap) => lapLength(0, 3.5, lap))).toEqual([4, 3, 4, 3]);
    expect([0, 1, 2, 3].map((lap) => lapLength(0.5, 3.5, lap))).toEqual([3, 4, 3, 4]);
    expect([0, 1, 2, 3].map((lap) => lapLength(0, 7, lap))).toEqual([7, 7, 7, 7]);
    expect(lapSpan(0, 3.5, 8)).toBe(28);
    expect(lapSpan(0.5, 2.75, 4)).toBe(11);
    expect(lapSpan(31.5, 3.5, 3)).toBe(
      lapLength(31.5, 3.5, 0) + lapLength(31.5, 3.5, 1) + lapLength(31.5, 3.5, 2),
    );
  });

  it('reduces a phase to its fractional part, and one that is not a number to 0', () => {
    expect(reduceLapPhase(31.5)).toBe(0.5);
    expect(reduceLapPhase(-0.25)).toBe(0.75);
    expect(reduceLapPhase(-0)).toBe(0);
    expect(reduceLapPhase(Number.NaN)).toBe(0);
    expect(lapPhaseAfter(0, 3.5, 3)).toBe(0.5);
  });

  it('counts the whole laps that fit in a span, from any phase', () => {
    for (const length of [2.5, 2.75, 3.125, 3.5, 7]) {
      for (const phase of [0, 0.25, 0.5, 0.875]) {
        for (let span = 0; span <= 80; span++) {
          let laps = 0;
          while (lapSpan(phase, length, laps + 1) <= span) laps++;
          expect(lapsWithin(phase, length, span)).toBe(laps);
        }
      }
    }
  });

  it('refuses only a length that is not whole and is under two frames', () => {
    expect(isUsableLoopLength(10, 11.5)).toBe(false);
    expect(isUsableLoopLength(10, 11.999)).toBe(false);
    expect(isUsableLoopLength(10, 12)).toBe(true);
    expect(isUsableLoopLength(10, 12.5)).toBe(true);
    expect(isUsableLoopLength(10, 11)).toBe(true);
    expect(isUsableLoopLength(10, 10)).toBe(true);
  });
});
