import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FrameClock, FrameClockStats } from '../ports/clock.js';
import type { SidFrame } from '../registers/sid-frame.js';
import { PAL_FRAME_INTERVAL_US, VOICE_CONTROL_REGISTERS } from '../registers/sid-constants.js';
import type { ReplayRequest, ReplayResponse, ReplayRunner } from '../replay/replay-runner.js';
import { replayToFrame } from '../replay/replay-to-frame.js';
import type { SidClock, SidFile, SidModel } from '../sid/sid-file.model.js';
import { FakeClock } from '../testing/fake-clock.js';
import { FakeSink } from '../testing/fake-sink.js';
import { frames, microseconds, milliseconds } from '../units.js';
import type { Microseconds, Milliseconds } from '../units.js';
import { createSidPlayer } from './create-sid-player.js';
import type { SidPlayer } from './sid-player.js';

/** Answers every request against the real `replayToFrame`, immediately — the landing is what these
 *  tests are about, not the thread it crosses. */
class FakeReplayRunner implements ReplayRunner {
  disposed = false;

  run(request: ReplayRequest): Promise<ReplayResponse> {
    try {
      return Promise.resolve({
        id: request.id,
        ok: true,
        result: replayToFrame(request.file, request.subtune, request.targetFrame, request.mutes),
      });
    } catch (error) {
      return Promise.resolve({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  dispose(): void {
    this.disposed = true;
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
 *  replay landed on can be read back off the delivered frame. */
function counterTune(): SidFile {
  return tune({
    blocks: [
      { at: 0x1000, bytes: [RTS] },
      { at: 0x1010, bytes: [0xe6, 0xfb, 0xa5, 0xfb, 0x8d, 0x00, 0xd4, RTS] },
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

/** Ticks `count` frames, each one interval apart on the same rising timeline a real clock reports. */
function run(clock: FakeClock, count: number, from = 0): void {
  for (let index = 0; index < count; index++) {
    clock.tick(milliseconds(performance.now() + from + index));
  }
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
});
