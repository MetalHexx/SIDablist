import { describe, expect, it } from 'vitest';
import type { Saveable } from '../common/saveable.js';
import { createVarispeed } from '../player/varispeed.js';
import { createRegisterFrame } from '../registers/register-frame.js';
import type { RegisterRecord } from '../registers/register-record.js';
import { SID_REGISTER_COUNT } from '../registers/sid-constants.js';
import { ALLOCATION_NOISE_BYTES, measureAllocation } from '../testing/measure-allocation.js';
import { frames } from '../units.js';
import { createActiveLoopTracker } from './active-loop.js';
import { createCrossingCaptures, createImageBuffer } from './crossing-captures.js';
import { ShadowPosition } from './shadow-position.js';
import { createTrackStructure } from './track-structure.js';

/** Saves and restores `part` `rounds` times and reports what that allocated. */
async function allocatedBySaving<S>(part: Saveable<S>, rounds: number) {
  const state = part.createState();
  return measureAllocation(() => {
    for (let round = 0; round < rounds; round++) {
      part.saveInto(state);
      part.restoreFrom(state);
    }
  });
}

async function expectNothingAllocated<S>(part: Saveable<S>, rounds = 200_000): Promise<void> {
  const { heapGrowthBytes, scavenges } = await allocatedBySaving(part, rounds);
  expect(scavenges).toBe(0);
  expect(heapGrowthBytes).toBeLessThan(ALLOCATION_NOISE_BYTES);
}

describe('saving and restoring on the frame path', () => {
  it('allocates nothing for the track structure', async () => {
    const track = createTrackStructure();
    track.setTrackStructure({
      loopStartFrame: frames(40),
      loopPeriodFrames: frames(200),
      endedAtFrame: frames(999),
    });
    track.setRepeatEnabled(true);

    await expectNothingAllocated(track);
  });

  it('allocates nothing for the active loop tracker mid-hand-off on a fractional loop', async () => {
    const image = createImageBuffer();
    image.frame = frames(30);
    const tracker = createActiveLoopTracker({ wrapLeadFrames: 1 });
    tracker.set({ startFrame: frames(10), endFrame: frames(16.375), lapPhase: 0.3 });
    tracker.setEntryImage(image);
    tracker.queue({
      startFrame: frames(30),
      loop: { startFrame: frames(30), endFrame: frames(38.5), lapPhase: 0.7 },
      beforeLanding: (): void => undefined,
    });
    tracker.setQueuedImage(image);
    tracker.changeAt(frames(30), { startFrame: frames(50), endFrame: frames(60.25) }, image);
    tracker.setLapPhase(0.425);

    await expectNothingAllocated(tracker);
  });

  it('allocates nothing for the shadow position on a fractional loop', async () => {
    const shadow = new ShadowPosition();
    shadow.start(
      { startFrame: frames(10), endFrame: frames(16.375), lapPhase: 0.625 },
      { frame: frames(10), held: false },
    );
    const track = createTrackStructure();
    for (let tick = 0; tick < 30; tick++) shadow.tick(track);

    await expectNothingAllocated(shadow);
  });

  it('allocates nothing for varispeed', async () => {
    const values = new Uint8Array(8 * SID_REGISTER_COUNT).map((_, index) => index);
    const record: RegisterRecord = {
      frames: 8,
      values,
      retriggerEntries: Uint32Array.of(3),
      retriggerRegisters: Uint8Array.of(4),
      retriggerValues: Uint8Array.of(0x11),
    };
    const varispeed = createVarispeed();
    varispeed.setRecord(record);
    varispeed.begin(2.5);
    varispeed.feed({ onSidWrite: (): void => undefined });
    varispeed.moveBy(1.25);

    await expectNothingAllocated(varispeed);
  });

  it('allocates nothing for the register frame with every setting in play', async () => {
    const frame = createRegisterFrame();
    frame.setTargetClock(985248, 1022730);
    frame.setVoicePitch(1, 1.5);
    frame.setRatePitch(0.75);
    frame.setRegisterScale('cutoff', 0.25);
    frame.setFieldOffset({ name: 'pulseWidth', voice: 2 }, 100);
    frame.holdField({ name: 'resonance' }, 9, 0.5);
    frame.setVoiceMuted(1, true);
    frame.onSidWrite(4, 0x11);
    frame.onSidWrite(4, 0x10);
    frame.markAllDirty();

    await expectNothingAllocated(frame);
  });

  it('allocates nothing for the crossing pool holding images', async () => {
    const pool = createCrossingCaptures();
    pool.declare([
      { originFrame: 0, periodFrames: 10, keep: 3 },
      { originFrame: 0, periodFrames: 25, keep: 2 },
    ]);
    for (let position = 0; position <= 60; position++) pool.take(position);

    await expectNothingAllocated(pool, 2_000);
  });
});
