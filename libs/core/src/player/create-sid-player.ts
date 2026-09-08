import { describeError } from '../common/errors.js';
import { clamp } from '../common/math.js';
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
import { createRegisterFrame } from '../registers/register-frame.js';
import type {
  RegisterFrame,
  ScaledRegisterGroup,
  SidFilterMode,
} from '../registers/register-frame.js';
import type { SidFrame } from '../registers/sid-frame.js';
import {
  NTSC_FRAME_INTERVAL_US,
  PAL_FRAME_INTERVAL_US,
  SID_REGISTER_COUNT,
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
import { cycles, frames, microseconds, milliseconds } from '../units.js';
import type { Cycles, Frames, Microseconds, Milliseconds } from '../units.js';
import type { SidPlayer } from './sid-player.js';
import type { PlayerSnapshot, PlayerStats } from './snapshot.js';
import { createPlayerSnapshotStore } from './store.js';
import type { PlayerSnapshotStore } from './store.js';
import { createTuneSession } from './tune-session.js';
import type { TuneSession } from './tune-session.js';

/** `emitted`'s default before any tune has loaded a register shadow to read. */
const EMPTY_REGISTER_BYTES = new Uint8Array(SID_REGISTER_COUNT);
const EMPTY_EMITTED: PlayerStats['emitted'] = {
  written: EMPTY_REGISTER_BYTES,
  sent: EMPTY_REGISTER_BYTES,
};
/** `voices`' default for a voice with no register shadow to decode yet. */
const EMPTY_VOICE_STATE: PlayerStats['voices'][number] = {
  gate: false,
  waveform: 0,
  frequency: 0,
  envelope: 0,
};

/**
 * The widest backward walk a seek target can carry, in real time — what the anchor ring is spaced
 * against. Held in milliseconds rather than frames so the reach is the same wall-clock span on a
 * 1x tune and on a 2x-multispeed one.
 */
const SEEK_REACH_MS = milliseconds(1000);

/** Microseconds in a millisecond — the lag measurements below read a µs interval as one. */
const MICROSECONDS_PER_MILLISECOND = 1000;

/**
 * Loop entry images kept at once. Each is a 64 KB machine image plus a register shadow, so this is
 * the same memory-against-replay-distance trade `AnchorRing`'s own size is, and it is held at the
 * same number for the same reason.
 *
 * More than one because a performer alternates: a set of two or three loops triggered against each
 * other is the ordinary gesture, and a cache of one would have every hand-off away from a loop
 * throw away the image the hand-off back to it is about to need.
 */
const LOOP_ENTRY_CACHE_SIZE = 4;

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
  private readonly gateOff = createRegisterFrame();

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

  /** Every entry image captured for this machine, by the frame it was taken at, oldest first — what
   *  a loop being armed, or a jump landing on one's own start, is served from instead of a replay.
   *  Emptied wholesale by anything that replaces the machine the images describe. */
  private readonly loopEntries = new Map<number, PositionAnchor>();

  /** The start frames a capture is in flight for. A loop re-armed while its own image is still on
   *  its way — a trigger pressed twice, an end nudged repeatedly — would otherwise queue a second
   *  identical replay ahead of the jump that is about to want it. */
  private readonly capturesInFlight = new Set<number>();

  private scheduledFrames = 0;
  private lateFrames = 0;
  private sumLagMs = 0;
  private worstLagMs = 0;
  private reorderedFrames = 0;
  private clampedFrames = 0;
  /** The previous frame's due time, so `record` can spot an inversion. Null before the first frame
   *  of a run — there is nothing yet to be earlier than. */
  private lastDueAtMs: Milliseconds | null = null;
  /** The most recent `runFrame()` call's cost, win or fail — `getStats()`'s cheap read against it
   *  rather than re-deriving it, since a pull must never re-run the frame it is reporting on. */
  private lastCyclesUsed: Cycles = cycles(0);

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
    const frame = this.session.frame;
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
      suppressedWrites: frame?.suppressedWriteCount ?? 0,
      illegalOpcodeCount: this.session.machine?.illegalOpcodeCount ?? 0,
      cpu: { cyclesUsed: this.lastCyclesUsed, headroom: this.cpuHeadroom() },
      voices: this.voiceStats(frame),
      emitted: frame?.emittedValues() ?? EMPTY_EMITTED,
      resync: { inFlightDepth: this.gateOffOwed ? 1 : 0 },
      rate: {
        exactCallsPerFrame: this.machineRates.exact,
        roundedCallsPerFrame: this.machineRates.rounded,
      },
    };
  }

  /** `1 - cyclesUsed / frameCycleBudget`, clamped — no machine loaded reports full headroom, since
   *  nothing is spending any of a budget that does not yet exist. */
  private cpuHeadroom(): number {
    const machine = this.session.machine;
    if (machine === null) return 1;
    return clamp(1 - this.lastCyclesUsed / machine.frameCycleBudget, 0, 1);
  }

  /** Decoded fresh from the shadow on every call — see `RegisterFrame.voiceState`'s own doc for why
   *  that is cheap enough for a pull. */
  private voiceStats(frame: RegisterFrame | null): PlayerStats['voices'] {
    const voices: PlayerStats['voices'][number][] = [];
    for (let voice = 0; voice < VOICE_COUNT; voice++) {
      voices.push(frame?.voiceState(voice) ?? EMPTY_VOICE_STATE);
    }
    return voices;
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

  /**
   * Stops the clock and gates every voice off, so a pause leaves silence rather than a held note.
   *
   * The active loop deliberately survives it: a pause is a hold on a passage, not a get-out from it,
   * so `play()` resumes into the same lap. `stop()` is the one that drops it.
   */
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

  /**
   * Stops the clock, closes the far end, re-initialises the machine and disarms whatever loop was
   * running.
   *
   * Dropping the loop is what makes this the hard stop `pause()` is not: the re-init puts the
   * machine back at the top of the subtune, and a loop left armed across that would have the very
   * next play run into a lap the performer had already stopped — and, in an application that infers
   * a wrap from the playhead moving backward, read the restart itself as one.
   */
  stop(): void {
    this.haltPlayback();
    // Landing a jump still in flight would restart playback at a position nobody asked for, and the
    // re-init below invalidates whatever it was carrying anyway.
    this.session.discardOutstandingJump();
    this.transport = 'stopped';
    // After the transport, so the one snapshot this publishes already reads as stopped rather than
    // announcing a deck that is still playing with its loop taken away.
    this.setActiveLoop(null);
    if (this.session.file !== null) {
      this.sink.end();
      this.session.initSubtune(this.session.currentSubtune);
    }
    this.markDirty();
  }

  /**
   * Asks for `frame`.
   *
   * A target landing exactly on the frame the active loop's entry image was taken at is applied from
   * that image here and now — the same restore a lap re-entry takes, no replay and no thread to
   * cross — and the returned promise is already resolved. That is what makes triggering, auditioning
   * or handing off to an armed loop cost the same whether it sits at the top of the tune or two
   * minutes into it; without it, every deliberate jump to a loop's own start paid the replay the
   * image exists to avoid, because a loop that only ever revisits its own narrow range never keeps a
   * usable anchor on the ring and falls back to the frame-0 seed.
   *
   * The match is exact by design. An image describes one frame, so applying it at any other would
   * land a position nobody asked for — a scrub is held to the same rule and takes the generic path
   * for every target but that one frame.
   *
   * Anything else replays off this thread, and the promise resolves once that request has settled
   * (landed, failed, or been superseded), not when it was issued.
   *
   * A target before the start of the tune resolves to frame 0 rather than erroring: a scrub dragged
   * off the left end of the bar is a gesture, not a fault.
   */
  seek(frame: Frames): Promise<void> {
    const target = frames(Math.max(0, Math.round(frame)));
    const entry = this.activeLoop.entryImage();
    if (entry !== null && entry.frame === target) {
      // A replay still in flight would land a moment later and move the playhead off what this has
      // just placed — the same supersession `jumpToFrame` gets from claiming the outstanding id.
      this.session.discardOutstandingJump();
      this.session.restoreState(entry.machine, entry.registers, entry.frame);
      return Promise.resolve();
    }
    return this.session.jumpToFrame(target);
  }

  selectSubtune(song: number): void {
    const before = this.session.currentSubtune;
    this.session.selectSubtune(song);
    if (this.session.currentSubtune === before) {
      return;
    }
    // Every entry image describes a machine the re-init has just replaced — the track's own and
    // whichever loop is presently active alike.
    this.dropEntryImages();
    void this.captureTrackLoopEntry();
    const activeLoop = this.activeLoop.get();
    if (activeLoop !== null) {
      void this.captureActiveLoopEntry(activeLoop);
    }
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
    // A loop already captured for this machine is armed with its image straight away, so the seek a
    // trigger, an audition or a queued hand-off makes right after this one lands instantly rather
    // than replaying — and so does its first wrap. Only a loop this machine has never held an image
    // for pays the one-time off-thread capture `captureTrackLoopEntry` already pays for the track's
    // own loop.
    const cached = this.entryImageFor(loop);
    this.activeLoop.setEntryImage(cached);
    if (loop !== null && cached === null) {
      // Not awaited: nothing on this path needs the image, and a lap cannot reach this loop's own
      // end for a whole pass yet.
      void this.captureActiveLoopEntry(loop);
    }
    this.markDirty();
  }

  /**
   * Snapshots the live machine and register frame at the current position straight into the
   * entry-image cache `entryImageFor`/`rememberEntryImage` already serve `setActiveLoop` and `seek`
   * from — no replay, since the live machine is already at this exact frame.
   *
   * Meant to be called by a caller marking the current position as a loop's future start: arming
   * that loop afterwards through `setActiveLoop` finds this image already cached and never falls
   * back to `captureActiveLoopEntry`'s off-thread replay, so even that loop's very first trigger is
   * instant rather than paying a cost proportional to how deep it sits in the tune.
   */
  capturePosition(): void {
    const machine = this.session.machine;
    const frame = this.session.frame;
    if (machine === null || frame === null) return;
    this.rememberEntryImage({
      frame: this.session.framesRendered,
      machine: machine.snapshot(),
      registers: frame.snapshotValues(),
    });
  }

  setTrackStructure(loop: DetectedLoopFrames | null): void {
    this.track.setTrackStructure(loop);
    // The track's end is the tune's measured length: what the playhead is drawn against, unless
    // detection answered nothing and the fixed ceiling stands in.
    this.session.setIndexedLengthFrames(this.track.trackEndFrame());
    this.dropEntryImages();
    this.markDirty();
    // Not awaited: nothing on this path needs the image, and playback cannot reach the loop's end
    // for a whole lap yet.
    void this.captureTrackLoopEntry();
    // A marker loop already running keeps running straight through the structure change; its own
    // entry image was just dropped above along with the track's, and recapturing it here — rather
    // than waiting on the performer to re-arm it — keeps its very next lap instant too.
    const activeLoop = this.activeLoop.get();
    if (activeLoop !== null) {
      void this.captureActiveLoopEntry(activeLoop);
    }
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

  /** Gain is documented as 0…1; a non-finite or out-of-range value would scale a register to NaN,
   *  which a typed-array write silently coerces to 0 and mutes the channel instead of erroring. */
  setOutputGain(gain: number): void {
    if (!Number.isFinite(gain) || gain < 0 || gain > 1) {
      console.warn(`SID player: ignoring an output gain of ${gain} (must be 0…1).`);
      return;
    }
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
    // Recorded before the completion check: a runaway routine's headroom is exactly what a
    // consumer needs to see, alongside the failure the incomplete branch below raises for it.
    this.lastCyclesUsed = cycles(result.cyclesUsed);
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
   * Replays to `startFrame` off-thread and returns the resulting image, or null when it needs none
   * (frame 0 — the anchor ring's own seed already is one) or the file/subtune moved on underneath
   * the request while it was in flight. Shared by `captureTrackLoopEntry` and
   * `captureActiveLoopEntry`, which each layer on the staleness check specific to what they are
   * caching the image for.
   */
  private async captureEntryImage(startFrame: Frames): Promise<PositionAnchor | null> {
    if (startFrame === 0) return null;
    const file = this.session.file;
    if (file === null) return null;
    const subtune = this.session.currentSubtune;

    const result = await this.session.replayImage(startFrame);
    if (result === null) return null;
    if (this.session.file !== file || this.session.currentSubtune !== subtune) return null;
    return result;
  }

  /**
   * Produces the track loop's own re-entry image once, off-thread — run ahead of need, from
   * `setTrackStructure`, since `advance` arms this loop itself only once the track first wraps.
   *
   * Re-checked against the loop start on the way back, on top of `captureEntryImage`'s own file and
   * subtune guard: a fresh detection landing mid-capture would otherwise cache an image for a loop
   * that is no longer the one detected.
   */
  private async captureTrackLoopEntry(): Promise<void> {
    const startFrame = this.track.loopStartFrame();
    if (startFrame === null) return;
    const result = await this.captureEntryImage(startFrame);
    if (result === null) return;
    if (this.track.loopStartFrame() !== startFrame) return;

    this.trackLoopEntry = result;
    this.rememberEntryImage(result);
    if (this.activeLoop.get() === null || this.activeLoop.get()?.startFrame === startFrame) {
      this.activeLoop.setEntryImage(result);
    }
  }

  /**
   * Produces `loop`'s own re-entry image once, off-thread — the mechanism `captureTrackLoopEntry`
   * already gives the track's own loop, generalized to any loop a performer arms through
   * `setActiveLoop`. Without it, a marker loop's narrow, endlessly-repeated frame range never earns
   * itself a usable anchor on the ring (`AnchorRing.select` needs one recorded a full nudge range
   * *before* the target, which a loop that only ever revisits its own start never gets), so every
   * lap would replay from the frame-0 seed at a cost proportional to how deep the loop sits.
   *
   * Also re-run wherever something strands an already-captured image out from under the presently
   * active loop — a subtune change, a fresh track-structure detection — rather than leaving that
   * loop to pay a slow lap before the performer happens to re-arm it.
   *
   * The image is cached whatever the performer did to the loop while it was in flight — it describes
   * a frame of this file and subtune, which `captureEntryImage` has already checked, and nothing
   * about the loop's bounds changes what it is an image *of*. Only handing it to the tracker is
   * re-checked, and against the start frame alone: a loop whose end moved mid-capture still enters
   * through this very image.
   */
  private async captureActiveLoopEntry(loop: ActiveLoop): Promise<void> {
    if (loop === null || this.capturesInFlight.has(loop.startFrame)) return;
    this.capturesInFlight.add(loop.startFrame);
    let result: PositionAnchor | null = null;
    try {
      result = await this.captureEntryImage(loop.startFrame);
    } finally {
      this.capturesInFlight.delete(loop.startFrame);
    }
    if (result === null) return;

    this.rememberEntryImage(result);
    if (this.activeLoop.get()?.startFrame !== loop.startFrame) return;
    this.activeLoop.setEntryImage(result);
  }

  /** Whichever image already stands at `loop`'s own start frame, or the track's own loop's entry
   *  when nothing is looping — what `setActiveLoop` arms a loop with in place of a fresh capture. */
  private entryImageFor(loop: ActiveLoop): PositionAnchor | null {
    if (loop === null) return this.trackLoopEntry;
    return this.loopEntries.get(loop.startFrame) ?? null;
  }

  /** Files `entry` under the frame it was taken at, evicting the oldest once the cache is full.
   *  Re-inserted rather than overwritten in place, so a loop being armed again counts as the newest
   *  and a set of loops played against each other keeps every one of their images. */
  private rememberEntryImage(entry: PositionAnchor): void {
    this.loopEntries.delete(entry.frame);
    this.loopEntries.set(entry.frame, entry);
    if (this.loopEntries.size > LOOP_ENTRY_CACHE_SIZE) {
      const oldest = this.loopEntries.keys().next();
      if (!oldest.done) this.loopEntries.delete(oldest.value);
    }
  }

  /** Drops every cached entry image along with whatever the tracker presently holds — the same call
   *  whether an image came from the track's own loop or a marker's, since all of them describe a
   *  machine a subtune re-init or a fresh detection has just invalidated. */
  private dropEntryImages(): void {
    this.trackLoopEntry = null;
    this.loopEntries.clear();
    // Whatever is in flight is about to come back describing the replaced machine and be dropped by
    // `captureEntryImage`'s own guard, so it must not stand in the way of the recapture that
    // follows.
    this.capturesInFlight.clear();
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
    this.lastCyclesUsed = cycles(0);
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
