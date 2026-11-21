import { describe, expect, it } from 'vitest';
import { ALLOCATION_NOISE_BYTES } from '../testing/measure-allocation.js';
import type { SidFile } from '../sid/sid-file.model.js';
import { FRAMES, measureWork, playing, RTS, tune } from './allocation-harness.js';

/** The header says CIA-timed and play writes CIA 1 timer A's latch from a table, alternating on
 *  every call between 9,827 and 6,551: two and three play calls a frame, so the rate it plays at
 *  changes on every tick. Whole calls a frame make whole microseconds between them, which is what
 *  the note below the tune is about. */
const swingingLatchTune = (): SidFile => {
  const play = [
    ...[0xa5, 0xfb, 0x49, 0x01, 0x85, 0xfb], // LDA $FB; EOR #$01; STA $FB
    ...[0xaa, 0xbd, 0x30, 0x10, 0x8d, 0x04, 0xdc], // TAX; LDA $1030,X; STA $DC04
    ...[0xbd, 0x32, 0x10, 0x8d, 0x05, 0xdc], // LDA $1032,X; STA $DC05
    RTS,
  ];
  const file = tune(play, [RTS], 1);
  const data = new Uint8Array(0x34);
  data.set(file.data);
  data.set([0x97, 0x63, 0x19, 0x26], 0x30); // latch low bytes, then high bytes: $1997, $2663
  return { ...file, data };
};

/** The header says CIA-timed and play writes CIA 1 timer A's latch high byte, alternating between
 *  $20 and $21 on every call (the low byte stays the PSID default's), so the rate it plays at
 *  changes on every tick and the interval handed to the clock is a fraction of a microsecond. */
const fractionalLatchTune = (): SidFile =>
  tune(
    [
      ...[0xa5, 0xfb, 0x49, 0x01, 0x85, 0xfb], // LDA $FB; EOR #$01; STA $FB
      ...[0x18, 0x69, 0x20, 0x8d, 0x05, 0xdc], // CLC; ADC #$20; STA $DC05
      RTS,
    ],
    [RTS],
    1,
  );

/** Between what the engine's boxing alone leaves (about 488 KB) and what a rate object and a boxed
 *  interval on every frame cost (about 968 KB). Looser than the shared gate, see below. */
const FRACTIONAL_RATE_BOUND_BYTES = 3 * ALLOCATION_NOISE_BYTES;

/*
 * A file of its own, so that it runs in a process of its own. The rate follows the machine every
 * tick and the clock is re-timed every tick, which is the path measured.
 */
describe('the frame path under a changing rate', { timeout: 60_000 }, () => {
  /*
   * Its bound is looser than the shared gate, on purpose. A fractional interval handed to the clock
   * is a number the engine boxes whenever it has not inlined the call, 16 bytes a frame, and whether
   * it inlined it varies from one run of the same code to the next, so the shared 256 KB gate would
   * flip on this tune (about 488 KB over 30,000 frames when the engine does not inline). What this
   * guards is the player and machine reading the rates into preallocated storage and keeping the
   * running interval a number: without them every frame also allocates a rate object and boxes the
   * interval, 32 bytes a frame, about 968 KB. The bound sits between the two. It runs first in the
   * file: after the whole-rate spec in the same process the engine boxes it about half the time.
   */
  it('allocates within a bounded residue when the rate is fractional and swings', async () => {
    const { player, run } = await playing(fractionalLatchTune());
    run(2);
    const rates = new Set<number>();
    for (let index = 0; index < 6; index++) {
      run(1);
      rates.add(player.getStats().rate.exactCallsPerFrame);
    }
    expect(rates.size).toBeGreaterThan(1);

    const { heapGrowthBytes } = await measureWork(() => run(FRAMES));

    expect(heapGrowthBytes).toBeLessThan(FRACTIONAL_RATE_BOUND_BYTES);
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

    const { heapGrowthBytes, scavenges } = await measureWork(() => run(FRAMES));

    expect(scavenges).toBe(0);
    expect(heapGrowthBytes).toBeLessThan(ALLOCATION_NOISE_BYTES);
  });
});
