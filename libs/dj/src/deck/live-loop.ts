import {
  frames,
  isUsableLoopLength,
  lapLength,
  lapPhaseAfter,
  reduceLapPhase,
} from '@sidablist/core';
import type { ActiveLoop, CrossingLines, PlayerSnapshot, SidPlayer } from '@sidablist/core';
import {
  foldIntoLoop,
  gridLine,
  lapPhaseAt,
  lapPhaseOfFold,
  loopStartAtOrBefore,
  shrinkLanding,
} from '@sidablist/analysis';
import type { Grid } from '../messages/commands.js';
import { ANSWER_NO, ANSWER_UNASKED, ANSWER_YES, type LogEntry } from './command-log.js';
import type { DeckState } from './deck-state.js';
import { tuneFrameOf, type DeckLoops } from './loops.js';
import type { DeckSlip } from './slip.js';

/** How many of the most recent crossings of each declared line the engine keeps an image of. */
const CROSSINGS_KEPT = 2;

type RunningLoop = Exclude<ActiveLoop, null>;

/** What a deck asks of the part of it that holds the live loop. */
export interface LiveLoopHost {
  /** The grid the load carried; null with none. */
  grid(): Grid | null;
  /** Makes the restore ring again: a state is only good for the crossing lines it was saved under. */
  rebuildRing(): void;
  /** Declares `tuneFrame` and waits for its image on behalf of log entry `seq`, to be seeked on landing. */
  awaitFold(tuneFrame: number, seq: number): void;
  warn(message: string): void;
}

/** A lap phase as `DeckState` keeps it: reduced, and `NaN` for none or for 0, the phase a loop given none laps at. */
function phaseCell(phase: number | undefined): number {
  if (phase === undefined || Number.isNaN(phase)) return Number.NaN;
  const reduced = reduceLapPhase(phase);
  return reduced === 0 ? Number.NaN : reduced;
}

function phaseField(cell: number): { lapPhase?: number } {
  return Number.isNaN(cell) ? {} : { lapPhase: cell };
}

function loopOf(start: number, end: number, phase: number): RunningLoop {
  return {
    startFrame: frames(start),
    endFrame: frames(end),
    varispeedStart: 'wrap',
    ...phaseField(phase),
  };
}

/** The first line of `periodFrames` through the grid's beat one that lies after `frame`. */
function lineAfter(grid: Grid, periodFrames: number, frame: number): number {
  let index = Math.floor((frame - grid.beatOneFrame) / periodFrames);
  while (gridLine(grid, periodFrames, index) <= frame) index++;
  while (gridLine(grid, periodFrames, index - 1) > frame) index--;
  return gridLine(grid, periodFrames, index);
}

function sameLines(a: readonly CrossingLines[], b: readonly CrossingLines[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (line, i) =>
        line.originFrame === b[i].originFrame &&
        line.periodFrames === b[i].periodFrames &&
        line.keep === b[i].keep,
    )
  );
}

/**
 * The live looper on the grid a load carries: a loop of the kept size pushed over whatever plays,
 * resized on the grid, and ended back into the loop running underneath.
 *
 * The engine keeps the images of the last grid crossings (`declareCaptures`), so a push starts from
 * an image taken on a line and replays nothing. A push starts on the last line at or behind the
 * frame after the playhead and lasts one size; a shrink lands on the first lap end the wrap lead
 * allows and a growth applies at once. The start never moves. A loop running under it keeps its
 * place, its queued target and its pending change in `DeckState`, and none of them reaches the
 * engine until the live loop ends back into it.
 *
 * With slip on, a push is a slip departure and its end lands the deck on the count slip kept.
 * Every call here is made between ticks, from a command that lands through the log; the live loop
 * is `DeckState`, so a rewind puts it back with the engine.
 */
export class DeckLiveLoop {
  /** The lines the engine was last told to save at: outside `DeckState`, as the engine's own setting is. */
  private declared: readonly CrossingLines[] = [];

  constructor(
    private readonly player: SidPlayer,
    private readonly state: DeckState,
    private readonly host: LiveLoopHost,
    private readonly slip: DeckSlip,
    private readonly loops: DeckLoops,
  ) {}

  /**
   * Tells the engine which grid lines to save the machine at: the beat lines, and the lines of the
   * kept size when it is shorter than a beat; none without a grid. Lines already declared change
   * nothing. The restore ring is made again unless `rebuildRing` is false (a load makes it itself).
   */
  declareCaptures(rebuildRing = true): void {
    const lines = this.linesFor(this.host.grid(), this.state.liveSize);
    if (sameLines(lines, this.declared)) return;
    this.declared = lines;
    this.player.setCrossingCaptures(lines);
    if (rebuildRing) this.host.rebuildRing();
  }

  /** Keeps `lengthFrames` as the size of the next live loop, and brings a running one to it. */
  setSize(entry: LogEntry, lengthFrames: number): void {
    this.state.liveSize = lengthFrames;
    if (this.state.liveOn) this.resize(entry, lengthFrames);
    // After the resize, so the restore point the ring is seeded with holds it.
    this.declareCaptures();
  }

  /**
   * Starts a live loop of the kept size. It starts on the last line at or behind the frame after
   * the playhead (one ahead, because a wrap falls due a frame before the end), or the first line
   * ahead when none is behind. A start behind the playhead whose image is not held, on a deck with
   * no register record to land on, starts on the next line instead. Refused with a log line without
   * a grid, a kept size or a playing transport, and while one runs.
   */
  start(entry: LogEntry): void {
    const state = this.state;
    const player = this.player;
    const grid = this.host.grid();
    const length = state.liveSize;
    if (grid === null || Number.isNaN(length)) {
      this.host.warn('live loop refused: it has no grid and size to loop on');
      return;
    }
    if (state.liveOn) {
      this.host.warn('live loop refused: one is already running');
      return;
    }
    const snapshot = player.getSnapshot();
    if (snapshot.transport !== 'playing') {
      this.host.warn('live loop refused: the deck is not playing');
      return;
    }
    const period = length >= grid.beatFrames ? grid.beatFrames : length;
    const ahead = Math.floor(player.getPosition()) + 1;
    let start = loopStartAtOrBefore(grid, length, ahead) ?? lineAfter(grid, period, ahead);
    if (start < ahead) {
      if (entry.ready === ANSWER_UNASKED) {
        entry.ready = player.holdsImageAt(frames(start)) ? ANSWER_YES : ANSWER_NO;
      }
      if (entry.ready === ANSWER_NO && (snapshot.tune?.recordedFrames ?? null) === null) {
        start = lineAfter(grid, period, ahead);
      }
    }

    this.slip.begin('live-loop');
    const running = player.getSnapshot().loop;
    state.underneath = running === null ? null : { ...running };
    const phase = phaseCell(lapPhaseAt(grid, period, start));
    player.setActiveLoop(loopOf(start, start + length, phase));
    state.startLive(start, start + length, phase);
    this.loops.reassertQueue();
  }

  /**
   * Ends the live loop back into the loop underneath, or on the line with none. Returns whether it
   * left the deck with no loop.
   *
   * With none underneath, slip lands, the engine's loop goes and a queued target engages at once.
   * With one, it goes back into the engine first, before any landing: a landing gives the loop
   * running at it the lap its count or fold is in, and a loop set after it would start again from
   * its own lap 0. Then slip lands on its count. With slip off (or no landing) a playhead already
   * inside the loop's first lap stays; otherwise it folds into the loop at the place its lap has
   * reached. With no register record to land on the deck plays on with no loop until a seek to the
   * folded frame, declared and waited for like any, lands; the loop underneath is put back then.
   */
  end(entry: LogEntry): boolean {
    const state = this.state;
    if (!state.liveOn) return false;
    const underneath = state.underneath;
    state.endLive();
    if (underneath === null) {
      this.slip.land('live-loop');
      this.player.setActiveLoop(null);
      this.loops.engageQueued(entry);
      return true;
    }
    this.loops.resumeUnderneath(entry);
    if (this.slip.land('live-loop')) {
      state.underneath = null;
      return false;
    }
    this.foldIn(entry, underneath);
    return false;
  }

  /** The live loop becomes the running loop, with nothing to return to. */
  adopt(): void {
    this.loops.adoptLive();
  }

  /**
   * Follows the engine after a tick: a loop the engine no longer runs ends the live loop, and a
   * shrink it has taken on becomes the loop in force, with the lap phase it landed at. Allocates nothing.
   */
  afterTick(snapshot: PlayerSnapshot): void {
    const state = this.state;
    const loop = snapshot.loop;
    if (loop === null) {
      this.loops.dropLive();
      return;
    }
    const pending = state.livePendingEnd;
    if (Number.isNaN(pending) || snapshot.tune === null || snapshot.tune.loopChange !== null)
      return;
    if (loop.endFrame === pending) state.setLiveBounds(pending, phaseCell(loop.lapPhase));
    else state.setLiveBounds(state.liveEnd, state.liveLapPhase);
  }

  /**
   * Brings the running live loop to `lengthFrames`, keeping its start. A larger size applies at
   * once and drops a shrink still waiting. A smaller one applies at once while the playhead is
   * early enough in the first lap of the new size, else at the end of the lap it falls in, named
   * in the engine by frame; a newer size replaces a shrink waiting.
   *
   * Every size laps from the lap the running loop is in, so a length that is not whole carries the
   * alternation on exactly: at once from the lap in progress, and from a shrink's landing (always a
   * whole frame, a lap end of both sizes) at the phase there.
   */
  private resize(entry: LogEntry, lengthFrames: number): void {
    const state = this.state;
    const player = this.player;
    const start = state.liveStart;
    const end = state.liveEnd;
    const newEnd = start + lengthFrames;
    if (!isUsableLoopLength(start, newEnd)) {
      this.host.warn(`live loop kept its size: ${lengthFrames} frames is too short to run`);
      return;
    }
    const lapPhase = state.liveLapPhase;
    const phase = player.getLapPhase() ?? reduceLapPhase(Number.isNaN(lapPhase) ? 0 : lapPhase);
    if (newEnd >= end) {
      if (newEnd !== end || !Number.isNaN(state.livePendingEnd)) this.apply(start, newEnd, phase);
      return;
    }
    const position = player.getPosition();
    if (position <= start + lapLength(phase, lengthFrames) - 2) {
      this.apply(start, newEnd, phase);
      return;
    }
    const at = shrinkLanding(
      start,
      lengthFrames,
      position + 1,
      start + lapLength(phase, end - start),
      phase,
    );
    const change = loopOf(start, newEnd, phaseCell(lapPhaseOfFold(at, start, newEnd, phase)));
    const named = entry.ready === ANSWER_NO ? false : player.changeLoopAt(frames(at), change);
    if (entry.ready === ANSWER_UNASKED) entry.ready = named ? ANSWER_YES : ANSWER_NO;
    if (named) {
      state.livePendingEnd = newEnd;
    } else {
      state.livePendingEnd = Number.NaN;
      this.host.warn(`live loop kept its size: the engine took no change at ${at}`);
    }
  }

  /** Makes the live loop `start`-`end` in the engine, lapping from `phase`, and names the queued target again. */
  private apply(start: number, end: number, phase: number): void {
    const cell = phaseCell(phase);
    this.player.setActiveLoop(loopOf(start, end, cell));
    this.state.setLiveBounds(end, cell);
    this.loops.reassertQueue();
  }

  /**
   * Returns a playhead at or past the loop underneath's wrap point into it, at the place its lap
   * has reached, landing there with the lap's phase: a playhead one tick from the loop's start
   * would otherwise leave the loop a tick behind once a lap. `land` is the only way, so a deck with
   * no register record to land on plays on with no loop and waits for a seek to the folded frame,
   * never replayed off-thread while playing; the loop underneath comes back when it lands.
   */
  private foldIn(entry: LogEntry, loop: RunningLoop): void {
    const state = this.state;
    const player = this.player;
    state.underneath = null;
    if (player.getSnapshot().transport !== 'playing') return;
    const start = loop.startFrame;
    const end = loop.endFrame;
    const length = end - start;
    const phase = player.getLapPhase() ?? reduceLapPhase(loop.lapPhase ?? 0);
    const position = Math.floor(player.getPosition());
    // The playhead is already inside the loop it was put back in.
    if (position < start + lapLength(phase, length) - 1) return;

    const lapPhase = lapPhaseOfFold(position, start, end, phase);
    const folded = foldIntoLoop(position, start, end, phase);
    const gateOff = folded - start === lapLength(lapPhase, length) - 1;
    const whole = Number.isInteger(length);
    const landed = player.land(
      gateOff
        ? {
            frame: frames(start),
            held: true,
            ...(whole ? {} : { lapPhase: reduceLapPhase(lapPhaseAfter(lapPhase, length, 1)) }),
          }
        : {
            frame: frames(folded),
            held: false,
            ...(whole ? {} : { lapPhase: reduceLapPhase(lapPhase) }),
          },
    );
    if (landed) return;

    state.underneath = loop;
    player.setActiveLoop(null);
    this.host.awaitFold(tuneFrameOf(folded), entry.seq);
  }

  private linesFor(grid: Grid | null, lengthFrames: number): readonly CrossingLines[] {
    if (grid === null) return [];
    const line = (periodFrames: number): CrossingLines => ({
      originFrame: grid.beatOneFrame,
      periodFrames,
      keep: CROSSINGS_KEPT,
    });
    return !Number.isNaN(lengthFrames) && lengthFrames < grid.beatFrames
      ? [line(grid.beatFrames), line(lengthFrames)]
      : [line(grid.beatFrames)];
  }
}
