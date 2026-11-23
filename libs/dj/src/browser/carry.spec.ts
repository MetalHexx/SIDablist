import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAL_PHI2_HZ } from '@sidablist/core';
import { BUNDLED_TUNES, decodeBundledTune } from '../__fixtures__/index.js';
import { createDj } from '../dj.js';
import { createInlineHeavyWork } from '../heavy-work/inline.js';
import type { DjInbound } from '../messages/commands.js';
import type { DjReport } from '../messages/reports.js';
import type { Dj, DjPlugs, HeavyWork } from '../plugs.js';
import { FakeTime, ManualWake } from '../testing/harness.js';
import { HoldingSink } from '../testing/holding-sink.js';
import { INBOUND_SAMPLES } from '../testing/samples.js';
import { connectDj, serveDj } from './carry.js';
import type { PortLike } from './carry.js';
import type { WorkerScope } from './wake.worker.js';

// The type-level proof that the carry's port is satisfied by what it is meant to carry over,
// checked by `tsc --strict` (the lib build) and never run.
export function portsSatisfyPortLike(
  messagePort: MessagePort,
  worker: Worker,
  workerScope: WorkerScope,
): PortLike[] {
  return [messagePort, worker, workerScope, new MessageChannel().port1];
}

const tunes = new Map(BUNDLED_TUNES.map((tune) => [tune.id, tune.base64] as const));
const fetchBundled = (tune: string): Promise<Uint8Array> => {
  const base64 = tunes.get(tune);
  return base64 === undefined
    ? Promise.reject(new Error(`no tune ${tune}`))
    : Promise.resolve(decodeBundledTune(base64));
};

/** A deck's whole package side on fake time, a manual wake and holding sinks. */
function packageSide(plugs: Pick<DjPlugs, 'report' | 'fetchTune'>): {
  dj: Dj;
  time: FakeTime;
  advance(ms: number): void;
  attach(deck: 'a'): void;
} {
  const time = new FakeTime();
  const wake = new ManualWake();
  const sinks: HoldingSink[] = [];
  const inline = createInlineHeavyWork();
  // A scan short enough that a spec does not wait on minutes of music.
  const heavyWork: HeavyWork = {
    replayRunner: inline.replayRunner,
    scanner: {
      scan: (request, onProgress) =>
        inline.scanner.scan(
          { ...request, maxFrames: Math.min(request.maxFrames, 400) },
          onProgress,
        ),
      dispose: () => undefined,
    },
  };
  const dj = createDj({ ...plugs, time, wake, heavyWork });
  return {
    dj,
    time,
    advance(ms) {
      for (let left = ms; left > 0; left -= 5) {
        time.ms += Math.min(5, left);
        for (const sink of sinks) sink.advanceTo(time.ms);
        wake.fire();
      }
    },
    attach(deck) {
      const sink = new HoldingSink();
      sinks.push(sink);
      dj.setOutput(deck, { sink, targetClockHz: PAL_PHI2_HZ, lookaheadMs: 60 });
    },
  };
}

const pause = (ms = 15): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The run both sides play: a deck loaded and playing, then every command kind in turn. */
async function scenario(
  send: (message: DjInbound) => void,
  side: { advance(ms: number): void; attach(deck: 'a'): void },
  loaded: () => Promise<void>,
): Promise<void> {
  send({ kind: 'add-deck', deck: 'a' });
  await pause();
  side.attach('a');
  send({ kind: 'load', deck: 'a', tune: 'still-time', subtune: 1, ends: 'playing' });
  await loaded();
  side.advance(100);
  await pause();
  for (const sample of Object.values(INBOUND_SAMPLES)) {
    send(sample);
    await pause();
    side.advance(20);
    await pause();
  }
}

const openPorts: MessagePort[] = [];
afterEach(() => {
  for (const port of openPorts.splice(0)) port.close();
});

function channel(): { host: MessagePort; far: MessagePort } {
  const { port1, port2 } = new MessageChannel();
  openPorts.push(port1, port2);
  return { host: port1, far: port2 };
}

describe('the carry across a MessageChannel', () => {
  it('gives the host the same reports a direct run gives, for every command kind', async () => {
    const direct: DjReport[] = [];
    const straight = packageSide({
      report: (report) => direct.push(structuredClone(report)),
      fetchTune: fetchBundled,
    });
    await scenario(
      (message) => straight.dj.send(message),
      straight,
      () => vi.waitFor(() => expect(direct.some((r) => r.kind === 'loaded')).toBe(true)),
    );
    straight.dj.dispose();

    const { host, far } = channel();
    const carried: DjReport[] = [];
    let side!: ReturnType<typeof packageSide>;
    const served = serveDj(far, (plugs) => {
      side = packageSide(plugs);
      return side.dj;
    });
    const remote = connectDj(host, { fetchTune: fetchBundled });
    remote.onReport((report) => carried.push(report));
    await scenario(
      (message) => remote.send(message),
      { advance: (ms) => side.advance(ms), attach: (deck) => side.attach(deck) },
      () => vi.waitFor(() => expect(carried.some((r) => r.kind === 'loaded')).toBe(true)),
    );
    await pause(50);

    expect(direct.filter((r) => r.kind === 'update').length).toBeGreaterThan(0);
    expect(carried).toEqual(direct);
    remote.dispose();
    served.dispose();
  });

  it('answers a load on the package side with bytes fetched on the host side', async () => {
    const { host, far } = channel();
    const asked: string[] = [];
    const reports: DjReport[] = [];
    let side!: ReturnType<typeof packageSide>;
    const served = serveDj(far, (plugs) => {
      side = packageSide(plugs);
      return side.dj;
    });
    const remote = connectDj(host, {
      fetchTune: (tune) => {
        asked.push(tune);
        return fetchBundled(tune);
      },
    });
    remote.onReport((report) => reports.push(report));

    remote.send({ kind: 'add-deck', deck: 'a' });
    remote.send({ kind: 'load', deck: 'a', tune: 'still-time', subtune: 1 });
    await vi.waitFor(() => expect(reports.some((r) => r.kind === 'loaded')).toBe(true));

    expect(asked).toEqual(['still-time']);
    remote.dispose();
    served.dispose();
  });

  it('carries a failed fetch back as a failed load', async () => {
    const { host, far } = channel();
    const reports: DjReport[] = [];
    const served = serveDj(far, (plugs) => packageSide(plugs).dj);
    const remote = connectDj(host, {
      fetchTune: () => Promise.reject(new Error('the shelf is empty')),
    });
    remote.onReport((report) => reports.push(report));

    remote.send({ kind: 'add-deck', deck: 'a' });
    remote.send({ kind: 'load', deck: 'a', tune: 'still-time', subtune: 1 });
    await vi.waitFor(() => expect(reports.some((r) => r.kind === 'load-failed')).toBe(true));

    const failure = reports.find((r) => r.kind === 'load-failed');
    expect(JSON.stringify(failure)).toContain('the shelf is empty');
    remote.dispose();
    served.dispose();
  });

  it('detaches both sides on dispose', async () => {
    const { host, far } = channel();
    const inbound: DjInbound[] = [];
    const sent: DjReport[] = [];
    const dj: Dj = {
      send: (message) => void inbound.push(message),
      setOutput: () => undefined,
      dispose: () => undefined,
    };
    const served = serveDj(far, () => dj);
    const remote = connectDj(host, { fetchTune: fetchBundled });
    remote.onReport((report) => sent.push(report));

    remote.send({ kind: 'play', deck: 'a' });
    await vi.waitFor(() => expect(inbound).toHaveLength(1));

    served.dispose();
    remote.send({ kind: 'pause', deck: 'a' });
    await pause(30);
    expect(inbound).toHaveLength(1);

    const second = channel();
    const remoteB = connectDj(second.host, { fetchTune: fetchBundled });
    const listener = vi.fn();
    remoteB.onReport(listener);
    remoteB.dispose();
    second.far.postMessage({ type: 'report', report: { kind: 'update' } });
    await pause(30);
    expect(listener).not.toHaveBeenCalled();
    remote.dispose();
  });

  it('ignores an unknown wire message with a log line, on both sides', async () => {
    const { host, far } = channel();
    const warnings: string[] = [];
    const log = { warn: (m: string) => void warnings.push(m), error: () => undefined };
    const inbound: DjInbound[] = [];
    const served = serveDj(
      far,
      () => ({
        send: (message) => void inbound.push(message),
        setOutput: () => undefined,
        dispose: () => undefined,
      }),
      { log },
    );
    const remote = connectDj(host, { fetchTune: fetchBundled, log });

    host.postMessage({ type: 'nonsense' });
    host.postMessage('not even an object');
    far.postMessage({ type: 'fetch-tune', id: 'one' });
    await vi.waitFor(() => expect(warnings).toHaveLength(3));

    expect(inbound).toEqual([]);
    expect(warnings.filter((w) => w.includes('package side'))).toHaveLength(2);
    expect(warnings.filter((w) => w.includes('host side'))).toHaveLength(1);
    remote.dispose();
    served.dispose();
  });
});
