import {
  MAX_CATCH_UP_US,
  createDeliveryBatch,
  createSidPlayer,
  describeError,
  frames,
  lapLength,
  parseSidFile,
} from '@sidablist/core';
import type {
  JumpSettings,
  PlayerSnapshot,
  RegisterRecord,
  ReplayRunner,
  SidFile,
  SidModel,
  SidPlayer,
} from '@sidablist/core';
import { ScanFailedError, recordRegisters } from '@sidablist/analysis';
import type { DeckCommand, DeckId, DjRequest, Grid, JumpTarget } from '../messages/commands.js';
import type {
  DeckDeliveries,
  DeckEvent,
  DeckPicture,
  DeckRegisters,
  DeckUpdate,
} from '../messages/reports.js';
import type { DeckOutput, DjPlugs } from '../plugs.js';
import {
  ANSWER_NO,
  ANSWER_UNASKED,
  ANSWER_YES,
  CommandLog,
  EVENT_NONE,
  EVENT_QUEUED,
  EVENT_SENT,
  LOOP_NO,
  LOOP_UNKNOWN,
  LOOP_YES,
  UNRESOLVED,
  type LogEntry,
} from './command-log.js';
import {
  DeckState,
  HAND_DOWN,
  HAND_THROWN,
  JUMP,
  LAST_POSITION,
  NOT_WAITING,
  NUDGE,
  SPEED,
} from './deck-state.js';
import { DrivenClock } from './driven-clock.js';
import {
  EventQueue,
  KIND_CAPTURED,
  KIND_JUMP_LANDED,
  KIND_LANDED,
  KIND_LOADED,
  KIND_LOAD_FAILED,
  type QueuedEvent,
} from './event-queue.js';
import { DeckHand } from './hand.js';
import { DeckLiveLoop, type LiveLoopHost } from './live-loop.js';
import {
  DeckLoops,
  RESOLVED_CANCEL,
  RESOLVED_LET_GO,
  RESOLVED_NONE,
  RESOLVED_QUEUE,
  RESOLVED_START,
  tuneFrameOf,
  type LoopsHost,
} from './loops.js';
import { NOTHING_APPLIED, RestoreRing, type RestoreSlot } from './restore-ring.js';
import { isMainSetting, mutesAsSettings, readMutes, voiceOf, VOICE_COUNT } from './settings.js';
import { SinkTap } from './sink-tap.js';
import { DeckSlip } from './slip.js';
import { effectiveTempo } from './tempo.js';

/** How far ahead a deck with no output renders, in milliseconds. */
export const DEFAULT_LOOKAHEAD_MS = 15;

/** What a deck asks of the package that holds it. */
export interface DeckHost {
  /** The deck's clock may have started or stopped: the package's one wake follows the decks. */
  syncWake(): void;
}

type LoadCommand = Extract<DeckCommand, { kind: 'load' }>;
type LandedEvent = Extract<DeckEvent, { kind: 'landed' }>;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type KeyResolution = NonNullable<LandedEvent['resolved']>;
type Phase = 'empty' | 'loading' | 'failed' | 'ready';
type Ends = 'playing' | 'paused' | 'stopped';

/** A `key` press's resolution, by the code the event queue carries it as. */
const RESOLUTIONS: Readonly<Record<number, KeyResolution>> = {
  [RESOLVED_START]: 'start',
  [RESOLVED_QUEUE]: 'queue',
  [RESOLVED_CANCEL]: 'cancel',
  [RESOLVED_LET_GO]: 'let-go',
};

const NO_FRAME = Number.MAX_SAFE_INTEGER;

/** Slots in `Deck.times`: the doubles the picture's timing reports, kept where a store never boxes. */
const WORST_LATE_MS = 0;
const LAST_REWIND_MS = 1;
const WORST_REWIND_MS = 2;

/** Seek frames kept declared beside the host's targets: each holds a prepared image of about 68 KB. */
const SEEK_FRAMES_KEPT = 8;
const LANDINGS_KEPT = 8;

/** A deck's `load` register-record margin, in seconds of tune past what the engine measures. */
const RECORD_MARGIN_SECONDS = 5;

/** Whether `command` halts the engine's output: its stop drops every frame the sink still holds. */
function halts(entry: LogEntry): boolean {
  const kind = entry.command?.kind;
  return kind === 'pause' || kind === 'stop' || kind === 'load';
}

/**
 * Whether applying `command` always ends the loop that is running, and with it the pass in
 * progress. The commands that end it only sometimes (a jump over a loop, a key, a let-go) say so
 * when they land.
 */
function endsLoop(command: DeckCommand): boolean {
  const kind = command.kind;
  return kind === 'seek' || kind === 'stop' || kind === 'load' || kind === 'stop-loop';
}

/**
 * One deck: an engine, the clock that drives it, the sink tap in front of its output, and the
 * rewind that lets every command land on the next frame the sink has not passed.
 *
 * The deck renders ahead of the sink's time into its output (frames carry their due times, and
 * holding them until due is the sink's job). A command is fixed to a stream frame when it arrives
 * and logged; a flush restores the engine to the frame before it, drops the frames the sink still
 * holds from there on, and re-renders them with every command due on each frame applied in order.
 * The engine's saved state and the deck's own (`DeckState`) are saved together after every frame.
 *
 * The package never subscribes to the engine: its listeners run inside the tick, and a call back
 * into the engine, or a save, from there breaks the engine's contract. All the deck's logic runs
 * between ticks.
 *
 * `player` is the engine the deck owns. Nothing outside the deck commands it between ticks: a
 * restore point saved before the call would not hold it, and a rewind would take it back.
 */
export class Deck {
  readonly id: DeckId;
  readonly player: SidPlayer;

  private readonly state = new DeckState();
  private readonly clock: DrivenClock;
  private readonly tap: SinkTap;
  private readonly log = new CommandLog();
  private readonly events = new EventQueue();
  private readonly replayRunner: ReplayRunner;
  private readonly prepareRunner: ReplayRunner | undefined;
  private readonly loops: DeckLoops;
  private readonly slip: DeckSlip;
  private readonly hand: DeckHand;
  private readonly live: DeckLiveLoop;

  private ring: RestoreRing | null = null;
  private output: DeckOutput | null = null;
  private phase: Phase = 'empty';
  private disposed = false;
  /** A flush, or a render, is in progress: a command arriving now is flushed after it. */
  private busy = false;
  /** Engine calls that returned a promise and have not settled: the deck renders nothing meanwhile. */
  private settling = 0;
  private microtaskPending = false;

  /** The last entry applied at the frame about to render: what a restore point saved now contains. */
  private watermark = NOTHING_APPLIED;
  /** The stream frame the current run's first frame carries: where the begin slot sits. */
  private runStart = -1;
  private beginSeen = 0;
  private lastRewindUnsent = -1;
  private rewindLanding = 0;
  private catchUp = false;
  private noOutputWarned = false;

  private tuneRef: string | null = null;
  private bytes: Uint8Array | null = null;
  private chipModel: SidModel | null = null;
  private hasTune = false;
  private grid: Grid | null = null;
  private error: string | null = null;
  private generation = 0;
  private deliveryCapacity = 0;

  /** The frames the host declared with `targets`, and the frames of recent seeks (see `declare`). */
  private hostTargets: readonly number[] = [];
  private recentSeeks: number[] = [];

  /** Fixed ready landings, outside `DeckState`: a waiting seek's landing frame, by the seek's sequence number. */
  private readonly landingSeq = new Int32Array(LANDINGS_KEPT);
  private readonly landingFrame = new Int32Array(LANDINGS_KEPT);
  private readonly landingTune = new Int32Array(LANDINGS_KEPT);
  private landingCount = 0;

  private framesDelivered = 0;
  private lateFrames = 0;
  private rewinds = 0;
  private rewoundFrames = 0;
  private ringShort = 0;
  private frontierLandings = 0;
  private readonly times = new Float64Array(3);

  private readonly update: Mutable<DeckUpdate>;
  private lastPictureSnapshot: PlayerSnapshot | null = null;
  private readonly pictureKey = new Float64Array(16);
  private pictureError: string | null = null;
  private pictureQueued: JumpTarget | null = null;
  private pictureWaiting: JumpTarget | null = null;
  private picturePending: object | null = null;

  /** Keeps the queued events a rewind to `rewindLanding` does not undo; one closure, made once. */
  private readonly retainAfterRewind = (event: QueuedEvent): boolean => {
    if (event.sticky || event.frame < this.rewindLanding) return true;
    if (event.entry < 0) return false;
    const entry = this.log.byIndex(event.entry);
    if (entry.seq !== event.seq) return false;
    if (entry.frame === this.rewindLanding && entry.seq <= this.watermark) return true;
    entry.eventState = EVENT_NONE;
    return false;
  };

  constructor(
    id: DeckId,
    private readonly plugs: DjPlugs,
    private readonly host: DeckHost,
  ) {
    this.id = id;
    this.clock = new DrivenClock(plugs.time, this.state.cells);
    this.tap = new SinkTap(() => this.state.stream);
    this.replayRunner = plugs.heavyWork.replayRunner();
    this.prepareRunner = plugs.heavyWork.prepareRunner?.();
    this.player = createSidPlayer({
      sink: this.tap,
      clock: this.clock,
      replayRunner: this.replayRunner,
      ...(this.prepareRunner === undefined ? {} : { prepareRunner: this.prepareRunner }),
      time: plugs.time,
      ...(plugs.log === undefined ? {} : { log: plugs.log }),
    });
    this.player.setRepeatTrack(true);
    this.slip = new DeckSlip(this.player, this.state);
    this.hand = new DeckHand(this.player, this.state, this.slip);
    this.loops = new DeckLoops(this.player, this.state, this.loopsHost(), this.slip);
    this.live = new DeckLiveLoop(
      this.player,
      this.state,
      this.liveLoopHost(),
      this.slip,
      this.loops,
    );
    this.update = {
      kind: 'update',
      deck: id,
      streamFrame: 0,
      dueAtMs: 0,
      intervalUs: 0,
      position: 0,
      lapProgress: null,
      slipPosition: null,
    };
  }

  /** Whether the deck's driven clock is started: it renders, so the package's wake has work for it. */
  get rendering(): boolean {
    return !this.disposed && this.clock.started;
  }

  /** How far ahead this deck renders, in milliseconds. */
  get lookaheadMs(): number {
    return this.output === null ? DEFAULT_LOOKAHEAD_MS : this.output.lookaheadMs;
  }

  // ---------------------------------------------------------------------------------------------
  // What the package calls

  /**
   * Why a command is refused, or null. A press needs a settled deck: not empty, loading or failed.
   * A load, the deck's own settings, slip, the hand's moves and the releases always pass: a move
   * the deck cannot take is ignored when it lands. The live looper is off on a deck with no grid.
   */
  refusal(command: DeckCommand): string | null {
    const kind = command.kind;
    if (kind === 'load') return null;
    const release =
      (kind === 'nudge' && command.amount === 0) ||
      kind === 'hand-lift' ||
      kind === 'cancel-queued' ||
      kind === 'let-go' ||
      kind === 'stop-loop';
    if (
      release ||
      kind === 'repeat' ||
      kind === 'targets' ||
      kind === 'slip' ||
      kind === 'hand-move'
    ) {
      return null;
    }
    if (this.phase !== 'ready') return `${kind} on a deck that is ${this.phase}`;
    if (this.player.getSnapshot().transport === 'error') return `${kind} on a deck that is failed`;
    if (kind === 'live-loop' && this.grid === null) return 'live-loop on a deck with no grid';
    return null;
  }

  /** Takes a command the deck has accepted: fixes its `When`, logs it and flushes it. */
  receive(command: DeckCommand): void {
    if (this.disposed) return;
    const entry = this.log.push(command, null);
    if (entry === null) {
      this.plugs.log?.warn(
        `dj: refused ${command.kind}: the command log of deck ${this.id} is full`,
      );
      return;
    }
    const unsent = this.tap.firstUnsent();
    const when = command.when;
    switch (when?.at) {
      case 'frame':
        entry.from = Math.max(when.frame, unsent);
        break;
      case 'pass-end':
        entry.passEnd = true;
        entry.from = Math.max(when.from ?? unsent, unsent);
        break;
      default:
        entry.from = unsent;
    }
    if (command.pressedAtMs !== undefined) entry.pressedAtMs = command.pressedAtMs;
    else if ('atMs' in command) entry.pressedAtMs = command.atMs;
    this.schedule();
  }

  /** Answers a request. Requests read a deck and change nothing, and never wait for a flush. */
  request(request: DjRequest): void {
    if (this.disposed) return;
    switch (request.kind) {
      case 'describe':
        this.plugs.report(this.buildPicture());
        break;
      case 'registers':
        this.plugs.report(this.readRegisters());
        break;
      case 'keep-deliveries':
        this.deliveryCapacity = request.capacity;
        this.player.keepDeliveries(request.capacity);
        break;
      case 'deliveries':
        this.plugs.report(this.readDeliveries());
        break;
    }
  }

  /** Points the deck at an output, or takes it off with null. */
  setOutput(output: DeckOutput | null): void {
    if (this.disposed || output === this.output) return;
    if (output !== null && !(Number.isFinite(output.lookaheadMs) && output.lookaheadMs > 0)) {
      this.plugs.log?.warn(`dj: refused output for deck ${this.id}: lookaheadMs must be above 0`);
      return;
    }
    const lookaheadChanged =
      this.lookaheadMs !== (output === null ? DEFAULT_LOOKAHEAD_MS : output.lookaheadMs);
    this.output = output;
    this.noOutputWarned = false;
    if (this.clock.started) {
      this.switchWhileRendering(output, lookaheadChanged);
    } else {
      this.tap.switchTo(output === null ? null : output.sink, this.state.stream, null);
      if (this.hasTune) this.player.setTargetClock(output === null ? null : output.targetClockHz);
      if (lookaheadChanged) this.rebuildRing();
    }
    this.afterWork();
  }

  /** The package's wake: renders ahead into the output and flushes what has arrived. */
  wake(nowMs: number): void {
    if (this.disposed || this.busy) return;
    if (this.settling > 0) {
      this.afterWork();
      return;
    }
    // A deck far behind skips ahead rather than render a burst of frames that fell due long ago.
    if (this.clock.started && nowMs - this.clock.nextDueMs > MAX_CATCH_UP_US / 1000) {
      this.clock.skipTo(nowMs);
      this.catchUp = true;
    }
    this.run(nowMs, true);
  }

  /** Stops the clock and disposes the engine and the runners it asked for. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clock.stop();
    this.player.dispose();
    this.replayRunner.dispose();
    this.prepareRunner?.dispose();
    this.log.clear();
    this.ring = null;
  }

  // ---------------------------------------------------------------------------------------------
  // Flushing: one path for every command

  /**
   * Flushes now when nothing is held (a command lands at once, before the next tick), otherwise
   * after a microtask: several commands in one turn cost one rewind. A rewind already run since
   * the sink last passed a frame waits for the next wake instead, so a fast control costs at most
   * one re-render a frame.
   */
  private schedule(): void {
    if (this.disposed || this.settling > 0) return;
    const unsent = this.tap.firstUnsent();
    if (!this.busy) {
      if (unsent >= this.state.stream) {
        this.flush();
        return;
      }
      if (unsent === this.lastRewindUnsent) return;
    }
    if (this.microtaskPending) return;
    this.microtaskPending = true;
    void Promise.resolve().then(() => {
      this.microtaskPending = false;
      this.flush();
    });
  }

  private flush(): void {
    if (this.disposed || this.busy || this.settling > 0) return;
    this.run(this.plugs.time.now(), false);
    this.host.syncWake();
  }

  private run(nowMs: number, forward: boolean): void {
    this.busy = true;
    try {
      this.process(nowMs, forward);
    } finally {
      this.busy = false;
    }
    this.afterWork();
  }

  /**
   * Fixes the landing of every command that arrived since the last flush, rewinds to the earliest
   * of them that falls in frames already rendered, and re-renders to where the deck had got to
   * (and on, when `forward`, as far as the lookahead allows).
   */
  private process(nowMs: number, forward: boolean): void {
    const state = this.state;
    const log = this.log;
    const unsent = this.tap.firstUnsent();
    const frontier = state.stream;
    let earliest = NO_FRAME;
    for (let i = 0; i < log.size; i++) {
      const entry = log.at(i);
      if (entry.flushed) continue;
      entry.flushed = true;
      entry.fresh = true;
      if (entry.from < unsent) entry.from = unsent;
      entry.frame = entry.passEnd ? UNRESOLVED : entry.from;
      if (entry.from < earliest) earliest = entry.from;
    }

    let floor = unsent;
    let rewoundAt = -1;
    if (earliest < frontier && this.clock.started) {
      rewoundAt = this.plugs.time.now();
      floor = this.rewind(earliest);
      if (floor >= frontier) rewoundAt = -1;
    }
    for (let i = 0; i < log.size; i++) {
      const entry = log.at(i);
      if (!entry.fresh) continue;
      entry.fresh = false;
      if (entry.from < floor) entry.from = floor;
      if (!entry.passEnd && entry.frame < floor) entry.frame = floor;
    }

    this.drain(frontier, forward ? nowMs + this.lookaheadMs : Number.NEGATIVE_INFINITY, nowMs);

    if (rewoundAt >= 0) {
      const took = this.plugs.time.now() - rewoundAt;
      this.times[LAST_REWIND_MS] = took;
      if (took > this.times[WORST_REWIND_MS]) this.times[WORST_REWIND_MS] = took;
    }
  }

  /**
   * Restores the engine and the deck to the oldest restore point at or after `wanted` that the
   * sink and the engine allow, and drops the sink's held frames from there. Returns the frame the
   * deck now renders from; the frontier when nothing could be restored, so the command lands after
   * the held frames.
   */
  private rewind(wanted: number): number {
    const frontier = this.state.stream;
    const tap = this.tap;
    const player = this.player;
    const ring = this.ring;
    const snapshot = player.getSnapshot();
    // A restore is refused into a stopped or ended engine, and into a paused one unless it is in varispeed.
    const restorable =
      snapshot.transport === 'playing' ||
      (snapshot.transport === 'paused' && snapshot.tempo.varispeed);
    if (!restorable || ring === null) {
      this.frontierLandings++;
      return frontier;
    }

    let landing = wanted;
    let slot: RestoreSlot | null = null;
    for (;;) {
      slot = null;
      while (landing < frontier) {
        const candidate = ring.slotFor(landing);
        if (candidate !== null && (snapshot.transport === 'playing' || candidate.deck.varispeed)) {
          slot = candidate;
          break;
        }
        landing++;
      }
      if (slot === null) break;
      // The sink answers where replacements begin: later than asked when it passed more meanwhile.
      const resume = tap.base + tap.replaceFrom(landing - tap.base);
      if (resume === landing) break;
      landing = resume;
    }
    if (slot === null || landing > wanted) this.ringShort++;
    if (slot === null) return frontier;

    player.restoreState(slot.engine);
    this.state.restoreFrom(slot.deck);
    this.watermark = slot.appliedThrough;
    this.rewinds++;
    this.rewoundFrames += frontier - landing;
    this.rewindLanding = landing;
    this.events.compact(this.retainAfterRewind);
    this.resetPassEnds(landing);
    this.lastRewindUnsent = tap.firstUnsent();
    return landing;
  }

  /**
   * Applies what is due on each frame from the frontier on and renders it, until the clock stops,
   * a command has to wait, an engine call is settling, or the frame is not wanted: before `until`
   * it is re-rendered whatever its due time; from there on only while it falls due by `limitMs`.
   */
  private drain(until: number, limitMs: number, nowMs: number): void {
    const state = this.state;
    const clock = this.clock;
    for (;;) {
      if (this.settling > 0 || this.disposed) return;
      const frame = state.stream;
      this.determinePassEnds(frame);
      if (!this.applyDue(frame)) return;
      if (this.settling > 0) return;
      if (!clock.started || this.phase !== 'ready') return;
      if (frame >= until && clock.nextDueMs > limitMs) return;
      this.renderOne(frame, nowMs);
    }
  }

  /**
   * Applies, in arrival order, every entry due on `frame` that the restore point the deck is at
   * does not already contain, then the ready landings due on it. False when an entry that halts
   * the engine has to wait for the sink to pass the frames before it: a halt resets the sink, which
   * would drop them.
   */
  private applyDue(frame: number): boolean {
    const log = this.log;
    for (let i = 0; i < log.size; i++) {
      const entry = log.at(i);
      if (entry.frame !== frame || entry.seq <= this.watermark) continue;
      if (halts(entry) && this.clock.started && this.tap.firstUnsent() < frame) return false;
      this.apply(entry, frame);
      if (this.settling > 0) return true;
    }
    for (let i = 0; i < this.landingCount; i++) {
      if (this.landingFrame[i] === frame && this.state.waitingSeq === this.landingSeq[i]) {
        this.landReady(i, frame);
      }
    }
    return true;
  }

  /** Renders one frame, and runs the package's own logic for it before saving its restore point. */
  private renderOne(frame: number, nowMs: number): void {
    const state = this.state;
    const clock = this.clock;
    if (this.output === null && !this.noOutputWarned) {
      this.noOutputWarned = true;
      this.plugs.log?.warn(`dj: deck ${this.id} has no output: its frames go nowhere`);
    }
    const dueMs = clock.nextDueMs;
    const clamped = this.catchUp;
    this.catchUp = false;
    state.stream = frame + 1;
    clock.tick(clamped);

    this.afterTick(frame);
    const ring = this.ring;
    if (ring !== null) this.capture(ring.slotAfter(frame), frame, NOTHING_APPLIED);
    this.watermark = NOTHING_APPLIED;

    this.framesDelivered++;
    if (nowMs > dueMs) {
      this.lateFrames++;
      if (nowMs - dueMs > this.times[WORST_LATE_MS]) this.times[WORST_LATE_MS] = nowMs - dueMs;
    }
    this.reportUpdate(frame, dueMs);
    this.reportPictureIfChanged();
  }

  /**
   * The package's logic between ticks, for the frame that just rendered. The engine's snapshot is
   * read first (by identity: nothing published changed when it is the one last read), then what
   * the frame showed: a hand-off or a wrap ends the running loop's pass, a hand-off is the queued
   * target running now (the only way a landing from the queue is learnt), a loop change that is no
   * longer pending has landed, and a waiting seek or jump whose target became ready is fixed to land
   * on the next frame, and a throw that reached the deck's speed hands the record back. The
   * restore point is saved after. The wrap is seen as the playhead moving back; a lap's phase
   * moves only with it. A running live loop follows the engine too: it ends when the engine's loop
   * is gone, and a shrink the engine took on becomes its bounds.
   */
  private afterTick(frame: number): void {
    const state = this.state;
    const player = this.player;
    const snapshot = player.getSnapshot();
    let passEnded = false;
    if (snapshot !== state.snapshot) {
      state.snapshot = snapshot;
      const tune = snapshot.tune;
      if (tune !== null) {
        if (tune.handOffs > state.lastHandOffs) {
          passEnded = true;
          this.loops.handedOff(frame);
        } else if (
          state.pending !== null &&
          state.underneath === null &&
          tune.loopChange === null
        ) {
          // Not while a live loop runs: the change pending is the loop underneath's, held outside the engine.
          this.loops.changeLanded();
        }
        state.lastHandOffs = tune.handOffs;
        this.watchWaiting(frame, tune.preparedFrames);
      }
      this.resizeRing(snapshot);
    }
    if (state.liveOn) this.live.afterTick(snapshot);
    const position = player.getPosition();
    if (snapshot.loop !== null && position < state.cells[LAST_POSITION]) passEnded = true;
    state.cells[LAST_POSITION] = position;
    if (passEnded) this.resolvePassEnds(frame);
    const settling = this.hand.afterTick();
    if (settling !== null) this.settleOn(settling);
  }

  // ---------------------------------------------------------------------------------------------
  // Applying commands

  /**
   * Applies one entry on `frame`, reusing the answers it got the first time, and queues its
   * `landed`. A press that starts a target on a deck that is not playing asks the engine to play
   * and returns: the deck settles, and the same entry is applied again once it has.
   */
  private apply(entry: LogEntry, frame: number): void {
    if (this.startsFirst(entry)) {
      entry.started = true;
      this.settleOn(this.player.play());
      return;
    }
    const dueMs = this.clock.nextDueMs;
    entry.applied = true;
    if (entry.seq > this.watermark) this.watermark = entry.seq;
    const command = entry.command;
    if (command === null) {
      if (entry.record !== null) this.player.setRegisterRecord(entry.record);
      return;
    }
    const player = this.player;
    let endedLoop = endsLoop(command);
    switch (command.kind) {
      case 'play':
        if (player.getSnapshot().transport !== 'playing') this.settleOn(player.play());
        break;
      case 'pause':
        player.pause();
        break;
      case 'stop':
        this.clearWaiting();
        this.hand.letGo();
        this.loops.drop();
        player.stop();
        break;
      case 'seek':
        this.applySeek(entry, command.frame);
        break;
      case 'speed':
        this.setLayer(SPEED, command.value);
        break;
      case 'nudge':
        this.setLayer(NUDGE, command.amount);
        break;
      case 'speed-jump':
        this.setLayer(JUMP, command.amount);
        break;
      case 'repeat':
        player.setRepeatTrack(command.on);
        break;
      case 'setting':
        if (isMainSetting(command.setting)) {
          this.loops.setSetting(voiceOf(command.setting), command.value === 1);
        }
        break;
      case 'targets':
        this.hostTargets = [...command.frames];
        this.declare();
        break;
      case 'load':
        this.applyLoad(command);
        break;
      case 'jump':
        endedLoop = this.loops.jump(entry, command.target);
        break;
      case 'key':
        endedLoop = this.loops.key(entry, command.target);
        break;
      case 'cancel-queued':
        this.loops.cancelQueued();
        break;
      case 'let-go':
        endedLoop = this.loops.letGo();
        break;
      case 'stop-loop':
        if (this.state.waiting !== null) this.clearWaiting();
        this.loops.stopLoop();
        break;
      case 'loop-bounds':
        endedLoop = this.loops.loopBounds(entry, command);
        break;
      case 'loop-wraps':
        this.loops.loopWraps(command.wraps);
        break;
      case 'capture':
        this.queueCaptured(entry, frame, player.capturePosition());
        break;
      case 'hand-touch':
        if (this.phase === 'ready') {
          this.hand.touch();
          // A touch on a deck that was not playing started the engine's clock and began its sink.
          this.afterBegin();
        }
        break;
      case 'hand-move':
        this.hand.move(command.travelFrames, command.atMs);
        break;
      case 'hand-lift':
        this.hand.lift(command.atMs, command.gripSeconds);
        break;
      case 'slip':
        this.slip.setOn(command.on);
        break;
      case 'live-loop-size':
        this.live.setSize(entry, command.lengthFrames);
        break;
      case 'live-loop':
        this.live.start(entry);
        break;
      case 'live-loop-end':
        endedLoop = this.live.end(entry);
        break;
      case 'live-loop-adopt':
        this.live.adopt();
        break;
      default:
        // The rest never get here.
        break;
    }
    this.queueLanded(entry, frame, dueMs);
    if (endedLoop) this.endPass(frame, entry.seq);
  }

  /**
   * Whether `entry` is a press that starts or queues a target on a deck that is not playing: the
   * deck plays first. It never pauses, and never jumps while `play()` is still settling.
   */
  private startsFirst(entry: LogEntry): boolean {
    const command = entry.command;
    if (command === null || entry.started) return false;
    if (command.kind !== 'jump' && command.kind !== 'key') return false;
    if (this.player.getSnapshot().transport === 'playing') return false;
    if (command.kind === 'jump') return true;
    const resolved = this.loops.resolve(command.target);
    return resolved === RESOLVED_START || resolved === RESOLVED_QUEUE;
  }

  private queueLanded(entry: LogEntry, frame: number, dueMs: number): void {
    if (entry.eventState !== EVENT_NONE) return;
    const event = this.events.push(KIND_LANDED, frame);
    if (event === null) {
      this.plugs.log?.warn(`dj: deck ${this.id} dropped an event: its queue is full`);
      return;
    }
    event.entry = entry.index;
    event.seq = entry.seq;
    event.dueMs = dueMs;
    event.a = entry.command?.kind === 'key' ? this.loops.resolved : RESOLVED_NONE;
    event.b = this.state.ownInPlay ? 2 : 1;
    entry.eventState = EVENT_QUEUED;
  }

  /**
   * Queues a `captured` beside the `landed` of the entry that captured the playhead, which a
   * rewind keeps or discards with it. Nothing is reported with nothing loaded.
   */
  private queueCaptured(entry: LogEntry, frame: number, position: number | null): void {
    if (position === null || entry.eventState !== EVENT_NONE) return;
    const event = this.events.push(KIND_CAPTURED, frame);
    if (event === null) {
      this.plugs.log?.warn(`dj: deck ${this.id} dropped an event: its queue is full`);
      return;
    }
    event.entry = entry.index;
    event.seq = entry.seq;
    event.a = position;
  }

  /** Changes one tempo layer, and the engine's tempo when the effective tempo moved. */
  private setLayer(cell: number, value: number): void {
    const state = this.state;
    const before = effectiveTempo(state.speed, state.nudge, state.jump);
    state.cells[cell] = value;
    const after = effectiveTempo(state.speed, state.nudge, state.jump);
    if (after !== before) this.player.setTempo(after);
  }

  /**
   * A seek, in tune frames. While playing, a target the engine holds an image for lands at once;
   * any other is declared and waited for, playing on, and lands on the frame after the one that
   * first shows it ready. The engine would replay an unprepared seek off-thread, whose landing time
   * would depend on the worker, so it is never asked to while playing. A deck that is not playing
   * awaits the engine's own seek (settling), and seeks held behind it collapse to the latest.
   */
  private applySeek(entry: LogEntry, asked: number): void {
    const player = this.player;
    // Rounded and bounded as the engine rounds a seek, so a frame is the same one wherever it is kept.
    const tuneFrame = tuneFrameOf(asked);
    const target = frames(tuneFrame);
    this.slip.abandon();
    this.loops.drop();
    this.clearWaiting();
    if (!this.clock.started || player.getSnapshot().transport !== 'playing') {
      if (!this.supersededSeek(entry)) this.settleOn(player.seek(target));
      return;
    }
    if (entry.ready === ANSWER_UNASKED) {
      const prepared = player.getSnapshot().tune?.preparedFrames ?? [];
      entry.ready = prepared.includes(target) ? ANSWER_YES : ANSWER_NO;
    }
    if (entry.ready === ANSWER_YES) {
      this.seekPrepared(target);
      return;
    }
    this.rememberSeek(tuneFrame);
    this.state.wait(tuneFrame, entry.seq);
    this.declare();
  }

  /** Whether a seek still to be applied on the same frame will move the playhead after this one. */
  private supersededSeek(entry: LogEntry): boolean {
    for (let i = 0; i < this.log.size; i++) {
      const later = this.log.at(i);
      if (later.seq > entry.seq && later.command?.kind === 'seek' && later.frame === entry.frame) {
        return true;
      }
    }
    return false;
  }

  private seekPrepared(target: ReturnType<typeof frames>): void {
    if (this.player.getSnapshot().tune?.preparedFrames.includes(target)) {
      void this.player.seek(target);
    } else {
      this.plugs.log?.warn(
        `dj: deck ${this.id} ignored a seek to ${target}: its image is not held`,
      );
    }
  }

  /**
   * Lands a waiting seek or jump on the frame its readiness fixed. A jump that replaced a running
   * loop ends that loop's pass. A seek that a live loop's fold-in waited for sets the loop it left
   * underneath again first.
   */
  private landReady(index: number, frame: number): void {
    const state = this.state;
    const target = state.waiting;
    const settings = state.waitingSettings;
    const seq = state.waitingSeq;
    state.stopWaiting();
    let endedLoop = false;
    if (target === null) {
      // A fold-in's landing: the loop it left underneath comes back, set before the seek as a jump's is.
      if (state.underneath !== null) {
        this.loops.resumeUnderneath(null);
        state.underneath = null;
      }
      this.seekPrepared(frames(this.landingTune[index]));
    } else {
      endedLoop = this.loops.land(target, settings);
    }
    const event = this.events.push(KIND_JUMP_LANDED, frame);
    if (event !== null) {
      event.a = target === null ? this.landingTune[index] : target.startFrame;
      event.b = target === null || target.endFrame === null ? -1 : target.endFrame;
      event.c = 1;
    }
    if (endedLoop) this.endPass(frame, seq);
  }

  /**
   * Makes `target` the one waiting for `tuneFrame`, declared like a seek's so a landing a rewind
   * re-renders finds its image.
   */
  private waitOn(
    tuneFrame: number,
    seq: number,
    target: JumpTarget,
    settings: JumpSettings | null,
  ): void {
    this.clearWaiting();
    this.rememberSeek(tuneFrame);
    this.state.wait(tuneFrame, seq, target, settings);
    this.declare();
  }

  /** What the part that holds the loops asks of this deck. Made once, so a call allocates no closure. */
  private loopsHost(): LoopsHost {
    return {
      wait: (tuneFrame, seq, target, settings) => this.waitOn(tuneFrame, seq, target, settings),
      stopWaiting: () => this.clearWaiting(),
      jumpLanded: (frame, target) => this.queueHandOff(frame, target),
      warn: (message) => this.plugs.log?.warn(`dj: deck ${this.id}: ${message}`),
    };
  }

  /** What the part that holds the live loop asks of this deck. Made once, so a call allocates no closure. */
  private liveLoopHost(): LiveLoopHost {
    return {
      grid: () => this.grid,
      rebuildRing: () => this.rebuildRing(),
      awaitFold: (tuneFrame, seq) => {
        this.clearWaiting();
        this.rememberSeek(tuneFrame);
        this.state.wait(tuneFrame, seq);
        this.declare();
      },
      warn: (message) => this.plugs.log?.warn(`dj: deck ${this.id}: ${message}`),
    };
  }

  /**
   * Queues the `jump-landed` of a hand-off made in the tick that rendered `frame`. The event is
   * tagged with that frame, so a rewind to the frame after keeps what its restore point already
   * holds; the landing it reports is the frame after, the first the new loop plays.
   */
  private queueHandOff(frame: number, target: JumpTarget): void {
    const event = this.events.push(KIND_JUMP_LANDED, frame);
    if (event === null) {
      this.plugs.log?.warn(`dj: deck ${this.id} dropped an event: its queue is full`);
      return;
    }
    event.a = target.startFrame;
    event.b = target.endFrame === null ? -1 : target.endFrame;
    event.c = 0;
  }

  /**
   * After the tick that rendered `frame`, notes a waiting seek's target ready. Its landing is fixed
   * once, at the next frame, in a list a rewind does not undo: the engine does not save which
   * images are prepared, so a re-render would otherwise find the target ready earlier than it
   * first was.
   */
  private watchWaiting(frame: number, prepared: readonly number[]): void {
    const seq = this.state.waitingSeq;
    if (seq === NOT_WAITING) return;
    for (let i = 0; i < this.landingCount; i++) if (this.landingSeq[i] === seq) return;
    const tuneFrame = this.state.waitingFrame;
    if (!prepared.includes(tuneFrame)) return;
    if (this.landingCount === LANDINGS_KEPT) this.removeLanding(0);
    this.landingSeq[this.landingCount] = seq;
    this.landingFrame[this.landingCount] = frame + 1;
    this.landingTune[this.landingCount] = tuneFrame;
    this.landingCount++;
  }

  /** A command replaces or cancels the wait: its fixed landing goes with it. */
  private clearWaiting(): void {
    const seq = this.state.waitingSeq;
    if (seq === NOT_WAITING) return;
    for (let i = 0; i < this.landingCount; i++) {
      if (this.landingSeq[i] === seq) {
        this.removeLanding(i);
        break;
      }
    }
    this.state.stopWaiting();
  }

  private removeLanding(index: number): void {
    for (let i = index + 1; i < this.landingCount; i++) {
      this.landingSeq[i - 1] = this.landingSeq[i];
      this.landingFrame[i - 1] = this.landingFrame[i];
      this.landingTune[i - 1] = this.landingTune[i];
    }
    this.landingCount--;
  }

  /**
   * A seek's or a jump's frame stays declared beside the host's, so a landing a rewind re-renders
   * finds its image.
   */
  private rememberSeek(tuneFrame: number): void {
    if (this.recentSeeks.includes(tuneFrame)) return;
    this.recentSeeks.push(tuneFrame);
    if (this.recentSeeks.length > SEEK_FRAMES_KEPT) this.recentSeeks.shift();
  }

  /** Declares the host's targets and the frames recently waited for, sorted and unique. */
  private declare(): void {
    const set = new Set<number>([...this.hostTargets, ...this.recentSeeks]);
    this.player.setJumpTargets([...set].sort((a, b) => a - b).map((frame) => frames(frame)));
  }

  // ---------------------------------------------------------------------------------------------
  // The end of a pass: `pass-end` commands

  /**
   * Fixes, at the start of its `from` frame, whether a loop runs there. With none, a `pass-end`
   * entry lands on that frame; with one, it waits for the end of the pass. A `jump` is the
   * exception: it lands on `from` either way, and with a loop running it queues in the engine,
   * which makes the end of the pass its own.
   */
  private determinePassEnds(frame: number): void {
    for (let i = 0; i < this.log.size; i++) {
      const entry = this.log.at(i);
      if (!entry.passEnd || entry.loopAtFrom !== LOOP_UNKNOWN || entry.from > frame) continue;
      if (this.player.getSnapshot().loop === null) {
        entry.loopAtFrom = LOOP_NO;
        entry.frame = frame;
      } else {
        entry.loopAtFrom = LOOP_YES;
        if (entry.command?.kind === 'jump') entry.frame = frame;
      }
    }
  }

  /** The tick that rendered `frame` showed the end of a pass: the entries waiting for it land on the next frame. */
  private resolvePassEnds(frame: number): void {
    for (let i = 0; i < this.log.size; i++) {
      const entry = this.log.at(i);
      if (!entry.passEnd || entry.loopAtFrom !== LOOP_YES || entry.from > frame) continue;
      if (entry.frame === UNRESOLVED || entry.frame > frame + 1) entry.frame = frame + 1;
    }
  }

  /**
   * A command that ended the running loop before its wrap ends the pass early: the `pass-end`
   * entries still waiting apply on this frame, right after it, so none waits for a later,
   * unrelated loop.
   */
  private endPass(frame: number, endedBy: number): void {
    for (let i = 0; i < this.log.size; i++) {
      const entry = this.log.at(i);
      if (!entry.passEnd || entry.from > frame) continue;
      if (entry.frame !== UNRESOLVED && entry.frame <= frame) continue;
      entry.frame = frame;
      entry.cascadedBy = endedBy;
      this.apply(entry, frame);
    }
  }

  /**
   * A rewind to `landing` undoes what the frames from there on showed: the ends of passes are
   * found again. An entry an ending command applied right after itself waits for that command
   * again, so a re-render keeps the order (the command, then the entry) and not arrival order;
   * unless the restore point already holds both.
   */
  private resetPassEnds(landing: number): void {
    for (let i = 0; i < this.log.size; i++) {
      const entry = this.log.at(i);
      if (!entry.passEnd) continue;
      if (entry.from >= landing) {
        entry.loopAtFrom = LOOP_UNKNOWN;
        entry.frame = UNRESOLVED;
        entry.cascadedBy = 0;
      } else if (entry.frame >= landing) {
        const contained = entry.frame === landing && entry.cascadedBy <= this.watermark;
        if (entry.cascadedBy !== 0 && !contained) {
          entry.frame = UNRESOLVED;
          entry.cascadedBy = 0;
        } else if (entry.cascadedBy === 0 && entry.frame > landing) {
          entry.frame = UNRESOLVED;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Settling: engine calls that return a promise

  /** Waits on an engine call: the deck renders nothing, and later commands are held, until it resolves. */
  private settleOn(promise: Promise<void>): void {
    this.settling++;
    const done = (): void => {
      this.settling--;
      if (this.settling === 0) this.settled();
    };
    promise.then(done, (error: unknown) => {
      this.plugs.log?.warn(`dj: deck ${this.id}: ${describeError(error)}`);
      done();
    });
  }

  private settled(): void {
    if (this.disposed) return;
    this.afterBegin();
    this.flush();
  }

  /**
   * After a `begin` (the engine's `play()` has resolved), saves the restore point for the state
   * before the run's first frame. It already holds the commands applied on that frame, and
   * records the last of them, so a rewind to it never applies the `play` twice.
   */
  private afterBegin(): void {
    if (this.tap.beginCount === this.beginSeen) return;
    this.beginSeen = this.tap.beginCount;
    if (!this.clock.started || this.ring === null) return;
    this.runStart = this.state.stream;
    this.capture(this.ring.startRun(this.runStart), this.runStart - 1, this.watermark);
  }

  // ---------------------------------------------------------------------------------------------
  // Restore points

  /** Saves the engine and the deck into `slot`, as the state after `frame`. */
  private capture(slot: RestoreSlot, frame: number, appliedThrough: number): void {
    this.state.varispeed = this.player.getSnapshot().tempo.varispeed;
    this.player.saveState(slot.engine);
    this.state.saveInto(slot.deck);
    slot.frame = frame;
    slot.appliedThrough = appliedThrough;
  }

  /**
   * Builds a new ring sized for the lookahead and the tune's rate. Allocates, so it is called off
   * the frame path and between ticks. A run under way keeps its current frame: the new ring is
   * re-seeded from the live state, and only the restore points behind it are lost.
   */
  private rebuildRing(): void {
    if (!this.hasTune) {
      this.ring = null;
      return;
    }
    const snapshot = this.player.getSnapshot();
    const tuneIntervalUs = snapshot.tempo.effectiveIntervalUs * snapshot.tempo.multiplier;
    const ring = new RestoreRing(RestoreRing.slotsFor(this.lookaheadMs, tuneIntervalUs), () => ({
      engine: this.player.createSavedState(),
      deck: this.state.createState(),
      frame: 0,
      appliedThrough: NOTHING_APPLIED,
    }));
    this.ring = ring;
    ring.startRun(this.runStart);
    if (this.clock.started) this.seedCurrent(ring);
  }

  /** Re-seeds the restore point for the state the deck is in now. */
  private seedCurrent(ring: RestoreRing): void {
    const frontier = this.state.stream;
    if (frontier === this.runStart) {
      this.capture(ring.startRun(this.runStart), frontier - 1, this.watermark);
    } else {
      this.capture(ring.slotAfter(frontier - 1), frontier - 1, this.watermark);
    }
  }

  /** The tune's own rate changed what the ring must hold: rebuild it. */
  private resizeRing(snapshot: PlayerSnapshot): void {
    const ring = this.ring;
    if (ring === null || snapshot.tune === null) return;
    const tuneIntervalUs = snapshot.tempo.effectiveIntervalUs * snapshot.tempo.multiplier;
    if (
      tuneIntervalUs > 0 &&
      RestoreRing.slotsFor(this.lookaheadMs, tuneIntervalUs) !== ring.capacity
    ) {
      this.rebuildRing();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The output

  /**
   * Switches the output of a deck that is rendering: the old sink is reset and ended, the new one
   * begins with the tune's chip model, and the frames the old sink had not passed are re-rendered
   * into it, with the new far-end clock set from the first of them. A restore queues no resync and
   * core has no public one, so a sink switched in while playing gets only the registers that
   * change after the switch (the cutover resends them).
   */
  private switchWhileRendering(output: DeckOutput | null, lookaheadChanged: boolean): void {
    const tap = this.tap;
    const frontier = this.state.stream;
    let start = tap.firstUnsent();
    const snapshot = this.player.getSnapshot();
    let slot: RestoreSlot | null = null;
    const ring = this.ring;
    if (start < frontier && ring !== null && snapshot.transport === 'playing') {
      const asked = start;
      while (start < frontier && (slot = ring.slotFor(start)) === null) start++;
      if (start > asked) this.ringShort++;
    }
    if (start >= frontier) slot = null;
    tap.switchTo(
      output === null ? null : output.sink,
      slot === null ? frontier : start,
      this.chipModel,
    );

    this.busy = true;
    try {
      if (slot !== null) {
        this.player.restoreState(slot.engine);
        this.state.restoreFrom(slot.deck);
        this.watermark = slot.appliedThrough;
        this.rewindLanding = start;
        this.events.compact(this.retainAfterRewind);
        this.resetPassEnds(start);
      }
      this.player.setTargetClock(output === null ? null : output.targetClockHz);
      if (lookaheadChanged) this.rebuildRing();
      else if (this.ring !== null) this.seedCurrent(this.ring);
      if (slot !== null) this.drain(frontier, Number.NEGATIVE_INFINITY, this.plugs.time.now());
    } finally {
      this.busy = false;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Loading

  /**
   * Step one of a load, on its landing frame: let go of everything the old tune had in play and
   * stop the engine. The rest of the load waits on the host's bytes; nothing renders meanwhile, so
   * the stream frame does not move and the landing is deterministic.
   */
  private applyLoad(command: LoadCommand): void {
    const player = this.player;
    const transportBefore = this.phase === 'ready' ? player.getSnapshot().transport : 'stopped';
    this.generation++;
    this.clearWaiting();
    this.landingCount = 0;
    this.hostTargets = [];
    this.recentSeeks = [];
    this.ring = null;
    this.runStart = -1;
    if (this.hasTune) {
      this.hand.letGo();
      this.loops.drop();
      player.stop();
      const state = this.state;
      state.cells[SPEED] = 1;
      state.cells[NUDGE] = 0;
      state.cells[JUMP] = 0;
      player.setTempo(1);
      player.clearVoiceMutes();
      state.mutes.fill(0);
      player.setJumpTargets([]);
    }
    this.phase = 'loading';
    this.error = null;
    this.framesDelivered = 0;
    this.lateFrames = 0;
    this.rewinds = 0;
    this.rewoundFrames = 0;
    this.ringShort = 0;
    this.frontierLandings = 0;
    this.times.fill(0);
    const ends: Ends =
      command.ends ??
      (transportBefore === 'playing' || transportBefore === 'paused' ? transportBefore : 'stopped');
    void this.runLoad(command, this.generation, ends);
  }

  private async runLoad(command: LoadCommand, generation: number, ends: Ends): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes =
        this.tuneRef === command.tune && this.bytes !== null
          ? this.bytes
          : await this.plugs.fetchTune(command.tune);
    } catch (error) {
      this.failLoad(command, generation, describeError(error));
      return;
    }
    await Promise.resolve();
    if (generation !== this.generation || this.disposed) return;

    let file: SidFile;
    try {
      file = parseSidFile(bytes);
    } catch (error) {
      this.failLoad(command, generation, describeError(error));
      return;
    }
    try {
      this.installTune(command, file, bytes);
    } catch (error) {
      this.failLoad(command, generation, describeError(error));
      return;
    }

    const player = this.player;
    const loaded = this.events.push(KIND_LOADED, this.state.stream);
    if (loaded !== null) {
      loaded.sticky = true;
      loaded.text = command.tune;
      loaded.a = player.getSnapshot().tune?.subtune ?? command.subtune;
      loaded.b = player.getSnapshot().tune?.subtuneCount ?? 1;
    }
    this.phase = 'ready';
    // The transport the load ends in. `play()` is awaited: it sets the transport only after its
    // clock start resolves, so a `pause()` any earlier would do nothing. The deck is settling
    // before `loaded` goes out, so a press the host sends on it is held, not run ahead of `play()`.
    if (ends !== 'stopped') this.settleOn(this.begin(ends));
    this.afterWork();
    this.host.syncWake();
    void this.requestRecord(bytes, generation);
  }

  private async begin(ends: Ends): Promise<void> {
    await this.player.play();
    if (ends === 'paused') this.player.pause();
  }

  /** Steps two and three of a load: the engine takes the tune and the deck's state is made to match it. */
  private installTune(command: LoadCommand, file: SidFile, bytes: Uint8Array): void {
    const player = this.player;
    const state = this.state;
    this.bytes = bytes;
    this.tuneRef = command.tune;
    this.chipModel = file.model;
    this.grid = command.grid ?? null;
    player.loadTune(file);
    this.hasTune = true;
    this.live.declareCaptures(false);
    this.slip.trackLoopStart = command.trackLoop?.loopStartFrame ?? null;
    if (command.subtune !== file.startSong) player.selectSubtune(command.subtune);
    const trackLoop = command.trackLoop;
    player.setTrackStructure(
      trackLoop === undefined || trackLoop === null
        ? null
        : {
            loopStartFrame:
              trackLoop.loopStartFrame === null ? null : frames(trackLoop.loopStartFrame),
            loopPeriodFrames:
              trackLoop.loopPeriodFrames === null ? null : frames(trackLoop.loopPeriodFrames),
            endedAtFrame: trackLoop.endedAtFrame === null ? null : frames(trackLoop.endedAtFrame),
          },
    );
    player.setTargetClock(this.output === null ? null : this.output.targetClockHz);

    state.cells[SPEED] = command.speed ?? 1;
    player.setTempo(effectiveTempo(state.speed, state.nudge, state.jump));
    readMutes(command.settings, state.mutes);
    for (let voice = 0; voice < VOICE_COUNT; voice++) {
      player.setVoiceMuted(voice, state.muted(voice));
    }
    state.snapshot = null;
    state.lastHandOffs = 0;
    state.cells[LAST_POSITION] = player.getPosition();
    this.rebuildRing();
  }

  private failLoad(command: LoadCommand, generation: number, reason: string): void {
    if (generation !== this.generation || this.disposed) return;
    this.phase = 'failed';
    this.error = reason;
    const failed = this.events.push(KIND_LOAD_FAILED, this.state.stream);
    if (failed !== null) {
      failed.sticky = true;
      failed.text = command.tune;
      failed.reason = reason;
    }
    this.afterWork();
    this.host.syncWake();
  }

  /**
   * Asks, off the deck's path, for the register record the hand and the rewind of a record work
   * on. It lands through the landing path as an internal command: the engine's saved state holds
   * the record, so every restore point saved before it has none, and setting it directly would let
   * the next rewind restore one without it and withdraw it for good.
   */
  private async requestRecord(bytes: Uint8Array, generation: number): Promise<void> {
    const snapshot = this.player.getSnapshot();
    const basis = snapshot.basis;
    const margin = Math.round((RECORD_MARGIN_SECONDS * 1e6) / snapshot.tempo.nominalIntervalUs);
    try {
      const record = await recordRegisters(
        this.plugs.heavyWork.scanner,
        bytes,
        snapshot.tune?.subtune ?? 1,
        Math.max(basis.positionBasisFrames, basis.ceilingFrames) + margin,
      );
      if (generation === this.generation && !this.disposed) this.receiveRecord(record);
    } catch (error) {
      if (generation !== this.generation || this.disposed) return;
      const what = error instanceof ScanFailedError ? 'the scan failed' : 'the scan could not run';
      this.plugs.log?.warn(
        `dj: deck ${this.id} has no register record: ${what}: ${describeError(error)}`,
      );
    }
  }

  private receiveRecord(record: RegisterRecord): void {
    const entry = this.log.push(null, record);
    if (entry === null) {
      this.plugs.log?.warn(
        `dj: deck ${this.id} dropped its register record: the command log is full`,
      );
      return;
    }
    entry.from = this.tap.firstUnsent();
    this.schedule();
  }

  // ---------------------------------------------------------------------------------------------
  // Reporting

  private afterWork(): void {
    this.sendEvents();
    this.log.dropBefore(this.clock.started ? this.tap.firstUnsent() : NO_FRAME);
    this.forgetPassedLandings();
    this.reportPictureIfChanged();
  }

  /** Landings the sink has passed can no longer be rewound across. */
  private forgetPassedLandings(): void {
    if (this.landingCount === 0) return;
    const unsent = this.tap.firstUnsent();
    for (let i = this.landingCount - 1; i >= 0; i--) {
      if (this.landingFrame[i] < unsent && this.state.waitingSeq !== this.landingSeq[i]) {
        this.removeLanding(i);
      }
    }
  }

  /**
   * Sends queued events, in order, once no frame at or before an event's tag is still held: the
   * sink has passed it, or nothing is held at all (a paused, stopped, empty or ended deck, or a
   * sink that holds nothing), since nothing there can be rewound.
   */
  private sendEvents(): void {
    const events = this.events;
    while (events.size > 0) {
      const head = events.at(0);
      const unsent = this.tap.firstUnsent();
      if (this.state.stream > unsent && unsent <= head.frame) return;
      const report = this.eventReport(head);
      events.shift();
      if (report !== null) this.plugs.report(report);
    }
  }

  private eventReport(event: QueuedEvent): DeckEvent | null {
    switch (event.kind) {
      case KIND_LANDED: {
        const entry = this.log.byIndex(event.entry);
        const command = entry.command;
        if (entry.seq !== event.seq || command === null) return null;
        entry.eventState = EVENT_SENT;
        const landed: Mutable<LandedEvent> = {
          kind: 'landed',
          deck: this.id,
          command,
          fixed: entry.passEnd
            ? { at: 'pass-end', from: entry.from }
            : { at: 'frame', frame: entry.frame },
          frame: event.frame,
          waitMs: Number.isNaN(entry.pressedAtMs) ? null : event.dueMs - entry.pressedAtMs,
        };
        if (command.kind === 'setting') landed.settingsIn = event.b === 2 ? 'loop' : 'main';
        if (command.kind === 'key') landed.resolved = RESOLUTIONS[event.a];
        return landed;
      }
      case KIND_LOADED:
        return {
          kind: 'loaded',
          deck: this.id,
          tune: event.text,
          subtune: event.a,
          subtuneCount: event.b,
          frame: event.frame,
        };
      case KIND_LOAD_FAILED:
        return { kind: 'load-failed', deck: this.id, tune: event.text, reason: event.reason };
      case KIND_JUMP_LANDED:
        return {
          kind: 'jump-landed',
          deck: this.id,
          frame: event.c === 1 ? event.frame : event.frame + 1,
          via: event.c === 1 ? 'ready' : 'pass-end',
          startFrame: event.a,
          endFrame: event.b < 0 ? null : event.b,
        };
      case KIND_CAPTURED:
        return { kind: 'captured', deck: this.id, frame: event.frame, position: event.a };
      default:
        return null;
    }
  }

  /** Fills the one reused update for the frame just delivered and hands it to the host. */
  private reportUpdate(frame: number, dueMs: number): void {
    const update = this.update;
    const position = this.player.getPosition();
    update.streamFrame = frame;
    update.dueAtMs = dueMs;
    update.intervalUs = this.clock.lastStepUs;
    update.position = position;
    update.lapProgress = this.lapProgress(position);
    update.slipPosition = this.slip.position();
    this.plugs.report(update);
  }

  /** 0 <= p < 1 through the running loop's lap in progress; null with no loop. Allocates nothing. */
  private lapProgress(position: number): number | null {
    const loop = this.player.getSnapshot().loop;
    if (loop === null) return null;
    const lap = lapLength(this.player.getLapPhase() ?? 0, loop.endFrame - loop.startFrame);
    if (!(lap > 0)) return 0;
    return Math.min(Math.max((position - loop.startFrame) / lap, 0), 1 - Number.EPSILON);
  }

  /**
   * Sends a picture when something it holds changed since the last one, compared cheaply; never
   * builds one on a frame where nothing did. `timing`, `output` and `rate` move every frame and
   * are read on `describe`.
   */
  private reportPictureIfChanged(): void {
    const state = this.state;
    const snapshot = this.player.getSnapshot();
    const key = this.pictureKey;
    const mutes = (state.muted(0) ? 1 : 0) | (state.muted(1) ? 2 : 0) | (state.muted(2) ? 4 : 0);
    const own = state.ownInPlay
      ? 8 |
        (state.loopMuted(0) ? 1 : 0) |
        (state.loopMuted(1) ? 2 : 0) |
        (state.loopMuted(2) ? 4 : 0)
      : 0;
    const phase =
      this.phase === 'empty' ? 0 : this.phase === 'loading' ? 1 : this.phase === 'failed' ? 2 : 3;
    const slots = this.ring === null ? 0 : this.ring.capacity;
    const slip = (this.slip.on ? 1 : 0) | (this.slip.departed ? 2 : 0);
    const live = state.liveOn ? (state.underneath === null ? 1 : 2) : 0;
    if (
      snapshot === this.lastPictureSnapshot &&
      key[0] === state.speed &&
      key[1] === state.nudge &&
      key[2] === state.jump &&
      key[3] === state.waitingFrame &&
      key[4] === mutes &&
      key[5] === phase &&
      key[6] === slots &&
      key[7] === this.lookaheadMs &&
      key[8] === own &&
      key[9] === slip &&
      key[10] === state.handState &&
      key[11] === live &&
      key[12] === (state.liveOn ? state.liveStart : -1) &&
      key[13] === (state.liveOn ? state.liveEnd : -1) &&
      key[14] === (Number.isNaN(state.livePendingEnd) ? -1 : state.livePendingEnd) &&
      key[15] === (Number.isNaN(state.liveSize) ? -1 : state.liveSize) &&
      this.pictureError === this.error &&
      this.pictureQueued === state.queued &&
      this.pictureWaiting === state.waiting &&
      this.picturePending === state.pending
    ) {
      return;
    }
    this.lastPictureSnapshot = snapshot;
    key[0] = state.speed;
    key[1] = state.nudge;
    key[2] = state.jump;
    key[3] = state.waitingFrame;
    key[4] = mutes;
    key[5] = phase;
    key[6] = slots;
    key[7] = this.lookaheadMs;
    key[8] = own;
    key[9] = slip;
    key[10] = state.handState;
    key[11] = live;
    key[12] = state.liveOn ? state.liveStart : -1;
    key[13] = state.liveOn ? state.liveEnd : -1;
    key[14] = Number.isNaN(state.livePendingEnd) ? -1 : state.livePendingEnd;
    key[15] = Number.isNaN(state.liveSize) ? -1 : state.liveSize;
    this.pictureError = this.error;
    this.pictureQueued = state.queued;
    this.pictureWaiting = state.waiting;
    this.picturePending = state.pending;
    this.plugs.report(this.buildPicture());
  }

  private buildPicture(): DeckPicture {
    const state = this.state;
    const snapshot = this.player.getSnapshot();
    const tuneSnapshot = this.phase === 'ready' ? snapshot.tune : null;
    const loop = snapshot.loop;
    const waiting: JumpTarget | null =
      state.waiting ??
      (state.waitingFrame === NOT_WAITING
        ? null
        : { startFrame: state.waitingFrame, endFrame: null });
    const pending = state.pending;
    const transport: DeckPicture['transport'] =
      this.phase !== 'ready'
        ? this.phase
        : snapshot.transport === 'error'
          ? 'failed'
          : snapshot.transport;
    const stats = this.hasTune ? this.player.getStats() : null;
    const ring = this.ring;
    return {
      kind: 'picture',
      deck: this.id,
      transport,
      tune:
        tuneSnapshot === null || this.tuneRef === null
          ? null
          : {
              tune: this.tuneRef,
              subtune: tuneSnapshot.subtune,
              subtuneCount: tuneSnapshot.subtuneCount,
              lengthFrames: tuneSnapshot.lengthFrames,
              recordReady: tuneSnapshot.recordedFrames !== null,
            },
      tempo: {
        speed: state.speed,
        nudge: state.nudge,
        jump: state.jump,
        effective: effectiveTempo(state.speed, state.nudge, state.jump),
      },
      repeat: snapshot.repeatTrack,
      loop:
        loop === null
          ? null
          : {
              startFrame: loop.startFrame,
              endFrame: loop.endFrame,
              wraps: loop.varispeedStart === 'wrap',
              ...(loop.lapPhase === undefined ? {} : { lapPhase: loop.lapPhase }),
              live: state.liveOn,
            },
      queued: state.queued,
      waiting,
      pendingBounds:
        pending === null ? null : { startFrame: pending.startFrame, endFrame: pending.endFrame },
      liveLoop: state.liveOn
        ? {
            lengthFrames: state.liveEnd - state.liveStart,
            pendingEndFrame: Number.isNaN(state.livePendingEnd) ? null : state.livePendingEnd,
            overLoop: state.underneath !== null,
          }
        : null,
      liveLoopSize: Number.isNaN(state.liveSize) ? null : state.liveSize,
      slip: { on: this.slip.on, departed: this.slip.departed },
      hand:
        state.handState === HAND_DOWN ? 'down' : state.handState === HAND_THROWN ? 'thrown' : 'up',
      settingsInPlay: state.ownInPlay ? 'loop' : 'main',
      settings: {
        main: mutesAsSettings(state.mutes),
        loop: state.ownInPlay ? mutesAsSettings(state.loopMutes) : null,
      },
      readyFrames: [...(tuneSnapshot?.preparedFrames ?? [])],
      grid: this.grid,
      rate:
        stats === null
          ? null
          : {
              exactCallsPerFrame: stats.rate.exactCallsPerFrame,
              nominalIntervalUs: snapshot.tempo.nominalIntervalUs,
            },
      output:
        this.output === null
          ? null
          : {
              lookaheadMs: this.output.lookaheadMs,
              heldFrames: Math.max(0, state.stream - this.tap.firstUnsent()),
              ringSlots: ring === null ? 0 : ring.capacity,
              ringBytes: ring === null ? 0 : ring.bytes,
            },
      timing: {
        framesDelivered: this.framesDelivered,
        lateFrames: this.lateFrames,
        worstLateMs: this.times[WORST_LATE_MS],
        rewinds: this.rewinds,
        rewoundFrames: this.rewoundFrames,
        lastRewindMs: this.times[LAST_REWIND_MS],
        worstRewindMs: this.times[WORST_REWIND_MS],
        ringShort: this.ringShort,
        frontierLandings: this.frontierLandings,
      },
      error: this.error ?? snapshot.error,
    };
  }

  private readRegisters(): DeckRegisters {
    const written = new Uint8Array(25);
    const sent = new Uint8Array(25);
    this.player.readRegisters(written, sent);
    return { kind: 'registers', deck: this.id, streamFrame: this.state.stream, written, sent };
  }

  /**
   * Everything delivered since the last drain. A rewind leaves the engine's history alone, so a
   * drained batch can hold a frame a rewind replaced and then its replacement: the history is the
   * engine's record of what it delivered, not of what the sink passed.
   */
  private readDeliveries(): DeckDeliveries {
    const batch = createDeliveryBatch(this.deliveryCapacity);
    this.player.drainDeliveries(batch);
    return { kind: 'deliveries', deck: this.id, batch };
  }
}
