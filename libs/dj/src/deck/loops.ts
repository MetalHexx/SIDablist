import { frames, isUsableLoopLength } from '@sidablist/core';
import type { ActiveLoop, JumpSettings, QueuedJump, SidPlayer } from '@sidablist/core';
import type { DeckCommand, JumpTarget } from '../messages/commands.js';
import { ANSWER_NO, ANSWER_UNASKED, ANSWER_YES, LOOP_YES, type LogEntry } from './command-log.js';
import type { DeckState } from './deck-state.js';
import { mutesAsBooleans, mutesOfSettings, VOICE_COUNT } from './settings.js';
import type { DeckSlip } from './slip.js';

/** How a `key` press resolved, as the event queue carries it: 0 for a command that is not a key. */
export const RESOLVED_NONE = 0;
export const RESOLVED_START = 1;
export const RESOLVED_QUEUE = 2;
export const RESOLVED_CANCEL = 3;
export const RESOLVED_LET_GO = 4;

/** The largest tune frame a seek keeps waiting for: it is stored in the deck state's 32-bit slots. */
const MAX_TUNE_FRAME = 0x7fffffff;

type LoopBoundsCommand = Extract<DeckCommand, { kind: 'loop-bounds' }>;
type RunningLoop = Exclude<ActiveLoop, null>;
type Queued = NonNullable<Parameters<SidPlayer['queueJump']>[0]>;

/** A tune frame rounded and bounded as the engine rounds a seek's, so a frame is the same one wherever it is kept. */
export function tuneFrameOf(frame: number): number {
  return Math.min(Math.max(0, Math.round(frame)), MAX_TUNE_FRAME);
}

/** What a deck asks of the part of it that holds the loops. */
export interface LoopsHost {
  /** Waits for `tuneFrame`, declared beside the host's targets, on behalf of log entry `seq`; replaces any wait. */
  wait(tuneFrame: number, seq: number, target: JumpTarget, settings: JumpSettings | null): void;
  /** Drops the wait, and the landing fixed for it. */
  stopWaiting(): void;
  /** The engine handed off to the queued `target` in the tick that rendered stream frame `frame`. */
  jumpLanded(frame: number, target: JumpTarget): void;
  warn(message: string): void;
}

/** The engine's loop for `target`: a loop's bounds, wrapping or stopping varispeed; null for a cue. */
function loopOf(target: JumpTarget): ActiveLoop {
  if (target.endFrame === null) return null;
  return {
    startFrame: frames(target.startFrame),
    endFrame: frames(target.endFrame),
    varispeedStart: target.wraps === true ? 'wrap' : 'stop',
    ...(target.lapPhase === undefined ? {} : { lapPhase: target.lapPhase }),
  };
}

function queuedOf(target: JumpTarget, settings: JumpSettings | null): Queued {
  const loop = loopOf(target);
  const base: QueuedJump =
    loop === null ? { startFrame: frames(target.startFrame), endFrame: null } : loop;
  return settings === null ? base : { ...base, settings };
}

function sameTarget(held: JumpTarget | null, target: JumpTarget): boolean {
  return (
    held !== null && held.startFrame === target.startFrame && held.endFrame === target.endFrame
  );
}

function sameBounds(loop: RunningLoop, target: JumpTarget): boolean {
  return loop.startFrame === target.startFrame && loop.endFrame === target.endFrame;
}

/** A loop too short for the engine to run is ignored by it, which would leave the deck believing in a loop never set. */
function canRun(target: JumpTarget): boolean {
  return target.endFrame === null || isUsableLoopLength(target.startFrame, target.endFrame);
}

/**
 * The loops a deck plays, between ticks: jumps that land now, at the end of the pass or when their
 * target is ready, the four-way key press, letting go, edits to the running loop and the loop's own
 * settings. The engine holds the loop itself; this holds what the engine does not say (the target
 * queued and what it carries, the change named, whose settings are in play) in `DeckState`, so a
 * rewind puts it back with the engine. It tells slip where a loop begins, lands and ends.
 *
 * A live loop counts as a loop running: a key queues behind it and a jump lands at its end of pass,
 * ending it. The loop under a live loop is kept in `DeckState` with its queue and pending change,
 * and an edit to it waits.
 *
 * Every engine call here is made between ticks and from a command that lands through the log. A
 * landing the engine makes inside a tick is learnt afterwards, from the hand-offs it counts.
 */
export class DeckLoops {
  /** How the last `key` resolved. */
  resolved = RESOLVED_NONE;

  constructor(
    private readonly player: SidPlayer,
    private readonly state: DeckState,
    private readonly host: LoopsHost,
    private readonly slip: DeckSlip,
  ) {}

  /**
   * What a `key` on `target` does, from the deck's state alone, so a replay at the same frame
   * resolves the same way: the running loop lets go, a target already queued or waiting is
   * cancelled, any other queues while a loop runs, and otherwise it starts.
   */
  resolve(target: JumpTarget): number {
    const loop = this.player.getSnapshot().loop;
    if (loop !== null && target.endFrame !== null && sameBounds(loop, target)) {
      return RESOLVED_LET_GO;
    }
    if (sameTarget(this.state.queued, target) || sameTarget(this.state.waiting, target)) {
      return RESOLVED_CANCEL;
    }
    return loop === null ? RESOLVED_START : RESOLVED_QUEUE;
  }

  /**
   * Jumps to `target`: now, or, as a `pass-end` entry that found a loop running at its `from`
   * frame, queued in the engine to land at that loop's next wrap. Returns whether it ended the
   * running loop.
   */
  jump(entry: LogEntry, target: JumpTarget): boolean {
    if (entry.passEnd && entry.loopAtFrom === LOOP_YES && this.player.getSnapshot().loop !== null) {
      this.queue(target);
      return false;
    }
    return this.start(entry, target);
  }

  /** A hot-key press, resolved at its landing frame. Returns whether it ended the running loop. */
  key(entry: LogEntry, target: JumpTarget): boolean {
    const resolved = this.resolve(target);
    this.resolved = resolved;
    switch (resolved) {
      case RESOLVED_LET_GO:
        return this.letGo();
      case RESOLVED_CANCEL:
        if (sameTarget(this.state.queued, target)) this.dropQueue();
        if (sameTarget(this.state.waiting, target)) this.host.stopWaiting();
        this.slip.cancelQueued();
        return false;
      case RESOLVED_QUEUE:
        this.queue(target);
        return false;
      default:
        return this.start(entry, target);
    }
  }

  /** Drops the queued target and the waiting jump. */
  cancelQueued(): void {
    if (this.state.queued !== null) this.dropQueue();
    if (this.state.waiting !== null) this.host.stopWaiting();
    this.slip.cancelQueued();
  }

  /**
   * Stops everything looping and plays straight on: with slip on, the deck lands on the outermost
   * departure's line first, unless that is the hand's. It lands before the live loop is dropped,
   * which ends the live loop's own departure with no landing.
   */
  stopLoop(): void {
    this.slip.landOutermost();
    this.dropLive();
    this.letGo();
  }

  /**
   * The DJ lets go of the running loop: with slip on and the loop a departure, the deck lands on
   * the count slip kept first, then the loop is released as `drop` does. Returns whether a loop
   * was running. A live loop is dropped with no landing: only `live-loop-end` and `stop-loop` land
   * one.
   */
  letGo(): boolean {
    this.slip.land('loop');
    return this.drop();
  }

  /**
   * Releases the running loop and the target queued behind it, and puts the main settings back on
   * this frame, with no slip landing (a stop, a seek or a load abandon slip themselves). The queue
   * goes because with no loop there is no end of pass for it to land at, and the engine ignores
   * one. A waiting target stays. Returns whether a loop was running.
   */
  drop(): boolean {
    const player = this.player;
    const state = this.state;
    this.dropLive();
    const looping = player.getSnapshot().loop !== null;
    if (looping || state.queued !== null) {
      player.setActiveLoop(null);
      player.queueJump(null);
    }
    state.queued = null;
    state.queuedSettings = null;
    state.pending = null;
    this.releaseSettings();
    return looping;
  }

  /**
   * Gives the running loop new bounds from the end of the lap in progress. No end lets it go at
   * once; the bounds already playing cancel a change still pending. Under a live loop the edit is the
   * loop underneath's and waits for it. Returns whether it ended the loop.
   */
  loopBounds(entry: LogEntry, command: LoopBoundsCommand): boolean {
    const end = command.endFrame;
    if (this.state.liveOn) {
      this.editUnderneath(command);
      return false;
    }
    if (end === null) return this.letGo();
    const player = this.player;
    const state = this.state;
    const loop = player.getSnapshot().loop;
    // With no loop there is nothing to change. Only the engine's own answer is kept as a first
    // answer: whether a loop runs is the deck's to derive again at every frame it is applied on.
    if (loop === null) return false;
    if (
      loop.startFrame === command.startFrame &&
      loop.endFrame === end &&
      loop.lapPhase === command.lapPhase
    ) {
      if (state.pending !== null) {
        player.setActiveLoop(loop);
        state.pending = null;
        this.requeue();
      }
      return false;
    }
    if (entry.ready === ANSWER_NO) return false;
    const change: RunningLoop = {
      startFrame: frames(command.startFrame),
      endFrame: frames(end),
      ...(loop.varispeedStart === undefined ? {} : { varispeedStart: loop.varispeedStart }),
      ...(command.lapPhase === undefined ? {} : { lapPhase: command.lapPhase }),
    };
    const named = player.changeLoopAt(loop.endFrame, change);
    if (entry.ready === ANSWER_UNASKED) {
      entry.ready = named ? ANSWER_YES : ANSWER_NO;
      if (!named)
        this.host.warn(`kept its loop: the engine took no change to ${command.startFrame}-${end}`);
    }
    if (named) state.pending = change;
    return false;
  }

  /**
   * Sets whether a thrown or scrubbed record wraps round the running loop. Setting the loop again
   * keeps the lap in progress and drops the queue and the change, so both are named again.
   */
  loopWraps(wraps: boolean): void {
    const varispeedStart = wraps ? 'wrap' : 'stop';
    if (this.state.liveOn) {
      this.rewrapUnderneath(varispeedStart);
      return;
    }
    const loop = this.player.getSnapshot().loop;
    if (loop === null) return;
    if ((loop.varispeedStart ?? 'stop') === varispeedStart) return;
    const pending = this.state.pending;
    this.player.setActiveLoop({ ...loop, varispeedStart });
    this.requeue();
    if (pending === null) return;
    const renamed: RunningLoop = { ...pending, varispeedStart };
    const named = this.player.changeLoopAt(loop.endFrame, renamed);
    this.state.pending = named ? renamed : null;
    if (!named) this.host.warn('lost the loop change it had named: the engine took it no more');
  }

  /** A main setting changes the loop's own while those play, and the main ones otherwise. */
  setSetting(voice: number, muted: boolean): void {
    const state = this.state;
    if (state.ownInPlay) {
      state.setLoopMuted(voice, muted);
    } else {
      state.setMuted(voice, muted);
    }
    this.player.setVoiceMuted(voice, muted);
    if (!state.ownInPlay) this.refreshCarried();
  }

  /**
   * Lands `target`, whose image is ready: the loop, the playhead and the settings it carries.
   * Returns whether it replaced a running loop. An image a later declaration has since withdrawn
   * would be replayed off the frame path, whose landing time would depend on the worker: the jump
   * is ignored instead.
   */
  land(target: JumpTarget, settings: JumpSettings | null): boolean {
    if (!this.isReady(target)) {
      this.host.warn(`ignored a jump to ${target.startFrame}: its image is not held`);
      return false;
    }
    const looping = this.player.getSnapshot().loop !== null;
    const isLoop = target.endFrame !== null;
    // The jump replaces the live loop and the loop underneath; slip's count goes on as the loop's.
    this.state.clearLive();
    if (isLoop) this.slip.begin('loop');
    this.player.setActiveLoop(loopOf(target));
    this.state.queued = null;
    this.state.queuedSettings = null;
    this.state.pending = null;
    this.swapIn(target, settings);
    this.seek(target, settings);
    if (isLoop) this.slip.loopLanded();
    else this.slip.cueLanded();
    return looping;
  }

  /**
   * The tick of stream frame `frame` showed a hand-off: the queued target is running now, with the
   * settings it carried. The engine drops a loop change the hand-off lands in the place of.
   */
  handedOff(frame: number): void {
    const state = this.state;
    state.pending = null;
    const target = state.queued;
    if (target === null) return;
    const settings = state.queuedSettings;
    state.clearLive();
    state.queued = null;
    state.queuedSettings = null;
    this.swapIn(target, settings);
    if (target.endFrame === null) this.slip.cueLanded();
    else this.slip.loopLanded();
    this.host.jumpLanded(frame, target);
  }

  /**
   * Ends the live loop's record and the loop underneath with it, and slip's live-loop departure with
   * no landing. The engine's loop is the caller's: `drop` clears it. Nothing with no live loop.
   */
  dropLive(): void {
    const state = this.state;
    const live = state.liveOn;
    state.clearLive();
    if (live) this.slip.release('live-loop');
  }

  /**
   * The running live loop becomes the running loop with no return: nothing underneath is put back,
   * the engine and the sound are untouched, and slip's count carries on as the loop's.
   */
  adoptLive(): void {
    if (!this.state.liveOn) return;
    this.state.clearLive();
    this.slip.loopLanded();
  }

  /** The engine drops the queue whenever the loop is set again, so a caller that does so names it again. */
  requeue(): void {
    const queued = this.state.queued;
    if (queued !== null) this.player.queueJump(queuedOf(queued, this.state.queuedSettings));
  }

  /**
   * Puts the loop underneath back in the engine as it was, the live loop's engine loop replaced:
   * its queued target named again and its pending bounds from the end of the lap in progress. It
   * starts again from its own lap 0. Whether the engine took the change is the entry's first
   * answer; with no entry it is asked. The record of the loop underneath stays for the caller to
   * clear.
   */
  resumeUnderneath(entry: LogEntry | null): void {
    const state = this.state;
    const loop = state.underneath;
    if (loop === null) return;
    this.player.setActiveLoop(loop);
    this.requeue();
    const pending = state.pending;
    if (pending === null) return;
    if (entry !== null && entry.ready === ANSWER_NO) {
      state.pending = null;
      return;
    }
    const named = this.player.changeLoopAt(loop.endFrame, pending);
    if (entry !== null && entry.ready === ANSWER_UNASKED) {
      entry.ready = named ? ANSWER_YES : ANSWER_NO;
    }
    if (!named) {
      state.pending = null;
      this.host.warn('lost the loop change it had named: the engine took it no more');
    }
  }

  /** With no loop left to wrap at, the target queued behind it is jumped to now. */
  engageQueued(entry: LogEntry): void {
    const state = this.state;
    const queued = state.queued;
    if (queued === null) return;
    state.queued = null;
    state.queuedSettings = null;
    this.start(entry, queued);
  }

  /** The loop change the engine was holding has landed: the bounds it named are the bounds playing. */
  changeLanded(): void {
    this.state.pending = null;
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * Jumps to `target` now: the playhead lands on the frame after this one with the settings it
   * carries. A target already running as the loop restarts from its start with `seek` alone, which
   * keeps a target queued behind it; any other replaces the loop, and with it the queue. A target
   * whose image is not ready waits, and the loop keeps running meanwhile.
   */
  private start(entry: LogEntry, target: JumpTarget): boolean {
    if (!this.runnable(target)) return false;
    const loop = this.player.getSnapshot().loop;
    const settings = this.carriedBy(target);
    if (loop !== null && target.endFrame !== null && sameBounds(loop, target)) {
      this.adoptLive();
      this.slip.begin('loop');
      this.swapIn(target, settings);
      this.seek(target, settings);
      return false;
    }
    if (entry.ready === ANSWER_UNASKED) {
      entry.ready = this.isReady(target) ? ANSWER_YES : ANSWER_NO;
    }
    if (entry.ready === ANSWER_YES) return this.land(target, settings);
    if (this.state.queued !== null) this.dropQueue();
    if (target.endFrame !== null) this.slip.begin('loop', true);
    this.host.wait(tuneFrameOf(target.startFrame), entry.seq, target, settings);
    return false;
  }

  /** An edit to the loop underneath a live loop: held as pending, or the loop itself let go. */
  private editUnderneath(command: LoopBoundsCommand): void {
    const state = this.state;
    const loop = state.underneath;
    if (loop === null) return;
    const end = command.endFrame;
    if (end === null) {
      state.underneath = null;
      state.pending = null;
      return;
    }
    if (
      loop.startFrame === command.startFrame &&
      loop.endFrame === end &&
      loop.lapPhase === command.lapPhase
    ) {
      state.pending = null;
      return;
    }
    state.pending = {
      startFrame: frames(command.startFrame),
      endFrame: frames(end),
      ...(loop.varispeedStart === undefined ? {} : { varispeedStart: loop.varispeedStart }),
      ...(command.lapPhase === undefined ? {} : { lapPhase: command.lapPhase }),
    };
  }

  /** Whether the loop underneath a live loop wraps a thrown record; its pending change follows. */
  private rewrapUnderneath(varispeedStart: 'wrap' | 'stop'): void {
    const state = this.state;
    const loop = state.underneath;
    if (loop === null || (loop.varispeedStart ?? 'stop') === varispeedStart) return;
    state.underneath = { ...loop, varispeedStart };
    if (state.pending !== null) state.pending = { ...state.pending, varispeedStart };
  }

  /** Queues `target` in the engine to land at the first wrap whose image is ready; replaces any queued. */
  private queue(target: JumpTarget): void {
    if (!this.runnable(target)) return;
    if (target.endFrame !== null) this.slip.begin('loop', true);
    this.queueInEngine(target, this.carriedBy(target));
  }

  private queueInEngine(target: JumpTarget, settings: JumpSettings | null): void {
    this.state.queued = target;
    this.state.queuedSettings = settings;
    this.player.queueJump(queuedOf(target, settings));
  }

  private dropQueue(): void {
    this.player.queueJump(null);
    this.state.queued = null;
    this.state.queuedSettings = null;
  }

  private seek(target: JumpTarget, settings: JumpSettings | null): void {
    void this.player.seek(frames(target.startFrame), settings ?? undefined);
  }

  private isReady(target: JumpTarget): boolean {
    const tune = this.player.getSnapshot().tune;
    return tune !== null && tune.preparedFrames.includes(frames(tuneFrameOf(target.startFrame)));
  }

  private runnable(target: JumpTarget): boolean {
    if (canRun(target)) return true;
    this.host.warn(`ignored a jump to ${target.startFrame}: its loop is too short to run`);
    return false;
  }

  /**
   * What a jump into `target` carries, built here and never at the landing: its own settings; the
   * main ones when it has none of its own and a loop's own are in play, which is how they come
   * back on the jump's frame; otherwise nothing.
   */
  private carriedBy(target: JumpTarget): JumpSettings | null {
    if (target.settings !== undefined) return { voiceMutes: mutesOfSettings(target.settings) };
    return this.state.ownInPlay ? { voiceMutes: mutesAsBooleans(this.state.mutes) } : null;
  }

  /**
   * Records the settings a landed `target` carried: the engine has applied them, so nothing is
   * applied again. Its own settings come into play with the main ones held aside; a target with
   * none of its own carried the main ones back.
   */
  private swapIn(target: JumpTarget, settings: JumpSettings | null): void {
    const state = this.state;
    if (target.settings !== undefined) {
      for (let voice = 0; voice < VOICE_COUNT; voice++) {
        state.setLoopMuted(voice, settings?.voiceMutes?.[voice] === true);
      }
      state.ownInPlay = true;
    } else {
      state.ownInPlay = false;
    }
    this.refreshCarried();
  }

  /** Puts the main settings back, on this frame, when a loop's own are in play. */
  private releaseSettings(): void {
    const state = this.state;
    if (!state.ownInPlay) return;
    state.ownInPlay = false;
    for (let voice = 0; voice < VOICE_COUNT; voice++) {
      this.player.setVoiceMuted(voice, state.muted(voice));
    }
    this.refreshCarried();
  }

  /**
   * Builds again what the queued and the waiting target carry when the main settings or whether a
   * loop's own are in play moved under them, so each lands with what is true then. A queued target
   * is named to the engine again, which replaces it.
   */
  private refreshCarried(): void {
    const state = this.state;
    const queued = state.queued;
    if (queued !== null && this.stale(queued, state.queuedSettings)) {
      this.queueInEngine(queued, this.carriedBy(queued));
    }
    const waiting = state.waiting;
    if (waiting !== null && this.stale(waiting, state.waitingSettings)) {
      state.waitingSettings = this.carriedBy(waiting);
    }
  }

  /** Whether `held` is not what a jump into `target` would carry now. A target's own settings never move. */
  private stale(target: JumpTarget, held: JumpSettings | null): boolean {
    if (target.settings !== undefined) return false;
    const state = this.state;
    if (!state.ownInPlay) return held !== null;
    if (held === null) return true;
    for (let voice = 0; voice < VOICE_COUNT; voice++) {
      if ((held.voiceMutes?.[voice] === true) !== state.muted(voice)) return true;
    }
    return false;
  }
}
