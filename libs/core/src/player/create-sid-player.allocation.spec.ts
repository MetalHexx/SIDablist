import { describe, expect, it } from 'vitest';
import { createC64Machine } from '../cpu/c64-machine.js';
import type { FarEndConsumption, SidSink } from '../ports/sink.js';
import { recordFromTune } from '../registers/__fixtures__/record-from-tune.js';
import type { ReplayRequest, ReplayResponse, ReplayRunner } from '../replay/replay-runner.js';
import { replayToFrame } from '../replay/replay-to-frame.js';
import type { SidFile } from '../sid/sid-file.model.js';
import { FakeClock } from '../testing/fake-clock.js';
import { ALLOCATION_NOISE_BYTES, measureAllocation } from '../testing/measure-allocation.js';
import { frames, milliseconds } from '../units.js';
import { createSidPlayer } from './create-sid-player.js';
import type { SavedPlayerState, SidPlayer } from './sid-player.js';

const FRAMES = 3_000;
/** Enough passes for the engine to have optimised every function the tick reaches, so the code it
 *  installs while tiering up is not counted as growth. */
const WARMUP = 8;
const RTS = 0x60;

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

function tune(play: readonly number[], init: readonly number[] = [RTS], speedFlags = 0): SidFile {
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
const counterTune = (): SidFile => tune([0xe6, 0xfb, 0xa5, 0xfb, 0x8d, 0x00, 0xd4, RTS]);

/** The header says CIA-timed and play writes CIA 1 timer A's latch high byte, alternating between
 *  $20 and $21 on every call, so the rate it plays at changes on every tick. */
const swingingLatchTune = (): SidFile =>
  tune(
    [
      0xa5,
      0xfb,
      0x49,
      0x01,
      0x85,
      0xfb, // LDA $FB; EOR #$01; STA $FB
      0x18,
      0x69,
      0x20,
      0x8d,
      0x05,
      0xdc, // CLC; ADC #$20; STA $DC05
      RTS,
    ],
    [RTS],
    1,
  );

interface Running {
  readonly player: SidPlayer;
  /** Ticks `count` frames on a timeline that keeps rising across calls, in fractions of a
   *  millisecond as a real clock reports them. */
  readonly run: (count: number) => void;
}

async function playing(file: SidFile): Promise<Running> {
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
      for (let index = 0; index < count; index++) clock.tick(milliseconds((dueAt += 19.95)));
    },
  };
}

/** Lets every replay a setup call fired settle. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function expectNoAllocation(work: () => void): Promise<void> {
  const { heapGrowthBytes, scavenges } = await measureAllocation(work, { warmup: WARMUP });
  expect(scavenges).toBe(0);
  expect(heapGrowthBytes).toBeLessThan(ALLOCATION_NOISE_BYTES);
}

describe('the frame path', () => {
  it('allocates nothing over plain play', async () => {
    const { run } = await playing(counterTune());

    await expectNoAllocation(() => run(FRAMES));
  });

  it('allocates nothing while a loop laps every fifty frames', async () => {
    const { player, run } = await playing(counterTune());
    run(200);
    player.setActiveLoop({ startFrame: frames(100), endFrame: frames(150) });
    await settled();

    await expectNoAllocation(() => run(FRAMES));

    expect(player.getPosition()).toBeLessThan(150);
  });

  it('allocates nothing across a loop whose length is not whole frames', async () => {
    const { player, run } = await playing(counterTune());
    run(200);
    player.setActiveLoop({ startFrame: frames(100), endFrame: frames(150.5), lapPhase: 0 });
    await settled();

    await expectNoAllocation(() => run(FRAMES));
  });

  it('allocates nothing on a tick when a queued jump lands on a held image, over and over', async () => {
    const { player, run } = await playing(counterTune());
    run(150);
    player.setJumpTargets([frames(100), frames(300)]);
    player.setActiveLoop({ startFrame: frames(100), endFrame: frames(110) });
    await settled();
    const landings = (): number => player.getSnapshot().tune?.handOffs ?? 0;
    const before = landings();
    let toSecond = true;

    // The queue is a host's command and the landing publishes a hand-off, so a few of each ride along
    // with the 3,000 ticks; it is the ticks between them that must allocate nothing. Settings go
    // along: a landing applies what `queueJump` prepared.
    await expectNoAllocation(() => {
      for (let hop = 0; hop < 4; hop++) {
        const startFrame = toSecond ? 300 : 100;
        toSecond = !toSecond;
        player.queueJump({
          startFrame: frames(startFrame),
          endFrame: frames(startFrame + 10),
          settings: { voicePitch: [1, 1, 1], voiceMutes: [false, false, false] },
        });
        run(FRAMES / 4);
      }
    });

    expect(landings()).toBeGreaterThan(before);
  });

  it('allocates nothing with the hand on the record', async () => {
    const file = counterTune();
    const { player, run } = await playing(file);
    player.setRegisterRecord(recordFromTune(file, 1, 2_000));
    run(10);
    // Reads the position it is handed and allocates nothing itself: a swing around frame 1000
    // feeds a new record entry on every tick.
    expect(player.enterVarispeed((position) => (position < 1_000 ? 1 : -1))).toBe(true);

    await expectNoAllocation(() => run(FRAMES));
  });

  it('allocates nothing when the tune changes its rate on every call', async () => {
    const { player, run } = await playing(swingingLatchTune());
    run(2);
    const rates = new Set<number>();
    for (let index = 0; index < 6; index++) {
      run(1);
      rates.add(player.getStats().rate.exactCallsPerFrame);
    }
    expect(rates.size).toBeGreaterThan(1);

    await expectNoAllocation(() => run(FRAMES));
  });
});

describe('saving and restoring a player', () => {
  const STATES = 8;
  const RESTORE_EVERY = 50;

  /** A player with a good deal in play — a loop of a length that is not whole frames, crossing
   *  lines holding images, the shadow, a tempo, a hold, an offset and a mute — and `STATES` states
   *  to keep restore points in, as a host does. */
  async function keeping(): Promise<Running & { readonly states: readonly SavedPlayerState[] }> {
    const running = await playing(counterTune());
    const { player, run } = running;
    player.setCrossingCaptures([{ originFrame: 0, periodFrames: 25, keep: 2 }]);
    player.setTempo(1.25);
    player.holdField({ name: 'resonance' }, 9, 0.5);
    player.setFieldOffset({ name: 'frequency', voice: 0 }, 40);
    player.setVoiceMuted(1, true);
    run(200);
    player.setActiveLoop({ startFrame: frames(100), endFrame: frames(150.5), lapPhase: 0 });
    await settled();
    player.startShadow(null);
    return {
      ...running,
      states: Array.from({ length: STATES }, () => player.createSavedState()),
    };
  }

  it('allocates nothing over frames saved every frame and restored every fifty', async () => {
    const { player, run, states } = await keeping();
    const published = player.getSnapshot();
    let frame = 0;
    let restores = 0;

    // A restore goes back to the state saved seven frames before: the same loop, tempo, mutes and
    // shadow, so nothing a snapshot publishes differs and none is built.
    await expectNoAllocation(() => {
      for (let index = 0; index < FRAMES; index++) {
        run(1);
        player.saveState(states[frame % STATES]);
        frame++;
        if (frame % RESTORE_EVERY === 0) {
          player.restoreState(states[(frame + 1) % STATES]);
          restores++;
        }
      }
    });

    expect(restores).toBeGreaterThan(FRAMES / RESTORE_EVERY);
    expect(player.getSnapshot()).toBe(published);
  });

  it('allocates nothing across restores alone', async () => {
    const { player, states } = await keeping();
    player.saveState(states[0]);

    // No tick between them: whatever a restore itself builds shows, ten times over.
    await expectNoAllocation(() => {
      for (let index = 0; index < FRAMES * 10; index++) player.restoreState(states[0]);
    });
  });

  it('prints what a save costs', async () => {
    const { player, run, states } = await keeping();
    const samples: number[] = [];
    for (let index = 0; index < 2_000; index++) {
      run(1);
      const start = performance.now();
      player.saveState(states[0]);
      samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    const median = samples[samples.length >> 1];
    const micros = (milliseconds: number): string => (milliseconds * 1000).toFixed(1);
    console.info(
      `saveState: median ${micros(median)} µs, p95 ${micros(samples[Math.floor(samples.length * 0.95)])} µs over ${samples.length} saves`,
    );
  });
});

describe('the machine', () => {
  it('runs a frame without building its result', async () => {
    const machine = createC64Machine(counterTune(), { onSidWrite: () => undefined });
    machine.initSubtune(1);

    await expectNoAllocation(() => {
      for (let index = 0; index < FRAMES; index++) machine.runFrame();
    });
  });
});
