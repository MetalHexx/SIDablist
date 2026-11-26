import {
  createAsidSink,
  ASID_MSG_SID_DATA,
  type AsidSink,
  type MidiOutputPort,
} from '@sidablist/asid';
import { PAL_PHI2_HZ, milliseconds } from '@sidablist/core';
import { describe, expect, it } from 'vitest';
import type { DeckCommand, JumpTarget } from '../messages/commands.js';
import { Rig } from '../testing/harness.js';

/**
 * A deck on the real ASID sink, over a fake MIDI port. ASID holds nothing: a frame handed to the
 * port cannot be taken back, so `passedCount` is the number of deliveries, a command lands on the
 * next frame to render, and a rewind redoes nothing. The conformance cases of the sink itself live
 * with the sink; these are about what the package puts on its wire.
 */

class FakePort implements MidiOutputPort {
  readonly portId = 'port-1';
  /** Cannot cancel, so every packet ever sent stays in `sent`, in order. */
  readonly supportsCancel = false;
  readonly sent: { readonly hex: string; readonly timestampMs: number | undefined }[] = [];

  send(bytes: Uint8Array, timestampMs?: number): void {
    this.sent.push({ hex: Array.from(bytes, hexByte).join(''), timestampMs });
  }

  cancelPending(): boolean {
    return false;
  }

  get dataPackets(): readonly { hex: string; timestampMs: number | undefined }[] {
    return this.sent.filter((packet) => packet.hex.startsWith('f02d' + hexByte(ASID_MSG_SID_DATA)));
  }
}

const hexByte = (value: number): string => value.toString(16).padStart(2, '0');

const LOOP: JumpTarget = { startFrame: 100, endFrame: 130, wraps: true };
const CUE: JumpTarget = { startFrame: 300, endFrame: null };
const TARGETS = [100, 300, 500];

/** Presses of the run, in milliseconds from the start: tempo, mutes, loops, a queue, a seek. */
const PRESSES: readonly (readonly [number, (deck: string) => DeckCommand])[] = [
  [200, (deck) => ({ kind: 'speed', deck, value: 1.3 })],
  [350, (deck) => ({ kind: 'setting', deck, setting: 1, value: 1 })],
  [500, (deck) => ({ kind: 'hot-cue', deck, target: LOOP })],
  [800, (deck) => ({ kind: 'hot-cue', deck, target: CUE })],
  [1300, (deck) => ({ kind: 'nudge', deck, amount: 0.05 })],
  [1500, (deck) => ({ kind: 'nudge', deck, amount: 0 })],
  [1700, (deck) => ({ kind: 'seek', deck, frame: 500 })],
  [2000, (deck) => ({ kind: 'hot-cue', deck, target: LOOP })],
  [2300, (deck) => ({ kind: 'stop-loop', deck })],
  [2500, (deck) => ({ kind: 'setting', deck, setting: 1, value: 0 })],
];
const RUN_MS = 3200;

interface Played {
  readonly rig: Rig;
  readonly port: FakePort;
  readonly sink: AsidSink;
}

async function start(): Promise<Played> {
  const rig = new Rig();
  const port = new FakePort();
  const sink = createAsidSink(port, { time: rig.time, scheduleAheadMs: milliseconds(15) });
  rig.addDeck('a', { sink: false });
  rig.dj.setOutput('a', { sink, targetClockHz: PAL_PHI2_HZ, lookaheadMs: 60 });
  await rig.load('a', 'still-time', { ends: 'paused' });
  rig.send({ kind: 'targets', deck: 'a', frames: TARGETS });
  await rig.settle();
  rig.send({ kind: 'play', deck: 'a' });
  await rig.settle();
  return { rig, port, sink };
}

describe('a deck on the real ASID sink', () => {
  it('takes commands, redoing nothing and neither losing nor repeating a frame on the wire', async () => {
    const pressed = await start();
    const { rig } = pressed;
    const sent: DeckCommand[] = [];
    const nextToRender: number[] = [];
    let at = 0;
    for (const [atMs, make] of PRESSES) {
      rig.advance(atMs - at);
      at = atMs;
      nextToRender.push(pressed.sink.passedCount());
      sent.push({ ...make('a'), pressedAtMs: rig.time.ms });
      rig.send(sent[sent.length - 1]);
      await rig.microtasks();
    }
    rig.advance(RUN_MS - at);

    const landings = sent.map((command) => {
      const landed = rig.landed().find((event) => event.command === command);
      if (landed === undefined) throw new Error(`the press of ${command.kind} never landed`);
      return landed;
    });
    // Every command lands on the next frame to render: the frame after the last one delivered.
    expect(landings.map((landed) => landed.frame)).toEqual(nextToRender);
    const delivered = pressed.sink.passedCount();
    expect(delivered).toBeGreaterThan(100);
    // Each delivery is one packet; the one more is the gate-off the paused load sent at once.
    expect(pressed.port.dataPackets.length).toBe(delivered + 1);
    expect(rig.picture().timing.rewoundFrames).toBe(0);
    expect(pressed.sink.passedCount()).toBe(delivered);
    expect(rig.warnings).toEqual([]);

    // A straight run, told every command at the frame it landed on before it renders, sends the same packets.
    const straight = await start();
    for (const landed of landings) {
      straight.rig.send({ ...landed.command, when: landed.fixed });
    }
    straight.rig.advance(RUN_MS);
    expect(straight.port.sent.length).toBe(pressed.port.sent.length);
    const firstDifference = pressed.port.sent.findIndex(
      (packet, i) =>
        packet.hex !== straight.port.sent[i].hex ||
        packet.timestampMs !== straight.port.sent[i].timestampMs,
    );
    expect(firstDifference, `packet ${firstDifference} of the run`).toBe(-1);

    rig.dispose();
    straight.rig.dispose();
  });
});
