import { describeError } from '../common/errors.js';
import {
  DEFAULT_TIMING_MODE,
  msToPlayCalls,
  playCallIntervalUs,
  playRateFor,
} from '../clock/play-rate.js';
import type { PlayRate, TimingMode } from '../clock/play-rate.js';
import type { C64Machine, FrameResult } from '../cpu/c64-machine.js';
import type { FrameClock } from '../ports/clock.js';
import type { SidSink } from '../ports/sink.js';
import { clockRatio } from '../registers/clock-ratio.js';
import { RegisterFrame } from '../registers/register-frame.js';
import type { ScaledRegisterGroup, SidFilterMode } from '../registers/register-frame.js';
import type { SidFrame } from '../registers/sid-frame.js';
import {
  NTSC_FRAME_INTERVAL_US,
  PAL_FRAME_INTERVAL_US,
  VOICE_CONTROL_REGISTERS,
  VOICE_COUNT,
} from '../registers/sid-constants.js';
import type { ReplayRunner } from '../replay/replay-runner.js';
import type { SidFile } from '../sid/sid-file.model.js';
import { createActiveLoopTracker } from '../timeline/active-loop.js';
import type { ActiveLoop, ActiveLoopTracker } from '../timeline/active-loop.js';
import { createAnchorRing } from '../timeline/anchor-ring.js';
import type { AnchorRing, PositionAnchor } from '../timeline/anchor-ring.js';
import { createTrackStructure } from '../timeline/track-structure.js';
import type { DetectedLoopFrames, TrackStructure } from '../timeline/track-structure.js';
import { frames, microseconds, milliseconds } from '../units.js';
import type { Frames, Microseconds, Milliseconds } from '../units.js';
import type { SidPlayer } from './sid-player.js';
import type { PlayerSnapshot, PlayerStats } from './snapshot.js';
import { createPlayerSnapshotStore } from './store.js';
import type { PlayerSnapshotStore } from './store.js';
import { createTuneSession } from './tune-session.js';
import type { TuneSession } from './tune-session.js';

/**
 * The widest backward walk a seek target can carry, in real time — what the anchor ring is spaced
 * against. Held in milliseconds rather than frames so the reach is the same wall-clock span on a
 * 1x tune and on a 2x-multispeed one.
 */
const SEEK_REACH_MS = milliseconds(1000);

/** Microseconds in a millisecond — the lag measurements below read a µs interval as one. */
const MICROSECONDS_PER_MILLISECOND = 1000;

/** What a player is built around: the far end it streams to, the cadence it rides, and the thread a
 *  jump replays on. Every one of them is injected — core constructs none of them. */
export interface SidPlayerCollaborators {
  readonly sink: SidSink;
  readonly clock: FrameClock;
  readonly replayRunner: ReplayRunner;
}

/**
 * Builds a player over `collaborators`. The coordinator class behind it is deliberately unexported:
 * a consumer holds the `SidPlayer` contract and nothing else, so no amount of casting reaches the
 * tune session, the anchor ring or the counters it sequences.
 */
export function createSidPlayer(collaborators: SidPlayerCollaborators): SidPlayer {
  return new SidPlayerCoordinator(collaborators);
}

/**
 * The timeline authority: it owns the tick loop, the transport state machine, tempo, the voices and
 * the delivery measurements, and sequences three collaborators for everything else — `TuneSession`
 * (the loaded tune, its machine/frame pair and the off-thread jump), the timeline modules (anchor
 * ring, track structure, active loop) and the snapshot store that publishes the read side.
 *
 * The measurement/scheduling split runs through `deliver` below: core knows the due time it computed
 * and the moment it handed the frame over, so lag, late frames, reorders and clamped advances are
 * its to count. Packets, bytes, cancel support and in-flight depth are the sink's, and reach a
 * consumer through `getStats().sink` rather than being recounted here.
 */
class SidPlayerCoordinator implements SidPlayer {
  private readonly sink: SidSink;
  private readonly clock: FrameClock;
  private readonly session: TuneSession;
  private readonly store: PlayerSnapshotStore;

  private readonly ring: AnchorRing = createAnchorRing(() => this.seekReachFrames());
  private readonly track: TrackStructure = createTrackStructure();
  private readonly activeLoop: ActiveLoopTracker = createActiveLoopTracker();

  /** The scratch frame every gate-off is built on. Never the live frame: that one mirrors the
   *  emulated chip and is what a resume restores from. */
  private readonly gateOff = new RegisterFrame();

  private transport: PlayerSnapshot['transport'] = 'stopped';
  private error: string | null = null;

  private tempoMultiplier = 1;
  private nominalIntervalUs: Microseconds = microseconds(PAL_FRAME_INTERVAL_US);
  private timingMode: TimingMode = DEFAULT_TIMING_MODE;
  /** The machine's two rates, mirrored on every subtune init — the CIA latch is only meaningful once
   *  init has run, so this cannot be read at load time. */
  private machineRates: { readonly exact: number; readonly rounded: number } = {
    exact: 1,
    rounded: 1,
  };
  /** What the clock was last handed, or null before it has ever started — the rate diagnostics
   *  report, rather than one derived from a fader that may have moved while stopped. */
  private runningIntervalUs: Microseconds | null = null;

  private readonly mutedVoices = [false, false, false];
  private readonly heldVoices = [false, false, false];

  /** Held so a fresh `RegisterFrame` built by `loadTune` inherits them — otherwise every tune load
   *  would silently reset the deck to full, at home, with the tune's own filter bits. */
  private outputGain = 1;
  private readonly registerScales = new Map<ScaledRegisterGroup, number>();
  private filterMode: SidFilterMode | null = null;

  /** The clock pair rather than the ratio it derives, because a fresh `RegisterFrame` is handed the
   *  pair. Null until the application — the only thing that knows what machine is on the far end —
   *  names one. */
  private clockCorrection: { readonly sourceHz: number; readonly targetHz: number } | null = null;
  private readonly voicePitch = [1, 1, 1];

  /** The one step a landed jump still owes the stream: a gate-off frame the next tick releases,
   *  leaving the resync — already armed on the live frame by `markAllDirty` — to ride the tick after
   *  it. Riding the clock is what gives each of them a frame slot and a due time of its own; sent
   *  between ticks they would share one slot and the release window would collapse. */
  private gateOffOwed = false;

  /** The image the track's own loop re-enters through, captured off-thread. Held here as well as in
   *  the tracker so a performer's loop can take the entry image away and give it back without a
   *  fresh replay. */
  private trackLoopEntry: PositionAnchor | null = null;

  private scheduledFrames = 0;
  private lateFrames = 0;
  private sumLagMs = 0;
  private worstLagMs = 0;
  private reorderedFrames = 0;
  private clampedFrames = 0;
  /** The previous frame's due time, so `record` can spot an inversion. Null before the first frame
   *  of a run — there is nothing yet to be earlier than. */
  private lastDueAtMs: Milliseconds | null = null;

  constructor(collaborators: SidPlayerCollaborators) {
    this.sink = collaborators.sink;
    this.clock = collaborators.clock;
    this.session = createTuneSession(collaborators.replayRunner, {
      nominalIntervalUs: () => this.nominalIntervalUs,
      playRate: () => this.playRate(),
      syncPlayRate: (machine) => {
        const rate = playRateFor(machine, this.timingMode);
        this.machineRates = {
          exact: rate.exactCallsPerFrame,
          rounded: rate.roundedCallsPerFrame,
        };
      },
      effectiveMutes: () => this.effectiveMutes(),
      clearError: () => {
        this.error = null;
      },
      fail: (reason) => this.fail(reason),
      queueResync: () => this.queueResync(),
      resetAnchors: () => this.ring.reset(),
      recordAnchor: (machine, frame, framesRendered) =>
        this.ring.record(machine, frame, framesRendered),
      applyIntervalChange: () => this.applyIntervalChange(),
      markDirty: () => this.markDirty(),
    });
    this.store = createPlayerSnapshotStore(this.buildSnapshot());
  }

  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener);
  }

  getSnapshot(): PlayerSnapshot {
    return this.store.getSnapshot();
  }

  getPosition(): Frames {
    return this.session.framesRendered;
  }

  getStats(): PlayerStats {
    return {
      framesRendered: this.session.framesRendered,
      clock: this.clock.stats,
      effectiveIntervalUs: this.reportedIntervalUs(),
      delivery: {
        scheduledFrames: this.scheduledFrames,
        lateFrames: this.lateFrames,
        meanLagMs: milliseconds(
          this.scheduledFrames === 0 ? 0 : this.sumLagMs / this.scheduledFrames,
        ),
        worstLagMs: milliseconds(this.worstLagMs),
        reorderedFrames: this.reorderedFrames,
        clampedFrames: this.clampedFrames,
      },
      sink: { farEnd: this.sink.readAt(), capabilities: this.sink.capabilities },
      suppressedWrites: this.session.frame?.suppressedWriteCount ?? 0,
      illegalOpcodeCount: this.session.machine?.illegalOpcodeCount ?? 0,
    };
  }

  /** Rebuilds the machine and register frame for `file` and initialises its start subtune. */
  loadTune(file: SidFile): void {
    if (this.transport === 'playing' || this.transport === 'paused') {
      this.clock.stop();
      this.sink.end();
    }
    // Whatever a jump is replaying describes the outgoing tune, not this one.
    this.session.discardOutstandingJump();
    this.session.load(file);

    // A fresh frame starts at full gain, every group at home, every voice at its own clock and pitch
    // and the tune's own filter bits, so every held control is re-applied here, before this load can
    // emit a packet at the wrong setting.
    const frame = this.session.frame;
    frame?.setOutputGain(this.outputGain);
    for (const [group, coefficient] of this.registerScales) {
      frame?.setRegisterScale(group, coefficient);
    }
    frame?.setFilterMode(this.filterMode);
    this.applyPitch();

    this.mutedVoices.fill(false);
    // A fresh frame starts fully unmuted, so a held button must not survive into a tune it was never
    // pressed against — `effectiveMutes` would disagree with the chip it just replaced.
    this.heldVoices.fill(false);
    this.nominalIntervalUs = microseconds(
      file.clock === 'ntsc' ? NTSC_FRAME_INTERVAL_US : PAL_FRAME_INTERVAL_US,
    );
    // The outgoing tune's mode was that tune's own; the application re-applies whatever detection
    // found for this one.
    this.timingMode = DEFAULT_TIMING_MODE;
    this.resetCounters();
    // The outgoing tune's detected structure describes a file this session no longer holds, and its
    // loop is measured in frames of it.
    this.setTrackStructure(null);
    this.setActiveLoop(null);

    if (this.session.initSubtune(file.startSong)) {
      this.transport = 'stopped';
    }
    this.markDirty();
  }

  /** Starts, or resumes, playback. */
  async play(): Promise<void> {
    const file = this.session.file;
    const frame = this.session.frame;
    if (file === null || frame === null) {
      this.fail('no tune is loaded');
      return;
    }
    if (this.transport === 'playing') {
      return;
    }

    if (this.transport === 'paused') {
      // Restore the chip to the emulated state rather than to whatever the pause gate-off left it
      // holding.
      frame.markAllDirty();
    } else {
      if (!this.session.initSubtune(this.session.currentSubtune)) {
        return;
      }
      this.resetCounters();
    }

    this.error = null;
    // The chip model is the tune header's, which is why core reads it and hands it over rather than
    // have the sink go looking.
    this.sink.begin({ chipModel: file.model });

    const intervalUs = this.effectiveIntervalUs();
    try {
      await this.clock.start(intervalUs, this.onTick);
    } catch (error) {
      // `begin` has already gone out, so the far end is waiting on a stream that will never start.
      this.sink.end();
      this.fail(`the frame clock could not start — ${describeError(error)}`);
      return;
    }
    this.runningIntervalUs = intervalUs;
    this.transport = 'playing';
    this.markDirty();
  }

  /** Stops the clock and gates every voice off, so a pause leaves silence rather than a held note. */
  pause(): void {
    if (this.transport !== 'playing') {
      return;
    }
    this.haltPlayback();
    // Immediate rather than scheduled: queued behind frames the sink still holds, the gate-off would
    // land after they had all played and the voices would ring on until then.
    this.sink.deliverNow(this.gateOffFrame());
    this.sink.end();
    this.transport = 'paused';
    this.markDirty();
  }

  /** Stops the clock, closes the far end, and re-initialises the machine. */
  stop(): void {
    this.haltPlayback();
    // Landing a jump still in flight would restart playback at a position nobody asked for, and the
    // re-init below invalidates whatever it was carrying anyway.
    this.session.discardOutstandingJump();
    this.transport = 'stopped';
    if (this.session.file !== null) {
      this.sink.end();
      this.session.initSubtune(this.session.currentSubtune);
    }
    this.markDirty();
  }

  /**
   * Asks for `frame`, which the replay reaches off this thread — the returned promise resolves once
   * the request has settled (landed, failed, or been superseded), not when it was issued.
   *
   * A target before the start of the tune resolves to frame 0 rather than erroring: a scrub dragged
   * off the left end of the bar is a gesture, not a fault.
   */
  seek(frame: Frames): Promise<void> {
    return this.session.jumpToFrame(frames(Math.max(0, Math.round(frame))));
  }

  selectSubtune(song: number): void {
    const before = this.session.currentSubtune;
    this.session.selectSubtune(song);
    if (this.session.currentSubtune === before) {
      return;
    }
    // The entry image describes a machine the re-init has just replaced.
    this.dropTrackLoopEntry();
    void this.captureTrackLoopEntry();
  }

  /** Routes through `selectSubtune` rather than `session.nextSubtune()` directly, so a step still
   *  drops and recaptures the track loop's entry image exactly as any other subtune change does. */
  nextSubtune(): void {
    this.selectSubtune(this.session.currentSubtune + 1);
  }

  previousSubtune(): void {
    this.selectSubtune(this.session.currentSubtune - 1);
  }

  setActiveLoop(loop: ActiveLoop): void {
    this.activeLoop.set(loop);
    // The entry image is the *track* loop's, taken at its own start frame, so it is only ever the
    // right way into a lap while no other loop is running.
    this.activeLoop.setEntryImage(loop === null ? this.trackLoopEntry : null);
    this.markDirty();
  }

  setTrackStructure(loop: DetectedLoopFrames | null): void {
    this.track.setTrackStructure(loop);
    // The track's end is the tune's measured length: what the playhead is drawn against, unless
    // detection answered nothing and the fixed ceiling stands in.
    this.session.setIndexedLengthFrames(this.track.trackEndFrame());
    this.dropTrackLoopEntry();
    this.markDirty();
    // Not awaited: nothing on this path needs the image, and playback cannot reach the loop's end
    // for a whole lap yet.
    void this.captureTrackLoopEntry();
  }

  setRepeatTrack(enabled: boolean): void {
    this.track.setRepeatEnabled(enabled);
    this.markDirty();
  }

  /** A divisor on the clock and nothing else, which is what makes a tempo change nearly free. The
   *  span a fader may reach is the application's to decide; core rejects only what it cannot divide
   *  by. */
  setTempo(multiplier: number): void {
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      console.warn(`SID player: ignoring a tempo multiplier of ${multiplier}.`);
      return;
    }
    this.tempoMultiplier = multiplier;
    this.applyIntervalChange();
  }

  setNominalIntervalUs(us: Microseconds): void {
    if (!Number.isFinite(us) || us <= 0) {
      console.warn(`SID player: ignoring a nominal interval of ${us} µs.`);
      return;
    }
    this.nominalIntervalUs = us;
    this.applyIntervalChange();
  }

  /** Sets the mode and re-resolves the clock — the only path that makes a mode change audible. */
  setTimingMode(mode: TimingMode): void {
    if (this.timingMode === mode) return;
    this.timingMode = mode;
    this.applyIntervalChange();
  }

  /**
   * Voice 0/1/2 — the latched state. Replicates the firmware's own hardware-mute technique: forces
   * that voice's control register to 0 once, then drops every further write the tune's code makes to
   * it until unmuted.
   */
  setVoiceMuted(voice: number, muted: boolean): void {
    if (voice < 0 || voice >= VOICE_COUNT) return;
    this.mutedVoices[voice] = muted;
    this.applyEffectiveMute(voice);
  }

  /** Voice 0/1/2 — the momentary state a press-and-hold button drives. Release always restores
   *  whatever the latched state says, even if it changed while held. */
  setVoiceHeld(voice: number, held: boolean): void {
    if (voice < 0 || voice >= VOICE_COUNT) return;
    this.heldVoices[voice] = held;
    this.applyEffectiveMute(voice);
  }

  /** Drops every latched mute without disturbing whichever voice is currently held. */
  clearVoiceMutes(): void {
    this.mutedVoices.fill(false);
    for (let voice = 0; voice < VOICE_COUNT; voice++) {
      this.applyEffectiveMute(voice);
    }
  }

  setOutputGain(gain: number): void {
    this.outputGain = gain;
    this.session.frame?.setOutputGain(gain);
  }

  setRegisterScale(group: ScaledRegisterGroup, coefficient: number): void {
    this.registerScales.set(group, coefficient);
    this.session.frame?.setRegisterScale(group, coefficient);
  }

  setFilterMode(mode: SidFilterMode | null): void {
    this.filterMode = mode;
    this.session.frame?.setFilterMode(mode);
  }

  /**
   * The pitch correction for a tune written for a machine clocked at `sourceHz` and played on one
   * clocked at `targetHz`. Only the application knows what is on the far end, so this is the route
   * by which it tells the register shadow — and it is held, so the next tune loaded inherits it.
   */
  setTargetClock(sourceHz: number, targetHz: number): void {
    if (clockRatio(sourceHz, targetHz) === null) {
      console.warn(`SID player: ignoring a clock correction of ${sourceHz} Hz to ${targetHz} Hz.`);
      return;
    }
    this.clockCorrection = { sourceHz, targetHz };
    this.session.frame?.setTargetClock(sourceHz, targetHz);
  }

  /**
   * Voice `voice`'s own pitch coefficient, which composes with the clock correction and never
   * disturbs it. The three are independent; ganging them is this player's caller's business.
   */
  setVoicePitch(voice: number, coefficient: number): void {
    if (voice < 0 || voice >= VOICE_COUNT) return;
    if (!Number.isFinite(coefficient) || coefficient <= 0) {
      console.warn(`SID player: ignoring a pitch coefficient of ${coefficient}.`);
      return;
    }
    this.voicePitch[voice] = coefficient;
    this.session.frame?.setVoicePitch(voice, coefficient);
  }

  /**
   * Tears playback down. Deliberately lighter than `stop()`: re-initialising the subtune here costs
   * a synchronous machine run nothing will ever play.
   */
  dispose(): void {
    this.clock.stop();
    this.session.discardOutstandingJump();
    this.session.dispose();
    if (this.transport === 'playing' || this.transport === 'paused') {
      this.sink.end();
    }
  }

  /**
   * One emulated frame, one delivered frame — including frames where nothing changed, so the stream
   * and the frame grid stay one-to-one and a frame's place in the grid always names its due time.
   *
   * `dueAtMs` is when the clock says this frame fell due, which is before now and one interval apart
   * from its neighbour when a callback releases several at once. It rides through to the sink so
   * delivery is anchored to the frame grid rather than to whenever this thread reached it.
   */
  private readonly onTick = (dueAtMs: Milliseconds, catchUpClamped: boolean): void => {
    const machine = this.session.machine;
    const frame = this.session.frame;
    if (machine === null || frame === null) {
      return;
    }

    // The gate-off a jump owes takes this tick's slot: the resync it leads is already armed on the
    // live frame and goes out on the next one.
    if (this.gateOffOwed) {
      this.gateOffOwed = false;
      this.deliver(this.gateOffFrame(), dueAtMs, catchUpClamped);
      return;
    }

    let result: FrameResult;
    try {
      result = machine.runFrame();
    } catch (error) {
      this.fail(`the play routine could not run — ${describeError(error)}`);
      return;
    }
    if (!result.completed) {
      this.fail(
        `the play routine did not return within its cycle budget (${result.cyclesUsed} cycles)`,
      );
      return;
    }

    this.deliver(frame.takeSnapshot(), dueAtMs, catchUpClamped);
    this.session.framesRendered = frames(this.session.framesRendered + 1);
    this.ring.maybeRecord(machine, frame, this.session.framesRendered);
    this.enforceLoop(machine, frame);
  };

  /** Hands one frame to the sink and measures the hand-off. The reading is taken before the call so
   *  it measures core's own lag against the frame grid, not the sink's work. */
  private deliver(frame: SidFrame, dueAtMs: Milliseconds, catchUpClamped: boolean): void {
    const handOffMs = performance.now();
    this.sink.deliver(frame, this.session.framesRendered, dueAtMs, catchUpClamped);

    this.scheduledFrames++;
    const lagMs = handOffMs - dueAtMs;
    this.sumLagMs += lagMs;
    if (lagMs > this.worstLagMs) {
      this.worstLagMs = lagMs;
    }
    if (lagMs > this.effectiveIntervalUs() / MICROSECONDS_PER_MILLISECOND) {
      this.lateFrames++;
    }
    // A clamped advance carries a due time later than the truth, so this frame's lag under-reports.
    // Counted rather than dropped from the average: a consumer reading a clamped count above zero
    // knows the lag figures beside it are a floor, which excluding them would hide.
    if (catchUpClamped) {
      this.clampedFrames++;
    }
    if (this.lastDueAtMs !== null && dueAtMs < this.lastDueAtMs) {
      this.reorderedFrames++;
    }
    this.lastDueAtMs = dueAtMs;
  }

  /** Runs whatever loop is in force against the frame just rendered: a lap re-enters and owes the
   *  stream a resync, a track end with repeat off ends the track. */
  private enforceLoop(machine: C64Machine, frame: RegisterFrame): void {
    const outcome = this.activeLoop.advance(
      machine,
      frame,
      this.ring,
      this.track,
      this.session.framesRendered,
    );
    if (outcome.action === 'looped') {
      this.session.framesRendered = outcome.frame;
      this.queueResync();
      // The track's own loop may have just armed itself, which is a discrete change to the loop a
      // consumer reads.
      this.markDirty();
      return;
    }
    if (outcome.action === 'stopped') {
      this.endTrack();
    }
  }

  /**
   * The track played through and stopped. Leaves the playhead at the track's end rather than
   * snapping it to zero, so a consumer can see where the deck finished, and deliberately does not
   * re-initialise the subtune — that would reset the position counter, and `play()` from `'ended'`
   * already falls through its own non-paused branch to restart from the beginning.
   */
  private endTrack(): void {
    this.haltPlayback();
    // A scrub still in flight would otherwise land after this reports `ended`, restore a position
    // and queue a resync that — with the clock stopped — goes out at once, so the deck would report
    // `ended` and then audibly resume.
    this.session.discardOutstandingJump();
    this.sink.end();
    this.transport = 'ended';
    this.markDirty();
  }

  /** What every transport halt shares: the clock stops, the step a jump still owed is dropped, and
   *  so is whatever the sink still holds — no tick is coming to drain either. */
  private haltPlayback(): void {
    this.clock.stop();
    this.gateOffOwed = false;
    this.sink.reset();
  }

  /**
   * Arms the chip resync a restore owes the stream.
   *
   * `markAllDirty` is the resync itself: it forces all 25 registers into whichever frame is taken
   * next. While playing that is the tick after the gate-off, which leads by a frame so every voice
   * gets a real release window before it re-attacks.
   *
   * Nothing is ticking while paused or stopped, so there is no tick to ride and no stream to stay in
   * step with — the frame goes out at once instead.
   */
  private queueResync(): void {
    const frame = this.session.frame;
    if (frame === null) return;

    frame.markAllDirty();
    if (this.transport === 'playing') {
      this.gateOffOwed = true;
      return;
    }

    // A jump landing while paused must stay silent: the pause already zeroed the three voice control
    // registers on the real chip, and this is a full re-emit, so sent verbatim it could re-open a
    // gate while the consumer still reads `paused`. Only the outgoing frame is forced — the live
    // frame keeps its true values, which `play()`'s paused branch restores.
    const resync = frame.takeSnapshot();
    this.sink.deliverNow(this.transport === 'paused' ? withVoiceGatesOff(resync) : resync);
  }

  /** A frame that gates every voice off — enough to release every note, and nothing else. */
  private gateOffFrame(): SidFrame {
    for (const register of VOICE_CONTROL_REGISTERS) {
      this.gateOff.onSidWrite(register, 0);
    }
    return this.gateOff.takeSnapshot();
  }

  /**
   * Produces the track loop's re-entry image once, off-thread. A loop start of 0 needs none — the
   * frame-0 anchor already is one — and neither does a track with no detected loop.
   *
   * The replay outlives the state it was asked against, so the file, the subtune and the loop start
   * are all re-checked on the way back: landing a stale image is worse than landing none, since the
   * fallback to a seek along the anchor path is correct where a foreign machine image is not.
   */
  private async captureTrackLoopEntry(): Promise<void> {
    const startFrame = this.track.loopStartFrame();
    if (startFrame === null || startFrame === 0) return;
    const file = this.session.file;
    if (file === null) return;
    const subtune = this.session.currentSubtune;

    const result = await this.session.replayImage(startFrame);
    if (result === null) return;
    if (this.session.file !== file || this.session.currentSubtune !== subtune) return;
    if (this.track.loopStartFrame() !== startFrame) return;

    this.trackLoopEntry = result;
    if (this.activeLoop.get() === null || this.activeLoop.get()?.startFrame === startFrame) {
      this.activeLoop.setEntryImage(result);
    }
  }

  private dropTrackLoopEntry(): void {
    this.trackLoopEntry = null;
    this.activeLoop.setEntryImage(null);
  }

  private fail(reason: string): void {
    this.clock.stop();
    this.error = reason;
    this.transport = 'error';
    this.markDirty();
    console.error(`SID player: ${reason}`);
  }

  private resetCounters(): void {
    this.session.resetPosition();
    this.gateOffOwed = false;
    this.scheduledFrames = 0;
    this.lateFrames = 0;
    this.sumLagMs = 0;
    this.worstLagMs = 0;
    this.reorderedFrames = 0;
    this.clampedFrames = 0;
    this.lastDueAtMs = null;
    this.sink.reset();
  }

  /**
   * Moves the clock the instant the tempo does, so the pitch tracks the hand, and re-times whatever
   * the sink still holds at the old spacing.
   */
  private applyIntervalChange(): void {
    if (this.transport === 'playing') {
      const intervalUs = this.effectiveIntervalUs();
      this.clock.setIntervalUs(intervalUs);
      this.runningIntervalUs = intervalUs;
      this.sink.retime(intervalUs);
    }
    // Nothing is pacing anything otherwise — `play()` reads the interval fresh when it starts the
    // clock — but the rate a consumer reads has still moved.
    this.markDirty();
  }

  /**
   * The real inter-frame time. Multispeed is a tick rate, never a batch: `runFrame` plays the
   * routine once, so a 2x tune ticks twice per video frame at half the interval.
   */
  private effectiveIntervalUs(): Microseconds {
    return microseconds(
      playCallIntervalUs(this.nominalIntervalUs, this.playRate()) / this.tempoMultiplier,
    );
  }

  /** The interval a consumer reads: what the clock is running while playing, and the rate the next
   *  `play()` would start at otherwise. */
  private reportedIntervalUs(): Microseconds {
    if (this.session.file === null) return microseconds(0);
    return this.transport === 'playing' && this.runningIntervalUs !== null
      ? this.runningIntervalUs
      : this.effectiveIntervalUs();
  }

  /** The rate in force for every duration in the player — the seek reach, the ceiling and the clock
   *  interval all read this rather than choosing between the two rates themselves. */
  private playRate(): PlayRate {
    const { exact, rounded } = this.machineRates;
    return {
      callsPerFrame: this.timingMode === 'exact' ? exact : rounded,
      exactCallsPerFrame: exact,
      roundedCallsPerFrame: rounded,
      mode: this.timingMode,
    };
  }

  /** Derived from the tune's own rate, never the tempo multiplier — riding the tempo must not make
   *  the ring's spacing breathe. */
  private seekReachFrames(): Frames {
    return frames(msToPlayCalls(SEEK_REACH_MS, this.nominalIntervalUs, this.playRate()));
  }

  /** What the chip actually does: latched XOR held. */
  private effectiveMutes(): readonly boolean[] {
    return this.mutedVoices.map((latched, voice) => latched !== this.heldVoices[voice]);
  }

  private applyEffectiveMute(voice: number): void {
    this.session.frame?.setVoiceMuted(voice, this.effectiveMutes()[voice]);
    this.markDirty();
  }

  /** Re-applies the correction and the three pitches to whichever register shadow is current. A
   *  fresh one starts at home, so without this a load would emit its first frames at the source
   *  machine's pitch. */
  private applyPitch(): void {
    const frame = this.session.frame;
    if (frame === null) return;
    if (this.clockCorrection !== null) {
      frame.setTargetClock(this.clockCorrection.sourceHz, this.clockCorrection.targetHz);
    }
    for (let voice = 0; voice < VOICE_COUNT; voice++) {
      frame.setVoicePitch(voice, this.voicePitch[voice]);
    }
  }

  private markDirty(): void {
    this.store.markDirty(() => this.buildSnapshot());
  }

  private buildSnapshot(): PlayerSnapshot {
    const rate = this.playRate();
    const trackEndFrame = this.track.trackEndFrame();
    return {
      transport: this.transport,
      tune:
        this.session.file === null
          ? null
          : {
              subtune: this.session.currentSubtune,
              subtuneCount: this.session.subtuneCount,
              lengthFrames: trackEndFrame,
            },
      tempo: {
        multiplier: this.tempoMultiplier,
        effectiveIntervalUs: this.reportedIntervalUs(),
        nominalIntervalUs: this.nominalIntervalUs,
        callsPerFrame: rate.roundedCallsPerFrame,
        rate,
        timingMode: this.timingMode,
      },
      loop: this.activeLoop.get(),
      voices: this.mutedVoices.map((muted, voice) => ({
        muted,
        held: this.heldVoices[voice],
      })),
      basis: {
        positionBasisFrames: this.session.positionBasisFrames,
        ceilingFrames: this.session.ceilingFrames,
        trackEndFrame,
      },
      repeatTrack: this.track.repeatEnabled(),
      error: this.error,
    };
  }
}

/**
 * A copy of `frame` with every voice control register's byte forced to 0.
 *
 * Addressed by register number rather than by position: a frame carries the tune's own writes in the
 * order it made them and the forced ones around them, so nothing guarantees where — or whether — a
 * given register sits. Getting this wrong costs a voice its release window, which is audible and
 * invisible to a check on frame length.
 */
function withVoiceGatesOff(frame: SidFrame): SidFrame {
  const values = frame.values.slice();
  for (let index = 0; index < frame.count; index++) {
    if (VOICE_CONTROL_REGISTERS.includes(frame.registers[index])) {
      values[index] = 0;
    }
  }
  return {
    count: frame.count,
    registers: frame.registers,
    values,
    offsetsUs: frame.offsetsUs,
  };
}
