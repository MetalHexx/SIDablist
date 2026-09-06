import { beforeEach, describe, expect, it } from 'vitest';
import { C64Machine, type MachineSnapshot } from '../cpu/c64-machine.js';
import { RegisterFrame, type RegisterValuesSnapshot } from '../registers/register-frame.js';
import { runFramesTo } from '../replay/run-frames.js';
import type { SidFile } from '../sid/sid-file.model.js';
import { frames, type Frames } from '../units.js';
import { createAnchorRing, type AnchorRing, type PositionAnchor } from './anchor-ring.js';
import { createActiveLoopTracker, type ActiveLoopTracker } from './active-loop.js';
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
  const registers = new RegisterFrame();
  const machine = new C64Machine(counterTune(), registers);
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
    registers = new RegisterFrame();
    machine = new C64Machine(counterTune(), registers);
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

  it('re-enters the active loop at the exact start frame through the anchor ring', () => {
    tracker.set({ startFrame: frames(75), endFrame: frames(140) });
    play(140);

    const result = tracker.advance(machine, registers, ring, track, frames(140));

    expect(result).toEqual({ action: 'looped', frame: 75 });
    expect(liveState()).toEqual(runUnbrokenTo(frames(75)));
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

  it("arms and enters the track's own loop when it ends and repeat is on", () => {
    track.setTrackStructure({
      loopStartFrame: frames(20),
      loopPeriodFrames: frames(80),
      endedAtFrame: null,
    });
    track.setRepeatEnabled(true);
    play(100); // trackEndFrame is 20 + 80

    const result = tracker.advance(machine, registers, ring, track, frames(100));

    expect(result).toEqual({ action: 'looped', frame: 20 });
    expect(tracker.get()).toEqual({ startFrame: 20, endFrame: 100 });
    expect(liveState()).toEqual(runUnbrokenTo(frames(20)));
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

    play(80); // from frame 20 back up to frame 100
    const result = tracker.advance(machine, registers, ring, track, frames(100));

    expect(result).toEqual({ action: 'looped', frame: 20 });
    expect(liveState()).toEqual(runUnbrokenTo(frames(20)));
  });
});
