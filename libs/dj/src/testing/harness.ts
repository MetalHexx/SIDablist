import { PAL_PHI2_HZ, milliseconds } from '@sidablist/core';
import type { TimeSource } from '@sidablist/core';
import type { AnalysisScanner, ScanRequest, ScanResult } from '@sidablist/analysis';
import { handleScanRequest } from '@sidablist/analysis';
import { BUNDLED_TUNES, decodeBundledTune } from '../__fixtures__/index.js';
import { Deck } from '../deck/deck.js';
import { createDj } from '../dj.js';
import { createInlineHeavyWork } from '../heavy-work/inline.js';
import type { DeckCommand, DeckId, DjInbound } from '../messages/commands.js';
import type { DeckEvent, DeckPicture, DjReport } from '../messages/reports.js';
import type { Dj, DjPlugs, HeavyWork, Wake } from '../plugs.js';
import { HoldingSink, type WireFrame } from './holding-sink.js';

/** Spec-only. Time that moves when a test says so, on the same timeline the sinks are held to. */
export class FakeTime implements TimeSource {
  ms: number;

  constructor(startMs = 1000) {
    this.ms = startMs;
  }

  now(): ReturnType<TimeSource['now']> {
    return milliseconds(this.ms);
  }
}

/**
 * Spec-only. A tiny PSID with `songs` subtunes, for a spec that needs a tune with more than one:
 * init keeps the song it is given, and every play call writes a counter to register 0 and the
 * song (from 0) to register 1, so the subtune a deck plays shows in what it delivers.
 */
export function multiSongTune(songs = 3): Uint8Array {
  const header = new Uint8Array(0x7c);
  const view = new DataView(header.buffer);
  header.set([0x50, 0x53, 0x49, 0x44]); // PSID
  view.setUint16(0x04, 2);
  view.setUint16(0x06, 0x7c);
  view.setUint16(0x08, 0x1000);
  view.setUint16(0x0a, 0x1000);
  view.setUint16(0x0c, 0x1010);
  view.setUint16(0x0e, songs);
  view.setUint16(0x10, 1);
  const payload = new Uint8Array(0x20);
  payload.set([0x85, 0xfc, 0x60]); // STA $FC; RTS
  payload.set([0xe6, 0xfb, 0xa5, 0xfb, 0x8d, 0x00, 0xd4, 0xa5, 0xfc, 0x8d, 0x01, 0xd4, 0x60], 0x10); // INC $FB; LDA $FB; STA $D400; LDA $FC; STA $D401; RTS
  const bytes = new Uint8Array(header.length + payload.length);
  bytes.set(header);
  bytes.set(payload, header.length);
  return bytes;
}

/** Spec-only. A wake the test fires by hand, which remembers how it was started. */
export class ManualWake implements Wake {
  periodUs: number | null = null;
  starts = 0;
  private callback: (() => void) | null = null;

  get running(): boolean {
    return this.callback !== null;
  }

  start(periodUs: number, onWake: () => void): void {
    this.starts++;
    this.periodUs = periodUs;
    this.callback = onWake;
  }

  stop(): void {
    this.periodUs = null;
    this.callback = null;
  }

  fire(): void {
    this.callback?.();
  }
}

/**
 * Spec-only. Scans the real way, on this thread, but only as far as `maxFrames` allows, so a spec
 * that loads a tune does not wait on a scan of minutes of music; with `held`, a scan resolves only
 * when the test releases it, which is how a spec makes the register record arrive when it chooses.
 */
class TestScanner implements AnalysisScanner {
  private readonly pending: (() => void)[] = [];

  constructor(
    private readonly maxFrames: number,
    private readonly held: boolean,
  ) {}

  scan(request: ScanRequest, onProgress?: (frame: number) => void): Promise<ScanResult> {
    const clamped = { ...request, maxFrames: Math.min(request.maxFrames, this.maxFrames) };
    return new Promise<ScanResult>((resolve) => {
      const run = (): void =>
        handleScanRequest(clamped, (message) => {
          if (message.kind === 'progress') onProgress?.(message.frame);
          else resolve(message);
        });
      if (this.held) this.pending.push(run);
      else run();
    });
  }

  /** Answers every scan that was held. */
  release(): void {
    for (const run of this.pending.splice(0)) run();
  }

  dispose(): void {
    // nothing is held open
  }
}

export interface RigOptions {
  /** `held` keeps each register scan until `releaseScans()`. Default `short`: answered at once, on a few hundred frames. */
  readonly scan?: 'short' | 'held';
  /** The fake time to start at, in milliseconds. */
  readonly startMs?: number;
  /**
   * Keeps no updates, no events and no wire: a spec that measures what the package allocates must
   * not count its own bookkeeping. Pictures, registers and deliveries are still kept, which is how
   * a picture built where none should be shows.
   */
  readonly quiet?: boolean;
}

export interface AddedDeck {
  readonly id: DeckId;
  /** What the deck's output holds; null for a deck added with no output. */
  readonly sink: HoldingSink | null;
}

/**
 * Spec-only: a package wired to a fake time, a manual wake, holding sinks and the two bundled
 * tunes, with the reports and the log lines it gives collected. `advance` moves time the way the
 * host's wake would: the sinks pass what fell due, then the wake fires.
 */
export class Rig {
  readonly quiet: boolean;
  readonly time: FakeTime;
  readonly wake = new ManualWake();
  readonly reports: DjReport[] = [];
  readonly warnings: string[] = [];
  readonly fetches: string[] = [];
  readonly sinks = new Map<DeckId, HoldingSink>();
  readonly plugs: DjPlugs;
  readonly dj: Dj;
  /** Decks made by `openDeck`, which the test drives itself and `advance` wakes with the others. */
  private readonly opened: Deck[] = [];
  private readonly scanner: TestScanner;
  private readonly held = new Map<string, Promise<Uint8Array>>();
  private readonly tunes = new Map<string, Uint8Array>();

  constructor(options: RigOptions = {}) {
    this.quiet = options.quiet ?? false;
    this.time = new FakeTime(options.startMs);
    this.scanner = new TestScanner(400, options.scan === 'held');
    for (const tune of BUNDLED_TUNES) this.tunes.set(tune.id, decodeBundledTune(tune.base64));
    const inline = createInlineHeavyWork();
    const heavyWork: HeavyWork = { replayRunner: inline.replayRunner, scanner: this.scanner };
    this.plugs = {
      time: this.time,
      wake: this.wake,
      heavyWork,
      fetchTune: (tune) => this.fetch(tune),
      report: (message) => {
        const keep =
          !this.quiet ||
          message.kind === 'picture' ||
          message.kind === 'registers' ||
          message.kind === 'deliveries';
        if (keep) this.reports.push(message.kind === 'update' ? { ...message } : message);
      },
      log: {
        warn: (message) => void this.warnings.push(message),
        error: (message) => void this.warnings.push(message),
      },
    };
    this.dj = createDj(this.plugs);
  }

  private fetch(tune: string): Promise<Uint8Array> {
    this.fetches.push(tune);
    const held = this.held.get(tune);
    if (held !== undefined) return held;
    const bytes = this.tunes.get(tune);
    return bytes === undefined
      ? Promise.reject(new Error(`no tune ${tune}`))
      : Promise.resolve(bytes);
  }

  /** Makes `bytes` fetchable as `tune`. */
  addTune(tune: string, bytes: Uint8Array): void {
    this.tunes.set(tune, bytes);
  }

  /** Holds the next fetch of `tune` until the returned handle resolves or fails it. */
  holdFetch(tune: string): { release(): void; fail(error: Error): void } {
    let release!: () => void;
    let fail!: (error: Error) => void;
    const promise = new Promise<Uint8Array>((resolve, reject) => {
      release = () => resolve(this.tunes.get(tune) ?? new Uint8Array());
      fail = reject;
    });
    this.held.set(tune, promise);
    return {
      release: () => {
        this.held.delete(tune);
        release();
      },
      fail: (error) => {
        this.held.delete(tune);
        fail(error);
      },
    };
  }

  /** Answers the register scans a `held` rig kept. */
  releaseScans(): void {
    this.scanner.release();
  }

  /** Adds a deck on a holding sink at `lookaheadMs` (60 by default), or on none with `sink: false`. */
  addDeck(id: DeckId = 'a', options: { lookaheadMs?: number; sink?: boolean } = {}): AddedDeck {
    this.dj.send({ kind: 'add-deck', deck: id });
    if (options.sink === false) return { id, sink: null };
    const sink = new HoldingSink({ retain: !this.quiet });
    this.sinks.set(id, sink);
    this.dj.setOutput(id, {
      sink,
      targetClockHz: PAL_PHI2_HZ,
      lookaheadMs: options.lookaheadMs ?? 60,
    });
    return { id, sink };
  }

  /** A deck of the package's own class on the same plugs, for a spec that needs its engine. */
  openDeck(id: DeckId = 'a', lookaheadMs = 60): { deck: Deck; sink: HoldingSink } {
    const deck = new Deck(id, this.plugs, { syncWake: () => undefined });
    const sink = new HoldingSink();
    deck.setOutput({ sink, targetClockHz: PAL_PHI2_HZ, lookaheadMs });
    this.opened.push(deck);
    this.sinks.set(id, sink);
    return { deck, sink };
  }

  send(message: DjInbound): void {
    this.dj.send(message);
  }

  /** Sends a load and lets everything it waits on settle. */
  async load(
    id: DeckId,
    tune: string,
    extra: Partial<Extract<DeckCommand, { kind: 'load' }>> = {},
  ): Promise<void> {
    this.send({ kind: 'load', deck: id, tune, subtune: 1, ...extra });
    await this.settle();
  }

  /** Lets every promise in flight settle: microtasks, and the zero-delay timer behind them. */
  async settle(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  /** Runs microtasks only: enough for a flush a command scheduled. */
  async microtasks(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  /** The sinks pass what fell due at the current time, then the wake fires. */
  tick(): void {
    for (const sink of this.sinks.values()) sink.advanceTo(this.time.ms);
    this.wake.fire();
    for (const deck of this.opened) deck.wake(this.time.ms);
  }

  /** Moves time on by `ms`, in steps of `stepMs`, ticking at each. */
  advance(ms: number, stepMs = 5): void {
    for (let left = ms; left > 0;) {
      const step = Math.min(stepMs, left);
      this.time.ms += step;
      left -= step;
      this.tick();
    }
  }

  /** The reports of one kind, oldest first, narrowed by their `kind`. */
  ofKind<K extends DjReport['kind']>(kind: K, deck?: DeckId): Extract<DjReport, { kind: K }>[] {
    return this.reports.filter(
      (report): report is Extract<DjReport, { kind: K }> =>
        report.kind === kind && (deck === undefined || report.deck === deck),
    );
  }

  /** The frames that reached a deck's sink, in order. */
  frames(id: DeckId = 'a'): WireFrame[] {
    return (this.sinks.get(id)?.wire ?? []).filter(
      (item): item is WireFrame => item.kind === 'frame',
    );
  }

  /** The `landed` events, oldest first, optionally of one command kind. */
  landed(commandKind?: DeckCommand['kind']): Extract<DeckEvent, { kind: 'landed' }>[] {
    return this.ofKind('landed').filter(
      (event) => commandKind === undefined || event.command.kind === commandKind,
    );
  }

  /** The deck's picture as it stands: asks for one and returns the answer. */
  picture(id: DeckId = 'a'): DeckPicture {
    const before = this.reports.length;
    this.send({ kind: 'describe', deck: id });
    const answer = this.reports.slice(before).find((r): r is DeckPicture => r.kind === 'picture');
    if (answer === undefined) throw new Error(`no picture for ${id}`);
    return answer;
  }

  dispose(): void {
    this.dj.dispose();
    for (const deck of this.opened) deck.dispose();
  }
}
