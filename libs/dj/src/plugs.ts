import type { EngineLog, ReplayRunner, SidSink, TimeSource } from '@sidablist/core';
import type { AnalysisScanner } from '@sidablist/analysis';
import type { DeckId, DjInbound } from './messages/commands.js';
import type { DjReport } from './messages/reports.js';

/** The host's wake-up: calls `onWake` about every `periodUs`, and keeps doing so on a hidden page. */
export interface Wake {
  start(periodUs: number, onWake: () => void): void;
  stop(): void;
}

/** Somewhere to run heavy work. A deck asks for its own runners when it is added. */
export interface HeavyWork {
  replayRunner(): ReplayRunner;
  prepareRunner?(): ReplayRunner;
  readonly scanner: AnalysisScanner;
}

/** Where a deck plays: environment, never a command, so a recording never carries it. */
export interface DeckOutput {
  readonly sink: SidSink;
  /** `PAL_PHI2_HZ` / `NTSC_PHI2_HZ`, or null for uncorrected. */
  readonly targetClockHz: number | null;
  /** How far ahead the deck renders, in milliseconds; above 0. */
  readonly lookaheadMs: number;
}

/** Everything environmental the package needs: it reads no clock, console or worker of its own. */
export interface DjPlugs {
  readonly time: TimeSource;
  readonly wake: Wake;
  readonly heavyWork: HeavyWork;
  /** Resolves a tune reference to its bytes. */
  readonly fetchTune: (tune: string) => Promise<Uint8Array>;
  /** Receives everything the decks report. */
  readonly report: (message: DjReport) => void;
  readonly log?: EngineLog;
}

/** The DJ desk: decks are added and driven through `send`. */
export interface Dj {
  send(message: DjInbound): void;
  /** Points a deck at an output, or takes it off with null. */
  setOutput(deck: DeckId, output: DeckOutput | null): void;
  dispose(): void;
}
