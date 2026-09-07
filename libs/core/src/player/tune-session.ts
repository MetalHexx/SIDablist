import { createC64Machine } from '../cpu/c64-machine.js';
import type { C64Machine, MachineSnapshot } from '../cpu/c64-machine.js';
import { createRegisterFrame } from '../registers/register-frame.js';
import type { RegisterFrame, RegisterValuesSnapshot } from '../registers/register-frame.js';
import type { SidFile } from '../sid/sid-file.model.js';
import type { ReplayRequest, ReplayResponse, ReplayRunner } from '../replay/replay-runner.js';
import type { ReplayResult } from '../replay/replay-to-frame.js';
import { clamp } from '../common/math.js';
import { describeError } from '../common/errors.js';
import { playCallsPerSecond } from '../clock/play-rate.js';
import type { PlayRate } from '../clock/play-rate.js';
import { frames, type Frames } from '../units.js';

/** The assumed length the scrub and playhead percentages are measured against — not the tune's real,
 * unmeasured length. A single tunable constant, not derived from anything about the file. */
export const JUMP_CEILING_SECONDS = 300;

/**
 * What `TuneSession` needs from the coordinator: the tune's configured rate, the mutes to seed a
 * jump's replay with, the handful of coordinator-owned effects a load/subtune/jump can trigger
 * (clearing the error state, queueing a resync, re-resolving the clock interval, recording an
 * anchor), and the store this session's own fields feed. Taking these as callbacks is what lets this
 * module own the machine/frame/position triple without importing the coordinator that also reads
 * them.
 */
export interface TuneSessionHost {
  nominalIntervalUs(): number;
  /** The rate in force — mirrors `machineRates()`, never a direct read of
   *  `machine.exactCallsPerFrame`/`callsPerFrame`, so `ceilingFrames` stays current after a subtune
   *  init that leaves the nominal interval unchanged. */
  playRate(): PlayRate;
  /** Mirrors `machine`'s two rates into whatever the coordinator reads `playRate()` from — the CIA
   *  latch is only meaningful once init has run, so this is called from `initSubtune`, not from
   *  `load`. */
  syncPlayRate(machine: C64Machine | null): void;
  effectiveMutes(): readonly boolean[];
  /** Clears the engine's error state — the tell that a subtune init succeeded. */
  clearError(): void;
  /** Marks the engine's failure state and logs why. */
  fail(reason: string): void;
  /** Queues the chip resync a restore owes the stream. */
  queueResync(): void;
  /** Drops the marker state's anchor ring — its entries describe a machine a subtune re-init has
   *  just invalidated. */
  resetAnchors(): void;
  /** Seeds the marker state's anchor ring with the freshly re-initialised machine. */
  recordAnchor(machine: C64Machine, frame: RegisterFrame, framesRendered: Frames): void;
  /** Re-resolves the clock's tick rate — a subtune can carry its own multispeed. */
  applyIntervalChange(): void;
  /** Tells the read-side store that a field this session owns — `currentSubtune`, `subtuneCount`, or
   *  the indexed length behind `positionBasisFrames` — has changed, so the next snapshot reflects it.
   *  Stands in for the Angular signals those fields used to carry directly. */
  markDirty(): void;
}

/** A usable frame span: a finite number greater than zero, else null. Mirrors the private helper
 *  `TrackStructure` keeps for its own loop period — the two are derived from different records but
 *  must agree on what counts as usable. */
function sanitizePositiveFrame(value: Frames | null): Frames | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Owns the loaded tune, the live `C64Machine`/`RegisterFrame` pair it plays through, the position
 * counter, and the off-thread replay a scrub or a cue hands to the worker.
 */
export interface TuneSession {
  readonly currentSubtune: number;
  readonly subtuneCount: number;

  /** Frames in the fixed jump ceiling at the current nominal interval and play rate: seconds of
   *  music times play calls per second, so a callsPerFrame 2 tune gets twice the frame count of the
   *  same nominal interval at callsPerFrame 1 — the same 300 seconds of music either way. Recomputed
   *  on every read rather than cached, so it can never go stale behind a rate change. */
  readonly ceilingFrames: Frames;

  /** What a position percentage is measured against, in both directions. Recomputed on every read
   *  rather than snapshotted at load time, so a record landing mid-play moves the playhead's meaning
   *  on the next read with no further wiring. */
  readonly positionBasisFrames: Frames;

  readonly file: SidFile | null;
  readonly machine: C64Machine | null;
  readonly frame: RegisterFrame | null;
  framesRendered: Frames;

  /** Rebuilds the machine and register frame for `file`. Does not initialise a subtune — the
   *  coordinator calls `initSubtune()` once it has decided what else a fresh load resets. */
  load(file: SidFile): void;

  /** Zeroes the position counter — what a fresh play run or a fresh load starts from. */
  resetPosition(): void;

  /** Stores the tune-index's measured length as the position basis. Anything that is not a finite
   *  number greater than zero is stored as null instead — a zero or negative basis would divide the
   *  playhead by nothing — which makes `positionBasisFrames` fall back to `ceilingFrames`. */
  setIndexedLengthFrames(lengthFrames: Frames | null): void;

  /** Re-inits the machine and marks every register dirty, so the chip cannot inherit the old state. */
  initSubtune(song: number): boolean;

  /** Moves to `song`, clamped to the tune's range. A no-op when it is already the current one, so a
   *  caller can hand it whatever the operator asked for without checking first. */
  selectSubtune(song: number): void;

  /** Moves to the next subtune, clamped to the tune's range. */
  nextSubtune(): void;

  /** Moves to the previous subtune, clamped to the tune's range. */
  previousSubtune(): void;

  /**
   * Asks for `percent` of `positionBasisFrames`. The position does not move as soon as this returns
   * — the replay runs off this thread and lands a moment later, and a second scrub issued in the
   * meantime supersedes this one. The returned promise resolves once this request has settled —
   * landed, failed, or been superseded/discarded.
   */
  scrubTo(percent: number): Promise<void>;

  /**
   * The shared silent-replay primitive: hands the rebuild to the replay runner and returns at once,
   * so the frame clock keeps ticking and a frame still goes out on every tick while the replay
   * runs. The landing happens later, off-thread.
   *
   * Only the newest request may land. A response carrying any other id is dropped — a second jump
   * supersedes the first rather than queueing behind it.
   */
  jumpToFrame(targetFrame: Frames): Promise<void>;

  /**
   * Replays off-thread to `targetFrame` and hands the result back instead of adopting it onto the
   * live pair. Shares the jump's runner but none of its outstanding-id gating: nothing about the live
   * machine changes, so a scrub in flight is neither superseded by this nor supersedes it.
   *
   * Null with no file loaded, or when the replay could not complete — the caller is asking for an
   * image it can do without, so a failure degrades rather than failing the engine.
   */
  replayImage(targetFrame: Frames): Promise<ReplayResult | null>;

  /**
   * Puts an image back onto the live pair: restore, adopt its frame number, resync. Shared by a cue
   * or loop re-entry (via `MarkerHost.restoreState`) and by a landing jump.
   *
   * No emulation, so the main thread never stalls and the frame clock keeps ticking straight
   * through. That stall is what made a deep cue hop — and a loop with a deep entry — hold its last
   * note: with the thread blocked, no packets went out and the SID simply kept sounding whatever it
   * was last told.
   */
  restoreState(
    machine: MachineSnapshot,
    registers: RegisterValuesSnapshot,
    frameNumber: Frames,
  ): void;

  /** Drops whatever jump is in flight, so its result is discarded rather than applied. */
  discardOutstandingJump(): void;

  /** Releases the replay thread — nothing else holds the runner, and it outlives this session
   *  otherwise. */
  dispose(): void;
}

/** Builds a `TuneSession` over `replayRunner`, coordinated through `host`. */
export function createTuneSession(replayRunner: ReplayRunner, host: TuneSessionHost): TuneSession {
  return new TuneSessionImpl(replayRunner, host);
}

/** Rebuilds the machine and frame on every `load()`, exactly as the engine did before the split —
 *  this class is the one place that constructs them. */
class TuneSessionImpl implements TuneSession {
  constructor(
    private readonly replayRunner: ReplayRunner,
    private readonly host: TuneSessionHost,
  ) {}

  private _currentSubtune = 1;
  private _subtuneCount = 1;

  get currentSubtune(): number {
    return this._currentSubtune;
  }

  get subtuneCount(): number {
    return this._subtuneCount;
  }

  get ceilingFrames(): Frames {
    return frames(
      Math.round(
        JUMP_CEILING_SECONDS *
          playCallsPerSecond(this.host.nominalIntervalUs(), this.host.playRate()),
      ),
    );
  }

  private _indexedLengthFrames: Frames | null = null;

  get positionBasisFrames(): Frames {
    return this._indexedLengthFrames ?? this.ceilingFrames;
  }

  private _file: SidFile | null = null;
  private _machine: C64Machine | null = null;
  private _frame: RegisterFrame | null = null;
  private _framesRendered: Frames = frames(0);
  /** Stamped onto every request this session hands the runner, so responses can be told apart by age.
   *  Shared with `replayImage` rather than counted separately: the runner is one shared worker, and
   *  two counters could stamp two live requests with the same id. */
  private jumpRequestId = 0;
  /**
   * The id of the only jump whose result may still be applied, or null when none may.
   *
   * A replay runs off-thread while playback carries on, so a result can arrive after the operator
   * has already asked for another position — or after a stop, a tune load or a subtune change made
   * the answer describe a machine this session no longer has. Anything that does not match is
   * dropped without a trace of it reaching the stream.
   */
  private outstandingJumpId: number | null = null;

  get file(): SidFile | null {
    return this._file;
  }

  get machine(): C64Machine | null {
    return this._machine;
  }

  get frame(): RegisterFrame | null {
    return this._frame;
  }

  get framesRendered(): Frames {
    return this._framesRendered;
  }

  set framesRendered(value: Frames) {
    this._framesRendered = value;
  }

  load(file: SidFile): void {
    this._file = file;
    this._frame = createRegisterFrame();
    this._machine = createC64Machine(file, this._frame);
    this._subtuneCount = Math.max(1, file.songs);
    // The outgoing tune's rate must not survive into this one — initSubtune() re-syncs it once the
    // incoming tune's own init has run.
    this.host.syncPlayRate(null);
    this.host.markDirty();
  }

  resetPosition(): void {
    this._framesRendered = frames(0);
  }

  setIndexedLengthFrames(lengthFrames: Frames | null): void {
    this._indexedLengthFrames = sanitizePositiveFrame(lengthFrames);
    this.host.markDirty();
  }

  initSubtune(song: number): boolean {
    const machine = this._machine;
    const frame = this._frame;
    if (machine === null || frame === null) {
      return false;
    }

    const clamped = clamp(song, 1, this._subtuneCount);
    try {
      const result = machine.initSubtune(clamped);
      if (!result.completed) {
        console.warn(
          `DJ engine: subtune ${clamped} init ran out of cycles (${result.cyclesUsed}) — playing it anyway.`,
        );
      }
    } catch (error) {
      this.host.fail(`subtune ${clamped} could not be initialised — ${describeError(error)}`);
      return false;
    }

    frame.markAllDirty();
    this._framesRendered = frames(0);
    // The ring is dropped rather than carried: its entries describe a machine that no longer exists,
    // at frame numbers the reset counter has just invalidated. Marker cues and marker loop starts
    // survive this deliberately — each owns its own anchor, so none of them needs the ring to
    // persist.
    this.host.resetAnchors();
    this.host.recordAnchor(machine, frame, this._framesRendered);
    // Init just ran, so this is the moment the CIA latch becomes meaningful — mirroring it any
    // earlier would read a rate the tune hasn't actually programmed yet.
    this.host.syncPlayRate(machine);
    this._currentSubtune = clamped;
    this.host.clearError();
    this.host.markDirty();
    return true;
  }

  selectSubtune(song: number): void {
    if (this._machine === null) {
      return;
    }
    const clamped = clamp(song, 1, this._subtuneCount);
    if (clamped === this._currentSubtune) {
      return;
    }
    // A jump in flight was replaying the outgoing subtune, so its answer is about to be wrong.
    this.discardOutstandingJump();
    if (!this.initSubtune(clamped)) {
      return;
    }
    // The tick rate itself also has to be re-resolved.
    this.host.applyIntervalChange();
  }

  nextSubtune(): void {
    this.selectSubtune(this._currentSubtune + 1);
  }

  previousSubtune(): void {
    this.selectSubtune(this._currentSubtune - 1);
  }

  scrubTo(percent: number): Promise<void> {
    if (this._machine === null) return Promise.resolve();
    return this.jumpToFrame(this.frameForPercent(percent));
  }

  private frameForPercent(percent: number): Frames {
    const clamped = clamp(percent, 0, 100);
    return frames(Math.round((clamped / 100) * this.positionBasisFrames));
  }

  jumpToFrame(targetFrame: Frames): Promise<void> {
    const file = this._file;
    if (file === null || this._machine === null || this._frame === null) return Promise.resolve();

    const request: ReplayRequest = {
      id: ++this.jumpRequestId,
      file,
      subtune: this._currentSubtune,
      targetFrame,
      // The mutes as they stand now; `awaitJump` re-asserts whatever they have become by the time
      // the result lands.
      mutes: this.host.effectiveMutes(),
    };
    this.outstandingJumpId = request.id;
    return this.awaitJump(request);
  }

  async replayImage(targetFrame: Frames): Promise<ReplayResult | null> {
    const file = this._file;
    if (file === null) return null;

    const request: ReplayRequest = {
      id: ++this.jumpRequestId,
      file,
      subtune: this._currentSubtune,
      targetFrame,
      mutes: this.host.effectiveMutes(),
    };

    let response: ReplayResponse;
    try {
      response = await this.replayRunner.run(request);
    } catch (error) {
      response = {
        id: request.id,
        ok: false,
        error: `replay to frame ${targetFrame} failed — ${describeError(error)}`,
      };
    }

    if (!response.ok) {
      console.warn(`DJ engine: ${response.error}`);
      return null;
    }
    return response.result;
  }

  /** Waits out one replay request and applies its result if it is still the one being waited on. */
  private async awaitJump(request: ReplayRequest): Promise<void> {
    let response: ReplayResponse;
    try {
      response = await this.replayRunner.run(request);
    } catch (error) {
      response = {
        id: request.id,
        ok: false,
        error: `jump to frame ${request.targetFrame} failed during replay — ${describeError(error)}`,
      };
    }

    if (response.id !== this.outstandingJumpId) {
      return; // superseded, or discarded by a stop, a tune load or a subtune change
    }
    this.outstandingJumpId = null;

    if (!response.ok) {
      this.host.fail(response.error);
      return;
    }

    // The operator can move a mute while the replay is in flight, so what the request carried may
    // already be stale. This has to land before `restoreState` takes the resync snapshot:
    // `restoreValues` re-zeroes exactly the voices the live frame knows about at that moment.
    const mutes = this.host.effectiveMutes();
    for (let voice = 0; voice < 3; voice++) {
      this._frame?.setVoiceMuted(voice, mutes[voice]);
    }
    this.restoreState(response.result.machine, response.result.registers, response.result.frame);
  }

  restoreState(
    machine: MachineSnapshot,
    registers: RegisterValuesSnapshot,
    frameNumber: Frames,
  ): void {
    if (this._machine === null || this._frame === null) return;

    this._machine.restore(machine);
    this._frame.restoreValues(registers);
    this._framesRendered = frameNumber;
    this.host.queueResync();
  }

  discardOutstandingJump(): void {
    this.outstandingJumpId = null;
  }

  dispose(): void {
    this.replayRunner.dispose();
  }
}
