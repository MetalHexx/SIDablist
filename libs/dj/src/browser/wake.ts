import type { EngineLog } from '@sidablist/core';
import type { Wake } from '../plugs.js';
import { createBrowserTime } from './time.js';

/** What the wake has measured: the bench reads these as the adapter's late-wake numbers. */
export interface WakeReadings {
  /** Beats delivered since the last `reset`. */
  readonly wakes: number;
  /** Mean time between consecutive beats, in milliseconds; 0 before the second beat. */
  readonly meanGapMs: number;
  readonly worstGapMs: number;
  /** Beats that came more than twice the period after the one before (the audio source's period is at least one buffer). */
  readonly lateWakes: number;
  reset(): void;
}

export interface BrowserWakeOptions {
  /** `worker` (default): a dedicated worker's timer. `audio`: a silent audio callback. */
  readonly source?: 'worker' | 'audio';
  /** Builds the wake worker, for an app whose bundler owns worker URLs. Default: `wake.worker.js` beside this file. */
  readonly workerFactory?: () => Worker;
  readonly log?: EngineLog;
}

export type BrowserWake = Wake & {
  readonly readings: WakeReadings;
  readonly source: 'worker' | 'audio';
};

/** How long an audio context may stay suspended before the wake warns that a page may need a click. */
const SUSPENDED_WARNING_MS = 1000;
/** The audio source's callback buffer, in frames: the finest beat it offers (about 6 ms at 44.1 kHz). */
const AUDIO_BUFFER_FRAMES = 256;

class Readings implements WakeReadings {
  wakes = 0;
  worstGapMs = 0;
  lateWakes = 0;
  private gapTotalMs = 0;
  private gaps = 0;
  private lastMs: number | null = null;

  get meanGapMs(): number {
    return this.gaps > 0 ? this.gapTotalMs / this.gaps : 0;
  }

  /** Counts a beat at `nowMs`; a gap is measured only against a beat since the last `restart`. */
  beat(nowMs: number, periodMs: number): void {
    this.wakes++;
    if (this.lastMs !== null) {
      const gap = nowMs - this.lastMs;
      this.gaps++;
      this.gapTotalMs += gap;
      if (gap > this.worstGapMs) this.worstGapMs = gap;
      if (gap > 2 * periodMs) this.lateWakes++;
    }
    this.lastMs = nowMs;
  }

  /** A restart's first beat has no beat before it to measure against. */
  restart(): void {
    this.lastMs = null;
  }

  reset(): void {
    this.wakes = 0;
    this.worstGapMs = 0;
    this.lateWakes = 0;
    this.gapTotalMs = 0;
    this.gaps = 0;
    this.lastMs = null;
  }
}

const defaultWorkerFactory = (): Worker =>
  new Worker(new URL('./wake.worker.js', import.meta.url), { type: 'module' });

/**
 * The wake for a browser page, which keeps firing while the page is hidden.
 *
 * `worker` runs `setInterval` in a dedicated worker (`wake.worker.js`) and posts each beat; worker
 * timers are not throttled on a hidden page. `audio` runs a silent `ScriptProcessorNode` on an
 * `AudioContext`, which keeps calling back while hidden: it beats once per buffer whatever the
 * period asked for, and the context may need a click before it runs (a warning goes to `log`).
 * Whether either survives a hidden page is measured by the bench, not provable in Node.
 *
 * `start` replaces a wake already running; `stop` stops the timer or audio and terminates the worker.
 */
export function createBrowserWake(options: BrowserWakeOptions = {}): BrowserWake {
  const source = options.source ?? 'worker';
  const workerFactory = options.workerFactory ?? defaultWorkerFactory;
  const log = options.log;
  const time = createBrowserTime();
  const readings = new Readings();

  let teardown: (() => void) | null = null;

  const stop = (): void => {
    teardown?.();
    teardown = null;
  };

  const startWorker = (periodUs: number, onWake: () => void): void => {
    const periodMs = periodUs / 1000;
    const worker = workerFactory();
    worker.onmessage = (): void => {
      readings.beat(time.now(), periodMs);
      onWake();
    };
    worker.onerror = (): void => log?.error('wake: the wake worker failed');
    worker.postMessage({ type: 'start', periodMs });
    teardown = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };
  };

  const startAudio = (periodUs: number, onWake: () => void): void => {
    const context = new AudioContext();
    // A buffer is the finest beat the audio source offers, so a gap is late against it, not a shorter period.
    const periodMs = Math.max(periodUs / 1000, (1000 * AUDIO_BUFFER_FRAMES) / context.sampleRate);
    const processor = context.createScriptProcessor(AUDIO_BUFFER_FRAMES, 1, 1);
    const silence = context.createGain();
    silence.gain.value = 0;
    processor.connect(silence);
    silence.connect(context.destination);
    processor.onaudioprocess = (): void => {
      readings.beat(time.now(), periodMs);
      onWake();
    };
    context.resume().catch(() => undefined);
    const warning = setTimeout(() => {
      if (context.state === 'suspended') {
        log?.warn('wake: the audio context is still suspended; the page may need a click first');
      }
    }, SUSPENDED_WARNING_MS);
    teardown = () => {
      clearTimeout(warning);
      processor.onaudioprocess = null;
      processor.disconnect();
      silence.disconnect();
      context.close().catch(() => undefined);
    };
  };

  return {
    readings,
    source,
    start(periodUs: number, onWake: () => void): void {
      stop();
      readings.restart();
      if (source === 'worker') startWorker(periodUs, onWake);
      else startAudio(periodUs, onWake);
    },
    stop,
  };
}
