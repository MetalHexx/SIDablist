import type { FarEndConsumption, SidSink } from '../ports/sink.js';
import type { ReplayRequest, ReplayResponse, ReplayRunner } from '../replay/replay-runner.js';
import { replayToFrame } from '../replay/replay-to-frame.js';
import type { SidFile } from '../sid/sid-file.model.js';
import { FakeClock } from '../testing/fake-clock.js';
import { measureAllocation, type AllocationMeasurement } from '../testing/measure-allocation.js';
import { milliseconds } from '../units.js';
import { createSidPlayer } from './create-sid-player.js';
import type { SidPlayer } from './sid-player.js';

/** What the allocation specs share: a player on a fake clock with a sink that copies nothing, and
 *  the tunes they play. Kept out of the specs so the ones that must run in a process of their own
 *  can. */

export const FRAMES = 30_000;
/** Restores with no tick between them cost far less than a tick, so a run of them is as many as a
 *  run of frames: enough for whatever one builds to show. */
export const RESTORES = 30_000;
/** Enough passes for the engine to have optimised every function the tick reaches, so the code it
 *  installs while tiering up is not counted as growth. */
const WARMUP = 8;
export const RTS = 0x60;

const CONSUMED: FarEndConsumption = { kind: 'unknown', inFlight: 0 };

/** Holds nothing and copies nothing, so what a run allocates is the engine's own: `FakeSink` copies
 *  every delivered frame, which would be the measurement. */
const nullSink: SidSink = {
  capabilities: {
    perWriteOffsets: false,
    cancellation: false,
    scheduleAheadMs: null,
    preservesWriteOrder: false,
  },
  begin: () => undefined,
  end: () => undefined,
  deliver: () => undefined,
  deliverNow: () => undefined,
  retime: () => undefined,
  reset: () => undefined,
  readAt: () => CONSUMED,
  passedCount: () => 0,
  replaceFrom: () => 0,
};

/** Answers a replay at once against the real `replayToFrame`: the images a jump lands on are built
 *  off the tick, and what these specs measure starts after they exist. */
const replayRunner: ReplayRunner = {
  run(request: ReplayRequest): Promise<ReplayResponse> {
    return Promise.resolve({
      id: request.id,
      ok: true,
      result: replayToFrame(
        request.file,
        request.subtune,
        request.targetFrame,
        request.mutes,
        request.start,
      ),
    });
  },
  dispose: () => undefined,
};

export function tune(
  play: readonly number[],
  init: readonly number[] = [RTS],
  speedFlags = 0,
): SidFile {
  const data = new Uint8Array(0x10 + play.length);
  data.set(init, 0);
  data.set(play, 0x10);
  return {
    format: 'PSID',
    version: 2,
    loadAddress: 0x1000,
    initAddress: 0x1000,
    playAddress: 0x1010,
    songs: 1,
    startSong: 1,
    speedFlags,
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

/** play counts in a zero-page byte and stores it to $D400, so every frame writes a register. */
export const counterTune = (): SidFile => tune([0xe6, 0xfb, 0xa5, 0xfb, 0x8d, 0x00, 0xd4, RTS]);

export interface Running {
  readonly player: SidPlayer;
  /** Ticks `count` frames on a timeline that keeps rising across calls, a whole millisecond at a
   *  time: a fractional due time held in a closure is boxed by V8 on every tick, and what these
   *  specs measure is the engine's allocation, not the harness's. */
  readonly run: (count: number) => void;
}

export async function playing(file: SidFile): Promise<Running> {
  const clock = new FakeClock();
  const player = createSidPlayer({
    sink: nullSink,
    clock,
    replayRunner,
    time: { now: () => milliseconds(0) },
  });
  player.loadTune(file);
  // Every scenario records its deliveries, so the history's append is on the path measured.
  player.keepDeliveries(64);
  await player.play();
  let dueAt = 0;
  return {
    player,
    run: (count) => {
      for (let index = 0; index < count; index++) clock.tick(milliseconds((dueAt += 20)));
    },
  };
}

/** Lets every replay a setup call fired settle. */
export const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** What `work` allocates once the engine has optimised it. */
export const measureWork = (work: () => void): Promise<AllocationMeasurement> =>
  measureAllocation(work, { warmup: WARMUP });
