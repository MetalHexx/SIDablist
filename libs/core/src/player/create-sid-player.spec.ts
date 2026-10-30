import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  NTSC_CYCLES_PER_FRAME,
  PAL_CYCLES_PER_FRAME,
  PLAY_BUDGET_FRAMES,
} from '../cpu/cpu-constants.js';
import type { FrameClock, FrameClockStats } from '../ports/clock.js';
import { NTSC_PHI2_HZ, PAL_PHI2_HZ, clockRatio } from '../registers/clock-ratio.js';
import { applyFrameToChip, recordFromTune } from '../registers/__fixtures__/record-from-tune.js';
import type { RegisterRecord } from '../registers/register-record.js';
import type { SidFrame } from '../registers/sid-frame.js';
import {
  PAL_FRAME_INTERVAL_US,
  SID_REGISTER_COUNT,
  VOICE_CONTROL_REGISTERS,
} from '../registers/sid-constants.js';
import type { ReplayRequest, ReplayResponse, ReplayRunner } from '../replay/replay-runner.js';
import { replayToFrame } from '../replay/replay-to-frame.js';
import type { SidClock, SidFile, SidModel } from '../sid/sid-file.model.js';
import { FakeClock } from '../testing/fake-clock.js';
import { FakeSink } from '../testing/fake-sink.js';
import { frames, microseconds, milliseconds } from '../units.js';
import type { Microseconds, Milliseconds } from '../units.js';
import { createSidPlayer } from './create-sid-player.js';
import { createDeliveryBatch } from './delivery-history.js';
import type { DeliveryBatch } from './delivery-history.js';
import type { SidPlayer, VarispeedRateSource } from './sid-player.js';
import type { JumpSettings, QueuedJump } from './snapshot.js';

/**
 * Counts every `runFrame()` call across every `C64Machine` this test file's code creates — the live
 * ticking machine and any throwaway one a replay builds alike — the same cross-instance visibility
 * `C64Machine.prototype` spying gave before the class became a factory-built, unexported internal.
 * Reset with `runFrameSpy.mockClear()` at the point a test wants to start counting from.
 */
const { runFrameSpy } = vi.hoisted(() => ({ runFrameSpy: vi.fn() }));

vi.mock('../cpu/c64-machine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cpu/c64-machine.js')>();
  return {
    ...actual,
    createC64Machine: (
      ...args: Parameters<typeof actual.createC64Machine>
    ): ReturnType<typeof actual.createC64Machine> => {
      const machine = actual.createC64Machine(...args);
      return new Proxy(machine, {
        get(target, prop) {
          if (prop === 'runFrame') {
            return () => {
              runFrameSpy();
              return target.runFrame();
            };
          }
          return Reflect.get(target, prop, target);
        },
      });
    },
  };
});

/** Answers every request against the real `replayToFrame`, immediately — the landing is what these
 *  tests are about, not the thread it crosses. `manual` holds requests until `resolveAll()`, which
 *  is what lets a test see what a second runner does while this one is busy. */
class FakeReplayRunner implements ReplayRunner {
  readonly requests: ReplayRequest[] = [];
  disposed = false;
  disposeCount = 0;
  manual = false;
  private readonly held: (() => void)[] = [];

  run(request: ReplayRequest): Promise<ReplayResponse> {
    this.requests.push(request);
    if (this.manual) {
      return new Promise<ReplayResponse>((resolve) => {
        this.held.push(() => resolve(answer(request)));
      });
    }
    return Promise.resolve(answer(request));
  }

  dispose(): void {
    this.disposed = true;
    this.disposeCount++;
  }

  resolveAll(): void {
    this.held.splice(0).forEach((resolve) => resolve());
  }
}

function answer(request: ReplayRequest): ReplayResponse {
  try {
    return {
      id: request.id,
      ok: true,
      result: replayToFrame(
        request.file,
        request.subtune,
        request.targetFrame,
        request.mutes,
        request.start,
      ),
    };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** `FakeSink` plus the order the control path reached it in — the sequence is the contract for a
 *  pause (gate-off, then end) and for a clock that fails after `begin` has gone out. */
class RecordingSink extends FakeSink {
  readonly calls: string[] = [];

  override begin(tune: { readonly chipModel: SidModel }): void {
    this.calls.push('begin');
    super.begin(tune);
  }

  override end(): void {
    this.calls.push('end');
    super.end();
  }

  override deliver(
    frame: SidFrame,
    frameNumber: ReturnType<typeof frames>,
    dueAtMs: Milliseconds,
    catchUpClamped: boolean,
  ): void {
    this.calls.push('deliver');
    super.deliver(frame, frameNumber, dueAtMs, catchUpClamped);
  }

  override deliverNow(frame: SidFrame): void {
    this.calls.push('deliverNow');
    super.deliverNow(frame);
  }

  override retime(intervalUs: Microseconds): void {
    this.calls.push('retime');
    super.retime(intervalUs);
  }

  override reset(): void {
    this.calls.push('reset');
    super.reset();
  }
}

/** A clock whose `start` rejects, standing in for the audio graph a real clock rides refusing to
 *  resume — the one path where `begin` has gone out and no frame ever will. */
class FailingClock implements FrameClock {
  start(): Promise<void> {
    return Promise.reject(new Error('the audio context refused to resume'));
  }
  setIntervalUs(): void {
    // never reached: nothing paces after a start that rejected
  }
  stop(): void {
    // never reached
  }
  get stats(): FrameClockStats {
    return {
      framesEmitted: 0,
      measuredMeanIntervalUs: microseconds(0),
      nominalIntervalUs: microseconds(0),
      driftMs: milliseconds(0),
      jitterMs: milliseconds(0),
      worstGapMs: milliseconds(0),
      lateCallbacks: 0,
    };
  }
}

interface CodeBlock {
  readonly at: number;
  readonly bytes: readonly number[];
}

function tune(options: {
  songs?: number;
  clock?: SidClock;
  model?: SidModel;
  blocks: readonly CodeBlock[];
}): SidFile {
  const loadAddress = 0x1000;
  const codeEnd = options.blocks.reduce(
    (end, block) => Math.max(end, block.at + block.bytes.length),
    loadAddress,
  );
  const data = new Uint8Array(codeEnd - loadAddress);
  for (const block of options.blocks) {
    data.set(block.bytes, block.at - loadAddress);
  }
  return {
    format: 'PSID',
    version: 2,
    loadAddress,
    initAddress: loadAddress,
    playAddress: 0x1010,
    songs: options.songs ?? 1,
    startSong: 1,
    speedFlags: 0,
    name: '',
    author: '',
    released: '',
    clock: options.clock ?? 'pal',
    model: options.model ?? 'unknown',
    secondSidAddress: null,
    thirdSidAddress: null,
    data,
  };
}

const RTS = 0x60;

/** init and play both return at once and touch no register. */
function silentTune(songs = 1, model: SidModel = 'unknown'): SidFile {
  return tune({
    songs,
    model,
    blocks: [
      { at: 0x1000, bytes: [RTS] },
      { at: 0x1010, bytes: [RTS] },
    ],
  });
}

/** init increments a zero-page counter and stores it into $D400 every play call, so the frame a
 *  replay landed on can be read back off the delivered frame. Its play routine costs the same
 *  handful of cycles whichever clock it is told to run under — only the budget it is measured
 *  against moves with `clock`. */
function counterTune(clock: SidClock = 'pal'): SidFile {
  return tune({
    clock,
    blocks: [
      { at: 0x1000, bytes: [RTS] },
      { at: 0x1010, bytes: [0xe6, 0xfb, 0xa5, 0xfb, 0x8d, 0x00, 0xd4, RTS] },
    ],
  });
}

/** play writes `value` to $D418 (volume/filter-mode) every call, so a gain or a forced filter mode
 *  scaling it is readable off `getStats().emitted`. */
function volumeTune(value: number): SidFile {
  return tune({
    blocks: [
      { at: 0x1000, bytes: [RTS] },
      { at: 0x1010, bytes: [0xa9, value, 0x8d, 0x18, 0xd4, RTS] }, // LDA #value; STA $D418; RTS
    ],
  });
}

/** init programs CIA 1 timer A to a latch of $1FFD, so 19656 / 8190 = 2.4 calls per frame — a rate
 *  that does not divide the frame evenly, which is exactly the case `exactCallsPerFrame` exists to
 *  report correctly and `callsPerFrame` rounds away. */
function fractionalSpeedTune(): SidFile {
  return tune({
    blocks: [
      { at: 0x1000, bytes: [0xa9, 0xfd, 0x8d, 0x04, 0xdc, 0xa9, 0x1f, 0x8d, 0x05, 0xdc, RTS] },
      { at: 0x1010, bytes: [RTS] },
    ],
  });
}

/** play holds voice 1's gate open every call — a tune whose voice control register is worth
 *  reading, unlike one that never writes it. */
function gateTune(): SidFile {
  return tune({
    blocks: [
      { at: 0x1000, bytes: [RTS] },
      { at: 0x1010, bytes: [0xa9, 0x41, 0x8d, 0x04, 0xd4, RTS] }, // LDA #$41; STA $D404; RTS
    ],
  });
}

/** play writes voice 0's frequency pair every call, so the bytes the correction rewrites are
 *  readable off the delivered frame. */
function frequencyTune(low: number, high: number): SidFile {
  return tune({
    blocks: [
      { at: 0x1000, bytes: [RTS] },
      // LDA #low; STA $D400; LDA #high; STA $D401; RTS
      { at: 0x1010, bytes: [0xa9, low, 0x8d, 0x00, 0xd4, 0xa9, high, 0x8d, 0x01, 0xd4, RTS] },
    ],
  });
}

/** play writes voice 0's pulse width — low byte to $D402, high nibble to $D403 — every call. */
function pulseWidthTune(low: number, high: number): SidFile {
  return tune({
    blocks: [
      { at: 0x1000, bytes: [RTS] },
      // LDA #low; STA $D402; LDA #high; STA $D403; RTS
      { at: 0x1010, bytes: [0xa9, low, 0x8d, 0x02, 0xd4, 0xa9, high, 0x8d, 0x03, 0xd4, RTS] },
    ],
  });
}

/** init programs CIA 1 timer A for exactly two play calls per frame. */
function doubleSpeedTune(): SidFile {
  return tune({
    blocks: [
      { at: 0x1000, bytes: [0xa9, 0x63, 0x8d, 0x04, 0xdc, 0xa9, 0x26, 0x8d, 0x05, 0xdc, RTS] },
      { at: 0x1010, bytes: [RTS] },
    ],
  });
}

/** The play routine never returns, so the first frame burns its whole cycle budget. */
function runawayTune(): SidFile {
  return tune({
    blocks: [
      { at: 0x1000, bytes: [RTS] },
      { at: 0x1010, bytes: [0x4c, 0x10, 0x10] }, // JMP $1010
    ],
  });
}

interface Harness {
  readonly player: SidPlayer;
  readonly sink: RecordingSink;
  readonly clock: FakeClock;
  readonly replay: FakeReplayRunner;
}

function harness(): Harness {
  const sink = new RecordingSink();
  const clock = new FakeClock();
  const replay = new FakeReplayRunner();
  return { player: createSidPlayer({ sink, clock, replayRunner: replay }), sink, clock, replay };
}

interface SplitHarness extends Harness {
  readonly prepare: FakeReplayRunner;
}

/** A player whose prepared builds run on a runner of their own, the way a second worker would. */
function splitHarness(): SplitHarness {
  const sink = new RecordingSink();
  const clock = new FakeClock();
  const replay = new FakeReplayRunner();
  const prepare = new FakeReplayRunner();
  return {
    player: createSidPlayer({ sink, clock, replayRunner: replay, prepareRunner: prepare }),
    sink,
    clock,
    replay,
    prepare,
  };
}

/** init sets voice 0's control register once and play never touches it again, so a state captured
 *  while that voice was muted stays silent after an unmute for as long as nothing rebuilds it. */
function heldNoteTune(): SidFile {
  return tune({
    blocks: [
      { at: 0x1000, bytes: [0xa9, 0x41, 0x8d, 0x04, 0xd4, RTS] }, // LDA #$41; STA $D404; RTS
      { at: 0x1010, bytes: [0xe6, 0xfb, 0xa5, 0xfb, 0x8d, 0x00, 0xd4, RTS] },
    ],
  });
}

/** The byte the tune last wrote to `register`, read off the live register shadow. */
function writtenRegister(player: SidPlayer, register: number): number {
  const written = new Uint8Array(SID_REGISTER_COUNT);
  player.readRegisters(written, new Uint8Array(SID_REGISTER_COUNT));
  return written[register];
}

function preparedFrames(player: SidPlayer): readonly number[] | undefined {
  return player.getSnapshot().tune?.preparedFrames;
}

/** Ticks `count` frames, each one interval apart on the same rising timeline a real clock reports. */
function run(clock: FakeClock, count: number, from = 0): void {
  for (let index = 0; index < count; index++) {
    clock.tick(milliseconds(performance.now() + from + index));
  }
}

/** Drains every pending microtask, however deep the chain — what settles an entry-image capture
 *  fired without being awaited (`setActiveLoop`, `setTrackStructure`), since `FakeReplayRunner`
 *  still resolves through real promises rather than answering synchronously. */
function flushEntryImageCapture(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function lastDelivered(sink: RecordingSink): SidFrame {
  const delivered = sink.deliveredFrames;
  return delivered[delivered.length - 1].frame;
}

function lastDeliveredNow(sink: RecordingSink): SidFrame {
  const delivered = sink.deliveredNowFrames;
  return delivered[delivered.length - 1];
}

/** The byte a frame carries for `register`, or undefined when it carries none — a frame holds the
 *  writes that were made, in the order they were made, so a register is found by number. */
function valueOf(frame: SidFrame, register: number): number | undefined {
  for (let index = 0; index < frame.count; index++) {
    if (frame.registers[index] === register) return frame.values[index];
  }
  return undefined;
}

describe('createSidPlayer', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  describe('the transport state machine', () => {
    it('walks stopped, playing, paused, playing and back to stopped', async () => {
      const { player, clock } = harness();
      player.loadTune(silentTune());
      expect(player.getSnapshot().transport).toBe('stopped');

      await player.play();
      expect(player.getSnapshot().transport).toBe('playing');

      player.pause();
      expect(player.getSnapshot().transport).toBe('paused');

      await player.play();
      run(clock, 1);
      expect(player.getSnapshot().transport).toBe('playing');

      player.stop();
      expect(player.getSnapshot().transport).toBe('stopped');
    });

    it('reports ended rather than stopped when the track plays through with repeat off, leaving the playhead where it finished', async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      player.setTrackStructure({
        loopStartFrame: null,
        loopPeriodFrames: null,
        endedAtFrame: frames(3),
      });
      player.setRepeatTrack(false);

      await player.play();
      run(clock, 3);

      expect(player.getSnapshot().transport).toBe('ended');
      expect(player.getPosition()).toBe(3);
    });

    it('resets the playhead on stop, which reaching the end of the track deliberately does not', async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      player.setTrackStructure({
        loopStartFrame: null,
        loopPeriodFrames: null,
        endedAtFrame: frames(3),
      });
      await player.play();
      run(clock, 3);

      player.stop();

      expect(player.getPosition()).toBe(0);
    });

    it('restarts from the top when play is pressed from ended', async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      player.setTrackStructure({
        loopStartFrame: null,
        loopPeriodFrames: null,
        endedAtFrame: frames(2),
      });
      await player.play();
      run(clock, 2);
      expect(player.getSnapshot().transport).toBe('ended');

      await player.play();
      run(clock, 1);

      expect(player.getSnapshot().transport).toBe('playing');
      expect(player.getPosition()).toBe(1);
    });

    it('wraps the track instead of ending it while repeat is on, arming the track loop as it goes', async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      player.setTrackStructure({
        loopStartFrame: frames(0),
        loopPeriodFrames: frames(3),
        endedAtFrame: null,
      });
      player.setRepeatTrack(true);

      await player.play();
      run(clock, 3);

      expect(player.getSnapshot().transport).toBe('playing');
      expect(player.getPosition()).toBe(0);
      expect(player.getSnapshot().loop).toEqual({ startFrame: 0, endFrame: 3 });
    });

    it('fails with no tune loaded, reporting why', async () => {
      const { player } = harness();

      await player.play();

      expect(player.getSnapshot().transport).toBe('error');
      expect(player.getSnapshot().error).toContain('no tune');
    });

    it('fails when the play routine never returns, and stops the clock behind it', async () => {
      const { player, clock } = harness();
      player.loadTune(runawayTune());

      await player.play();
      run(clock, 1);

      expect(player.getSnapshot().transport).toBe('error');
      expect(() => run(clock, 1)).toThrow();
    });
  });

  describe("a loop's entry image", () => {
    // A wrap owes the stream a resync (`queueResync`'s `gateOffOwed`), which the tick immediately
    // after a wrap spends delivering a gate-off frame instead of running the play routine — one
    // tick with no `runFrame` call of its own, on every wrap, fast path or slow. Each case below
    // ticks past that one first, so the batch it measures is unbroken real ticks throughout.

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("captures a newly armed loop's own re-entry image off-thread, so its first wrap restores instantly rather than replaying from the frame-0 seed", async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      await player.play();

      const deepStart = 500; // far enough in that a replay from frame 0 would run hundreds of frames
      run(clock, deepStart);
      player.setActiveLoop({ startFrame: frames(deepStart), endFrame: frames(deepStart + 10) });
      await flushEntryImageCapture();

      run(clock, 9); // up to, but not touching, the loop's end

      runFrameSpy.mockClear();
      run(clock, 1); // crosses the loop's end and re-enters its start on this same tick

      // One call for the tick's own frame and nothing more — a seek along the anchor path would have
      // cost extra calls proportional to how far back the newest usable anchor sat, and once this
      // loop has laid long enough that only the frame-0 seed remains usable that cost is `deepStart`.
      expect(runFrameSpy).toHaveBeenCalledTimes(1);
      expect(player.getPosition()).toBe(deepStart);
    });

    it("costs nothing on a loop's very first trigger when capturePosition seeded its entry image before the loop was ever armed", async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      await player.play();

      const deepStart = 500; // far enough in that a replay from frame 0 would run hundreds of frames
      run(clock, deepStart);
      // The performer is already sitting here — capturing it is a memory copy, not a replay — and
      // this loop has never been armed before, so there is no prior activity to have warmed the
      // cache any other way.
      player.capturePosition();

      runFrameSpy.mockClear();
      player.setActiveLoop({ startFrame: frames(deepStart), endFrame: frames(deepStart + 10) });
      await player.seek(frames(deepStart));

      // Arming and seeking straight back to a loop's own start is exactly what a trigger does. With
      // no eager capture this would fall back to `captureActiveLoopEntry`'s off-thread replay; with
      // it, `setActiveLoop` finds the image already cached and `seek` restores from it directly.
      expect(runFrameSpy).not.toHaveBeenCalled();
      expect(player.getPosition()).toBe(deepStart);
    });

    it('keeps re-entering instantly on every later lap, not only the first', async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      await player.play();

      const deepStart = 500;
      run(clock, deepStart);
      player.setActiveLoop({ startFrame: frames(deepStart), endFrame: frames(deepStart + 10) });
      await flushEntryImageCapture();

      run(clock, 10); // first wrap: 500 -> 510 -> back to 500
      run(clock, 1); // the gate-off tick the first wrap owed the stream

      runFrameSpy.mockClear();
      run(clock, 10); // second wrap in full: every one of these ticks is a real one

      expect(runFrameSpy).toHaveBeenCalledTimes(10);
      expect(player.getPosition()).toBe(deepStart);
    });

    it("reverts to the track's own loop's cached entry once a marker loop that borrowed the slot is cleared", async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      player.setTrackStructure({
        loopStartFrame: frames(500),
        loopPeriodFrames: frames(50),
        endedAtFrame: null,
      });
      player.setRepeatTrack(true);
      await player.play();
      await flushEntryImageCapture(); // lets the track's own loop capture its entry image

      run(clock, 550); // plays through the track's own end and wraps back to its start
      expect(player.getSnapshot().loop).toEqual({ startFrame: 500, endFrame: 550 });
      expect(player.getPosition()).toBe(500);

      // Borrow the tracker's entry-image slot for a marker loop, then hand it back before the
      // marker loop's own capture has any chance to resolve.
      player.setActiveLoop({ startFrame: frames(10), endFrame: frames(20) });
      player.setActiveLoop(null);
      run(clock, 1); // the gate-off tick the earlier wrap owed the stream

      runFrameSpy.mockClear();
      run(clock, 50); // back around to the track loop's own end again

      expect(runFrameSpy).toHaveBeenCalledTimes(50);
      expect(player.getPosition()).toBe(500);
    });

    it('re-enters a loop it already holds an image for without replaying, and still owes the stream its gate-off and resync', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(counterTune());
      await player.play();

      const deepStart = 500;
      run(clock, deepStart);
      player.setActiveLoop({ startFrame: frames(deepStart), endFrame: frames(deepStart + 10) });
      await flushEntryImageCapture();
      run(clock, 3); // a few frames into the lap, so the jump back is a real move

      runFrameSpy.mockClear();
      await player.seek(frames(deepStart));

      // A trigger, a start audition and a queued hand-off all resolve to exactly this jump. Nothing
      // is emulated for it: the generic path would have replayed from the frame-0 seed, since a loop
      // that only ever revisits its own range keeps no usable anchor on the ring.
      expect(runFrameSpy).not.toHaveBeenCalled();
      expect(player.getPosition()).toBe(deepStart);

      run(clock, 1);
      expect(lastDelivered(sink).count).toBe(VOICE_CONTROL_REGISTERS.length);
      run(clock, 1);
      expect(lastDelivered(sink).count).toBe(25);
    });

    it('hands over to a loop engaged earlier without replaying, rather than keeping only the newest image', async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      await player.play();

      const first = { startFrame: frames(400), endFrame: frames(410) };
      const second = { startFrame: frames(600), endFrame: frames(610) };
      run(clock, 700);
      player.setActiveLoop(first);
      await flushEntryImageCapture();
      player.setActiveLoop(second);
      await flushEntryImageCapture();

      // Arming a loop and jumping to its own start is what a lap-boundary hand-off does; the loop
      // handed back to here is the one whose image a single-image cache would have thrown away.
      runFrameSpy.mockClear();
      player.setActiveLoop(first);
      await player.seek(first.startFrame);

      expect(runFrameSpy).not.toHaveBeenCalled();
      expect(player.getPosition()).toBe(400);
    });

    it('leaves a target that is not the image’s own frame on the generic path', async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      await player.play();

      const deepStart = 500;
      run(clock, deepStart);
      player.setActiveLoop({ startFrame: frames(deepStart), endFrame: frames(deepStart + 10) });
      await flushEntryImageCapture();

      // A scrub landing anywhere but that one frame — applying the image here would put the playhead
      // ten frames from where it was asked for.
      runFrameSpy.mockClear();
      await player.seek(frames(deepStart + 10));

      expect(runFrameSpy).toHaveBeenCalled();
      expect(player.getPosition()).toBe(deepStart + 10);
    });
  });

  describe('what a transport halt does to the loop', () => {
    it('disarms the loop on stop, so a fresh play runs past where the lap used to wrap', async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      await player.play();
      player.setActiveLoop({ startFrame: frames(10), endFrame: frames(20) });
      run(clock, 5);

      player.stop();

      expect(player.getSnapshot().loop).toBeNull();

      await player.play();
      run(clock, 25);

      expect(player.getPosition()).toBe(25);
    });

    it('keeps the loop armed across a pause, so a resume plays back into the same lap', async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      await player.play();
      player.setActiveLoop({ startFrame: frames(2), endFrame: frames(6) });
      run(clock, 3);

      player.pause();

      expect(player.getSnapshot().loop).toEqual({ startFrame: 2, endFrame: 6 });

      await player.play();
      run(clock, 3); // reaches the loop's end and re-enters its start

      expect(player.getPosition()).toBe(2);
    });
  });

  describe("the sink's control path", () => {
    it("begins the sink with the tune's own chip model, before the first frame", async () => {
      const { player, sink, clock } = harness();
      player.loadTune(silentTune(1, 'mos8580'));

      await player.play();

      expect(sink.beginCalls).toEqual([{ chipModel: 'mos8580' }]);
      expect(sink.deliveredFrames).toHaveLength(0);

      run(clock, 1);
      expect(sink.deliveredFrames).toHaveLength(1);
    });

    it('gates every voice off immediately, then ends the sink, on pause', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(gateTune());
      await player.play();
      run(clock, 2);

      player.pause();

      const gateOff = lastDeliveredNow(sink);
      expect(gateOff.count).toBe(VOICE_CONTROL_REGISTERS.length);
      for (const register of VOICE_CONTROL_REGISTERS) {
        expect(valueOf(gateOff, register)).toBe(0);
      }
      expect(sink.calls.slice(-2)).toEqual(['deliverNow', 'end']);
    });

    it('ends the sink exactly once on each of the paths that close a session', async () => {
      for (const close of [
        (player: SidPlayer): void => player.stop(),
        (player: SidPlayer): void => player.dispose(),
        (player: SidPlayer): void => player.loadTune(silentTune()),
      ]) {
        const { player, sink, clock } = harness();
        player.loadTune(silentTune());
        await player.play();
        run(clock, 1);

        close(player);

        expect(sink.endCallCount).toBe(1);
      }
    });

    it('ends the sink exactly once when the track plays through to its end', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(counterTune());
      player.setTrackStructure({
        loopStartFrame: null,
        loopPeriodFrames: null,
        endedAtFrame: frames(2),
      });
      await player.play();
      run(clock, 2);

      expect(player.getSnapshot().transport).toBe('ended');
      expect(sink.endCallCount).toBe(1);
    });

    it('ends the sink when the clock fails to start, since begin has already gone out', async () => {
      const sink = new RecordingSink();
      const player = createSidPlayer({
        sink,
        clock: new FailingClock(),
        replayRunner: new FakeReplayRunner(),
      });
      player.loadTune(silentTune());

      await player.play();

      expect(sink.calls.slice(-2)).toEqual(['begin', 'end']);
      expect(player.getSnapshot().transport).toBe('error');
    });

    it('leaves the sink alone on a stop with no tune ever loaded', () => {
      const { player, sink } = harness();

      player.stop();

      expect(sink.endCallCount).toBe(0);
    });
  });

  describe('tempo and the clock', () => {
    it('halves the interval at double tempo, on the clock and on the sink, while playing', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(silentTune());
      await player.play();
      expect(clock.stats.nominalIntervalUs).toBe(PAL_FRAME_INTERVAL_US);

      player.setTempo(2);

      expect(clock.stats.nominalIntervalUs).toBe(PAL_FRAME_INTERVAL_US / 2);
      expect(sink.retimeCalls).toEqual([PAL_FRAME_INTERVAL_US / 2]);
    });

    it('leaves the clock alone while stopped, and starts the next run at the tempo asked for', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(silentTune());

      player.setTempo(0.5);

      expect(sink.retimeCalls).toHaveLength(0);
      await player.play();
      expect(clock.stats.nominalIntervalUs).toBe(PAL_FRAME_INTERVAL_US / 0.5);
    });

    it('ignores a tempo that cannot be divided by', async () => {
      const { player, clock } = harness();
      player.loadTune(silentTune());
      await player.play();

      player.setTempo(0);
      player.setTempo(Number.NaN);

      expect(player.getSnapshot().tempo.multiplier).toBe(1);
      expect(clock.stats.nominalIntervalUs).toBe(PAL_FRAME_INTERVAL_US);
    });

    it('ticks a multispeed tune faster rather than batching its play calls', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(doubleSpeedTune());

      await player.play();
      run(clock, 1);

      expect(clock.stats.nominalIntervalUs).toBe(PAL_FRAME_INTERVAL_US / 2);
      expect(sink.deliveredFrames).toHaveLength(1);
      expect(player.getSnapshot().tempo.callsPerFrame).toBe(2);
    });

    it('re-resolves the running clock when the timing mode changes, with no reload', async () => {
      const { player, clock } = harness();
      player.loadTune(doubleSpeedTune());
      await player.play();

      player.setTimingMode('rounded');

      expect(player.getSnapshot().tempo.timingMode).toBe('rounded');
      expect(clock.stats.nominalIntervalUs).toBe(PAL_FRAME_INTERVAL_US / 2);
    });
  });

  describe('seeking', () => {
    it('lands the playhead while playing, then owes the stream a gate-off and a resync', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(counterTune());
      await player.play();
      run(clock, 2);

      await player.seek(frames(10));

      expect(player.getPosition()).toBe(10);

      run(clock, 1);
      const gateOff = lastDelivered(sink);
      expect(gateOff.count).toBe(VOICE_CONTROL_REGISTERS.length);

      run(clock, 1);
      const resync = lastDelivered(sink);
      expect(resync.count).toBe(25);
      expect(valueOf(resync, 0)).toBe(11); // the counter ran one frame past the landing
    });

    it('resyncs at once with the voice gates forced off when it lands while paused', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(gateTune());
      await player.play();
      run(clock, 2);
      player.pause();

      await player.seek(frames(10));

      const resync = lastDeliveredNow(sink);
      expect(resync.count).toBe(25);
      expect(valueOf(resync, VOICE_CONTROL_REGISTERS[0])).toBe(0);
    });

    it('resyncs at once with the true voice state when it lands while stopped', async () => {
      const { player, sink } = harness();
      player.loadTune(gateTune());

      await player.seek(frames(10));

      const resync = lastDeliveredNow(sink);
      expect(resync.count).toBe(25);
      expect(valueOf(resync, VOICE_CONTROL_REGISTERS[0])).toBe(0x41);
    });

    it('resolves a target before the start of the tune to frame 0 rather than erroring', async () => {
      const { player } = harness();
      player.loadTune(counterTune());

      await player.seek(frames(-40));

      expect(player.getPosition()).toBe(0);
      expect(player.getSnapshot().transport).not.toBe('error');
    });
  });

  describe('voices', () => {
    it('composes the latched and held states as an exclusive-or, in both directions', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(gateTune());
      await player.play();
      run(clock, 1);
      expect(valueOf(lastDelivered(sink), 4)).toBe(0x41);

      // The mute forces the control register to 0 once, then drops every further write to it.
      player.setVoiceMuted(0, true);
      run(clock, 1);
      expect(valueOf(lastDelivered(sink), 4)).toBe(0);
      run(clock, 1);
      expect(valueOf(lastDelivered(sink), 4)).toBeUndefined();

      // Held on top of latched cancels back out: the tune's write reaches the chip again.
      player.setVoiceHeld(0, true);
      run(clock, 1);
      expect(valueOf(lastDelivered(sink), 4)).toBe(0x41);

      player.setVoiceHeld(0, false);
      run(clock, 2);
      expect(valueOf(lastDelivered(sink), 4)).toBeUndefined();

      expect(player.getSnapshot().voices[0]).toEqual({ muted: true, held: false });
    });

    it('clears the latched mutes without disturbing a held voice', () => {
      const { player } = harness();
      player.loadTune(gateTune());
      player.setVoiceMuted(0, true);
      player.setVoiceMuted(1, true);
      player.setVoiceHeld(1, true);

      player.clearVoiceMutes();

      expect(player.getSnapshot().voices).toEqual([
        { muted: false, held: false },
        { muted: false, held: true },
        { muted: false, held: false },
      ]);
    });

    it('ignores a voice outside the chip', () => {
      const { player } = harness();
      player.loadTune(gateTune());

      player.setVoiceMuted(-1, true);
      player.setVoiceHeld(3, true);

      expect(player.getSnapshot().voices).toEqual([
        { muted: false, held: false },
        { muted: false, held: false },
        { muted: false, held: false },
      ]);
    });

    it('starts a fresh tune unmuted and unheld', async () => {
      const { player, clock } = harness();
      player.loadTune(gateTune());
      await player.play();
      run(clock, 1);
      player.setVoiceMuted(0, true);
      player.setVoiceHeld(1, true);

      player.loadTune(gateTune());

      expect(player.getSnapshot().voices).toEqual([
        { muted: false, held: false },
        { muted: false, held: false },
        { muted: false, held: false },
      ]);
    });
  });

  describe('pitch correction', () => {
    it('carries a target clock through to the register shadow', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(frequencyTune(0x34, 0x12)); // 0x1234
      player.setTargetClock(PAL_PHI2_HZ, NTSC_PHI2_HZ);

      await player.play();
      run(clock, 1);

      const frame = lastDelivered(sink);
      expect(valueOf(frame, 0)).toBe(0x89); // 0x1189
      expect(valueOf(frame, 1)).toBe(0x11);
    });

    it('survives a tune load, which starts a register shadow at home', async () => {
      const { player, sink, clock } = harness();
      player.setTargetClock(PAL_PHI2_HZ, NTSC_PHI2_HZ);
      player.setVoicePitch(0, 2);

      player.loadTune(frequencyTune(0x34, 0x12));
      await player.play();
      run(clock, 1);

      const frame = lastDelivered(sink);
      expect(valueOf(frame, 0)).toBe(0x12); // 0x2312
      expect(valueOf(frame, 1)).toBe(0x23);
    });

    it('composes a voice pitch with the correction without either disturbing the other', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(frequencyTune(0x34, 0x12));
      player.setTargetClock(PAL_PHI2_HZ, NTSC_PHI2_HZ);
      await player.play();

      player.setVoicePitch(0, 2);
      run(clock, 1);
      expect(valueOf(lastDelivered(sink), 1)).toBe(0x23);

      // The pitch comes home; the correction it never touched is still in force.
      player.setVoicePitch(0, 1);
      run(clock, 1);
      expect(valueOf(lastDelivered(sink), 1)).toBe(0x11);
    });

    it('leaves the tunes own bytes alone with the clocks matched and the pitch at 1', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(frequencyTune(0x34, 0x12));
      player.setTargetClock(NTSC_PHI2_HZ, NTSC_PHI2_HZ);
      player.setVoicePitch(0, 1);

      await player.play();
      run(clock, 1);

      const frame = lastDelivered(sink);
      expect(valueOf(frame, 0)).toBe(0x34);
      expect(valueOf(frame, 1)).toBe(0x12);
    });

    it('ignores a clock pair it cannot divide and a voice outside the chip', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(frequencyTune(0x34, 0x12));

      player.setTargetClock(0, NTSC_PHI2_HZ);
      player.setTargetClock(PAL_PHI2_HZ, Number.NaN);
      player.setVoicePitch(3, 0.5);
      player.setVoicePitch(0, 0);

      await player.play();
      run(clock, 1);

      const frame = lastDelivered(sink);
      expect(valueOf(frame, 0)).toBe(0x34);
      expect(valueOf(frame, 1)).toBe(0x12);
    });
  });

  describe('subtunes', () => {
    it('resets the playhead and adopts the subtune, leaving repeat-track alone', async () => {
      const { player, clock } = harness();
      player.loadTune(silentTune(3));
      player.setRepeatTrack(true);
      await player.play();
      run(clock, 5);
      expect(player.getPosition()).toBe(5);

      player.selectSubtune(2);

      expect(player.getPosition()).toBe(0);
      expect(player.getSnapshot().tune).toEqual({
        subtune: 2,
        subtuneCount: 3,
        lengthFrames: null,
        preparedFrames: [],
        queuedJump: null,
        handOffs: 0,
        recordedFrames: null,
      });
      expect(player.getSnapshot().repeatTrack).toBe(true);
    });

    it("clamps a subtune to the tune's own range", () => {
      const { player } = harness();
      player.loadTune(silentTune(2));

      player.selectSubtune(9);
      expect(player.getSnapshot().tune?.subtune).toBe(2);

      player.selectSubtune(0);
      expect(player.getSnapshot().tune?.subtune).toBe(1);
    });

    it('carries every register again on the first frame after a subtune change', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(silentTune(3));
      await player.play();
      run(clock, 2);
      expect(lastDelivered(sink).count).toBe(0);

      player.selectSubtune(2);
      run(clock, 1);

      expect(lastDelivered(sink).count).toBe(25);
    });

    it('steps to the next and previous subtune, clamped to the tune range', () => {
      const { player } = harness();
      player.loadTune(silentTune(3));

      player.nextSubtune();
      expect(player.getSnapshot().tune?.subtune).toBe(2);

      player.previousSubtune();
      player.previousSubtune(); // already at the bottom — clamps rather than wrapping
      expect(player.getSnapshot().tune?.subtune).toBe(1);
    });
  });

  describe('delivery measurement', () => {
    it('counts a clamped frame as clamped, and still counts its lag', async () => {
      const { player, clock } = harness();
      player.loadTune(silentTune());
      await player.play();

      clock.tick(milliseconds(performance.now()), true);
      clock.tick(milliseconds(performance.now()), false);

      const { delivery } = player.getStats();
      expect(delivery.clampedFrames).toBe(1);
      expect(delivery.scheduledFrames).toBe(2);
    });

    it('counts a frame due earlier than its predecessor as reordered', async () => {
      const { player, clock } = harness();
      player.loadTune(silentTune());
      await player.play();

      clock.tick(milliseconds(1000));
      clock.tick(milliseconds(500));
      clock.tick(milliseconds(1500));

      expect(player.getStats().delivery.reorderedFrames).toBe(1);
    });

    it('counts a frame handed over more than one interval past due as late, and one handed over on time as not', async () => {
      const { player, clock } = harness();
      player.loadTune(silentTune());
      await player.play();

      clock.tick(milliseconds(performance.now()));
      expect(player.getStats().delivery.lateFrames).toBe(0);

      clock.tick(milliseconds(performance.now() - 500));
      expect(player.getStats().delivery.lateFrames).toBe(1);
    });

    it('reports the lag in milliseconds, with the worst reading never under the mean', async () => {
      const { player, clock } = harness();
      player.loadTune(silentTune());
      await player.play();

      clock.tick(milliseconds(performance.now() - 40));
      clock.tick(milliseconds(performance.now()));

      const { delivery } = player.getStats();
      expect(delivery.meanLagMs).toBeGreaterThan(0);
      expect(delivery.worstLagMs).toBeGreaterThanOrEqual(delivery.meanLagMs);
      expect(delivery.worstLagMs).toBeGreaterThan(30); // ms, not µs
    });

    it('zeroes the delivery counters for a fresh run rather than carrying the last one forward', async () => {
      const { player, clock } = harness();
      player.loadTune(silentTune());
      await player.play();
      run(clock, 3);
      player.stop();

      await player.play();

      expect(player.getStats().delivery.scheduledFrames).toBe(0);
    });

    it("reads the sink's own counters through instead of recounting them", async () => {
      const { player, sink, clock } = harness();
      sink.setConsumption({ kind: 'known', consumedThroughFrame: frames(2), inFlight: 4 });
      sink.setCapabilities({
        perWriteOffsets: true,
        cancellation: true,
        scheduleAheadMs: null,
        preservesWriteOrder: true,
      });
      player.loadTune(silentTune());
      await player.play();
      run(clock, 3);

      const stats = player.getStats();
      expect(stats.sink.farEnd).toEqual({
        kind: 'known',
        consumedThroughFrame: 2,
        inFlight: 4,
      });
      expect(stats.sink.capabilities.cancellation).toBe(true);
      expect(stats.framesRendered).toBe(3);
    });

    it('leaves the frames a pause or a landed jump sends immediately out of the schedule', async () => {
      const { player, clock } = harness();
      player.loadTune(silentTune());
      await player.play();
      run(clock, 2);

      player.pause();

      expect(player.getStats().delivery.scheduledFrames).toBe(2);
    });
  });

  describe('cpu headroom', () => {
    it("computes headroom against the tune's own PAL or NTSC cycle budget", async () => {
      const pal = harness();
      pal.player.loadTune(counterTune('pal'));
      await pal.player.play();
      run(pal.clock, 1);
      const palStats = pal.player.getStats();
      const palBudget = PAL_CYCLES_PER_FRAME * PLAY_BUDGET_FRAMES;

      const ntsc = harness();
      ntsc.player.loadTune(counterTune('ntsc'));
      await ntsc.player.play();
      run(ntsc.clock, 1);
      const ntscStats = ntsc.player.getStats();
      const ntscBudget = NTSC_CYCLES_PER_FRAME * PLAY_BUDGET_FRAMES;

      // The same play routine costs the same cycles under either clock — only the budget the
      // headroom figure divides it against should differ.
      expect(palStats.cpu.cyclesUsed).toBe(ntscStats.cpu.cyclesUsed);
      expect(palStats.cpu.headroom).toBeCloseTo(1 - palStats.cpu.cyclesUsed / palBudget, 10);
      expect(ntscStats.cpu.headroom).toBeCloseTo(1 - ntscStats.cpu.cyclesUsed / ntscBudget, 10);
      expect(palStats.cpu.headroom).not.toBe(ntscStats.cpu.headroom);
    });

    it('reports full headroom and no cycles spent before any frame has run', () => {
      const { player } = harness();

      expect(player.getStats().cpu).toEqual({ cyclesUsed: 0, headroom: 1 });
    });

    it('reports zero headroom when the play routine burns its whole cycle budget', async () => {
      const { player, clock } = harness();
      player.loadTune(runawayTune());
      await player.play();

      run(clock, 1);

      expect(player.getStats().cpu.headroom).toBe(0);
    });
  });

  describe('voice register stats', () => {
    it('decodes gate and waveform off the live register shadow', async () => {
      const { player, clock } = harness();
      player.loadTune(gateTune()); // writes 0x41 to $D404 every play call — waveform 4, gate on
      await player.play();
      run(clock, 1);

      const { voices } = player.getStats();
      expect(voices[0]).toEqual({ gate: true, waveform: 0x4, frequency: 0, envelope: 0 });
      expect(voices[1]).toEqual({ gate: false, waveform: 0, frequency: 0, envelope: 0 });
      expect(voices[2]).toEqual({ gate: false, waveform: 0, frequency: 0, envelope: 0 });
    });

    it('reports three silent voices before any tune has loaded', () => {
      const { player } = harness();

      expect(player.getStats().voices).toEqual([
        { gate: false, waveform: 0, frequency: 0, envelope: 0 },
        { gate: false, waveform: 0, frequency: 0, envelope: 0 },
        { gate: false, waveform: 0, frequency: 0, envelope: 0 },
      ]);
    });
  });

  describe('emitted register bytes', () => {
    it("reports the tune's raw volume byte as written and the gain-scaled one as sent", async () => {
      const { player, clock } = harness();
      player.loadTune(volumeTune(0x2f));
      player.setOutputGain(0.5);
      await player.play();
      run(clock, 1);

      const { emitted } = player.getStats();
      expect(emitted.written[24]).toBe(0x2f);
      expect(emitted.sent[24]).toBe(0x20 | Math.round(0x0f * 0.5));
      expect(emitted.sent[0]).toBe(emitted.written[0]); // untouched by gain — unchanged
    });

    it('ignores a non-finite or out-of-0…1-range gain rather than let it corrupt the scaled byte', async () => {
      const { player, clock } = harness();
      player.loadTune(volumeTune(0x2f));
      player.setOutputGain(0.5);

      player.setOutputGain(Number.NaN);
      player.setOutputGain(-0.1);
      player.setOutputGain(1.1);
      player.setOutputGain(Number.POSITIVE_INFINITY);

      await player.play();
      run(clock, 1);

      const { emitted } = player.getStats();
      expect(emitted.sent[24]).toBe(0x20 | Math.round(0x0f * 0.5)); // still the last valid gain
    });

    it('matches written and sent, 25 registers wide, before any tune has loaded', () => {
      const { player } = harness();

      const { emitted } = player.getStats();
      expect(emitted.written).toHaveLength(SID_REGISTER_COUNT);
      expect(emitted.sent).toEqual(emitted.written);
    });
  });

  describe('resync in-flight depth', () => {
    it("reports 1 while a landed jump's gate-off is still owed to the stream, 0 once it has gone out", async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      await player.play();
      run(clock, 2);

      await player.seek(frames(10));
      expect(player.getStats().resync.inFlightDepth).toBe(1);

      run(clock, 1); // delivers the gate-off, clearing what was owed
      expect(player.getStats().resync.inFlightDepth).toBe(0);
    });

    it('reports 0 before any jump or loop has ever queued a resync', () => {
      const { player } = harness();

      expect(player.getStats().resync.inFlightDepth).toBe(0);
    });
  });

  describe('the exact play-call rate', () => {
    it('reports the unrounded rate alongside the rounded one once they genuinely disagree', () => {
      const { player } = harness();
      player.loadTune(fractionalSpeedTune());

      const { rate } = player.getStats();
      expect(rate.exactCallsPerFrame).toBeCloseTo(2.4, 5);
      expect(rate.roundedCallsPerFrame).toBe(2);
    });
  });

  describe('field holds', () => {
    /** $D418 as the tune writes it: bit 7 set, filter mode 0b010, volume nibble $F. */
    const TUNE_VOLUME_BYTE = 0xaf;
    const VOLUME_REGISTER = 24;
    const VOLUME_FIELD = { name: 'volume' } as const;
    const FILTER_TYPE_FIELD = { name: 'filterType' } as const;

    it('reaches the delivered frames and the sent bytes until released', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(volumeTune(TUNE_VOLUME_BYTE));
      await player.play();

      player.holdField(VOLUME_FIELD, 5);
      run(clock, 1);
      expect(valueOf(lastDelivered(sink), VOLUME_REGISTER)).toBe(0xa5);
      expect(player.getStats().emitted.sent[VOLUME_REGISTER]).toBe(0xa5);
      expect(player.getStats().emitted.written[VOLUME_REGISTER]).toBe(TUNE_VOLUME_BYTE);

      player.releaseField(VOLUME_FIELD);
      run(clock, 1, 1);
      expect(valueOf(lastDelivered(sink), VOLUME_REGISTER)).toBe(TUNE_VOLUME_BYTE);
      expect(player.getStats().emitted.sent[VOLUME_REGISTER]).toBe(TUNE_VOLUME_BYTE);
    });

    it('is in the first delivered frame of a tune loaded after it was set', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(silentTune());
      player.holdField(VOLUME_FIELD, 3);

      player.loadTune(volumeTune(TUNE_VOLUME_BYTE));
      await player.play();
      run(clock, 1);

      expect(valueOf(sink.deliveredFrames[0].frame, VOLUME_REGISTER)).toBe(0xa3);
    });

    it('is in the first delivered frame after a subtune change', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(silentTune(2));
      player.holdField(VOLUME_FIELD, 7);
      await player.play();
      run(clock, 2);

      player.selectSubtune(2);
      run(clock, 1, 2);

      const frame = lastDelivered(sink);
      expect(frame.count).toBe(25);
      expect(valueOf(frame, VOLUME_REGISTER)).toBe(7);
    });

    it('is absent from the gate-off a seek owes while playing and present in the resync after it', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(counterTune());
      await player.play();
      player.holdField(VOLUME_FIELD, 9);
      run(clock, 2);

      await player.seek(frames(10));

      run(clock, 1);
      const gateOff = lastDelivered(sink);
      expect(gateOff.count).toBe(VOICE_CONTROL_REGISTERS.length);
      expect(valueOf(gateOff, VOLUME_REGISTER)).toBeUndefined();

      run(clock, 1, 1);
      const resync = lastDelivered(sink);
      expect(resync.count).toBe(25);
      expect(valueOf(resync, VOLUME_REGISTER)).toBe(9);
    });

    it('is in the immediate resync of a seek while stopped or paused', async () => {
      const stopped = harness();
      stopped.player.loadTune(counterTune());
      stopped.player.holdField(VOLUME_FIELD, 9);
      await stopped.player.seek(frames(10));
      expect(valueOf(lastDeliveredNow(stopped.sink), VOLUME_REGISTER)).toBe(9);

      const paused = harness();
      paused.player.loadTune(counterTune());
      await paused.player.play();
      paused.player.holdField(VOLUME_FIELD, 9);
      run(paused.clock, 2);
      paused.player.pause();
      await paused.player.seek(frames(10));
      expect(valueOf(lastDeliveredNow(paused.sink), VOLUME_REGISTER)).toBe(9);
    });

    it('carries the filter-type override into the next load, leaving the other bits of $D418 alone', async () => {
      const { player, sink, clock } = harness();
      player.setFilterMode('lowPass');

      player.loadTune(volumeTune(TUNE_VOLUME_BYTE));
      await player.play();
      run(clock, 1);

      const byte = valueOf(sink.deliveredFrames[0].frame, VOLUME_REGISTER);
      expect(byte).toBeDefined();
      expect(((byte ?? 0) >> 4) & 0b111).toBe(0b001);
      expect((byte ?? 0) & 0x80).toBe(0x80);
      expect((byte ?? 0) & 0x0f).toBe(0x0f);
    });

    it('leaves no forced filter mode once the filter-type hold is released, now or on the next load', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(volumeTune(TUNE_VOLUME_BYTE));
      player.setFilterMode('lowPass');

      player.releaseField(FILTER_TYPE_FIELD);
      player.loadTune(volumeTune(TUNE_VOLUME_BYTE));
      await player.play();
      run(clock, 1);

      expect(valueOf(sink.deliveredFrames[0].frame, VOLUME_REGISTER)).toBe(TUNE_VOLUME_BYTE);
      expect(player.getStats().emitted.sent[VOLUME_REGISTER]).toBe(TUNE_VOLUME_BYTE);
    });

    it('lets the filter mode be cleared as well as set through a plain hold of filterType', async () => {
      const { player, sink, clock } = harness();
      player.holdField(FILTER_TYPE_FIELD, 0b100);
      player.setFilterMode(null);

      player.loadTune(volumeTune(TUNE_VOLUME_BYTE));
      await player.play();
      run(clock, 1);

      expect(valueOf(sink.deliveredFrames[0].frame, VOLUME_REGISTER)).toBe(TUNE_VOLUME_BYTE);
    });

    it('warns about a refused value and does not carry it into the next load', async () => {
      const { player, sink, clock } = harness();
      const warn = vi.spyOn(console, 'warn');
      warn.mockClear();

      player.holdField(VOLUME_FIELD, 16);
      player.holdField(VOLUME_FIELD, 5, 1.5);
      player.holdField({ name: 'gate', voice: 3 }, 1);
      expect(warn).toHaveBeenCalledTimes(3);

      player.loadTune(volumeTune(TUNE_VOLUME_BYTE));
      await player.play();
      run(clock, 1);
      expect(valueOf(sink.deliveredFrames[0].frame, VOLUME_REGISTER)).toBe(TUNE_VOLUME_BYTE);
    });

    it('keeps a hold already in place when a replacement is refused', async () => {
      const { player, sink, clock } = harness();
      player.holdField(VOLUME_FIELD, 5);

      player.holdField(VOLUME_FIELD, 99);
      player.loadTune(volumeTune(TUNE_VOLUME_BYTE));
      await player.play();
      run(clock, 1);

      expect(valueOf(sink.deliveredFrames[0].frame, VOLUME_REGISTER)).toBe(0xa5);
    });

    it('warns about a release of a field that does not resolve and carries on', () => {
      const { player } = harness();
      const warn = vi.spyOn(console, 'warn');
      warn.mockClear();

      player.releaseField({ name: 'gate', voice: -1 });

      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('treats one field given as two different objects as a single hold', async () => {
      const { player, sink, clock } = harness();
      player.holdField({ name: 'volume' }, 5);
      player.holdField({ name: 'volume' }, 6);
      player.releaseField({ name: 'volume' });

      player.loadTune(volumeTune(TUNE_VOLUME_BYTE));
      await player.play();
      run(clock, 1);

      expect(valueOf(sink.deliveredFrames[0].frame, VOLUME_REGISTER)).toBe(TUNE_VOLUME_BYTE);
    });

    it('is dropped by dispose', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(volumeTune(TUNE_VOLUME_BYTE));
      player.holdField(VOLUME_FIELD, 5);

      player.dispose();
      player.loadTune(volumeTune(TUNE_VOLUME_BYTE));
      await player.play();
      run(clock, 1);

      expect(valueOf(sink.deliveredFrames[0].frame, VOLUME_REGISTER)).toBe(TUNE_VOLUME_BYTE);
    });
  });

  describe('the read side', () => {
    it('notifies on a discrete change and stays quiet while the playhead moves', async () => {
      const { player, clock } = harness();
      player.loadTune(silentTune());
      await player.play();
      let notifications = 0;
      const unsubscribe = player.subscribe(() => {
        notifications++;
      });

      run(clock, 5);
      expect(notifications).toBe(0);
      expect(player.getPosition()).toBe(5);

      player.pause();
      expect(notifications).toBe(1);

      unsubscribe();
      player.stop();
      expect(notifications).toBe(1);
    });

    it('holds snapshot identity across a change that changes nothing', () => {
      const { player } = harness();
      player.loadTune(silentTune());
      const before = player.getSnapshot();

      player.setRepeatTrack(false);

      expect(player.getSnapshot()).toBe(before);
    });

    it("publishes the tune's measured length, its basis and the loop the application set", () => {
      const { player } = harness();
      player.loadTune(counterTune());

      player.setTrackStructure({
        loopStartFrame: frames(100),
        loopPeriodFrames: frames(400),
        endedAtFrame: null,
      });
      player.setActiveLoop({ startFrame: frames(10), endFrame: frames(20) });

      const snapshot = player.getSnapshot();
      expect(snapshot.tune?.lengthFrames).toBe(500);
      expect(snapshot.basis.trackEndFrame).toBe(500);
      expect(snapshot.basis.positionBasisFrames).toBe(500);
      expect(snapshot.loop).toEqual({ startFrame: 10, endFrame: 20 });
    });

    it('falls back to the fixed ceiling as the basis when detection answered nothing', () => {
      const { player } = harness();
      player.loadTune(counterTune());

      const snapshot = player.getSnapshot();
      expect(snapshot.tune?.lengthFrames).toBeNull();
      expect(snapshot.basis.positionBasisFrames).toBe(snapshot.basis.ceilingFrames);
    });

    it('reports no tune before one is loaded', () => {
      const { player } = harness();

      expect(player.getSnapshot().tune).toBeNull();
      expect(player.getStats().effectiveIntervalUs).toBe(0);
    });
  });

  describe('field offsets', () => {
    const PULSE_LOW_REGISTER = 2;
    const PULSE_HIGH_REGISTER = 3;
    const PULSE_FIELD = { name: 'pulseWidth', voice: 0 } as const;
    /** The tune writes a pulse width of 256 ($100). */
    const TUNE_LOW = 0x00;
    const TUNE_HIGH = 0x01;

    it('reaches the delivered frames and the sent bytes until cleared', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(pulseWidthTune(TUNE_LOW, TUNE_HIGH));
      await player.play();

      player.setFieldOffset(PULSE_FIELD, 512);
      run(clock, 1);
      const frame = lastDelivered(sink);
      expect(valueOf(frame, PULSE_LOW_REGISTER)).toBe(0x00);
      expect(valueOf(frame, PULSE_HIGH_REGISTER)).toBe(0x03);
      expect(player.getStats().emitted.sent[PULSE_HIGH_REGISTER]).toBe(0x03);
      expect(player.getStats().emitted.written[PULSE_HIGH_REGISTER]).toBe(TUNE_HIGH);

      player.clearFieldOffset(PULSE_FIELD);
      run(clock, 1, 1);
      expect(valueOf(lastDelivered(sink), PULSE_HIGH_REGISTER)).toBe(TUNE_HIGH);
      expect(player.getStats().emitted.sent[PULSE_HIGH_REGISTER]).toBe(TUNE_HIGH);
    });

    it('is in the first delivered frame of a tune loaded after it was set', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(silentTune());
      player.setFieldOffset(PULSE_FIELD, 512);

      player.loadTune(pulseWidthTune(TUNE_LOW, TUNE_HIGH));
      await player.play();
      run(clock, 1);

      expect(valueOf(sink.deliveredFrames[0].frame, PULSE_HIGH_REGISTER)).toBe(0x03);
    });

    it('is not carried once set back to 0 or cleared', async () => {
      const { player, sink, clock } = harness();
      player.setFieldOffset(PULSE_FIELD, 512);
      player.setFieldOffset(PULSE_FIELD, 0);
      player.setFieldOffset({ name: 'pulseWidth', voice: 1 }, 512);
      player.clearFieldOffset({ name: 'pulseWidth', voice: 1 });

      player.loadTune(pulseWidthTune(TUNE_LOW, TUNE_HIGH));
      await player.play();
      run(clock, 1);

      expect(valueOf(sink.deliveredFrames[0].frame, PULSE_HIGH_REGISTER)).toBe(TUNE_HIGH);
    });

    it('treats one field given as two different objects as a single offset', async () => {
      const { player, sink, clock } = harness();
      player.setFieldOffset({ name: 'pulseWidth', voice: 0 }, 512);
      player.setFieldOffset({ name: 'pulseWidth', voice: 0 }, 256);
      player.clearFieldOffset({ name: 'pulseWidth', voice: 0 });

      player.loadTune(pulseWidthTune(TUNE_LOW, TUNE_HIGH));
      await player.play();
      run(clock, 1);

      expect(valueOf(sink.deliveredFrames[0].frame, PULSE_HIGH_REGISTER)).toBe(TUNE_HIGH);
    });

    it('is dropped by dispose', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(pulseWidthTune(TUNE_LOW, TUNE_HIGH));
      player.setFieldOffset(PULSE_FIELD, 512);

      player.dispose();
      player.loadTune(pulseWidthTune(TUNE_LOW, TUNE_HIGH));
      await player.play();
      run(clock, 1);

      expect(valueOf(sink.deliveredFrames[0].frame, PULSE_HIGH_REGISTER)).toBe(TUNE_HIGH);
    });

    it.each([
      ['a switch field', { name: 'gate', voice: 0 } as const, 1],
      ['a fraction', PULSE_FIELD, 1.5],
      ['an amount out of range', PULSE_FIELD, 5000],
      ['an unknown field', { name: 'pulseWidth', voice: 3 } as const, 512],
    ])(
      'warns once about %s and leaves an offset already in place alone',
      async (_, field, amount) => {
        const { player, sink, clock } = harness();
        const warn = vi.spyOn(console, 'warn');
        player.setFieldOffset(PULSE_FIELD, 512);
        warn.mockClear();

        player.setFieldOffset(field, amount);
        expect(warn).toHaveBeenCalledTimes(1);

        player.loadTune(pulseWidthTune(TUNE_LOW, TUNE_HIGH));
        await player.play();
        run(clock, 1);
        expect(valueOf(sink.deliveredFrames[0].frame, PULSE_HIGH_REGISTER)).toBe(0x03);
      },
    );

    it('warns once about a release of a field that does not resolve and carries on', () => {
      const { player } = harness();
      const warn = vi.spyOn(console, 'warn');
      warn.mockClear();

      player.clearFieldOffset({ name: 'gate', voice: -1 });

      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('readRegisters', () => {
    const REGISTER_COUNT = 25;

    it('fills both buffers with zeros when nothing is loaded', () => {
      const { player } = harness();
      const written = new Uint8Array(REGISTER_COUNT).fill(0xff);
      const sent = new Uint8Array(REGISTER_COUNT).fill(0xff);

      player.readRegisters(written, sent);

      expect(Array.from(written)).toEqual(new Array(REGISTER_COUNT).fill(0));
      expect(Array.from(sent)).toEqual(new Array(REGISTER_COUNT).fill(0));
    });

    it('matches getStats().emitted with a tune loaded, offsets included', async () => {
      const { player, clock } = harness();
      player.loadTune(pulseWidthTune(0x00, 0x01));
      player.setFieldOffset({ name: 'pulseWidth', voice: 0 }, 512);
      await player.play();
      run(clock, 2);
      const written = new Uint8Array(REGISTER_COUNT);
      const sent = new Uint8Array(REGISTER_COUNT);

      player.readRegisters(written, sent);

      const { emitted } = player.getStats();
      expect(Array.from(written)).toEqual(Array.from(emitted.written));
      expect(Array.from(sent)).toEqual(Array.from(emitted.sent));
      expect(sent[3]).toBe(0x03);
      expect(written[3]).toBe(0x01);
    });

    it('refreshes the same buffers on repeated calls', async () => {
      const { player, clock } = harness();
      player.loadTune(pulseWidthTune(0x00, 0x01));
      await player.play();
      run(clock, 1);
      const written = new Uint8Array(REGISTER_COUNT);
      const sent = new Uint8Array(REGISTER_COUNT);
      player.readRegisters(written, sent);
      expect(sent[3]).toBe(0x01);

      player.setFieldOffset({ name: 'pulseWidth', voice: 0 }, 512);
      run(clock, 1, 1);
      player.readRegisters(written, sent);

      expect(sent[3]).toBe(0x03);
      expect(written[3]).toBe(0x01);
    });

    it('throws a RangeError for a buffer shorter than a register file, loaded or not', () => {
      const { player } = harness();
      const ok = new Uint8Array(REGISTER_COUNT);
      const short = new Uint8Array(REGISTER_COUNT - 1);

      expect(() => player.readRegisters(short, ok)).toThrow(RangeError);
      expect(() => player.readRegisters(ok, short)).toThrow(RangeError);

      player.loadTune(silentTune());
      expect(() => player.readRegisters(ok, short)).toThrow(RangeError);
    });
  });

  describe('delivery history', () => {
    /** play writes voice 0's control register twice, `first` then `second`, every call. */
    function doubledControlTune(first: number, second: number): SidFile {
      return tune({
        blocks: [
          { at: 0x1000, bytes: [RTS] },
          // LDA #first; STA $D404; LDA #second; STA $D404; RTS
          {
            at: 0x1010,
            bytes: [0xa9, first, 0x8d, 0x04, 0xd4, 0xa9, second, 0x8d, 0x04, 0xd4, RTS],
          },
        ],
      });
    }

    /** init writes an envelope byte to $D405 and a pulse width high byte to $D403 once; play only
     *  bumps a counter on $D400, so the envelope never appears in a delivered frame again. */
    function initOnceTune(): SidFile {
      return tune({
        blocks: [
          { at: 0x1000, bytes: [0xa9, 0xab, 0x8d, 0x05, 0xd4, 0xa9, 0x08, 0x8d, 0x03, 0xd4, RTS] },
          { at: 0x1010, bytes: [0xe6, 0xfb, 0xa5, 0xfb, 0x8d, 0x00, 0xd4, RTS] },
        ],
      });
    }

    function drain(player: SidPlayer, capacity = 64): DeliveryBatch {
      const batch = createDeliveryBatch(capacity);
      player.drainDeliveries(batch);
      return batch;
    }

    function entryRegisters(batch: DeliveryBatch, entry: number): number[] {
      return Array.from(
        batch.registers.slice(entry * SID_REGISTER_COUNT, (entry + 1) * SID_REGISTER_COUNT),
      );
    }

    function entryControl(batch: DeliveryBatch, entry: number, voice: number): number[] {
      const count = batch.controlCounts[entry * 3 + voice];
      const from = (entry * 3 + voice) * 2;
      return Array.from(batch.controlBytes.slice(from, from + count));
    }

    /** The chip after each delivered frame, applying every frame's writes in order. */
    function chipsAfterEach(delivered: readonly SidFrame[]): number[][] {
      const chip = new Uint8Array(SID_REGISTER_COUNT);
      return delivered.map((frame) => {
        applyFrameToChip(chip, frame);
        return Array.from(chip);
      });
    }

    it('reports nothing, and changes nothing about delivery, until the host asks', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(counterTune());
      await player.play();
      run(clock, 3);
      const batch = createDeliveryBatch(4);
      batch.count = 3;
      batch.dropped = 2;
      batch.restarted = true;

      player.drainDeliveries(batch);

      expect([batch.count, batch.dropped, batch.restarted]).toEqual([0, 0, false]);
      expect(sink.deliveredFrames).toHaveLength(3);
    });

    it('returns the delivered frames oldest first, each with the chip as the deliveries left it and the due time the clock handed over', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(counterTune());
      player.keepDeliveries(64);
      await player.play();
      run(clock, 5);

      const batch = drain(player);

      expect(batch.count).toBe(5);
      const chips = chipsAfterEach(sink.deliveredFrames.map(({ frame }) => frame));
      sink.deliveredFrames.forEach(({ dueAtMs }, index) => {
        expect(entryRegisters(batch, index)).toEqual(chips[index]);
        expect(batch.timesMs[index]).toBe(dueAtMs);
      });
      expect(entryRegisters(batch, 4)[0]).toBe(5);
    });

    it.each([
      ['cuts the gate', 0x40],
      ['changes the waveform', 0x21],
    ])(
      'shows both bytes of a doubled control write, and the second in the register, when the second %s',
      async (_name, second) => {
        const { player, sink, clock } = harness();
        player.loadTune(doubledControlTune(0x41, second));
        player.keepDeliveries(8);
        await player.play();
        run(clock, 2);

        const batch = drain(player);

        expect(batch.count).toBe(2);
        for (let entry = 0; entry < 2; entry++) {
          expect(entryControl(batch, entry, 0)).toEqual([0x41, second]);
          expect(entryRegisters(batch, entry)[4]).toBe(second);
        }
        // The first frame of a run writes all 25 registers; the next writes only what the tune did.
        expect(entryControl(batch, 0, 1)).toEqual([0]);
        expect(entryControl(batch, 1, 1)).toEqual([]);
        const received: number[] = [];
        const sent = sink.deliveredFrames[0].frame;
        for (let index = 0; index < sent.count; index++) {
          if (sent.registers[index] === 4) received.push(sent.values[index]);
        }
        expect(received).toEqual([0x41, second]);
      },
    );

    it('seeds a history switched on mid-play with what the tune wrote once, and says the stream starts there', async () => {
      const { player, clock } = harness();
      player.loadTune(initOnceTune());
      await player.play();
      run(clock, 3);

      player.keepDeliveries(64);
      run(clock, 2, 3);
      const batch = drain(player);

      expect(batch.restarted).toBe(true);
      expect(batch.count).toBe(2);
      for (let entry = 0; entry < 2; entry++) {
        expect(entryRegisters(batch, entry)[5]).toBe(0xab);
        expect(entryRegisters(batch, entry)[3]).toBe(0x08);
      }
      expect(entryRegisters(batch, 1)[0]).toBe(5);
      expect(drain(player).restarted).toBe(false);
    });

    it('seeds again when it is switched off and on', async () => {
      const { player, clock } = harness();
      player.loadTune(initOnceTune());
      await player.play();
      run(clock, 2);
      player.keepDeliveries(8);
      run(clock, 1, 2);
      drain(player);

      player.keepDeliveries(0);
      player.keepDeliveries(8);
      run(clock, 1, 3);
      const batch = drain(player);

      expect(batch.restarted).toBe(true);
      expect(batch.count).toBe(1);
      expect(entryRegisters(batch, 0)[5]).toBe(0xab);
    });

    it("shows a pause's gate-off, and does not restart for it or the resume", async () => {
      const { player, clock } = harness();
      player.loadTune(gateTune());
      player.keepDeliveries(64);
      await player.play();
      run(clock, 2);
      drain(player);
      run(clock, 2, 2);

      player.pause();
      await player.play();
      run(clock, 2, 4);
      const batch = drain(player);

      expect(batch.restarted).toBe(false);
      expect(batch.count).toBe(2 + 1 + 2);
      expect(entryControl(batch, 1, 0)).toEqual([0x41]);
      for (let voice = 0; voice < 3; voice++) {
        expect(entryControl(batch, 2, voice)).toEqual([0]);
      }
      expect(entryRegisters(batch, 2)[4]).toBe(0);
      expect(entryRegisters(batch, 3)[4]).toBe(0x41);
    });

    it("shows a landing's owed gate-off and then its resync, as the first entries of a fresh history", async () => {
      const { player, sink, clock } = harness();
      player.loadTune(gateTune());
      player.keepDeliveries(64);
      await player.play();
      run(clock, 2);

      await player.seek(frames(10));
      run(clock, 2, 2);
      const batch = drain(player);

      expect(batch.restarted).toBe(true);
      expect(batch.count).toBe(2);
      expect(entryControl(batch, 0, 0)).toEqual([0]);
      expect(entryRegisters(batch, 0)[4]).toBe(0);
      const resync = lastDelivered(sink);
      expect(resync.count).toBe(25);
      expect(entryRegisters(batch, 1)).toEqual(chipsAfterEach([resync])[0]);
      expect(entryRegisters(batch, 1)[4]).toBe(0x41);
    });

    it('shows the immediate resync of a landing while paused, gates forced off', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(gateTune());
      player.keepDeliveries(64);
      await player.play();
      run(clock, 2);
      player.pause();
      drain(player);

      await player.seek(frames(10));
      const batch = drain(player);

      expect(batch.restarted).toBe(true);
      expect(batch.count).toBe(1);
      const resync = lastDeliveredNow(sink);
      expect(resync.count).toBe(25);
      expect(entryRegisters(batch, 0)).toEqual(chipsAfterEach([resync])[0]);
      expect(entryRegisters(batch, 0)[4]).toBe(0);
    });

    it("records a loop lap's full re-send as an ordinary entry, without a restart", async () => {
      const { player, sink, clock } = harness();
      player.loadTune(counterTune());
      player.setTrackStructure({
        loopStartFrame: frames(0),
        loopPeriodFrames: frames(3),
        endedAtFrame: null,
      });
      player.setRepeatTrack(true);
      player.keepDeliveries(64);
      await player.play();
      run(clock, 3);
      expect(player.getPosition()).toBe(0);
      drain(player);

      run(clock, 2, 3);
      const batch = drain(player);

      expect(batch.restarted).toBe(false);
      expect(batch.count).toBe(2);
      expect(lastDelivered(sink).count).toBe(25);
      expect(entryRegisters(batch, 1)).toEqual(
        chipsAfterEach(sink.deliveredFrames.map(({ frame }) => frame)).at(-1),
      );
    });

    it('records the record-fed ticks of varispeed', async () => {
      const { player, sink, clock } = harness();
      const file = counterTune();
      player.loadTune(file);
      player.setRegisterRecord(recordFromTune(file, 1, 20));
      player.keepDeliveries(64);
      await player.play();
      run(clock, 2);
      drain(player);
      expect(player.enterVarispeed(() => 1)).toBe(true);

      run(clock, 3, 2);
      const batch = drain(player);

      expect(batch.restarted).toBe(false);
      expect(batch.count).toBe(3);
      const chips = chipsAfterEach(sink.deliveredFrames.map(({ frame }) => frame));
      expect([0, 1, 2].map((entry) => entryRegisters(batch, entry))).toEqual(chips.slice(2));
    });

    it('returns the newest capacity when more were delivered than it holds, with the rest as dropped', async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      player.keepDeliveries(4);
      await player.play();
      run(clock, 10);

      const batch = drain(player, 4);

      expect(batch.count).toBe(4);
      expect(batch.dropped).toBe(6);
      expect([0, 1, 2, 3].map((entry) => entryRegisters(batch, entry)[0])).toEqual([7, 8, 9, 10]);

      run(clock, 3, 10);
      const next = drain(player, 4);
      expect([next.count, next.dropped]).toEqual([3, 0]);
    });

    it('takes the newest entries into a batch smaller than what is pending', async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      player.keepDeliveries(8);
      await player.play();
      run(clock, 6);

      const batch = drain(player, 2);

      expect(batch.count).toBe(2);
      expect(batch.dropped).toBe(4);
      expect([0, 1].map((entry) => entryRegisters(batch, entry)[0])).toEqual([5, 6]);
    });

    it('survives a load, recording the new tune from a fresh history', async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      player.keepDeliveries(8);
      await player.play();
      run(clock, 2);

      player.loadTune(counterTune());
      const afterLoad = drain(player);
      await player.play();
      run(clock, 2);
      const batch = drain(player);

      expect(afterLoad.restarted).toBe(true);
      expect(afterLoad.count).toBe(0);
      expect(batch.count).toBe(2);
      expect(entryRegisters(batch, 0)[0]).toBe(1);
    });

    it.each<[string, (player: SidPlayer) => void | Promise<void>]>([
      ['a load', (player) => player.loadTune(silentTune(2))],
      ['a stop', (player) => player.stop()],
      [
        'a play from stopped',
        async (player) => {
          player.stop();
          drain(player);
          await player.play();
        },
      ],
      ['a subtune change', (player) => player.selectSubtune(2)],
      ['a seek landing', (player) => player.seek(frames(10))],
    ])('restarts on %s, discarding what was kept', async (_name, act) => {
      const { player, clock } = harness();
      player.loadTune(silentTune(2));
      player.keepDeliveries(64);
      await player.play();
      run(clock, 2);
      drain(player);
      run(clock, 2, 2);

      await act(player);
      const batch = drain(player);

      expect(batch.restarted).toBe(true);
      expect(batch.count).toBe(0);
    });

    it('restarts when a queued jump is handed off to, and not for the laps before it', async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      await player.play();
      player.setJumpTargets([frames(500)]);
      player.setActiveLoop({ startFrame: frames(100), endFrame: frames(110) });
      await flushEntryImageCapture();
      player.queueJump({ startFrame: frames(500), endFrame: frames(520) });
      player.keepDeliveries(8);
      const batch = drain(player, 8);
      const handOffs = (): number | undefined => player.getSnapshot().tune?.handOffs;

      let ticks = 0;
      while (handOffs() !== 1 && ticks < 400) {
        run(clock, 1, ticks);
        player.drainDeliveries(batch);
        if (handOffs() !== 1) expect(batch.restarted).toBe(false);
        ticks++;
      }

      expect(handOffs()).toBe(1);
      expect(batch.restarted).toBe(true);
      expect(batch.count).toBe(0);
    });

    it('ignores a capacity it cannot honour, with a warning, and leaves the history as it was', async () => {
      vi.mocked(console.warn).mockClear();
      const { player, clock } = harness();
      player.loadTune(counterTune());
      player.keepDeliveries(8);
      await player.play();
      run(clock, 2);

      for (const unusable of [Number.NaN, -1, Number.POSITIVE_INFINITY, 5000]) {
        player.keepDeliveries(unusable);
      }

      expect(console.warn).toHaveBeenCalledTimes(4);
      expect(drain(player, 8).count).toBe(2);
    });

    it('floors a fractional capacity', async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      player.keepDeliveries(4.9);
      await player.play();
      run(clock, 6);

      const batch = drain(player, 8);

      expect([batch.count, batch.dropped]).toEqual([4, 2]);
    });

    it('keeps what was recorded when the capacity in force is asked for again, and starts afresh for another', async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      player.keepDeliveries(8);
      await player.play();
      run(clock, 2);

      player.keepDeliveries(8);
      expect(drain(player, 8).count).toBe(2);

      run(clock, 2, 2);
      player.keepDeliveries(4);
      const batch = drain(player, 8);
      expect([batch.count, batch.restarted]).toEqual([0, true]);
    });

    it('drops what is kept, and stops keeping, when asked for 0 or disposed', async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      player.keepDeliveries(8);
      await player.play();
      run(clock, 2);

      player.keepDeliveries(0);
      const off = createDeliveryBatch(8);
      off.count = 5;
      off.restarted = true;
      player.drainDeliveries(off);
      expect([off.count, off.restarted]).toEqual([0, false]);

      player.keepDeliveries(8);
      run(clock, 1, 2);
      player.dispose();
      expect(drain(player, 8).count).toBe(0);
    });
  });

  it('releases the replay thread and closes the session when disposed mid-playback', async () => {
    const { player, sink, clock, replay } = harness();
    player.loadTune(silentTune());
    await player.play();
    run(clock, 1);

    player.dispose();

    expect(replay.disposed).toBe(true);
    expect(sink.endCallCount).toBe(1);
    expect(() => run(clock, 1)).toThrow();
  });

  describe('declared jump frames', () => {
    it('makes every declared frame ready, however many, and leaves the playhead and the stream alone', async () => {
      const { player, sink, clock } = harness();
      player.loadTune(counterTune());
      await player.play();
      run(clock, 5);
      const delivered = sink.deliveredFrames.length;

      player.setJumpTargets([900, 100, 500, 300, 700, 50].map((frame) => frames(frame)));
      await flushEntryImageCapture();

      expect(preparedFrames(player)).toEqual([50, 100, 300, 500, 700, 900]);
      expect(player.getPosition()).toBe(5);
      expect(sink.deliveredFrames).toHaveLength(delivered);
      expect(sink.deliveredNowFrames).toHaveLength(0);
    });

    it('notifies as each frame becomes ready, and stays quiet when a declaration changes nothing', async () => {
      const { player } = harness();
      player.loadTune(counterTune());
      const seen: (readonly number[] | undefined)[] = [];
      player.subscribe(() => seen.push(preparedFrames(player)));

      player.setJumpTargets([frames(200), frames(100)]);
      await flushEntryImageCapture();

      expect(seen).toEqual([[100], [100, 200]]);

      const settled = player.getSnapshot();
      player.setJumpTargets([frames(100), frames(200)]);
      await flushEntryImageCapture();

      expect(player.getSnapshot()).toBe(settled);
    });

    it('answers a seek, a lap re-entry and a cue on a ready frame without a replay request', async () => {
      const { player, clock, replay } = harness();
      player.loadTune(counterTune());
      await player.play();
      player.setJumpTargets([frames(100), frames(500)]);
      await flushEntryImageCapture();
      const requests = replay.requests.length;
      runFrameSpy.mockClear();

      await player.seek(frames(500));
      expect(player.getPosition()).toBe(500);

      run(clock, 1); // the gate-off tick the jump owed the stream
      player.setActiveLoop({ startFrame: frames(500), endFrame: frames(510) });
      runFrameSpy.mockClear();
      run(clock, 10); // plays the lap through and re-enters its start on the last tick
      expect(runFrameSpy).toHaveBeenCalledTimes(10);
      expect(player.getPosition()).toBe(500);

      await player.seek(frames(100));
      expect(player.getPosition()).toBe(100);
      expect(replay.requests).toHaveLength(requests);
    });

    it('builds each frame the way a replay from the top would have', async () => {
      const { player } = harness();
      const file = counterTune();
      player.loadTune(file);

      player.setJumpTargets([frames(300), frames(100)]);
      await flushEntryImageCapture();
      await player.seek(frames(300));

      const straight = replayToFrame(file, 1, frames(300), [false, false, false]);
      expect(writtenRegister(player, 0)).toBe(straight.registers.values[0]);
    });

    it('builds in ascending order, each continuing from the one before', async () => {
      const { player, replay } = harness();
      player.loadTune(counterTune());

      player.setJumpTargets([frames(300), frames(100), frames(200)]);
      await flushEntryImageCapture();

      expect(replay.requests.map((request) => request.targetFrame)).toEqual([100, 200, 300]);
      expect(replay.requests.map((request) => request.start?.frame)).toEqual([undefined, 100, 200]);
    });

    it('routes builds to the prepare runner, one at a time, and answers a scrub while one is pending', async () => {
      const { player, replay, prepare } = splitHarness();
      prepare.manual = true;
      player.loadTune(counterTune());

      player.setJumpTargets([frames(200), frames(100)]);

      expect(prepare.requests.map((request) => request.targetFrame)).toEqual([100]);
      expect(replay.requests).toHaveLength(0);

      await player.seek(frames(40));

      expect(player.getPosition()).toBe(40);
      expect(replay.requests.map((request) => request.targetFrame)).toEqual([40]);
      expect(preparedFrames(player)).toEqual([]);

      prepare.resolveAll();
      await flushEntryImageCapture();
      prepare.resolveAll();
      await flushEntryImageCapture();

      expect(preparedFrames(player)).toEqual([100, 200]);
      expect(prepare.requests.map((request) => request.start?.frame)).toEqual([undefined, 100]);
      expect(replay.requests).toHaveLength(1);
    });

    it('seeds every build unmuted, so a frame prepared while a voice is silenced still sounds once it is let back', async () => {
      const { player, replay } = harness();
      player.loadTune(heldNoteTune());
      player.setVoiceMuted(0, true);
      player.setVoiceHeld(1, true);

      player.setJumpTargets([frames(60)]);
      await flushEntryImageCapture();

      expect(replay.requests[0].mutes).toEqual([false, false, false]);

      player.setVoiceMuted(0, false);
      player.setVoiceHeld(1, false);
      await player.seek(frames(60));

      expect(writtenRegister(player, VOICE_CONTROL_REGISTERS[0])).toBe(0x41);
    });

    it('unpublishes a frame the moment it is withdrawn, and sends a seek to it down the generic path', async () => {
      const { player, replay } = harness();
      player.loadTune(counterTune());
      player.setJumpTargets([frames(100), frames(200), frames(300)]);
      await flushEntryImageCapture();

      player.setJumpTargets([frames(200)]);
      expect(preparedFrames(player)).toEqual([200]);

      player.setJumpTargets([]);
      expect(preparedFrames(player)).toEqual([]);

      const requests = replay.requests.length;
      await player.seek(frames(200));
      expect(replay.requests).toHaveLength(requests + 1);
      expect(player.getPosition()).toBe(200);
    });

    it('leaves a running loop on its image when the loop’s start is withdrawn', async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      await player.play();
      player.setJumpTargets([frames(100)]);
      await flushEntryImageCapture();
      run(clock, 100);
      player.setActiveLoop({ startFrame: frames(100), endFrame: frames(110) });

      player.setJumpTargets([]);
      runFrameSpy.mockClear();
      run(clock, 10);

      expect(runFrameSpy).toHaveBeenCalledTimes(10);
      expect(player.getPosition()).toBe(100);
    });

    it('hands the image to a loop armed on a declared start before its build landed', async () => {
      const { player, clock, replay, prepare } = splitHarness();
      prepare.manual = true;
      player.loadTune(counterTune());
      await player.play();
      run(clock, 500);

      player.setJumpTargets([frames(500)]);
      player.setActiveLoop({ startFrame: frames(500), endFrame: frames(510) });
      await flushEntryImageCapture();

      expect(replay.requests).toHaveLength(0);

      prepare.resolveAll();
      await flushEntryImageCapture();
      run(clock, 9);
      runFrameSpy.mockClear();
      run(clock, 1);

      expect(runFrameSpy).toHaveBeenCalledTimes(1);
      expect(player.getPosition()).toBe(500);
    });

    it('discards a build that was running when a new tune was loaded, and builds nothing against the new file', async () => {
      const { player, prepare } = splitHarness();
      prepare.manual = true;
      player.loadTune(counterTune());
      player.setJumpTargets([frames(100)]);

      player.loadTune(silentTune());
      prepare.resolveAll();
      await flushEntryImageCapture();

      expect(preparedFrames(player)).toEqual([]);
      expect(prepare.requests).toHaveLength(1);
    });

    it('clears the declaration with a subtune change, discarding a build still running for it', async () => {
      const { player, prepare } = splitHarness();
      prepare.manual = true;
      player.loadTune(silentTune(3));
      player.setJumpTargets([frames(100)]);

      player.selectSubtune(2);
      prepare.resolveAll();
      await flushEntryImageCapture();

      expect(preparedFrames(player)).toEqual([]);
      expect(prepare.requests).toHaveLength(1);

      player.setJumpTargets([frames(100)]);
      prepare.resolveAll();
      await flushEntryImageCapture();

      expect(preparedFrames(player)).toEqual([100]);
      expect(prepare.requests[1].subtune).toBe(2);
    });

    it('unpublishes ready frames on a load or a subtune change and does not rebuild them', async () => {
      const { player, replay } = harness();
      player.loadTune(silentTune(3));
      player.setJumpTargets([frames(100)]);
      await flushEntryImageCapture();
      expect(preparedFrames(player)).toEqual([100]);

      player.selectSubtune(2);
      await flushEntryImageCapture();
      expect(preparedFrames(player)).toEqual([]);

      player.setJumpTargets([frames(100)]);
      await flushEntryImageCapture();
      player.loadTune(silentTune(3));
      await flushEntryImageCapture();

      expect(preparedFrames(player)).toEqual([]);
      expect(replay.requests).toHaveLength(2);
    });

    it('builds the declared frames again when the track structure changes', async () => {
      const { player, replay } = harness();
      player.loadTune(counterTune());
      player.setJumpTargets([frames(100), frames(200)]);
      await flushEntryImageCapture();
      const requests = replay.requests.length;

      player.setTrackStructure(null);
      expect(preparedFrames(player)).toEqual([]);
      await flushEntryImageCapture();

      expect(preparedFrames(player)).toEqual([100, 200]);
      expect(replay.requests.slice(requests).map((request) => request.targetFrame)).toEqual([
        100, 200,
      ]);
    });

    it('keeps the declaration across stop, play and pause', async () => {
      const { player, replay } = harness();
      player.loadTune(counterTune());
      player.setJumpTargets([frames(100)]);
      await flushEntryImageCapture();

      await player.play();
      player.pause();
      player.stop();
      await flushEntryImageCapture();

      expect(preparedFrames(player)).toEqual([100]);
      expect(replay.requests).toHaveLength(1);
    });

    it('captures the live position without a replay, returning the frame', async () => {
      const { player, clock, replay } = harness();
      expect(player.capturePosition()).toBeNull();

      player.loadTune(counterTune());
      await player.play();
      run(clock, 7);

      expect(player.capturePosition()).toBe(player.getPosition());
      expect(player.capturePosition()).toBe(7);
      expect(replay.requests).toHaveLength(0);
    });

    it('reads a captured position that is declared afterwards as ready with no replay', async () => {
      const { player, clock, replay } = harness();
      player.loadTune(counterTune());
      await player.play();
      run(clock, 500);
      player.capturePosition();

      player.setJumpTargets([frames(500)]);

      expect(preparedFrames(player)).toEqual([500]);
      await flushEntryImageCapture();
      expect(replay.requests).toHaveLength(0);

      await player.seek(frames(0));
      runFrameSpy.mockClear();
      await player.seek(frames(500));
      expect(runFrameSpy).not.toHaveBeenCalled();
      expect(player.getPosition()).toBe(500);
    });

    it('makes a position captured at an already declared frame ready at once, adding no replay', async () => {
      const { player, clock, replay, prepare } = splitHarness();
      prepare.manual = true;
      player.loadTune(counterTune());
      await player.play();
      player.setJumpTargets([frames(300)]);
      run(clock, 300);

      expect(player.capturePosition()).toBe(300);

      expect(preparedFrames(player)).toEqual([300]);
      expect(prepare.requests).toHaveLength(1);
      expect(replay.requests).toHaveLength(0);
    });

    it('stands a capture taken while a voice was muted in until a clean image replaces it', async () => {
      const { player, clock, replay } = harness();
      player.loadTune(heldNoteTune());
      await player.play();
      run(clock, 50);
      player.setVoiceMuted(0, true);
      expect(player.capturePosition()).toBe(50);
      player.setVoiceMuted(0, false);

      player.setJumpTargets([frames(50)]);

      expect(preparedFrames(player)).toEqual([50]);
      expect(replay.requests).toHaveLength(1);
      expect(replay.requests[0].targetFrame).toBe(50);
      expect(replay.requests[0].mutes).toEqual([false, false, false]);

      await flushEntryImageCapture();
      await player.seek(frames(10));
      await player.seek(frames(50));

      expect(writtenRegister(player, VOICE_CONTROL_REGISTERS[0])).toBe(0x41);
    });

    it('queues the same clean rebuild for a muted capture made at a frame already declared', async () => {
      const { player, clock, replay } = harness();
      player.loadTune(heldNoteTune());
      await player.play();
      player.setJumpTargets([frames(50)]);
      await flushEntryImageCapture();
      run(clock, 50);
      player.setVoiceMuted(0, true);
      const requests = replay.requests.length;

      player.capturePosition();
      player.setVoiceMuted(0, false);

      expect(replay.requests).toHaveLength(requests + 1);
      expect(replay.requests[requests].mutes).toEqual([false, false, false]);
    });

    it('normalises what is declared the way a seek does, collapsing duplicates and refusing what is not a number', async () => {
      const { player, replay } = harness();
      player.loadTune(counterTune());

      player.setJumpTargets([NaN, 0, -7, 99.6, 100, Infinity].map((frame) => frames(frame)));
      await flushEntryImageCapture();

      expect(console.warn).toHaveBeenCalledWith('SID player: ignoring a jump target of NaN.');
      expect(console.warn).toHaveBeenCalledWith('SID player: ignoring a jump target of Infinity.');
      expect(preparedFrames(player)).toEqual([0, 100]);

      const requests = replay.requests.length;
      await player.seek(frames(99.6));
      expect(player.getPosition()).toBe(100);
      await player.seek(frames(0));
      expect(player.getPosition()).toBe(0);
      expect(replay.requests).toHaveLength(requests);
    });

    it('leaves a frame whose build failed unready, warns, and tries again only when it is declared again', async () => {
      const { player, replay } = harness();
      player.loadTune(runawayTune());

      player.setJumpTargets([frames(5)]);
      await flushEntryImageCapture();

      expect(preparedFrames(player)).toEqual([]);
      expect(replay.requests).toHaveLength(1);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('exceeded its cycle budget'),
      );

      player.setJumpTargets([frames(5)]);
      await flushEntryImageCapture();

      expect(replay.requests).toHaveLength(2);
    });

    it('does not move the tempo or the rate across a prepared jump', async () => {
      const { player } = harness();
      player.loadTune(doubleSpeedTune());
      player.setTempo(1.5);
      player.setJumpTargets([frames(100)]);
      await flushEntryImageCapture();
      const tempo = player.getSnapshot().tempo;
      const rate = player.getStats().rate;
      expect(rate.exactCallsPerFrame).toBe(2);

      await player.seek(frames(100));

      expect(player.getPosition()).toBe(100);
      expect(player.getSnapshot().tempo).toEqual(tempo);
      expect(player.getStats().rate).toEqual(rate);
    });

    it('disposes a separate prepare runner with the player, and a shared one once', async () => {
      const split = splitHarness();
      split.player.dispose();
      expect(split.replay.disposeCount).toBe(1);
      expect(split.prepare.disposeCount).toBe(1);

      const shared = new FakeReplayRunner();
      const player = createSidPlayer({
        sink: new RecordingSink(),
        clock: new FakeClock(),
        replayRunner: shared,
        prepareRunner: shared,
      });
      player.dispose();
      expect(shared.disposeCount).toBe(1);
    });

    it('lands a build that finishes after the player was disposed without effect', async () => {
      const { player, prepare } = splitHarness();
      prepare.manual = true;
      player.loadTune(counterTune());
      player.setJumpTargets([frames(100)]);

      player.dispose();
      prepare.resolveAll();
      await flushEntryImageCapture();

      expect(preparedFrames(player)).toEqual([]);
    });
  });

  describe('queued jumps', () => {
    /** The byte `counterTune` writes to $D400 on the frame after `frame`. */
    const counterAfter = (frame: number): number => (frame + 1) & 0xff;

    /** Ticks one frame at a time until `done` holds, so a landing is observed on the very tick it
     *  happens rather than somewhere after it. */
    function runUntil(clock: FakeClock, done: () => boolean, limit = 400): void {
      for (let tick = 0; tick < limit && !done(); tick++) run(clock, 1);
      expect(done()).toBe(true);
    }

    const handOffs = (player: SidPlayer): number | undefined => player.getSnapshot().tune?.handOffs;
    const queued = (player: SidPlayer): unknown => player.getSnapshot().tune?.queuedJump;

    /** A counter tune playing inside a ten-frame loop at 100, with 500 and 600 declared and ready. */
    async function loopingPlayer(h: Harness = harness()): Promise<Harness> {
      h.player.loadTune(counterTune());
      await h.player.play();
      h.player.setJumpTargets([frames(500), frames(600)]);
      h.player.setActiveLoop({ startFrame: frames(100), endFrame: frames(110) });
      await flushEntryImageCapture();
      return h;
    }

    it('continues from the queued start on the frame after the wrap, never from the running loop', async () => {
      const { player, clock, sink } = await loopingPlayer();
      player.queueJump({ startFrame: frames(500), endFrame: frames(520) });
      expect(queued(player)).toEqual({ startFrame: 500, endFrame: 520 });

      runUntil(clock, () => handOffs(player) === 1);

      expect(player.getPosition()).toBe(500);
      expect(player.getSnapshot().loop).toEqual({ startFrame: 500, endFrame: 520 });
      expect(queued(player)).toBeNull();
      run(clock, 2); // the gate-off the landing owes, then the first frame played from the image
      expect(valueOf(lastDelivered(sink), 0)).toBe(counterAfter(500));
      expect(player.getPosition()).toBe(501);
    });

    it('enforces the queued loop on later laps', async () => {
      const { player, clock } = await loopingPlayer();
      player.queueJump({ startFrame: frames(500), endFrame: frames(520) });
      runUntil(clock, () => handOffs(player) === 1);

      runUntil(clock, () => player.getPosition() > 515);
      runUntil(
        clock,
        () => player.getPosition() === 500 && player.getStats().resync.inFlightDepth === 1,
      );

      expect(handOffs(player)).toBe(1);
      expect(player.getSnapshot().loop).toEqual({ startFrame: 500, endFrame: 520 });
    });

    it('lands a cue by clearing the loop, after which track repeat still re-arms at the track end', async () => {
      const { player, clock } = harness();
      player.loadTune(counterTune());
      player.setTrackStructure({
        loopStartFrame: null,
        loopPeriodFrames: null,
        endedAtFrame: frames(510),
      });
      player.setRepeatTrack(true);
      await player.play();
      player.setJumpTargets([frames(500)]);
      player.setActiveLoop({ startFrame: frames(100), endFrame: frames(110) });
      await flushEntryImageCapture();
      player.queueJump({ startFrame: frames(500), endFrame: null });

      runUntil(clock, () => handOffs(player) === 1);

      expect(player.getPosition()).toBe(500);
      expect(player.getSnapshot().loop).toBeNull();
      expect(queued(player)).toBeNull();

      runUntil(clock, () => player.getSnapshot().loop !== null);
      expect(player.getSnapshot().loop).toEqual({ startFrame: 0, endFrame: 510 });
      expect(player.getPosition()).toBe(0);
      expect(handOffs(player)).toBe(1);
    });

    it('lets laps continue until the target is ready, then lands at the first wrap after it arrives', async () => {
      const { player, clock, prepare } = splitHarness();
      prepare.manual = true;
      player.loadTune(counterTune());
      await player.play();
      player.setJumpTargets([frames(500)]);
      player.setActiveLoop({ startFrame: frames(100), endFrame: frames(110) });
      await flushEntryImageCapture();
      player.queueJump({ startFrame: frames(500), endFrame: frames(520) });

      run(clock, 60);

      expect(handOffs(player)).toBe(0);
      expect(queued(player)).toEqual({ startFrame: 500, endFrame: 520 });
      expect(player.getSnapshot().loop).toEqual({ startFrame: 100, endFrame: 110 });
      expect(player.getPosition()).toBeLessThan(111);

      prepare.resolveAll();
      await flushEntryImageCapture();
      runUntil(clock, () => handOffs(player) === 1);

      expect(player.getPosition()).toBe(500);
    });

    it('captures an undeclared target once, off-thread, and lands on it', async () => {
      const { player, clock, replay } = await loopingPlayer();
      const requests = replay.requests.length;

      player.queueJump({ startFrame: frames(300), endFrame: frames(320) });
      await flushEntryImageCapture();

      expect(replay.requests.slice(requests).map((request) => request.targetFrame)).toEqual([300]);
      runUntil(clock, () => handOffs(player) === 1);
      expect(player.getPosition()).toBe(300);
    });

    it('captures an undeclared frame 0 off-thread and lands on it', async () => {
      const { player, clock, replay } = await loopingPlayer();
      const requests = replay.requests.length;

      player.queueJump({ startFrame: frames(0), endFrame: frames(20) });
      await flushEntryImageCapture();

      expect(replay.requests.slice(requests).map((request) => request.targetFrame)).toEqual([0]);
      runUntil(clock, () => handOffs(player) === 1);
      expect(player.getPosition()).toBe(0);
      expect(player.getSnapshot().loop).toEqual({ startFrame: 0, endFrame: 20 });
    });

    it('needs no replay for a target whose image was captured from the live position', async () => {
      const { player, clock, replay } = harness();
      player.loadTune(counterTune());
      await player.play();
      run(clock, 300);
      expect(player.capturePosition()).toBe(300);
      player.setActiveLoop({ startFrame: frames(100), endFrame: frames(320) });
      await flushEntryImageCapture();
      const requests = replay.requests.length;

      player.queueJump({ startFrame: frames(300), endFrame: null });
      await flushEntryImageCapture();

      expect(replay.requests).toHaveLength(requests);
      runUntil(clock, () => handOffs(player) === 1);
      expect(player.getPosition()).toBe(300);
    });

    it('replaces the queued jump, and a cancel keeps the loop running', async () => {
      const { player, clock } = await loopingPlayer();
      player.queueJump({ startFrame: frames(500), endFrame: frames(520) });
      player.queueJump({ startFrame: frames(600), endFrame: frames(630) });
      expect(queued(player)).toEqual({ startFrame: 600, endFrame: 630 });

      runUntil(clock, () => handOffs(player) === 1);
      expect(player.getPosition()).toBe(600);
      expect(player.getSnapshot().loop).toEqual({ startFrame: 600, endFrame: 630 });

      player.queueJump({ startFrame: frames(500), endFrame: frames(520) });
      player.queueJump(null);
      expect(queued(player)).toBeNull();
      runUntil(clock, () => player.getPosition() > 625);
      runUntil(clock, () => player.getPosition() === 600);

      expect(player.getSnapshot().loop).toEqual({ startFrame: 600, endFrame: 630 });
      expect(handOffs(player)).toBe(1);
    });

    it('normalises the target the way a seek does', async () => {
      const { player } = await loopingPlayer();

      player.queueJump({ startFrame: frames(499.6), endFrame: frames(520.4) });

      expect(queued(player)).toEqual({ startFrame: 500, endFrame: 520 });
    });

    it('counts a landing and nothing else', async () => {
      const { player, clock } = await loopingPlayer();

      player.queueJump({ startFrame: frames(500), endFrame: frames(520) });
      player.queueJump({ startFrame: frames(600), endFrame: null });
      player.queueJump(null);
      player.queueJump({ startFrame: frames(500), endFrame: frames(520) });
      player.setActiveLoop({ startFrame: frames(100), endFrame: frames(110) });
      expect(handOffs(player)).toBe(0);

      player.queueJump({ startFrame: frames(500), endFrame: frames(520) });
      runUntil(clock, () => handOffs(player) === 1);

      player.queueJump({ startFrame: frames(600), endFrame: frames(610) });
      player.setActiveLoop({ startFrame: frames(500), endFrame: frames(520) });
      expect(handOffs(player)).toBe(1);
      player.queueJump({ startFrame: frames(600), endFrame: frames(610) });
      player.stop();
      expect(handOffs(player)).toBe(1);
      expect(queued(player)).toBeNull();
    });

    it('drops the queue on setActiveLoop, stop, loadTune and a subtune change', async () => {
      const { player } = await loopingPlayer();
      const loop = { startFrame: frames(100), endFrame: frames(110) };
      const queueAgain = (): void => {
        player.setActiveLoop(loop);
        player.queueJump({ startFrame: frames(500), endFrame: frames(520) });
        expect(queued(player)).not.toBeNull();
      };

      queueAgain();
      player.setActiveLoop(loop);
      expect(queued(player)).toBeNull();

      queueAgain();
      player.setActiveLoop(null);
      expect(queued(player)).toBeNull();

      queueAgain();
      player.stop();
      expect(queued(player)).toBeNull();

      queueAgain();
      player.loadTune(silentTune(3));
      expect(queued(player)).toBeNull();

      player.setActiveLoop(loop);
      player.queueJump({ startFrame: frames(500), endFrame: frames(520) });
      player.selectSubtune(2);
      expect(queued(player)).toBeNull();
    });

    it('resets the count on loadTune and on a subtune change, and not on selecting the same subtune', async () => {
      const { player, clock } = harness();
      player.loadTune(silentTune(3));
      await player.play();
      player.setJumpTargets([frames(50)]);
      player.setActiveLoop({ startFrame: frames(10), endFrame: frames(20) });
      await flushEntryImageCapture();
      player.queueJump({ startFrame: frames(50), endFrame: frames(60) });
      runUntil(clock, () => handOffs(player) === 1);

      player.selectSubtune(1);
      expect(handOffs(player)).toBe(1);
      player.selectSubtune(2);
      expect(handOffs(player)).toBe(0);

      player.setJumpTargets([frames(50)]);
      player.setActiveLoop({ startFrame: frames(10), endFrame: frames(20) });
      await flushEntryImageCapture();
      player.queueJump({ startFrame: frames(50), endFrame: frames(60) });
      runUntil(clock, () => handOffs(player) === 1);
      player.loadTune(silentTune(3));

      expect(handOffs(player)).toBe(0);
    });

    it('ignores a queue with no loop running, a start that is not a number and an end that is not after the start', () => {
      const { player } = harness();
      player.loadTune(counterTune());

      player.queueJump({ startFrame: frames(500), endFrame: frames(520) });
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('SID player: ignoring'));
      expect(queued(player)).toBeNull();

      player.queueJump(null);
      expect(console.warn).toHaveBeenCalledTimes(1);

      player.setActiveLoop({ startFrame: frames(100), endFrame: frames(110) });
      for (const target of [
        { startFrame: frames(NaN), endFrame: null },
        { startFrame: frames(Infinity), endFrame: frames(520) },
        { startFrame: frames(500), endFrame: frames(500) },
        { startFrame: frames(500), endFrame: frames(400) },
        { startFrame: frames(500), endFrame: frames(NaN) },
      ]) {
        player.queueJump(target);
        expect(queued(player)).toBeNull();
      }
      expect(console.warn).toHaveBeenCalledTimes(6);
    });

    it('keeps the queued jump when a later call is rejected', async () => {
      const { player } = await loopingPlayer();
      player.queueJump({ startFrame: frames(500), endFrame: frames(520) });

      player.queueJump({ startFrame: frames(NaN), endFrame: null });

      expect(queued(player)).toEqual({ startFrame: 500, endFrame: 520 });
    });

    it('notifies on queue, replace and cancel, and once on the landing with a consistent snapshot', async () => {
      const { player, clock } = await loopingPlayer();
      const seen: unknown[] = [];
      player.subscribe(() => {
        const { loop, tune } = player.getSnapshot();
        seen.push({ loop, queued: tune?.queuedJump, handOffs: tune?.handOffs });
      });

      player.queueJump({ startFrame: frames(500), endFrame: frames(520) });
      player.queueJump({ startFrame: frames(600), endFrame: frames(620) });
      player.queueJump(null);
      expect(seen).toHaveLength(3);

      player.queueJump({ startFrame: frames(500), endFrame: frames(520) });
      seen.length = 0;
      runUntil(clock, () => handOffs(player) === 1);

      expect(seen).toEqual([
        { loop: { startFrame: 500, endFrame: 520 }, queued: null, handOffs: 1 },
      ]);
    });

    it('lets a host call made from the landing notification stand', async () => {
      const { player, clock } = await loopingPlayer();
      player.queueJump({ startFrame: frames(500), endFrame: frames(520) });
      const loop = { startFrame: frames(600), endFrame: frames(630) };
      const unsubscribe = player.subscribe(() => {
        if (handOffs(player) === 1) {
          unsubscribe();
          player.setActiveLoop(loop);
        }
      });

      runUntil(clock, () => handOffs(player) === 1);

      expect(player.getSnapshot().loop).toEqual(loop);
      expect(handOffs(player)).toBe(1);
    });

    it('leaves the tempo and the rate alone across a landing', async () => {
      const { player, clock } = harness();
      player.loadTune(doubleSpeedTune());
      player.setTempo(1.5);
      await player.play();
      player.setJumpTargets([frames(500)]);
      player.setActiveLoop({ startFrame: frames(100), endFrame: frames(110) });
      await flushEntryImageCapture();
      const tempo = player.getSnapshot().tempo;
      const rate = player.getStats().rate;
      player.queueJump({ startFrame: frames(500), endFrame: frames(520) });

      runUntil(clock, () => handOffs(player) === 1);

      expect(player.getSnapshot().tempo).toEqual(tempo);
      expect(player.getStats().rate).toEqual(rate);
    });
  });

  describe('jump settings', () => {
    const VOICE_0_CONTROL = 4;
    const VOICE_1_FREQUENCY_HIGH = 8;
    const VOICE_1_CONTROL = 11;
    const VOLUME_REGISTER = 24;
    const VOLUME = { name: 'volume' } as const;
    const PULSE_WIDTH = { name: 'pulseWidth', voice: 0 } as const;
    const LOOP = { startFrame: frames(100), endFrame: frames(110) };

    /** LDA #value; STA $D4xx. */
    const poke = (register: number, value: number): number[] => [0xa9, value, 0x8d, register, 0xd4];

    /** play writes voice 0's frequency ($1234), pulse width ($0100) and control ($41), voice 1's
     *  frequency ($1000) and control, and the volume byte ($0F) on every call: one register of
     *  each kind a jump's settings reach. */
    function settingsTune(songs = 1): SidFile {
      return tune({
        songs,
        blocks: [
          { at: 0x1000, bytes: [RTS] },
          {
            at: 0x1010,
            bytes: [
              ...poke(0x00, 0x34),
              ...poke(0x01, 0x12),
              ...poke(0x02, 0x00),
              ...poke(0x03, 0x01),
              ...poke(0x04, 0x41),
              ...poke(0x0b, 0x41),
              ...poke(0x07, 0x00),
              ...poke(0x08, 0x10),
              ...poke(0x18, 0x0f),
              RTS,
            ],
          },
        ],
      });
    }

    /** The registers `settingsTune` writes and the bytes it writes to them. */
    const HOME: readonly (readonly [number, number])[] = [
      [0, 0x34],
      [1, 0x12],
      [2, 0x00],
      [3, 0x01],
      [7, 0x00],
      [8, 0x10],
      [24, 0x0f],
    ];

    /** The registers `frame` carries at a byte other than the tune's own. */
    const departures = (frame: SidFrame): number[] =>
      HOME.filter(([register, value]) => {
        const carried = valueOf(frame, register);
        return carried !== undefined && carried !== value;
      }).map(([register]) => register);

    const handOffs = (player: SidPlayer): number | undefined => player.getSnapshot().tune?.handOffs;
    const queued = (player: SidPlayer): unknown => player.getSnapshot().tune?.queuedJump;
    const mutedVoices = (player: SidPlayer): boolean[] =>
      player.getSnapshot().voices.map((voice) => voice.muted);

    function registers(player: SidPlayer): { written: Uint8Array; sent: Uint8Array } {
      const written = new Uint8Array(SID_REGISTER_COUNT);
      const sent = new Uint8Array(SID_REGISTER_COUNT);
      player.readRegisters(written, sent);
      return { written, sent };
    }

    function runUntil(clock: FakeClock, done: () => boolean, limit = 400): void {
      for (let tick = 0; tick < limit && !done(); tick++) run(clock, 1);
      expect(done()).toBe(true);
    }

    /** `file` playing inside a ten-frame loop at 100, with 500 and 600 declared and ready. */
    async function looping(file: SidFile, h: Harness = harness()): Promise<Harness> {
      h.player.loadTune(file);
      await h.player.play();
      h.player.setJumpTargets([frames(500), frames(600)]);
      h.player.setActiveLoop(LOOP);
      await flushEntryImageCapture();
      return h;
    }

    type Jump = QueuedJump & { readonly settings?: JumpSettings };
    const jump = (settings?: JumpSettings): Jump => ({
      startFrame: frames(500),
      endFrame: frames(520),
      ...(settings === undefined ? {} : { settings }),
    });

    /** Ticks until the queued jump lands, then through the gate-off it owes and the resync after
     *  it. `before` is every frame delivered up to and including the wrap. */
    function landQueued(h: Harness): { before: SidFrame[]; gateOff: SidFrame; resync: SidFrame } {
      const first = h.sink.deliveredFrames.length;
      runUntil(h.clock, () => handOffs(h.player) === 1);
      const before = h.sink.deliveredFrames.slice(first).map(({ frame }) => frame);
      run(h.clock, 2);
      const [gateOff, resync] = h.sink.deliveredFrames.slice(-2).map(({ frame }) => frame);
      return { before, gateOff, resync };
    }

    async function landedWith(
      settings: JumpSettings,
      h?: Harness,
    ): Promise<{ h: Harness; before: SidFrame[]; gateOff: SidFrame; resync: SidFrame }> {
      const looped = await looping(settingsTune(), h);
      looped.player.queueJump(jump(settings));
      return { h: looped, ...landQueued(looped) };
    }

    describe('on a queued hand-off', () => {
      it('applies a pitch, an offset, a hold and a mute in the resync after the gate-off, and on no frame before it', async () => {
        const h = await looping(settingsTune());
        h.player.queueJump(
          jump({
            voicePitch: [2],
            fieldOffsets: [{ field: PULSE_WIDTH, amount: 512 }],
            fieldHolds: [{ field: VOLUME, value: 5 }],
            voiceMutes: [false, true],
          }),
        );
        expect(mutedVoices(h.player)).toEqual([false, false, false]);

        const { before, gateOff, resync } = landQueued(h);

        expect(before.length).toBeGreaterThan(0);
        expect(before.flatMap(departures)).toEqual([]);
        expect(gateOff.count).toBe(VOICE_CONTROL_REGISTERS.length);
        expect(departures(gateOff)).toEqual([]);
        expect(resync.count).toBe(25);
        expect([valueOf(resync, 0), valueOf(resync, 1)]).toEqual([0x68, 0x24]);
        expect([valueOf(resync, 2), valueOf(resync, 3)]).toEqual([0x00, 0x03]);
        expect(valueOf(resync, VOLUME_REGISTER)).toBe(0x05);
        expect(valueOf(resync, VOICE_0_CONTROL)).toBe(0x41);
        expect(valueOf(resync, VOICE_1_CONTROL)).toBe(0);
        expect(mutedVoices(h.player)).toEqual([false, true, false]);
      });

      it('keeps the shadow as the tune wrote it, shaping only the bytes sent', async () => {
        const { h } = await landedWith({
          voicePitch: [2],
          fieldOffsets: [{ field: PULSE_WIDTH, amount: 512 }],
        });
        run(h.clock, 1);

        const { written, sent } = registers(h.player);

        expect([written[0], written[1], written[2], written[3]]).toEqual([0x34, 0x12, 0x00, 0x01]);
        expect([sent[0], sent[1], sent[2], sent[3]]).toEqual([0x68, 0x24, 0x00, 0x03]);
      });

      it('leaves every setting the jump does not list as it was', async () => {
        const h = await looping(settingsTune());
        h.player.setVoicePitch(1, 3);
        h.player.holdField(VOLUME, 3);
        h.player.setVoiceMuted(1, true);
        h.player.queueJump(jump({ voicePitch: [2], voiceMutes: [false] }));

        const { resync } = landQueued(h);

        expect(valueOf(resync, 1)).toBe(0x24);
        expect(valueOf(resync, VOICE_1_FREQUENCY_HIGH)).toBe(0x30);
        expect(valueOf(resync, VOLUME_REGISTER)).toBe(0x03);
        expect(valueOf(resync, VOICE_1_CONTROL)).toBe(0);
        expect(mutedVoices(h.player)).toEqual([false, true, false]);
      });

      it('releases a hold and hands an offset back when the settings say so', async () => {
        const h = await looping(settingsTune());
        h.player.holdField(VOLUME, 3);
        h.player.setFieldOffset(PULSE_WIDTH, 256);
        h.player.queueJump(
          jump({
            fieldHolds: [{ field: VOLUME, value: null }],
            fieldOffsets: [{ field: PULSE_WIDTH, amount: 0 }],
          }),
        );

        const { resync } = landQueued(h);
        h.player.loadTune(settingsTune());
        await h.player.play();
        run(h.clock, 1);

        expect(valueOf(resync, VOLUME_REGISTER)).toBe(0x0f);
        expect(valueOf(resync, 3)).toBe(0x01);
        expect(departures(lastDelivered(h.sink))).toEqual([]);
      });

      it('blends a hold by its amount', async () => {
        const { resync } = await landedWith({
          fieldHolds: [{ field: VOLUME, value: 5, amount: 0.5 }],
        });

        expect(valueOf(resync, VOLUME_REGISTER)).toBe(0x0a);
      });

      it('leaves a voice a button holds to latched XOR held', async () => {
        const h = await looping(heldNoteTune());
        h.player.setVoiceHeld(0, true);
        h.player.queueJump(jump({ voiceMutes: [true] }));

        const { resync } = landQueued(h);

        expect(valueOf(resync, VOICE_0_CONTROL)).toBe(0x41);
        expect(h.player.getSnapshot().voices[0]).toEqual({ muted: true, held: true });
      });

      it('carries what landed into the next tune loaded', async () => {
        const { h } = await landedWith({
          voicePitch: [2],
          fieldOffsets: [{ field: PULSE_WIDTH, amount: 512 }],
          fieldHolds: [{ field: VOLUME, value: 5 }],
        });

        h.player.loadTune(settingsTune());
        await h.player.play();
        run(h.clock, 1);

        const frame = lastDelivered(h.sink);
        expect([valueOf(frame, 0), valueOf(frame, 1)]).toEqual([0x68, 0x24]);
        expect(valueOf(frame, 3)).toBe(0x03);
        expect(valueOf(frame, VOLUME_REGISTER)).toBe(0x05);
      });

      it('warns about each refused entry when the jump is queued, once, and applies the rest', async () => {
        const warn = vi.spyOn(console, 'warn');
        const h = await looping(settingsTune());
        warn.mockClear();

        h.player.queueJump(
          jump({
            voicePitch: [2, -1],
            fieldOffsets: [
              { field: { name: 'gate', voice: 0 }, amount: 1 },
              { field: PULSE_WIDTH, amount: 512 },
            ],
            fieldHolds: [
              { field: { name: 'cutoff' }, value: 5000 },
              { field: { name: 'pulseWidth', voice: 3 }, value: null },
              { field: VOLUME, value: 5 },
            ],
          }),
        );
        expect(warn).toHaveBeenCalledTimes(4);
        for (const [message] of warn.mock.calls) {
          expect(message).toEqual(expect.stringContaining('SID player: ignoring'));
        }
        const { resync } = landQueued(h);

        expect(warn).toHaveBeenCalledTimes(4);
        expect(valueOf(resync, 1)).toBe(0x24);
        expect(valueOf(resync, VOICE_1_FREQUENCY_HIGH)).toBe(0x10);
        expect(valueOf(resync, 3)).toBe(0x03);
        expect(valueOf(resync, VOLUME_REGISTER)).toBe(0x05);
      });

      it('publishes the queued record as it always was, and counts a landing and nothing else', async () => {
        const h = await looping(settingsTune());

        h.player.queueJump(jump({ voicePitch: [2] }));
        expect(queued(h.player)).toStrictEqual({ startFrame: 500, endFrame: 520 });
        h.player.queueJump(jump({ voicePitch: [3] }));
        h.player.queueJump(null);
        h.player.queueJump(jump({ voicePitch: [2] }));
        expect(handOffs(h.player)).toBe(0);

        landQueued(h);

        expect(handOffs(h.player)).toBe(1);
        expect(queued(h.player)).toBeNull();
      });

      it('notifies once on the landing, with the changed mute and the new loop already in place', async () => {
        const h = await looping(settingsTune());
        h.player.queueJump(jump({ voiceMutes: [true] }));
        const seen: unknown[] = [];
        h.player.subscribe(() => {
          const { loop, tune: published, voices } = h.player.getSnapshot();
          seen.push({ loop, handOffs: published?.handOffs, muted: voices[0].muted });
        });

        landQueued(h);

        expect(seen).toEqual([
          { loop: { startFrame: 500, endFrame: 520 }, handOffs: 1, muted: true },
        ]);
      });

      it('lets a seek made from the landing notification stand, after seeing the landed state', async () => {
        const h = await looping(settingsTune());
        h.player.queueJump(jump({ voicePitch: [2] }));
        let seen: unknown = null;
        const unsubscribe = h.player.subscribe(() => {
          if (handOffs(h.player) !== 1) return;
          unsubscribe();
          seen = { position: h.player.getPosition(), pitch: registers(h.player).sent[1] };
          h.player.setActiveLoop({ startFrame: frames(600), endFrame: frames(630) });
          void h.player.seek(frames(600), { voicePitch: [3] });
        });

        runUntil(h.clock, () => handOffs(h.player) === 1);
        run(h.clock, 2);

        expect(seen).toEqual({ position: 500, pitch: 0x24 });
        expect(h.player.getPosition()).toBe(601);
        const resync = lastDelivered(h.sink);
        expect([valueOf(resync, 0), valueOf(resync, 1)]).toEqual([0x9c, 0x36]);
      });

      it('lets a loop set from the landing notification stand, with the landed settings in force', async () => {
        const h = await looping(settingsTune());
        h.player.queueJump(jump({ voicePitch: [2] }));
        const loop = { startFrame: frames(600), endFrame: frames(630) };
        const unsubscribe = h.player.subscribe(() => {
          if (handOffs(h.player) !== 1) return;
          unsubscribe();
          h.player.setActiveLoop(loop);
        });

        runUntil(h.clock, () => handOffs(h.player) === 1);
        run(h.clock, 2);

        expect(h.player.getSnapshot().loop).toEqual(loop);
        expect(valueOf(lastDelivered(h.sink), 1)).toBe(0x24);
      });

      it('leaves the tempo and the rate alone', async () => {
        const h = harness();
        h.player.setTempo(1.5);
        await looping(settingsTune(), h);
        const tempo = h.player.getSnapshot().tempo;
        const rate = h.player.getStats().rate;
        h.player.queueJump(jump({ voicePitch: [2], voiceMutes: [true] }));

        landQueued(h);

        expect(h.player.getSnapshot().tempo).toEqual(tempo);
        expect(h.player.getStats().rate).toEqual(rate);
      });

      it.each([
        ['a replace by a jump without settings', (p: SidPlayer) => p.queueJump(jump())],
        ['a cancel', (p: SidPlayer) => p.queueJump(null)],
        ['setActiveLoop', (p: SidPlayer) => p.setActiveLoop(LOOP)],
        ['a stop', (p: SidPlayer) => p.stop()],
        ['a tune load', (p: SidPlayer) => p.loadTune(settingsTune(2))],
        ['a subtune change', (p: SidPlayer) => p.selectSubtune(2)],
      ])('drops the settings queued with a jump on %s', async (_, clear) => {
        const h = await looping(settingsTune(2));
        h.player.queueJump(jump({ voicePitch: [2], voiceMutes: [true] }));

        clear(h.player);
        await h.player.play();
        h.player.setJumpTargets([frames(500)]);
        h.player.setActiveLoop(LOOP);
        await flushEntryImageCapture();
        h.player.queueJump(jump());
        const { resync } = landQueued(h);

        expect(valueOf(resync, 1)).toBe(0x12);
        expect(mutedVoices(h.player)).toEqual([false, false, false]);
      });

      it('applies the replacing jump’s settings and not the replaced one’s', async () => {
        const h = await looping(settingsTune());
        h.player.queueJump(jump({ voicePitch: [2], fieldHolds: [{ field: VOLUME, value: 5 }] }));
        h.player.queueJump(jump({ voicePitch: [3] }));

        const { resync } = landQueued(h);

        expect([valueOf(resync, 0), valueOf(resync, 1)]).toEqual([0x9c, 0x36]);
        expect(valueOf(resync, VOLUME_REGISTER)).toBe(0x0f);
      });
    });

    describe('on an immediate seek', () => {
      it.each([
        ['a declared frame that is ready', 500],
        ['the active loop’s own start', 100],
      ])(
        'applies the settings of a seek to %s before the next frame is delivered',
        async (_, target) => {
          const h = await looping(settingsTune());
          const requests = h.replay.requests.length;
          const delivered = h.sink.deliveredFrames.length;

          const pending = h.player.seek(frames(target), {
            voicePitch: [2],
            fieldOffsets: [{ field: PULSE_WIDTH, amount: 512 }],
            fieldHolds: [{ field: VOLUME, value: 5 }],
            voiceMutes: [false, true],
          });

          const { sent } = registers(h.player);
          expect([sent[1], sent[3], sent[VOLUME_REGISTER]]).toEqual([0x24, 0x03, 0x05]);
          expect(mutedVoices(h.player)).toEqual([false, true, false]);
          await pending;
          expect(h.player.getPosition()).toBe(target);
          expect(h.replay.requests).toHaveLength(requests);
          expect(h.sink.deliveredFrames).toHaveLength(delivered);
          run(h.clock, 2);
          const resync = lastDelivered(h.sink);
          expect(resync.count).toBe(25);
          expect([
            valueOf(resync, 1),
            valueOf(resync, 3),
            valueOf(resync, VOLUME_REGISTER),
          ]).toEqual([0x24, 0x03, 0x05]);
          expect(valueOf(resync, VOICE_1_CONTROL)).toBe(0);
        },
      );

      it('notifies once, after the restore, with the changed mute', async () => {
        const h = await looping(settingsTune());
        const seen: unknown[] = [];
        h.player.subscribe(() => {
          seen.push({
            position: h.player.getPosition(),
            pitch: registers(h.player).sent[1],
            muted: mutedVoices(h.player),
          });
        });

        await h.player.seek(frames(500), { voicePitch: [2], voiceMutes: [false, true] });

        expect(seen).toEqual([{ position: 500, pitch: 0x24, muted: [false, true, false] }]);
      });

      it('applies nothing and notifies no one when it carries no settings', async () => {
        const h = await looping(settingsTune());
        const listener = vi.fn();
        h.player.subscribe(listener);

        await h.player.seek(frames(500));

        expect(listener).not.toHaveBeenCalled();
        expect(registers(h.player).sent[1]).toBe(0x12);
      });
    });

    describe('on a replayed seek', () => {
      it('applies the settings when the replay lands, and not while it is in flight', async () => {
        const h = await looping(settingsTune());
        h.replay.manual = true;

        const pending = h.player.seek(frames(300), { voicePitch: [2], voiceMutes: [true] });
        run(h.clock, 2);
        expect(registers(h.player).sent[1]).toBe(0x12);
        expect(mutedVoices(h.player)).toEqual([false, false, false]);
        h.replay.resolveAll();
        await pending;

        expect(h.player.getPosition()).toBe(300);
        expect(registers(h.player).sent[1]).toBe(0x24);
        expect(mutedVoices(h.player)).toEqual([true, false, false]);
      });

      it('notifies once, after the restore, with the changed mute', async () => {
        const h = await looping(settingsTune());
        const seen: unknown[] = [];
        h.player.subscribe(() => {
          seen.push({
            position: h.player.getPosition(),
            pitch: registers(h.player).sent[1],
            muted: mutedVoices(h.player),
          });
        });

        await h.player.seek(frames(300), { voicePitch: [2], voiceMutes: [true] });

        expect(seen).toEqual([{ position: 300, pitch: 0x24, muted: [true, false, false] }]);
      });

      it('seeds the replay with no voice muted, and seeds as it always did without settings', async () => {
        const h = await looping(settingsTune());
        h.player.setVoiceMuted(0, true);

        await h.player.seek(frames(300), { voicePitch: [2] });
        expect(h.replay.requests.at(-1)?.mutes).toEqual([false, false, false]);

        await h.player.seek(frames(350));
        expect(h.replay.requests.at(-1)?.mutes).toEqual([true, false, false]);
      });

      it('never applies the settings of a seek a later seek superseded', async () => {
        const h = await looping(settingsTune());
        h.replay.manual = true;

        const first = h.player.seek(frames(300), {
          fieldHolds: [{ field: VOLUME, value: 5 }],
          voiceMutes: [true],
        });
        const second = h.player.seek(frames(350), { voicePitch: [2] });
        h.replay.resolveAll();
        await Promise.all([first, second]);

        expect(h.player.getPosition()).toBe(350);
        run(h.clock, 2);
        const resync = lastDelivered(h.sink);
        expect(valueOf(resync, 1)).toBe(0x24);
        expect(valueOf(resync, VOLUME_REGISTER)).toBe(0x0f);
        expect(mutedVoices(h.player)).toEqual([false, false, false]);
      });

      it.each([
        ['a stop', (p: SidPlayer) => p.stop()],
        ['a tune load', (p: SidPlayer) => p.loadTune(settingsTune(2))],
        ['a subtune change', (p: SidPlayer) => p.selectSubtune(2)],
        ['a seek to a ready frame', (p: SidPlayer) => void p.seek(frames(500))],
      ])('never applies the settings of a seek that %s discarded', async (_, discard) => {
        const h = await looping(settingsTune(2));
        h.replay.manual = true;

        const pending = h.player.seek(frames(300), { voicePitch: [2], voiceMutes: [true] });
        discard(h.player);
        h.replay.resolveAll();
        await pending;
        await h.player.play();
        run(h.clock, 3);

        expect(registers(h.player).sent[1]).toBe(0x12);
        expect(mutedVoices(h.player)).toEqual([false, false, false]);
      });
    });

    describe('a voice a landing mutes or unmutes', () => {
      type Landing = (h: Harness, settings: JumpSettings) => SidFrame | Promise<SidFrame>;
      const landings: [string, Landing][] = [
        [
          'a queued hand-off',
          (h, settings) => {
            h.player.queueJump(jump(settings));
            return landQueued(h).resync;
          },
        ],
        [
          'a seek to a ready frame',
          async (h, settings) => {
            await h.player.seek(frames(500), settings);
            run(h.clock, 2);
            return lastDelivered(h.sink);
          },
        ],
        [
          'a replayed seek',
          async (h, settings) => {
            await h.player.seek(frames(300), settings);
            run(h.clock, 2);
            return lastDelivered(h.sink);
          },
        ],
      ];

      it.each(landings)(
        'sounds a voice unmuted by %s from the image’s control register in the resync frame',
        async (_, land) => {
          const h = await looping(heldNoteTune());
          h.player.setVoiceMuted(0, true);

          const resync = await land(h, { voiceMutes: [false] });

          expect(resync.count).toBe(25);
          expect(valueOf(resync, VOICE_0_CONTROL)).toBe(0x41);
          expect(mutedVoices(h.player)).toEqual([false, false, false]);
        },
      );

      it.each(landings)('keeps a voice muted by %s silent from the landing on', async (_, land) => {
        const h = await looping(heldNoteTune());

        const resync = await land(h, { voiceMutes: [true] });
        run(h.clock, 3);

        expect(valueOf(resync, VOICE_0_CONTROL)).toBe(0);
        expect(registers(h.player).sent[VOICE_0_CONTROL]).toBe(0);
        expect(mutedVoices(h.player)).toEqual([true, false, false]);
      });
    });
  });
  describe('varispeed', () => {
    /** HANDBACK_LEAD_SECONDS of a PAL tune, in play calls. */
    const LEAD = 100;

    /** play bumps a counter in $FB and writes it to voice 0's frequency low byte and pulse width low
     *  byte, with $01 as the frequency high byte and the gate open: entry e of its record reads
     *  frequency 0x100 + counter and no retrigger. */
    function rampTune(songs = 1): SidFile {
      return tune({
        songs,
        blocks: [
          { at: 0x1000, bytes: [RTS] },
          {
            at: 0x1010,
            bytes: [
              ...[0xe6, 0xfb], // INC $FB
              ...[0xa5, 0xfb], // LDA $FB
              ...[0x8d, 0x00, 0xd4], // STA $D400
              ...[0x8d, 0x02, 0xd4], // STA $D402
              ...[0xa9, 0x01], // LDA #$01
              ...[0x8d, 0x01, 0xd4], // STA $D401
              ...[0xa9, 0x41], // LDA #$41
              ...[0x8d, 0x04, 0xd4], // STA $D404
              RTS,
            ],
          },
        ],
      });
    }

    /** Odd calls write $40 then $41 to $D404 — a retrigger — and even calls write $40 alone, so the
     *  gate closes on every second call. The counter rides $D400. */
    function retriggerTune(): SidFile {
      return tune({
        blocks: [
          { at: 0x1000, bytes: [RTS] },
          {
            at: 0x1010,
            bytes: [
              ...[0xe6, 0xfb], // INC $FB
              ...[0xa5, 0xfb], // LDA $FB
              ...[0x8d, 0x00, 0xd4], // STA $D400
              ...[0x29, 0x01], // AND #$01
              ...[0xf0, 0x0b], // BEQ even
              ...[0xa9, 0x40], // LDA #$40
              ...[0x8d, 0x04, 0xd4], // STA $D404
              ...[0xa9, 0x41], // LDA #$41
              ...[0x8d, 0x04, 0xd4], // STA $D404
              RTS,
              ...[0xa9, 0x40], // even: LDA #$40
              ...[0x8d, 0x04, 0xd4], // STA $D404
              RTS,
            ],
          },
        ],
      });
    }

    interface Held extends Harness {
      readonly record: RegisterRecord;
      readonly rate: { value: number };
      readonly source: VarispeedRateSource;
    }

    /** A loaded tune with the record of its first `length` play calls, and a source that reads
     *  `rate.value`. */
    function withRecord(file: SidFile, length: number): Held {
      const h = harness();
      h.player.loadTune(file);
      const record = recordFromTune(file, 1, length);
      h.player.setRegisterRecord(record);
      const rate = { value: 1 };
      return { ...h, record, rate, source: () => rate.value };
    }

    function rowOf(record: RegisterRecord, entry: number): Uint8Array {
      return record.values.slice(entry * SID_REGISTER_COUNT, (entry + 1) * SID_REGISTER_COUNT);
    }

    /** The chip after a tick at `rate` whose position is at `entry`: the record's row, with voice 0's
     *  frequency scaled by the rate. */
    function expectedChip(record: RegisterRecord, entry: number, rate: number): Uint8Array {
      const chip = rowOf(record, entry);
      const scaled = Math.min(0xffff, Math.round((chip[0] | (chip[1] << 8)) * Math.abs(rate)));
      chip[0] = scaled & 0xff;
      chip[1] = scaled >> 8;
      return chip;
    }

    /** The chip image after each delivered frame, applying every frame's entries in order. */
    function chipsOf(sink: RecordingSink): Uint8Array[] {
      const chip = new Uint8Array(SID_REGISTER_COUNT);
      return sink.deliveredFrames.map(({ frame }) => {
        applyFrameToChip(chip, frame);
        return chip.slice();
      });
    }

    function writesOf(frame: SidFrame): [number, number][] {
      const writes: [number, number][] = [];
      for (let index = 0; index < frame.count; index++) {
        writes.push([frame.registers[index], frame.values[index]]);
      }
      return writes;
    }

    const snapshotOf = (player: SidPlayer): ReturnType<SidPlayer['getSnapshot']> =>
      player.getSnapshot();
    const varispeedOn = (player: SidPlayer): boolean => snapshotOf(player).tempo.varispeed;
    const handOffs = (player: SidPlayer): number | undefined => snapshotOf(player).tune?.handOffs;

    function readSent(player: SidPlayer): { written: Uint8Array; sent: Uint8Array } {
      const written = new Uint8Array(SID_REGISTER_COUNT);
      const sent = new Uint8Array(SID_REGISTER_COUNT);
      player.readRegisters(written, sent);
      return { written, sent };
    }

    const clockIsStopped = (clock: FakeClock): boolean => {
      try {
        clock.tick(milliseconds(performance.now()));
        return false;
      } catch {
        return true;
      }
    };

    describe('the record', () => {
      it('publishes its length and withdraws it on null', () => {
        const h = withRecord(rampTune(), 12);
        expect(snapshotOf(h.player).tune?.recordedFrames).toBe(12);

        h.player.setRegisterRecord(null);

        expect(snapshotOf(h.player).tune?.recordedFrames).toBeNull();
      });

      it('refuses a record of an unusable shape, with a warning', () => {
        const h = withRecord(rampTune(), 12);

        h.player.setRegisterRecord({ ...h.record, values: new Uint8Array(3) });

        expect(snapshotOf(h.player).tune?.recordedFrames).toBe(12);
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/^SID player:/));
      });

      it('refuses a record while in varispeed, with a warning', () => {
        const h = withRecord(rampTune(), 12);
        h.player.enterVarispeed(h.source);

        h.player.setRegisterRecord(null);

        expect(snapshotOf(h.player).tune?.recordedFrames).toBe(12);
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/^SID player:/));
      });

      it('is dropped by loadTune and by a subtune change, and kept by selecting the same subtune', () => {
        const h = withRecord(rampTune(2), 12);

        h.player.selectSubtune(1);
        expect(snapshotOf(h.player).tune?.recordedFrames).toBe(12);

        h.player.selectSubtune(2);
        expect(snapshotOf(h.player).tune?.recordedFrames).toBeNull();

        h.player.setRegisterRecord(h.record);
        h.player.loadTune(rampTune());
        expect(snapshotOf(h.player).tune?.recordedFrames).toBeNull();
        expect(h.player.enterVarispeed(h.source)).toBe(false);
      });
    });

    describe('entering', () => {
      it('is refused with nothing loaded', () => {
        const { player } = harness();

        expect(player.enterVarispeed(() => 1)).toBe(false);
      });

      it('is refused without a record, with no effect', () => {
        const h = harness();
        h.player.loadTune(rampTune());

        expect(h.player.enterVarispeed(() => 1)).toBe(false);

        expect(varispeedOn(h.player)).toBe(false);
        expect(h.sink.beginCalls).toHaveLength(0);
        expect(clockIsStopped(h.clock)).toBe(true);
      });

      it('is refused when the position lies past the record, with no effect', async () => {
        const h = harness();
        h.player.loadTune(rampTune());
        await h.player.play();
        run(h.clock, 30);
        h.player.setRegisterRecord(recordFromTune(rampTune(), 1, 10));
        const begins = h.sink.beginCalls.length;

        expect(h.player.enterVarispeed(() => 1)).toBe(false);

        expect(varispeedOn(h.player)).toBe(false);
        expect(h.sink.beginCalls).toHaveLength(begins);
        run(h.clock, 1);
        expect(h.player.getPosition()).toBe(31);
      });

      it('is refused from the error transport', async () => {
        const h = harness();
        h.player.loadTune(runawayTune());
        h.player.setRegisterRecord(recordFromTune(rampTune(), 1, 10));
        await h.player.play();
        run(h.clock, 1);
        expect(snapshotOf(h.player).transport).toBe('error');

        expect(h.player.enterVarispeed(() => 1)).toBe(false);
      });

      it('starts the clock and opens the sink from a stopped player, leaving the transport alone', () => {
        const h = withRecord(rampTune(), 20);
        const start = vi.spyOn(h.clock, 'start');

        expect(h.player.enterVarispeed(h.source)).toBe(true);

        expect(start).toHaveBeenCalledTimes(1);
        expect(h.sink.beginCalls).toHaveLength(1);
        expect(snapshotOf(h.player).transport).toBe('stopped');
        expect(varispeedOn(h.player)).toBe(true);
      });

      it('rides the clock a playing player already has, without a begin', async () => {
        const h = withRecord(rampTune(), 20);
        const start = vi.spyOn(h.clock, 'start');
        await h.player.play();
        run(h.clock, 3);

        expect(h.player.enterVarispeed(h.source)).toBe(true);

        expect(start).toHaveBeenCalledTimes(1);
        expect(h.sink.beginCalls).toHaveLength(1);
        run(h.clock, 1);
        expect(h.player.getPosition()).toBe(4);
      });

      it('restores all 25 registers on the first frame from a paused player', async () => {
        const h = withRecord(rampTune(), 20);
        await h.player.play();
        run(h.clock, 3);
        h.player.pause();

        h.player.enterVarispeed(h.source);
        run(h.clock, 1);

        expect(lastDelivered(h.sink).count).toBeGreaterThanOrEqual(SID_REGISTER_COUNT);
        expect(valueOf(lastDelivered(h.sink), 4)).toBe(0x41);
        expect(snapshotOf(h.player).transport).toBe('paused');
      });

      it('takes a source change between ticks, without calling the old one again', async () => {
        const h = withRecord(rampTune(), 40);
        await h.player.seek(frames(10));
        const first = vi.fn(() => 1);
        const second = vi.fn(() => -1);
        h.player.enterVarispeed(first);
        run(h.clock, 1);
        expect(first).toHaveBeenCalledWith(10, h.player.getStats().effectiveIntervalUs);

        expect(h.player.enterVarispeed(second)).toBe(true);
        run(h.clock, 1);

        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledWith(11, h.player.getStats().effectiveIntervalUs);
        expect(h.player.getPosition()).toBe(10);
      });

      it('reads a source that returns something non-finite as 0', () => {
        const h = withRecord(rampTune(), 40);
        h.player.enterVarispeed(() => Number.NaN);

        run(h.clock, 3);

        expect(h.player.getPosition()).toBe(0);
      });

      it('fails the player when the rate source throws', () => {
        const h = withRecord(rampTune(), 40);
        h.player.enterVarispeed(() => {
          throw new Error('boom');
        });

        run(h.clock, 1);

        expect(snapshotOf(h.player).transport).toBe('error');
        expect(varispeedOn(h.player)).toBe(false);
        expect(clockIsStopped(h.clock)).toBe(true);
      });
    });

    describe('the varispeed tick', () => {
      it.each([
        ['1', 1, 0],
        ['2', 2, 0],
        ['0.5', 0.5, 0],
        ['-1', -1, 12],
        ['-0.5', -0.5, 12],
        ['0', 0, 8],
      ])(
        'follows rate %s: the position, the entry fed and the frequency scaled by the rate',
        async (_label, rate, start) => {
          const h = withRecord(rampTune(), 40);
          if (start > 0) await h.player.seek(frames(start));
          h.rate.value = rate;
          expect(h.player.enterVarispeed(h.source)).toBe(true);

          const positions: number[] = [];
          let position = start;
          for (let tick = 0; tick < 8; tick++) {
            run(h.clock, 1);
            position = Math.min(40, Math.max(0, position + rate));
            positions.push(position);
            expect(h.player.getPosition()).toBe(Math.floor(position));
            expect(h.player.getStats().framesRendered).toBe(Math.floor(position));
          }

          expect(h.sink.deliveredFrames).toHaveLength(8);
          chipsOf(h.sink).forEach((chip, tick) => {
            const entry = Math.max(0, Math.floor(positions[tick]) - 1);
            expect(chip).toEqual(expectedChip(h.record, entry, rate));
          });
        },
      );

      it('changes the entry on every second tick at rate 0.5', async () => {
        const h = withRecord(rampTune(), 40);
        await h.player.seek(frames(4));
        h.rate.value = 0.5;
        h.player.enterVarispeed(h.source);

        run(h.clock, 6);

        // Pulse width low rides the counter, so it is in a frame exactly when the entry changed.
        const wrote = h.sink.deliveredFrames.map(({ frame }) => valueOf(frame, 2) !== undefined);
        expect(wrote).toEqual([true, true, false, true, false, true]);
      });

      it('delivers a frame on every tick, even when nothing changed, and reports no cycles', () => {
        const h = withRecord(rampTune(), 40);
        h.rate.value = 0;
        h.player.enterVarispeed(h.source);

        run(h.clock, 4);

        expect(h.sink.deliveredFrames).toHaveLength(4);
        expect(h.player.getStats().cpu.cyclesUsed).toBe(0);
        expect(h.player.getStats().delivery.scheduledFrames).toBe(4);
      });

      it('holds a stopped tune silent at rate 0, and a playing one', async () => {
        const stopped = withRecord(rampTune(), 40);
        stopped.rate.value = 0;
        stopped.player.enterVarispeed(stopped.source);
        run(stopped.clock, 3);
        expect(chipsOf(stopped.sink)[2][0] | (chipsOf(stopped.sink)[2][1] << 8)).toBe(0);

        const playing = withRecord(rampTune(), 40);
        await playing.player.play();
        run(playing.clock, 10);
        playing.rate.value = 0;
        playing.player.enterVarispeed(playing.source);
        run(playing.clock, 3);

        const chip = chipsOf(playing.sink).at(-1) as Uint8Array;
        expect(chip[0] | (chip[1] << 8)).toBe(0);
        expect(playing.player.getPosition()).toBe(10);
      });

      it('scales frequency by the rate on top of the clock correction and voice pitch, clamped to the register', async () => {
        const h = withRecord(rampTune(), 60);
        await h.player.seek(frames(20));
        h.player.setTargetClock(PAL_PHI2_HZ, NTSC_PHI2_HZ);
        h.player.setVoicePitch(0, 2);
        h.player.enterVarispeed(h.source);
        const ratio = clockRatio(PAL_PHI2_HZ, NTSC_PHI2_HZ) as number;
        const chip = new Uint8Array(SID_REGISTER_COUNT);

        let position = 20;
        for (const rate of [1.5, -2, 0, 1, 1000]) {
          h.rate.value = rate;
          run(h.clock, 1);
          const moved = Math.min(60, Math.max(0, position + rate));
          const travelled = moved - position;
          position = moved;
          applyFrameToChip(chip, lastDelivered(h.sink));
          const row = rowOf(h.record, Math.floor(position) - 1);
          const raw = row[0] | (row[1] << 8);
          const expected = Math.min(0xffff, Math.round(raw * (ratio * 2 * Math.abs(travelled))));
          expect(chip[0] | (chip[1] << 8)).toBe(expected);
        }
      });

      it('keeps a muted voice silent and still applies a hold and an offset', () => {
        const h = withRecord(rampTune(), 40);
        h.player.setVoiceMuted(0, true);
        h.player.holdField({ name: 'pulseWidth', voice: 0 }, 0x234);
        h.player.setFieldOffset({ name: 'frequency', voice: 0 }, 10);
        h.rate.value = 2;
        h.player.enterVarispeed(h.source);

        run(h.clock, 3);

        for (const { frame } of h.sink.deliveredFrames) {
          expect(valueOf(frame, 4) ?? 0).toBe(0);
        }
        const chip = chipsOf(h.sink).at(-1) as Uint8Array;
        const raw = rowOf(h.record, 5);
        expect(chip[4]).toBe(0);
        expect(chip[2]).toBe(0x34);
        expect(chip[3]).toBe(0x02);
        expect(chip[0] | (chip[1] << 8)).toBe(Math.round((raw[0] | (raw[1] << 8)) * 2) + 10);
      });

      it('delivers a retrigger as two control-register entries in one frame', () => {
        const h = withRecord(retriggerTune(), 10);
        h.player.enterVarispeed(h.source);

        run(h.clock, 1);

        expect(
          writesOf(h.sink.deliveredFrames[0].frame).filter(([register]) => register === 4),
        ).toEqual([
          [4, 0x40],
          [4, 0x41],
        ]);
      });

      it('releases a gate the shadow would hide, as live playback does', async () => {
        const live = harness();
        live.player.loadTune(retriggerTune());
        await live.player.play();
        run(live.clock, 2);

        const h = withRecord(retriggerTune(), 10);
        h.player.enterVarispeed(h.source);
        run(h.clock, 2);

        const gate = (chips: Uint8Array[]): number => chips[1][4] & 0x01;
        expect(gate(chipsOf(live.sink))).toBe(0);
        expect(gate(chipsOf(h.sink))).toBe(0);
        expect(chipsOf(h.sink)).toEqual(chipsOf(live.sink));
      });
    });

    describe('a loop that holds varispeed', () => {
      const frequencyOf = (chip: Uint8Array): number => chip[0] | (chip[1] << 8);

      /** In varispeed over a 60-frame record, inside a loop over 5…10 that holds in `mode`, at
       *  `position`. */
      async function heldIn(mode: 'stop' | 'wrap', position: number, rate: number): Promise<Held> {
        const h = withRecord(rampTune(), 60);
        h.player.setActiveLoop({
          startFrame: frames(5),
          endFrame: frames(10),
          varispeedStart: mode,
        });
        await flushEntryImageCapture();
        h.rate.value = rate;
        h.player.enterVarispeed(h.source);
        await h.player.seek(frames(position));
        return h;
      }

      it('wraps a move past the end to the start, keeping the pitch of the full rate', async () => {
        const h = await heldIn('stop', 8, 3);

        run(h.clock, 1); // 8 + 3 = 11, one past the end: lands at 6

        expect(h.player.getPosition()).toBe(6);
        expect(chipsOf(h.sink)[0]).toEqual(expectedChip(h.record, 5, 3));
      });

      it('goes silent while held at a stopped start, after the tick that reached it', async () => {
        const h = await heldIn('stop', 6, -1);

        run(h.clock, 3);

        const chips = chipsOf(h.sink);
        expect(h.player.getPosition()).toBe(5);
        expect(frequencyOf(chips[0])).not.toBe(0); // 6 to 5: travelled a whole call
        expect(frequencyOf(chips[1])).toBe(0);
        expect(frequencyOf(chips[2])).toBe(0);
      });

      it('wraps backward past the start to just below the end, at the full pitch', async () => {
        const h = await heldIn('wrap', 6, -3);

        run(h.clock, 1); // 6 - 3 = 3, two under the start: lands at 10 - 2 = 8

        expect(h.player.getPosition()).toBe(8);
        expect(chipsOf(h.sink)[0]).toEqual(expectedChip(h.record, 7, 3));
      });

      it('leaves a queued jump, the hand-off count and the loop alone across wraps', async () => {
        const h = withRecord(rampTune(), 60);
        h.player.setJumpTargets([frames(30)]);
        h.player.setActiveLoop({
          startFrame: frames(5),
          endFrame: frames(10),
          varispeedStart: 'wrap',
        });
        await flushEntryImageCapture();
        h.rate.value = 4;
        h.player.enterVarispeed(h.source);
        await h.player.seek(frames(8));
        h.player.queueJump({ startFrame: frames(30), endFrame: frames(40) });
        await flushEntryImageCapture();
        const queuedBefore = snapshotOf(h.player).tune?.queuedJump;
        const requests = h.replay.requests.length;

        run(h.clock, 6); // 8 → 7 → 6 → 5 → 9 → 8 → 7: wraps on ticks 1 and 4

        expect(h.player.getPosition()).toBeGreaterThanOrEqual(5);
        expect(h.player.getPosition()).toBeLessThan(10);
        expect(handOffs(h.player)).toBe(0);
        expect(snapshotOf(h.player).tune?.queuedJump).toEqual(queuedBefore);
        expect(snapshotOf(h.player).tune?.queuedJump).not.toBeNull();
        expect(snapshotOf(h.player).loop).toEqual({
          startFrame: 5,
          endFrame: 10,
          varispeedStart: 'wrap',
        });
        expect(h.player.getStats().resync.inFlightDepth).toBe(0);
        expect(h.replay.requests).toHaveLength(requests);
      });

      it('keeps its mode on the loop a queued jump hands off to', async () => {
        const h = withRecord(rampTune(), 60);
        await h.player.play();
        h.player.setJumpTargets([frames(30)]);
        h.player.setActiveLoop({ startFrame: frames(5), endFrame: frames(10) });
        await flushEntryImageCapture();

        h.player.queueJump({
          startFrame: frames(30),
          endFrame: frames(40),
          varispeedStart: 'stop',
        });

        expect(snapshotOf(h.player).tune?.queuedJump).toEqual({
          startFrame: 30,
          endFrame: 40,
          varispeedStart: 'stop',
        });
        for (let tick = 0; tick < 100 && handOffs(h.player) !== 1; tick++) run(h.clock, 1);
        expect(handOffs(h.player)).toBe(1);
        expect(snapshotOf(h.player).loop).toEqual({
          startFrame: 30,
          endFrame: 40,
          varispeedStart: 'stop',
        });
      });

      it('drops the mode from a queued cue, which has no loop to hold', async () => {
        const h = withRecord(rampTune(), 60);
        h.player.setActiveLoop({ startFrame: frames(5), endFrame: frames(10) });
        await flushEntryImageCapture();

        h.player.queueJump({ startFrame: frames(30), endFrame: null, varispeedStart: 'wrap' });

        expect(snapshotOf(h.player).tune?.queuedJump).toEqual({ startFrame: 30, endFrame: null });
      });

      it('reports the mode in the loop snapshot, and notifies when only the mode changes', () => {
        const h = withRecord(rampTune(), 60);
        const listener = vi.fn();
        h.player.setActiveLoop({ startFrame: frames(5), endFrame: frames(10) });
        h.player.subscribe(listener);

        h.player.setActiveLoop({
          startFrame: frames(5),
          endFrame: frames(10),
          varispeedStart: 'wrap',
        });

        expect(snapshotOf(h.player).loop).toEqual({
          startFrame: 5,
          endFrame: 10,
          varispeedStart: 'wrap',
        });
        expect(listener).toHaveBeenCalledTimes(1);

        h.player.setActiveLoop({
          startFrame: frames(5),
          endFrame: frames(10),
          varispeedStart: 'wrap',
        });
        expect(listener).toHaveBeenCalledTimes(1);
      });

      it('still laps at the loop end during the handback', async () => {
        const h = withRecord(rampTune(), 60);
        h.player.setActiveLoop({
          startFrame: frames(5),
          endFrame: frames(10),
          varispeedStart: 'wrap',
        });
        await flushEntryImageCapture();
        await h.player.seek(frames(8));
        h.player.enterVarispeed(h.source);
        await h.player.play();
        h.replay.manual = true;
        h.player.leaveVarispeed();

        run(h.clock, 2);

        expect(varispeedOn(h.player)).toBe(false);
        expect(h.player.getPosition()).toBe(5);
        expect(h.player.getStats().resync.inFlightDepth).toBe(1);
      });
    });

    describe('transport inside varispeed', () => {
      it('leaves the clock alone for play and pause, and sends no gate-off', async () => {
        const h = withRecord(rampTune(), 40);
        const start = vi.spyOn(h.clock, 'start');
        const stop = vi.spyOn(h.clock, 'stop');
        const before = h.sink.calls.length; // loadTune resets the sink
        h.player.enterVarispeed(h.source);

        await h.player.play();
        expect(snapshotOf(h.player).transport).toBe('playing');
        h.player.pause();
        expect(snapshotOf(h.player).transport).toBe('paused');
        run(h.clock, 2);
        await h.player.play();

        expect(snapshotOf(h.player).transport).toBe('playing');
        expect(start).toHaveBeenCalledTimes(1);
        expect(stop).not.toHaveBeenCalled();
        expect(h.sink.calls.slice(before)).toEqual(['begin', 'deliver', 'deliver']);
        expect(h.player.getPosition()).toBe(2);
      });

      it('moves the position with seek and replays nothing', async () => {
        const h = withRecord(rampTune(), 40);
        h.player.enterVarispeed(h.source);

        await h.player.seek(frames(9999));
        expect(h.player.getPosition()).toBe(40);
        await h.player.seek(frames(7));
        expect(h.player.getPosition()).toBe(7);
        await h.player.seek(frames(-5));
        expect(h.player.getPosition()).toBe(0);
        await h.player.seek(frames(7));
        run(h.clock, 1);

        expect(h.player.getPosition()).toBe(8);
        expect(h.replay.requests).toHaveLength(0);
        expect(chipsOf(h.sink)[0]).toEqual(expectedChip(h.record, 7, 1));
      });

      it('applies the settings a seek carries at once', async () => {
        const h = withRecord(rampTune(), 40);
        h.player.enterVarispeed(h.source);

        await h.player.seek(frames(5), { voiceMutes: [true] });

        expect(snapshotOf(h.player).voices[0].muted).toBe(true);
        expect(h.replay.requests).toHaveLength(0);
      });

      it('caches no image when the position is captured', () => {
        const h = withRecord(rampTune(), 40);
        h.player.enterVarispeed(h.source);
        run(h.clock, 5);

        expect(h.player.capturePosition()).toBe(5);
        h.player.setJumpTargets([frames(5)]);

        expect(preparedFrames(h.player)).toEqual([]);
      });

      it('counts varispeed as a running clock when the tempo moves', () => {
        const h = withRecord(rampTune(), 40);
        const setInterval = vi.spyOn(h.clock, 'setIntervalUs');
        const intervals: number[] = [];
        h.player.enterVarispeed((_position, intervalUs) => {
          intervals.push(intervalUs);
          return 1;
        });
        run(h.clock, 1);

        h.player.setTempo(2);
        run(h.clock, 1);

        expect(setInterval).toHaveBeenCalledTimes(1);
        expect(h.sink.calls).toContain('retime');
        expect(intervals[1]).toBeCloseTo(intervals[0] / 2);
        expect(h.player.getStats().effectiveIntervalUs).toBe(intervals[1]);
      });

      it('does not wrap an active loop or land a queued jump, then enforces both on handing back', async () => {
        const h = withRecord(rampTune(), 100);
        h.player.setJumpTargets([frames(50)]);
        h.player.setActiveLoop({ startFrame: frames(5), endFrame: frames(10) });
        h.player.queueJump({ startFrame: frames(50), endFrame: null });
        await flushEntryImageCapture();
        expect(preparedFrames(h.player)).toEqual([50]);
        h.player.enterVarispeed(h.source);
        await h.player.play();

        run(h.clock, 15);

        expect(h.player.getPosition()).toBe(15);
        expect(handOffs(h.player)).toBe(0);
        expect(snapshotOf(h.player).tune?.queuedJump).toEqual({ startFrame: 50, endFrame: null });
        expect(snapshotOf(h.player).loop).toEqual({ startFrame: 5, endFrame: 10 });

        h.replay.manual = true;
        h.player.leaveVarispeed();
        run(h.clock, 1);

        expect(handOffs(h.player)).toBe(1);
        expect(h.player.getPosition()).toBe(50);
        expect(varispeedOn(h.player)).toBe(false);
        expect(snapshotOf(h.player).loop).toBeNull();
      });
    });

    describe('leaving out of the playing transport: the handback', () => {
      it('hands back with no gate-off, the chip and the frames after it equal to a straight live run', async () => {
        const file = retriggerTune();
        const live = harness();
        live.player.loadTune(file);
        await live.player.play();
        run(live.clock, 130);

        const h = withRecord(file, 200);
        h.player.enterVarispeed(h.source);
        await h.player.play();
        run(h.clock, 20);
        h.player.leaveVarispeed();
        expect(varispeedOn(h.player)).toBe(true);
        await flushEntryImageCapture();

        expect(h.replay.requests).toHaveLength(1);
        expect(h.replay.requests[0].targetFrame).toBe(20 + LEAD);
        expect(h.replay.requests[0].mutes).toEqual([false, false, false]);
        run(h.clock, LEAD - 1);
        expect(varispeedOn(h.player)).toBe(true);
        run(h.clock, 1);
        expect(varispeedOn(h.player)).toBe(false);
        expect(h.player.getPosition()).toBe(20 + LEAD);
        run(h.clock, 10);

        expect(h.sink.deliveredFrames).toHaveLength(130);
        expect(h.sink.deliveredNowFrames).toHaveLength(0);
        expect(h.sink.calls).not.toContain('deliverNow');
        expect(chipsOf(h.sink)).toEqual(chipsOf(live.sink));
        for (let index = 20 + LEAD; index < 130; index++) {
          expect(writesOf(h.sink.deliveredFrames[index].frame)).toEqual(
            writesOf(live.sink.deliveredFrames[index].frame),
          );
        }
        expect(snapshotOf(h.player).transport).toBe('playing');
        expect(h.player.getPosition()).toBe(130);
      });

      it('never calls the source again, and brings the rate pitch home before the first frame', async () => {
        const h = withRecord(rampTune(), 200);
        h.rate.value = 3;
        const source = vi.fn(() => h.rate.value);
        h.player.enterVarispeed(source);
        await h.player.play();
        run(h.clock, 5);
        const calls = source.mock.calls.length;
        expect(readSent(h.player).sent[0]).not.toBe(readSent(h.player).written[0]);

        h.player.leaveVarispeed();
        run(h.clock, 3);

        expect(source).toHaveBeenCalledTimes(calls);
        expect(h.player.getPosition()).toBe(15 + 3);
        expect(readSent(h.player).sent[0]).toBe(readSent(h.player).written[0]);
      });

      it('lands paused with a gate-off when paused during the handback', async () => {
        const h = withRecord(rampTune(), 400);
        h.replay.manual = true;
        h.player.enterVarispeed(h.source);
        await h.player.play();
        run(h.clock, 5);
        h.player.leaveVarispeed();

        h.player.pause();

        expect(snapshotOf(h.player).transport).toBe('paused');
        expect(varispeedOn(h.player)).toBe(false);
        expect(writesOf(lastDeliveredNow(h.sink))).toEqual([
          [4, 0],
          [11, 0],
          [18, 0],
        ]);
        expect(h.sink.calls.lastIndexOf('deliverNow')).toBeLessThan(
          h.sink.calls.lastIndexOf('end'),
        );
        expect(clockIsStopped(h.clock)).toBe(true);
        expect(h.player.getPosition()).toBe(5);

        h.replay.resolveAll();
        await flushEntryImageCapture();

        // The handback's image is stale; the landing's is not, and it is silent.
        expect(h.replay.requests[1].targetFrame).toBe(5);
        expect(h.player.getPosition()).toBe(5);
        const landing = lastDeliveredNow(h.sink);
        expect(landing.count).toBe(SID_REGISTER_COUNT);
        for (const register of VOICE_CONTROL_REGISTERS) {
          expect(valueOf(landing, register)).toBe(0);
        }
      });

      it('restarts the image request at the new position on a seek, dropping the stale image', async () => {
        const h = withRecord(rampTune(), 400);
        h.replay.manual = true;
        h.player.enterVarispeed(h.source);
        await h.player.play();
        run(h.clock, 20);
        h.player.leaveVarispeed();
        expect(h.replay.requests.map((request) => request.targetFrame)).toEqual([20 + LEAD]);

        await h.player.seek(frames(200));
        expect(h.replay.requests.map((request) => request.targetFrame)).toEqual([
          20 + LEAD,
          200 + LEAD,
        ]);
        h.replay.resolveAll();
        await flushEntryImageCapture();

        // Had the old image, at 120, been kept it would sit behind the playhead and be asked for again.
        expect(h.replay.requests).toHaveLength(2);
        run(h.clock, LEAD - 1);
        expect(varispeedOn(h.player)).toBe(true);
        run(h.clock, 1);
        expect(varispeedOn(h.player)).toBe(false);
        expect(h.player.getPosition()).toBe(200 + LEAD);
      });

      it('asks again with double the lead when the image arrives behind the playhead', async () => {
        const h = withRecord(rampTune(), 400);
        h.replay.manual = true;
        h.player.enterVarispeed(h.source);
        await h.player.play();
        run(h.clock, 20);
        h.player.leaveVarispeed();
        run(h.clock, 150);
        expect(h.player.getPosition()).toBe(170);

        h.replay.resolveAll();
        await flushEntryImageCapture();

        expect(h.replay.requests.map((request) => request.targetFrame)).toEqual([
          20 + LEAD,
          170 + 2 * LEAD,
        ]);
        h.replay.resolveAll();
        await flushEntryImageCapture();
        run(h.clock, 2 * LEAD - 1);
        expect(varispeedOn(h.player)).toBe(true);
        run(h.clock, 1);
        expect(varispeedOn(h.player)).toBe(false);
        expect(h.player.getPosition()).toBe(170 + 2 * LEAD);
      });

      it('is cancelled by entering again, and the image that arrives is dropped', async () => {
        const h = withRecord(rampTune(), 400);
        h.replay.manual = true;
        h.player.enterVarispeed(h.source);
        await h.player.play();
        run(h.clock, 20);
        h.player.leaveVarispeed();

        expect(h.player.enterVarispeed(h.source)).toBe(true);
        h.replay.resolveAll();
        await flushEntryImageCapture();
        run(h.clock, 2 * LEAD);

        expect(varispeedOn(h.player)).toBe(true);
        expect(h.player.getPosition()).toBe(20 + 2 * LEAD);
        expect(h.replay.requests).toHaveLength(1);
      });

      it('wraps as a lap when the loop end is crossed during the handback', async () => {
        const h = withRecord(rampTune(), 60);
        h.player.setActiveLoop({ startFrame: frames(5), endFrame: frames(10) });
        await flushEntryImageCapture();
        await h.player.seek(frames(8));
        h.player.enterVarispeed(h.source);
        await h.player.play();
        h.replay.manual = true;
        h.player.leaveVarispeed();

        run(h.clock, 1);
        expect(varispeedOn(h.player)).toBe(true);
        run(h.clock, 1);

        expect(varispeedOn(h.player)).toBe(false);
        expect(h.player.getPosition()).toBe(5);
        expect(snapshotOf(h.player).transport).toBe('playing');
        expect(h.player.getStats().resync.inFlightDepth).toBe(1);
        run(h.clock, 1); // the gate-off the lap owes
        for (const register of VOICE_CONTROL_REGISTERS) {
          expect(valueOf(lastDelivered(h.sink), register)).toBe(0);
        }
        run(h.clock, 1); // the resync, riding the first frame played from the lap's image
        expect(lastDelivered(h.sink).count).toBe(SID_REGISTER_COUNT);
        expect(valueOf(lastDelivered(h.sink), 0)).toBe(6);
        run(h.clock, 1);
        expect(valueOf(lastDelivered(h.sink), 0)).toBe(7);

        h.replay.resolveAll();
        await flushEntryImageCapture();
        expect(h.player.getPosition()).toBeLessThan(20);
      });

      it('ends the track when it starts past the track end with repeat off', async () => {
        const h = withRecord(rampTune(), 100);
        h.player.setTrackStructure({
          loopStartFrame: null,
          loopPeriodFrames: null,
          endedAtFrame: frames(30),
        });
        h.player.setRepeatTrack(false);
        await h.player.seek(frames(50));
        h.player.enterVarispeed(h.source);
        await h.player.play();
        h.replay.manual = true;
        h.player.leaveVarispeed();

        run(h.clock, 1);

        expect(snapshotOf(h.player).transport).toBe('ended');
        expect(varispeedOn(h.player)).toBe(false);
        expect(h.player.getPosition()).toBe(51);
        expect(clockIsStopped(h.clock)).toBe(true);
      });

      it('laps to the loop start when it starts past the track end with repeat on', async () => {
        const h = withRecord(rampTune(), 100);
        h.player.setTrackStructure({
          loopStartFrame: frames(4),
          loopPeriodFrames: frames(26),
          endedAtFrame: null,
        });
        h.player.setRepeatTrack(true);
        await flushEntryImageCapture();
        await h.player.seek(frames(50));
        h.player.enterVarispeed(h.source);
        await h.player.play();
        h.replay.manual = true;
        h.player.leaveVarispeed();

        run(h.clock, 1);

        expect(snapshotOf(h.player).transport).toBe('playing');
        expect(varispeedOn(h.player)).toBe(false);
        expect(h.player.getPosition()).toBe(4);
        expect(snapshotOf(h.player).loop).toEqual({ startFrame: 4, endFrame: 30 });
        expect(h.player.getStats().resync.inFlightDepth).toBe(1);
      });
    });

    describe('leaving out of a transport that is not playing', () => {
      const setups: [string, (h: Held) => Promise<number>][] = [
        [
          'stopped',
          (h) => {
            h.player.enterVarispeed(h.source);
            run(h.clock, 10);
            return Promise.resolve(10);
          },
        ],
        [
          'paused',
          async (h) => {
            h.player.enterVarispeed(h.source);
            await h.player.play();
            run(h.clock, 10);
            h.player.pause();
            return 10;
          },
        ],
        [
          'ended',
          async (h) => {
            h.player.setTrackStructure({
              loopStartFrame: null,
              loopPeriodFrames: null,
              endedAtFrame: frames(10),
            });
            await h.player.play();
            run(h.clock, 10);
            expect(snapshotOf(h.player).transport).toBe('ended');
            h.player.enterVarispeed(h.source);
            run(h.clock, 3);
            return 13;
          },
        ],
      ];

      it.each(setups)(
        'lands paused at the position with a gate-off at once and a silent landing from %s',
        async (_label, setup) => {
          const h = withRecord(rampTune(), 40);
          const position = await setup(h);
          expect(h.player.getPosition()).toBe(position);

          h.player.leaveVarispeed();

          expect(snapshotOf(h.player).transport).toBe('paused');
          expect(varispeedOn(h.player)).toBe(false);
          expect(h.player.getPosition()).toBe(position);
          expect(writesOf(lastDeliveredNow(h.sink))).toEqual([
            [4, 0],
            [11, 0],
            [18, 0],
          ]);
          expect(h.sink.calls.lastIndexOf('deliverNow')).toBeLessThan(
            h.sink.calls.lastIndexOf('end'),
          );
          expect(clockIsStopped(h.clock)).toBe(true);

          await flushEntryImageCapture();

          expect(h.replay.requests.at(-1)?.targetFrame).toBe(position);
          const landing = lastDeliveredNow(h.sink);
          expect(landing.count).toBe(SID_REGISTER_COUNT);
          for (const register of VOICE_CONTROL_REGISTERS) {
            expect(valueOf(landing, register)).toBe(0);
          }
          expect(h.player.getPosition()).toBe(position);

          await h.player.play();
          run(h.clock, 1);
          expect(valueOf(lastDelivered(h.sink), 0)).toBe(position + 1);
        },
      );

      it('does nothing outside varispeed', () => {
        const h = withRecord(rampTune(), 40);

        h.player.leaveVarispeed();

        expect(snapshotOf(h.player).transport).toBe('stopped');
        expect(h.sink.calls).toEqual(['reset']); // loadTune's, and nothing since
      });
    });

    describe('the exits that leave with no landing', () => {
      it.each([
        ['stop', (h: Held) => h.player.stop()],
        ['a subtune change', (h: Held) => h.player.selectSubtune(2)],
        ['leaving paused', (h: Held) => h.player.leaveVarispeed()],
      ])('return the rate pitch to home on %s', async (_label, exit) => {
        const h = withRecord(rampTune(2), 40);
        h.rate.value = 0;
        h.player.enterVarispeed(h.source);
        run(h.clock, 2);
        expect(readSent(h.player).sent[0]).toBe(0);

        exit(h);
        await flushEntryImageCapture();

        const { written, sent } = readSent(h.player);
        expect(sent[0]).toBe(written[0]);
        expect(sent[1]).toBe(written[1]);
        expect(varispeedOn(h.player)).toBe(false);
      });

      it('plays raw frequencies after a stop out of a hold at rate 0', async () => {
        const h = withRecord(rampTune(), 40);
        h.rate.value = 0;
        h.player.enterVarispeed(h.source);
        run(h.clock, 2);

        h.player.stop();
        await h.player.play();
        run(h.clock, 1);

        expect(valueOf(lastDelivered(h.sink), 0)).toBe(1);
        expect(valueOf(lastDelivered(h.sink), 1)).toBe(1);
      });

      it.each([
        ['stopped', false],
        ['paused', true],
      ])(
        'stops the clock and ends the sink when %s varispeed meets loadTune or selectSubtune',
        async (_label, pause) => {
          for (const exit of [
            (h: Held) => h.player.loadTune(rampTune(2)),
            (h: Held) => h.player.selectSubtune(2),
          ]) {
            const h = withRecord(rampTune(2), 40);
            h.player.enterVarispeed(h.source);
            if (pause) {
              await h.player.play();
              h.player.pause();
            }
            run(h.clock, 2);
            const ends = h.sink.endCallCount;

            exit(h);

            expect(clockIsStopped(h.clock)).toBe(true);
            expect(h.sink.endCallCount).toBe(ends + 1);
            expect(varispeedOn(h.player)).toBe(false);
            expect(snapshotOf(h.player).tune?.recordedFrames).toBeNull();
          }
        },
      );

      it('keeps a playing clock running through a subtune change, with the machine live again', async () => {
        const h = withRecord(rampTune(2), 40);
        h.player.enterVarispeed(h.source);
        await h.player.play();
        run(h.clock, 2);

        h.player.selectSubtune(2);
        run(h.clock, 1);

        expect(varispeedOn(h.player)).toBe(false);
        expect(snapshotOf(h.player).transport).toBe('playing');
        expect(h.player.getPosition()).toBe(1);
        expect(h.player.getStats().cpu.cyclesUsed).toBeGreaterThan(0);
      });
    });

    describe('the clock a non-playing varispeed starts', () => {
      /** A clock whose `start` stays pending until the test releases it. */
      class DeferredStartClock extends FakeClock {
        running = false;
        private release: (() => void) | null = null;

        override start(
          intervalUs: Microseconds,
          onFrame: (dueAtMs: Milliseconds, catchUpClamped: boolean) => void,
        ): Promise<void> {
          return new Promise<void>((resolve) => {
            this.release = () => {
              this.running = true;
              void super.start(intervalUs, onFrame);
              resolve();
            };
          });
        }

        override stop(): void {
          this.running = false;
          super.stop();
        }

        resolveStart(): void {
          this.release?.();
        }
      }

      it('is stopped again when it starts after its varispeed has already ended', async () => {
        const sink = new RecordingSink();
        const clock = new DeferredStartClock();
        const player = createSidPlayer({ sink, clock, replayRunner: new FakeReplayRunner() });
        player.loadTune(rampTune());
        player.setRegisterRecord(recordFromTune(rampTune(), 1, 10));
        player.enterVarispeed(() => 1);
        player.leaveVarispeed();

        clock.resolveStart();
        await flushEntryImageCapture();

        expect(clock.running).toBe(false);
      });

      it('fails the player, and closes the sink it opened, when it cannot start', async () => {
        const sink = new RecordingSink();
        const player = createSidPlayer({
          sink,
          clock: new FailingClock(),
          replayRunner: new FakeReplayRunner(),
        });
        player.loadTune(rampTune());
        player.setRegisterRecord(recordFromTune(rampTune(), 1, 10));

        player.enterVarispeed(() => 1);
        await flushEntryImageCapture();

        expect(snapshotOf(player).transport).toBe('error');
        expect(varispeedOn(player)).toBe(false);
        expect(sink.calls.slice(1)).toEqual(['begin', 'end']);
      });
    });
  });
});
