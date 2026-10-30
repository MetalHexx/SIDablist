import { describe, it, expect, vi } from 'vitest';
import {
  createSidPlayer,
  FakeClock,
  FakeSink,
  milliseconds,
  parseSidFile,
  replayToFrame,
  SID_REGISTER_COUNT,
} from '@sidablist/core';
import type {
  ReplayRequest,
  ReplayResponse,
  ReplayRunner,
  SidFile,
  SidFrame,
} from '@sidablist/core';
import { decodeBundledTune, STILL_TIME_BASE64 } from './__fixtures__/index.js';
import { ScanFailedError } from './index-tune.js';
import { recordRegisters, toRegisterRecord } from './register-record.js';
import { scanTune } from './scan-tune.js';
import { handleScanRequest } from './scan-worker-handler.js';
import type { AnalysisScanner, ScanMessage, ScanRequest, ScanResult } from './scanner.js';

interface CodeBlock {
  readonly at: number;
  readonly bytes: readonly number[];
}

function tune(blocks: readonly CodeBlock[]): SidFile {
  const loadAddress = 0x1000;
  const codeEnd = blocks.reduce(
    (end, block) => Math.max(end, block.at + block.bytes.length),
    loadAddress,
  );
  const data = new Uint8Array(codeEnd - loadAddress);
  for (const block of blocks) {
    data.set(block.bytes, block.at - loadAddress);
  }
  return {
    format: 'PSID',
    version: 2,
    loadAddress,
    initAddress: loadAddress,
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

const RTS = 0x60;

/** Writes $D404 twice per call: $40 then $41. */
const doubledWriteTune = tune([
  { at: 0x1000, bytes: [RTS] },
  { at: 0x1010, bytes: [0xa9, 0x40, 0x8d, 0x04, 0xd4, 0xa9, 0x41, 0x8d, 0x04, 0xd4, RTS] },
]);

/** Odd calls write $40 then $41 to $D404, even calls $40 alone, so the gate closes on every second
 *  call. The counter rides $D400. */
const alternatingTune = tune([
  { at: 0x1000, bytes: [RTS] },
  {
    at: 0x1010,
    bytes: [
      ...[0xe6, 0xfb], // INC $FB
      ...[0xa5, 0xfb], // LDA $FB
      ...[0x8d, 0x00, 0xd4], // STA $D400
      ...[0x29, 0x01], // AND #$01
      ...[0xf0, 0x0b], // BEQ even
      ...[0xa9, 0x40, 0x8d, 0x04, 0xd4], // LDA #$40; STA $D404
      ...[0xa9, 0x41, 0x8d, 0x04, 0xd4], // LDA #$41; STA $D404
      RTS,
      ...[0xa9, 0x40, 0x8d, 0x04, 0xd4], // even: LDA #$40; STA $D404
      RTS,
    ],
  },
]);

const STILL_TIME_BYTES = decodeBundledTune(STILL_TIME_BASE64);

/** A scanner that answers on the calling thread through the real worker handler, the way a worker
 *  would, and remembers each request it was sent. */
class InlineScanner implements AnalysisScanner {
  readonly requests: ScanRequest[] = [];

  scan(request: ScanRequest): Promise<ScanResult> {
    this.requests.push(request);
    return new Promise((resolve) => {
      handleScanRequest(request, (message: ScanMessage) => {
        if (message.kind !== 'progress') {
          resolve(message);
        }
      });
    });
  }

  dispose(): void {
    // nothing to release
  }
}

describe('toRegisterRecord', () => {
  it('takes the control columns from the chip bytes and keeps every other column as scanned', () => {
    const output = scanTune(doubledWriteTune, 1, 8);

    const record = toRegisterRecord(output);

    expect(record.frames).toBe(8);
    expect(record.values.length).toBe(8 * SID_REGISTER_COUNT);
    for (let entry = 0; entry < 8; entry++) {
      expect(record.values[entry * SID_REGISTER_COUNT + 4]).toBe(0x41);
      expect(output.registerValues[entry * SID_REGISTER_COUNT + 4]).toBe(0x40);
    }
    expect(record.retriggerEntries.length).toBe(8);
    expect(new Set(record.retriggerRegisters)).toEqual(new Set([4]));
    expect(new Set(record.retriggerValues)).toEqual(new Set([0x40]));
  });

  it('reads entry i as the chip after play call i + 1', () => {
    const record = toRegisterRecord(scanTune(alternatingTune, 1, 6));

    // The counter at $D400 is 1 after the first play call.
    expect(
      Array.from({ length: 6 }, (_, entry) => record.values[entry * SID_REGISTER_COUNT]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    expect(
      Array.from({ length: 6 }, (_, entry) => record.values[entry * SID_REGISTER_COUNT + 4]),
    ).toEqual([0x41, 0x40, 0x41, 0x40, 0x41, 0x40]);
  });

  it('throws for an output that carries no control bytes or retriggers', () => {
    const { controlBytes, retriggers, ...bare } = scanTune(doubledWriteTune, 1, 2);
    void controlBytes;
    void retriggers;

    expect(() => toRegisterRecord(bare)).toThrow();
  });

  it('is the right shape on the Still Time fixture', () => {
    const file = parseSidFile(STILL_TIME_BYTES);
    const record = toRegisterRecord(scanTune(file, 1, 500));

    expect(record.frames).toBe(500);
    expect(record.values.length).toBe(500 * SID_REGISTER_COUNT);
    expect(record.retriggerRegisters.length).toBe(record.retriggerEntries.length);
    expect(record.retriggerValues.length).toBe(record.retriggerEntries.length);
  });
});

describe('recordRegisters', () => {
  it('asks for a session of its own and a scan that is not kept, and returns the record', async () => {
    const scanner = new InlineScanner();

    const first = await recordRegisters(scanner, STILL_TIME_BYTES, 1, 120);
    await recordRegisters(scanner, STILL_TIME_BYTES, 1, 120);

    expect(scanner.requests.map((request) => request.keep)).toEqual([false, false]);
    expect(scanner.requests[0].session).not.toBe(scanner.requests[1].session);
    expect(scanner.requests[0].maxFrames).toBe(120);
    expect(first).toEqual(toRegisterRecord(scanTune(parseSidFile(STILL_TIME_BYTES), 1, 120)));
  });

  it('throws ScanFailedError with the scanner message when the scan fails', async () => {
    const scanner: AnalysisScanner = {
      scan: (request) =>
        Promise.resolve({ id: request.id, kind: 'failed', error: 'out of cycles' }),
      dispose: vi.fn(),
    };

    await expect(recordRegisters(scanner, STILL_TIME_BYTES, 1, 10)).rejects.toThrow(
      new ScanFailedError('out of cycles'),
    );
  });
});

describe('the record played under varispeed', () => {
  class ReplayAnswers implements ReplayRunner {
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
    }

    dispose(): void {
      // nothing to release
    }
  }

  function rig() {
    const sink = new FakeSink();
    const clock = new FakeClock();
    const player = createSidPlayer({ sink, clock, replayRunner: new ReplayAnswers() });
    return { sink, clock, player };
  }

  function tick(clock: FakeClock, count: number): void {
    for (let index = 0; index < count; index++) {
      clock.tick(milliseconds(performance.now() + index));
    }
  }

  function chipsOf(sink: FakeSink): Uint8Array[] {
    const chip = new Uint8Array(SID_REGISTER_COUNT);
    return sink.deliveredFrames.map(({ frame }) => {
      applyFrame(chip, frame);
      return chip.slice();
    });
  }

  function applyFrame(chip: Uint8Array, frame: SidFrame): void {
    for (let index = 0; index < frame.count; index++) {
      chip[frame.registers[index]] = frame.values[index];
    }
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  async function recordOf(file: SidFile, frames: number) {
    return toRegisterRecord(scanTune(file, 1, frames));
  }

  /** Plays `ticks` ticks live; and the same stream through varispeed at rate 1 for `inside` ticks,
   *  then a handback to live for the rest. */
  async function liveAndHandedBack(file: SidFile, ticks: number, inside: number) {
    const live = rig();
    live.player.loadTune(file);
    await live.player.play();
    tick(live.clock, ticks);

    const held = rig();
    held.player.loadTune(file);
    held.player.setRegisterRecord(await recordOf(file, 400));
    held.player.enterVarispeed(() => 1);
    await held.player.play();
    tick(held.clock, inside);
    held.player.leaveVarispeed();
    await settle();
    tick(held.clock, ticks - inside);
    return { live, held };
  }

  it('leaves the chip as a straight live run does, tick for tick, across the handback (Still Time)', async () => {
    const file = parseSidFile(STILL_TIME_BYTES);

    const { live, held } = await liveAndHandedBack(file, 200, 20);

    expect(held.player.getSnapshot().tempo.varispeed).toBe(false);
    expect(held.sink.deliveredFrames).toHaveLength(200);
    expect(held.sink.deliveredNowFrames).toHaveLength(0);
    expect(chipsOf(held.sink)).toEqual(chipsOf(live.sink));
  });

  it('releases the gate on every lone write, as live playback does', async () => {
    const { live, held } = await liveAndHandedBack(alternatingTune, 60, 20);

    const gates = chipsOf(held.sink).map((chip) => chip[4]);
    expect(gates.slice(0, 6)).toEqual([0x41, 0x40, 0x41, 0x40, 0x41, 0x40]);
    expect(chipsOf(held.sink)).toEqual(chipsOf(live.sink));
  });

  it('logs the mean cost of a varispeed tick against a live tick', async () => {
    const file = parseSidFile(STILL_TIME_BYTES);
    const ticks = 3000;
    const record = await recordOf(file, ticks + 100);

    const live = rig();
    live.player.loadTune(file);
    await live.player.play();
    const liveStart = performance.now();
    tick(live.clock, ticks);
    const liveMs = (performance.now() - liveStart) / ticks;

    const held = rig();
    held.player.loadTune(file);
    held.player.setRegisterRecord(record);
    held.player.enterVarispeed(() => 1);
    await held.player.play();
    const heldStart = performance.now();
    tick(held.clock, ticks);
    const heldMs = (performance.now() - heldStart) / ticks;

    console.log(
      `mean tick cost over ${ticks} ticks: live ${(liveMs * 1000).toFixed(1)} us, ` +
        `varispeed ${(heldMs * 1000).toFixed(1)} us`,
    );
    expect(held.sink.deliveredFrames).toHaveLength(ticks);
  });
});
