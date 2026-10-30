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
import { FILTER_MODE_BITS, createRegisterFrame } from '../registers/register-frame.js';
import type {
  RegisterFrame,
  ScaledRegisterGroup,
  SidFilterMode,
} from '../registers/register-frame.js';
import { isUsableRegisterRecord } from '../registers/register-record.js';
import type { RegisterRecord } from '../registers/register-record.js';
import type { SidFrame } from '../registers/sid-frame.js';
import { isUsableHold, isUsableOffset, resolveSidField } from '../registers/sid-fields.js';
import type { SidField } from '../registers/sid-fields.js';
import {
  NTSC_FRAME_INTERVAL_US,
  PAL_FRAME_INTERVAL_US,
  SID_REGISTER_COUNT,
  VOICE_CONTROL_REGISTERS,
  VOICE_COUNT,
} from '../registers/sid-constants.js';
import type { ReplayRunner } from '../replay/replay-runner.js';
import type { ReplayResult } from '../replay/replay-to-frame.js';
import type { SidFile } from '../sid/sid-file.model.js';
import { createActiveLoopTracker } from '../timeline/active-loop.js';
import type { ActiveLoop, ActiveLoopTracker, AdvanceResult } from '../timeline/active-loop.js';
import { createAnchorRing } from '../timeline/anchor-ring.js';
import type { AnchorRing, PositionAnchor } from '../timeline/anchor-ring.js';
import { createTrackStructure } from '../timeline/track-structure.js';
import type { DetectedLoopFrames, TrackStructure } from '../timeline/track-structure.js';
import { cycles, frames, microseconds, milliseconds } from '../units.js';
import type { Cycles, Frames, Microseconds, Milliseconds } from '../units.js';
import type { SidPlayer, VarispeedRateSource } from './sid-player.js';
import type { JumpSettings, PlayerSnapshot, PlayerStats, QueuedJump } from './snapshot.js';
import { createPlayerSnapshotStore } from './store.js';
import type { PlayerSnapshotStore } from './store.js';
import { createTuneSession } from './tune-session.js';
import type { TuneSession } from './tune-session.js';
import { createVarispeed } from './varispeed.js';
import type { Varispeed } from './varispeed.js';

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
 *
 * Bounds only the images no one declared: a declared jump frame is held in the prepared map for as
 * long as it stays declared, however many there are.
 */
const LOOP_ENTRY_CACHE_SIZE = 4;

/** The mutes every prepared build is seeded with. An image taken with a voice muted carries that
 *  voice's control register zeroed, which is wrong for a restore into an unmuted player. */
const NO_VOICES_MUTED: readonly boolean[] = [false, false, false];

/**
 * How far ahead of the playhead a handback asks for the machine's image, in seconds of music.
 * Replay time grows with the depth it is asked for, and the record played at rate 1 is the stream
 * itself, so the lead costs nothing audible — it only decides how long the record keeps playing
 * before the machine takes over.
 */
const HANDBACK_LEAD_SECONDS = 2;
const HANDBACK_LEAD_MS = milliseconds(HANDBACK_LEAD_SECONDS * 1000);

/** A field hold as the coordinator carries it into every tune loaded after. */
interface FieldHoldRecord {
  readonly field: SidField;
  readonly value: number;
  readonly amount: number;
}

/** A field offset as the coordinator carries it into every tune loaded after. */
interface FieldOffsetRecord {
  readonly field: SidField;
  readonly amount: number;
}

/**
 * `JumpSettings` resolved at the call that carried them: every entry validated, every field
 * resolved to its table index, and every record the coordinator carries built once. Landing them is
 * then only assignment, which is what keeps it off the allocation budget of the frame it lands on.
 */
interface PreparedSettings {
  readonly pitches: readonly { readonly voice: number; readonly coefficient: number }[];
  /** An amount of 0 hands the field back. */
  readonly offsets: readonly { readonly index: number; readonly record: FieldOffsetRecord }[];
  /** A null record releases the field. */
  readonly holds: readonly {
    readonly index: number;
    readonly field: SidField;
    readonly record: FieldHoldRecord | null;
  }[];
  readonly mutes: readonly { readonly voice: number; readonly muted: boolean }[];
}

/** What a player is built around: the far end it streams to, the cadence it rides, and the thread a
 *  jump replays on. Every one of them is injected — core constructs none of them. */
export interface SidPlayerCollaborators {
  readonly sink: SidSink;
  readonly clock: FrameClock;
  readonly replayRunner: ReplayRunner;
  /** Runs prepared-snapshot builds. Supply a second runner (its own worker) so a scrub never
   *  waits behind a batch of builds; when absent, builds share `replayRunner`'s queue. */
  readonly prepareRunner?: ReplayRunner;
}

/** An entry image and what is known about how it was taken. */
interface HeldImage {
  readonly anchor: PositionAnchor;
  /** Built by replay with every voice unmuted — the only kind a chained build may start from. A
   *  live capture never is: the live machine's history is not guaranteed to be a replay's. */
  readonly chainable: boolean;
  /** Some voice was effectively muted as the image was taken, which leaves its control register
   *  zeroed in the image. */
  readonly mutedAtCapture: boolean;
}

/** A prepared-snapshot build in flight, with what must still hold when its answer arrives. */
interface PreparedBuild {
  readonly frame: number;
  readonly generation: number;
  readonly file: SidFile;
  readonly subtune: number;
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
  private readonly replayRunner: ReplayRunner;
  private readonly prepareRunner: ReplayRunner | undefined;
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
   *  report, rather than one derived from a tempo that may have changed while stopped. */
  private runningIntervalUs: Microseconds | null = null;

  private readonly mutedVoices = [false, false, false];
  private readonly heldVoices = [false, false, false];

  /** Held so a fresh `RegisterFrame` built by `loadTune` inherits them — otherwise every tune load
   *  would silently reset the output to full, at home, with no field held or offset. */
  private outputGain = 1;
  private readonly registerScales = new Map<ScaledRegisterGroup, number>();
  /** Keyed by the field's table index, so the same field named by two different objects is one
   *  hold. The filter-type override is a hold of `filterType` here and has no state of its own. */
  private readonly fieldHolds = new Map<number, FieldHoldRecord>();
  /** Keyed like `fieldHolds`; an amount of 0 is never stored. */
  private readonly fieldOffsets = new Map<number, FieldOffsetRecord>();

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

  /** The record-driven half of varispeed: the playhead, the record and the feed. */
  private readonly varispeed: Varispeed = createVarispeed();
  /** True from `enterVarispeed` until live playback or the paused landing takes over. The clock's
   *  ticks go to `varispeedTick` meanwhile, whatever the transport reads. */
  private varispeedActive = false;
  /** Asked for the rate once a tick; null outside varispeed and while handing back. */
  private rateSource: VarispeedRateSource | null = null;
  /** The host has left varispeed while playing: the record plays at rate 1 until the machine's
   *  image is reached. */
  private handingBack = false;
  /** Bumped by anything that makes an image request describe a handback that is gone or has moved:
   *  a new request, a seek, a re-entry, any exit. A late answer carrying an old number is dropped. */
  private handbackGeneration = 0;
  private handbackLeadFrames = 0;
  /** The image that arrived ahead of the playhead, adopted when the playhead reaches its frame. */
  private handbackImage: ReplayResult | null = null;
  /** Bumped when varispeed is entered and when it ends, so a clock start that resolves late can tell
   *  it belongs to a run that is gone. */
  private varispeedRun = 0;
  /** Counts every `clock.start` this player issues, so a late-resolving start can tell whether a
   *  later one has since taken the clock over. */
  private clockStarts = 0;

  /** The image the track's own loop re-enters through, captured off-thread. Held here as well as in
   *  the tracker so a performer's loop can take the entry image away and give it back without a
   *  fresh replay. */
  private trackLoopEntry: PositionAnchor | null = null;

  /** Every entry image captured for this machine, by the frame it was taken at, oldest first — what
   *  a loop being armed, or a jump landing on one's own start, is served from instead of a replay.
   *  Emptied wholesale by anything that replaces the machine the images describe. */
  private readonly loopEntries = new Map<number, HeldImage>();

  /** The frames the host asked to be able to jump to instantly, normalised the way `seek` is. */
  private readonly declared = new Set<number>();

  /** One image per declared frame that has one, kept for as long as the frame stays declared. Looked
   *  up before `loopEntries`. */
  private readonly prepared = new Map<number, HeldImage>();

  /** Declared frames still owed a build: not yet ready, or ready from a capture taken muted. A build
   *  that fails leaves its frame out, so a failure is retried by the next declaration and never in a
   *  loop. */
  private readonly buildQueue = new Set<number>();

  /** The one build running. Builds go one at a time, lowest frame first, so each can continue from
   *  the one before it and the whole set costs about one pass to its deepest frame. */
  private activeBuild: PreparedBuild | null = null;

  /** Bumped by anything that makes a running build's answer describe the wrong machine. */
  private preparedGeneration = 0;

  /** The start frames a capture is in flight for. A loop re-armed while its own image is still on
   *  its way — a trigger pressed twice, an end nudged repeatedly — would otherwise queue a second
   *  identical replay ahead of the jump that is about to want it. */
  private readonly capturesInFlight = new Set<number>();

  /** The jump queued for the running loop's next wrap, as the host asked for it (normalised). The
   *  tracker holds its own `QueuedNext` for the same jump; this record is what is published, and
   *  what an in-flight capture checks it is still answering for. */
  private queuedJump: QueuedJump | null = null;

  /** Queued jumps handed off to since the tune and subtune loaded. Incremented on a landing only. */
  private handOffs = 0;

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
    this.replayRunner = collaborators.replayRunner;
    this.prepareRunner = collaborators.prepareRunner;
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
    const varispeedOwnedClock = this.varispeedActive && this.transport !== 'playing';
    this.leaveVarispeedForRebuild();
    if (!varispeedOwnedClock && (this.transport === 'playing' || this.transport === 'paused')) {
      this.clock.stop();
      this.sink.end();
    }
    this.varispeed.setRecord(null);
    // Whatever a jump is replaying describes the outgoing tune, not this one. The same goes for the
    // frames declared against it and the images prepared for them: gone before the new file is
    // loaded, so nothing published or scheduled from here on names the old tune's frames.
    this.session.discardOutstandingJump();
    this.declared.clear();
    this.dropPreparedImages();
    this.queuedJump = null;
    this.activeLoop.queue(null);
    this.session.load(file);

    // A fresh frame starts at full gain, every group at home, every voice at its own clock and pitch
    // and no field held or offset, so every carried setting is re-applied here, before this load can
    // emit a packet at the wrong setting.
    const frame = this.session.frame;
    frame?.setOutputGain(this.outputGain);
    for (const [group, coefficient] of this.registerScales) {
      frame?.setRegisterScale(group, coefficient);
    }
    for (const hold of this.fieldHolds.values()) {
      frame?.holdField(hold.field, hold.value, hold.amount);
    }
    for (const offset of this.fieldOffsets.values()) {
      frame?.setFieldOffset(offset.field, offset.amount);
    }
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
    this.handOffs = 0;
    this.setActiveLoop(null);

    if (this.session.initSubtune(file.startSong)) {
      this.transport = 'stopped';
    }
    this.markDirty();
  }

  /** Starts, or resumes, playback. In varispeed it only sets the transport: the clock is already
   *  running, so nothing is started, initialised or reset. */
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
    if (this.varispeedActive) {
      this.transport = 'playing';
      this.markDirty();
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
    this.clockStarts++;
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
   *
   * In varispeed the source still drives the clock, so a pause there only sets the transport; the
   * clock keeps running and no gate-off is sent. During a handback it is the paused landing, since
   * nothing else will leave varispeed once the host has handed back.
   */
  pause(): void {
    if (this.transport !== 'playing') {
      return;
    }
    if (this.varispeedActive) {
      if (this.handingBack) {
        this.landPaused();
      } else {
        this.transport = 'paused';
        this.markDirty();
      }
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
    // No landing: the re-init below puts the machine back at the top. The halt and the sink end
    // below are what stop a clock varispeed was running.
    this.endVarispeed();
    this.haltPlayback();
    // Landing a jump still in flight would restart playback at a position nobody asked for, and the
    // re-init below invalidates whatever it was carrying anyway.
    this.session.discardOutstandingJump();
    this.transport = 'stopped';
    // After the transport, so the one snapshot this publishes already reads as stopped rather than
    // announcing a player that is still playing with its loop taken away.
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
   * The same holds for a target exactly on a declared jump frame that is ready: it is restored from
   * that frame's prepared image, whatever the active loop is.
   *
   * Anything else replays off this thread, and the promise resolves once that request has settled
   * (landed, failed, or been superseded), not when it was issued.
   *
   * A target before the start of the tune resolves to frame 0 rather than erroring: a scrub dragged
   * off the left end of the bar is a gesture, not a fault.
   *
   * `settings` are prepared here and applied as the jump lands: before the restore on the image
   * path, so the restore re-zeroes the voices they leave muted, and when the replay lands otherwise.
   * A replay carrying settings is seeded with no voice muted, since a muted seed would leave that
   * voice's control register at 0 in the image and no restore could bring the voice back. A jump
   * that is superseded or discarded never applies them.
   *
   * In varispeed it moves the varispeed position to the target, clamped to the record, and resolves
   * at once with no replay.
   */
  seek(frame: Frames, settings?: JumpSettings): Promise<void> {
    const target = frames(Math.max(0, Math.round(frame)));
    if (this.varispeedActive) return this.seekVarispeed(target, settings);
    const prepared = settings === undefined ? null : this.prepareSettings(settings);
    const entry = this.activeLoop.entryImage();
    const image =
      entry !== null && entry.frame === target
        ? entry
        : (this.prepared.get(target)?.anchor ?? null);
    if (image !== null) {
      // A replay still in flight would land a moment later and move the playhead off what this has
      // just placed — the same supersession `jumpToFrame` gets from claiming the outstanding id.
      this.session.discardOutstandingJump();
      if (prepared !== null) this.applyPreparedSettings(prepared);
      this.session.restoreState(image.machine, image.registers, image.frame);
      // Last, for the reason `enforceLoop` gives: a listener may call straight back in.
      if (prepared !== null) this.markDirty();
      return Promise.resolve();
    }
    if (prepared === null) return this.session.jumpToFrame(target);
    return this.session.jumpToFrame(target, {
      beforeLanding: () => this.applyPreparedSettings(prepared),
      mutes: NO_VOICES_MUTED,
    });
  }

  selectSubtune(song: number): void {
    const before = this.session.currentSubtune;
    this.session.selectSubtune(song);
    if (this.session.currentSubtune === before) {
      return;
    }
    this.leaveVarispeedForRebuild();
    this.varispeed.setRecord(null);
    // Every entry image describes a machine the re-init has just replaced — the track's own and
    // whichever loop is presently active alike — and so does every frame declared against it. The
    // declarations go before the recaptures below, which skip a declared frame.
    this.dropEntryImages();
    this.declared.clear();
    this.queuedJump = null;
    this.activeLoop.queue(null);
    this.handOffs = 0;
    this.markDirty();
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
    this.queuedJump = null;
    this.activeLoop.set(loop);
    // A loop already captured for this machine is armed with its image straight away, so the seek a
    // trigger, an audition or a queued hand-off makes right after this one lands instantly rather
    // than replaying — and so does its first wrap. Only a loop this machine has never held an image
    // for pays the one-time off-thread capture `captureTrackLoopEntry` already pays for the track's
    // own loop. A start the host declared is not captured here at all: the build scheduler owns
    // that frame and hands the image to the loop when it lands.
    const cached = this.entryImageFor(loop);
    this.activeLoop.setEntryImage(cached);
    if (loop !== null && cached === null) {
      // Not awaited: nothing on this path needs the image, and a lap cannot reach this loop's own
      // end for a whole pass yet.
      void this.captureActiveLoopEntry(loop);
    }
    this.markDirty();
  }

  queueJump(target: (QueuedJump & { readonly settings?: JumpSettings }) | null): void {
    if (target === null) {
      this.queuedJump = null;
      this.activeLoop.queue(null);
      this.markDirty();
      return;
    }
    if (!Number.isFinite(target.startFrame)) {
      console.warn(`SID player: ignoring a queued jump to ${target.startFrame}.`);
      return;
    }
    const startFrame = frames(Math.max(0, Math.round(target.startFrame)));
    const endFrame = target.endFrame === null ? null : frames(Math.round(target.endFrame));
    if (endFrame !== null && !(endFrame > startFrame)) {
      console.warn(
        `SID player: ignoring a queued jump to ${startFrame} ending at ${target.endFrame}.`,
      );
      return;
    }
    if (this.activeLoop.get() === null) {
      console.warn(`SID player: ignoring a queued jump to ${startFrame} with no loop running.`);
      return;
    }

    // The published record never carries settings: they live only on the tracker's queued object,
    // and go when it does.
    const prepared = target.settings === undefined ? null : this.prepareSettings(target.settings);
    const varispeedStart = endFrame === null ? undefined : target.varispeedStart;
    const record: QueuedJump = {
      startFrame,
      endFrame,
      ...(varispeedStart === undefined ? {} : { varispeedStart }),
    };
    this.queuedJump = record;
    this.activeLoop.queue({
      startFrame,
      loop:
        endFrame === null
          ? null
          : { startFrame, endFrame, ...(varispeedStart === undefined ? {} : { varispeedStart }) },
      ...(prepared === null ? {} : { beforeLanding: () => this.applyPreparedSettings(prepared) }),
    });
    this.armQueuedImage(record);
    this.markDirty();
  }

  setJumpTargets(requested: readonly Frames[]): void {
    this.declared.clear();
    for (const requestedFrame of requested) {
      if (!Number.isFinite(requestedFrame)) {
        console.warn(`SID player: ignoring a jump target of ${requestedFrame}.`);
        continue;
      }
      this.declared.add(Math.max(0, Math.round(requestedFrame)));
    }

    for (const frame of this.prepared.keys()) {
      if (!this.declared.has(frame)) this.prepared.delete(frame);
    }
    // The host usually captures a position and declares it afterwards, so an image already in the
    // cache at a declared frame is the main way a frame becomes ready — with no replay at all.
    this.buildQueue.clear();
    for (const frame of this.declared) {
      if (!this.prepared.has(frame)) {
        const cached = this.loopEntries.get(frame);
        if (cached !== undefined) this.prepared.set(frame, cached);
      }
      const held = this.prepared.get(frame);
      if (held === undefined || held.mutedAtCapture) this.buildQueue.add(frame);
    }

    this.scheduleBuilds();
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
   *
   * A frame that is already declared is ready the moment this returns. If a voice was muted as the
   * image was taken, it stands in until a clean one is built, since a muted voice's control register
   * is zeroed in it.
   */
  capturePosition(): Frames | null {
    const machine = this.session.machine;
    const frame = this.session.frame;
    if (machine === null || frame === null) return null;
    // The live machine is not at the position, so there is nothing true to snapshot.
    if (this.varispeedActive) return this.session.framesRendered;

    const position = this.session.framesRendered;
    const image: HeldImage = {
      anchor: { frame: position, machine: machine.snapshot(), registers: frame.snapshotValues() },
      chainable: false,
      mutedAtCapture: this.anyVoiceMuted(),
    };
    this.rememberEntryImage(image);
    if (this.queuedJump?.startFrame === position) this.activeLoop.setQueuedImage(image.anchor);
    if (this.declared.has(position)) {
      this.prepared.set(position, image);
      if (image.mutedAtCapture) {
        this.buildQueue.add(position);
      } else {
        this.buildQueue.delete(position);
      }
      this.scheduleBuilds();
      this.markDirty();
    }
    return position;
  }

  setTrackStructure(loop: DetectedLoopFrames | null): void {
    this.track.setTrackStructure(loop);
    // The track's end is the tune's measured length: what the playhead is drawn against, unless
    // detection answered nothing and the fixed ceiling stands in.
    this.session.setIndexedLengthFrames(this.track.trackEndFrame());
    this.dropEntryImages();
    // The declared frames stay declared; only their images went, so each is built again.
    for (const frame of this.declared) this.buildQueue.add(frame);
    this.scheduleBuilds();
    if (this.queuedJump !== null) this.armQueuedImage(this.queuedJump);
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

  setRegisterRecord(record: RegisterRecord | null): void {
    if (this.varispeedActive) {
      console.warn('SID player: ignoring a register record while in varispeed.');
      return;
    }
    if (record !== null && !isUsableRegisterRecord(record)) {
      console.warn('SID player: ignoring a register record of an unusable shape.');
      return;
    }
    this.varispeed.setRecord(record);
    this.markDirty();
  }

  /**
   * The record drives the stream from here: nothing of the tune's own code runs until the host
   * leaves. An outstanding jump and an owed gate-off are dropped, since the record now says what
   * the chip does.
   *
   * With the clock not running (paused, stopped or ended) varispeed starts it, restoring all 25
   * registers on the first frame — the pause left the chip's gates zeroed. The transport is not
   * changed. Already in varispeed, only the source is swapped, and a handback in progress is
   * cancelled.
   */
  enterVarispeed(source: VarispeedRateSource): boolean {
    const file = this.session.file;
    const frame = this.session.frame;
    const record = this.varispeed.record;
    if (file === null || frame === null || record === null || this.transport === 'error') {
      return false;
    }

    if (this.varispeedActive) {
      this.rateSource = source;
      this.dropHandback();
      this.markDirty();
      return true;
    }
    if (this.session.framesRendered > record.frames) return false;

    this.session.discardOutstandingJump();
    this.gateOffOwed = false;
    this.varispeed.begin(this.session.framesRendered);
    this.rateSource = source;
    this.varispeedActive = true;
    const run = ++this.varispeedRun;

    if (this.transport !== 'playing') {
      // The pause gated every voice off on the real chip, so the first frame restores it all.
      frame.markAllDirty();
      this.sink.begin({ chipModel: file.model });
      const intervalUs = this.effectiveIntervalUs();
      this.runningIntervalUs = intervalUs;
      void this.startVarispeedClock(run, intervalUs);
    }
    this.markDirty();
    return true;
  }

  /**
   * Playing: the source is dropped and the record plays on at rate 1 while the machine's image is
   * replayed ahead of the playhead; when the playhead reaches it the machine takes over from it,
   * with no gate-off and nothing re-sent. Otherwise: the player lands paused at the position.
   */
  leaveVarispeed(): void {
    if (!this.varispeedActive || this.handingBack) return;
    if (this.transport !== 'playing') {
      this.landPaused();
      return;
    }

    this.rateSource = null;
    this.handingBack = true;
    this.session.frame?.setRatePitch(1);
    this.handbackLeadFrames = Math.max(
      1,
      msToPlayCalls(HANDBACK_LEAD_MS, this.nominalIntervalUs, this.playRate()),
    );
    void this.requestHandbackImage();
    this.markDirty();
  }

  /** A divisor on the clock and nothing else, which is what makes a tempo change nearly free. The
   *  span a tempo may reach is the application's to decide; core rejects only what it cannot divide
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

  /**
   * Holds `field` at `value`, blended by `amount`, and carries it into every tune loaded after. A
   * refused hold is neither applied nor carried, and leaves any hold already on the field alone.
   */
  holdField(field: SidField, value: number, amount = 1): void {
    const index = resolveSidField(field);
    if (!isUsableHold(index, value, amount)) {
      console.warn(
        `SID player: ignoring a hold of ${value} (amount ${amount}) on ${describeField(field)}.`,
      );
      return;
    }
    this.fieldHolds.set(index, { field: { ...field }, value, amount });
    this.session.frame?.holdField(field, value, amount);
  }

  releaseField(field: SidField): void {
    const index = resolveSidField(field);
    if (index < 0) {
      console.warn(`SID player: ignoring a release of ${describeField(field)}.`);
      return;
    }
    this.fieldHolds.delete(index);
    this.session.frame?.releaseField(field);
  }

  /**
   * Offsets `field` by `amount` and carries it into every tune loaded after. A refused offset is
   * neither applied nor carried, and leaves any offset already on the field alone; an amount of 0
   * hands the field back.
   */
  setFieldOffset(field: SidField, amount: number): void {
    const index = resolveSidField(field);
    if (!isUsableOffset(index, amount)) {
      console.warn(`SID player: ignoring an offset of ${amount} on ${describeField(field)}.`);
      return;
    }
    if (amount === 0) {
      this.fieldOffsets.delete(index);
    } else {
      this.fieldOffsets.set(index, { field: { ...field }, amount });
    }
    this.session.frame?.setFieldOffset(field, amount);
  }

  clearFieldOffset(field: SidField): void {
    const index = resolveSidField(field);
    if (index < 0) {
      console.warn(`SID player: ignoring an offset release of ${describeField(field)}.`);
      return;
    }
    this.fieldOffsets.delete(index);
    this.session.frame?.clearFieldOffset(field);
  }

  /**
   * Validates and resolves every entry of `settings` once, so landing them is only assignment. A
   * refused entry is skipped with the warning its single-field method gives, and the rest still
   * apply.
   */
  private prepareSettings(settings: JumpSettings): PreparedSettings {
    const pitches: { voice: number; coefficient: number }[] = [];
    const voicePitch = settings.voicePitch ?? [];
    for (let voice = 0; voice < Math.min(voicePitch.length, VOICE_COUNT); voice++) {
      const coefficient = voicePitch[voice];
      if (!Number.isFinite(coefficient) || coefficient <= 0) {
        console.warn(`SID player: ignoring a pitch coefficient of ${coefficient}.`);
        continue;
      }
      pitches.push({ voice, coefficient });
    }

    const offsets: { index: number; record: FieldOffsetRecord }[] = [];
    for (const { field, amount } of settings.fieldOffsets ?? []) {
      const index = resolveSidField(field);
      if (!isUsableOffset(index, amount)) {
        console.warn(`SID player: ignoring an offset of ${amount} on ${describeField(field)}.`);
        continue;
      }
      offsets.push({ index, record: { field: { ...field }, amount } });
    }

    const holds: { index: number; field: SidField; record: FieldHoldRecord | null }[] = [];
    for (const { field, value, amount } of settings.fieldHolds ?? []) {
      const index = resolveSidField(field);
      const carried = { ...field };
      if (value === null) {
        if (index < 0) {
          console.warn(`SID player: ignoring a release of ${describeField(field)}.`);
          continue;
        }
        holds.push({ index, field: carried, record: null });
        continue;
      }
      const blend = amount ?? 1;
      if (!isUsableHold(index, value, blend)) {
        console.warn(
          `SID player: ignoring a hold of ${value} (amount ${blend}) on ${describeField(field)}.`,
        );
        continue;
      }
      holds.push({ index, field: carried, record: { field: carried, value, amount: blend } });
    }

    const mutes: { voice: number; muted: boolean }[] = [];
    const voiceMutes = settings.voiceMutes ?? [];
    for (let voice = 0; voice < Math.min(voiceMutes.length, VOICE_COUNT); voice++) {
      const muted = voiceMutes[voice];
      if (typeof muted !== 'boolean') {
        console.warn(`SID player: ignoring a mute of ${String(muted)} on voice ${voice}.`);
        continue;
      }
      mutes.push({ voice, muted });
    }

    return { pitches, offsets, holds, mutes };
  }

  /**
   * Lands `prepared` on the coordinator's carried state and on the live frame, exactly as the
   * single-field methods do, so the next `loadTune` carries what landed. Builds no object, array or
   * closure and notifies no one: it runs on the frame path, ahead of the image restore that
   * re-zeroes the voices these mutes leave muted, and the landing's own `markDirty` follows the
   * restore.
   */
  private applyPreparedSettings(prepared: PreparedSettings): void {
    const frame = this.session.frame;
    const { pitches, offsets, holds, mutes } = prepared;

    for (const { voice, coefficient } of pitches) {
      this.voicePitch[voice] = coefficient;
      frame?.setVoicePitch(voice, coefficient);
    }
    for (const { index, record } of offsets) {
      if (record.amount === 0) {
        this.fieldOffsets.delete(index);
        frame?.clearFieldOffset(record.field);
      } else {
        this.fieldOffsets.set(index, record);
        frame?.setFieldOffset(record.field, record.amount);
      }
    }
    for (const { index, field, record } of holds) {
      if (record === null) {
        this.fieldHolds.delete(index);
        frame?.releaseField(field);
      } else {
        this.fieldHolds.set(index, record);
        frame?.holdField(field, record.value, record.amount);
      }
    }
    for (const { voice, muted } of mutes) {
      this.mutedVoices[voice] = muted;
      frame?.setVoiceMuted(voice, muted !== this.heldVoices[voice]);
    }
  }

  /** Allocates nothing: both buffers are the caller's, and zero-filled by index when no tune is
   *  loaded. */
  readRegisters(written: Uint8Array, sent: Uint8Array): void {
    const shortest = Math.min(written.length, sent.length);
    if (shortest < SID_REGISTER_COUNT) {
      throw new RangeError(
        `register buffers must hold ${SID_REGISTER_COUNT} bytes, got ${shortest}`,
      );
    }
    const frame = this.session.frame;
    if (frame === null) {
      for (let i = 0; i < SID_REGISTER_COUNT; i++) {
        written[i] = 0;
        sent[i] = 0;
      }
      return;
    }
    frame.readRegisters(written, sent);
  }

  /** A hold or release of `filterType`, so the override has no copy of its own to disagree with. */
  setFilterMode(mode: SidFilterMode | null): void {
    if (mode === null) {
      this.releaseField({ name: 'filterType' });
    } else {
      this.holdField({ name: 'filterType' }, FILTER_MODE_BITS[mode]);
    }
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
    this.declared.clear();
    this.dropPreparedImages();
    this.session.dispose();
    if (this.prepareRunner !== undefined && this.prepareRunner !== this.replayRunner) {
      this.prepareRunner.dispose();
    }
    this.fieldHolds.clear();
    this.fieldOffsets.clear();
    if (this.varispeedActive || this.transport === 'playing' || this.transport === 'paused') {
      this.sink.end();
    }
    this.endVarispeed();
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

    if (this.varispeedActive) {
      this.varispeedTick(machine, frame, dueAtMs, catchUpClamped);
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

  /**
   * One tick of varispeed: the source names a rate, the playhead moves by it, the record entry
   * under the playhead is fed through the live frame, and one frame goes out — even when nothing
   * changed, so the stream and the frame grid stay one-to-one. No machine runs.
   *
   * A loop carrying `varispeedStart` holds the playhead inside it: a wrap is a move along the record,
   * never a lap, so it restores no image, owes no resync and leaves the queued jump alone. The pitch
   * follows the distance travelled, so a playhead held at a stopped start or the record's ends is
   * silent.
   *
   * While handing back the rate is 1 and the loop in force is enforced as a live tick enforces it.
   * Once the playhead reaches the frame of the image the handback is waiting on, the machine takes
   * over from it.
   */
  private varispeedTick(
    machine: C64Machine,
    frame: RegisterFrame,
    dueAtMs: Milliseconds,
    catchUpClamped: boolean,
  ): void {
    const varispeed = this.varispeed;
    let rate = 1;
    if (!this.handingBack) {
      try {
        rate = this.rateSource === null ? 0 : this.rateSource(varispeed.position, this.tickUs());
      } catch (error) {
        this.fail(`the varispeed rate source threw — ${describeError(error)}`);
        return;
      }
      if (!Number.isFinite(rate)) rate = 0;
    }

    // A handback tick runs the loop through `enforceLoop`, so it is never held.
    const travelled = varispeed.moveBy(rate, this.handingBack ? null : this.activeLoop.get());
    varispeed.feed(frame);
    frame.setRatePitch(Math.abs(travelled));
    this.lastCyclesUsed = cycles(0);
    this.deliver(frame.takeSnapshot(), dueAtMs, catchUpClamped);
    this.session.framesRendered = frames(Math.floor(varispeed.position));

    if (!this.handingBack) return;
    if (this.enforceLoop(machine, frame) !== 'none') return;
    const image = this.handbackImage;
    if (image !== null && this.session.framesRendered === image.frame) this.adoptHandback(image);
  }

  /** The interval the running clock paces at — what a varispeed tick is handed as its own. Read
   *  from the value the clock was last given, since recomputing it builds a rate object. */
  private tickUs(): number {
    return this.runningIntervalUs ?? 0;
  }

  /** Runs whatever loop is in force against the frame just rendered: a lap re-enters and owes the
   *  stream a resync, as does a hand-off to a queued jump; a track end with repeat off ends the
   *  track. Each of those ends a handback, so every branch that moves the stream also ends
   *  varispeed. Reports what it did. */
  private enforceLoop(machine: C64Machine, frame: RegisterFrame): AdvanceResult['action'] {
    const outcome = this.activeLoop.advance(
      machine,
      frame,
      this.ring,
      this.track,
      this.session.framesRendered,
    );
    if (outcome.action === 'looped') {
      this.endVarispeed();
      this.session.framesRendered = outcome.frame;
      this.queueResync();
      // The track's own loop may have just armed itself, which is a discrete change to the loop a
      // consumer reads.
      this.markDirty();
    } else if (outcome.action === 'handed-off') {
      // Every coordinator and tracker update comes before `markDirty`, whose listeners run
      // synchronously and may call straight back in: they must see a consistent snapshot, and what
      // they do must not be overwritten afterwards.
      this.endVarispeed();
      this.session.framesRendered = outcome.frame;
      this.queuedJump = null;
      this.handOffs++;
      if (this.activeLoop.get() === null) this.activeLoop.setEntryImage(this.trackLoopEntry);
      this.queueResync();
      this.markDirty();
    } else if (outcome.action === 'stopped') {
      this.endTrack();
    }
    return outcome.action;
  }

  /**
   * The track played through and stopped. Leaves the playhead at the track's end rather than
   * snapping it to zero, so a consumer can see where playback finished, and deliberately does not
   * re-initialise the subtune — that would reset the position counter, and `play()` from `'ended'`
   * already falls through its own non-paused branch to restart from the beginning.
   */
  private endTrack(): void {
    this.endVarispeed();
    this.haltPlayback();
    // A scrub still in flight would otherwise land after this reports `ended`, restore a position
    // and queue a resync that — with the clock stopped — goes out at once, so the player would report
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

  /** The register record's length as the snapshot publishes it, or null without a record. */
  private recordedFrames(): Frames | null {
    const record = this.varispeed.record;
    return record === null ? null : frames(record.frames);
  }

  /**
   * Starts the clock a varispeed entered from a stopped transport runs on, failing the player as
   * `play()` does when it cannot. A start that resolves after its varispeed has already ended stops
   * the clock again, unless something else — a later start, or live playback — wants it running.
   */
  private async startVarispeedClock(run: number, intervalUs: Microseconds): Promise<void> {
    const start = ++this.clockStarts;
    try {
      await this.clock.start(intervalUs, this.onTick);
    } catch (error) {
      if (this.varispeedRun !== run) return;
      this.sink.end();
      this.fail(`the frame clock could not start — ${describeError(error)}`);
      return;
    }
    const abandoned = this.varispeedRun !== run && !this.varispeedActive;
    if (abandoned && this.clockStarts === start && this.transport !== 'playing') {
      this.clock.stop();
    }
  }

  /**
   * The one routine every exit from varispeed runs: the handback is dropped, the source let go and
   * the rate pitch returned to home. The rate pitch lives on the `RegisterFrame`, which `stop()` and
   * a subtune change keep, so one left at 0 would silence the next play.
   *
   * It leaves the clock, the sink and the transport to the exit that called it, and does not
   * notify.
   */
  private endVarispeed(): void {
    if (!this.varispeedActive) return;
    this.varispeedActive = false;
    this.varispeedRun++;
    this.rateSource = null;
    this.dropHandback();
    this.session.frame?.setRatePitch(1);
  }

  /** Abandons the handback, and with it any image request still on its way. */
  private dropHandback(): void {
    this.handingBack = false;
    this.handbackImage = null;
    this.handbackGeneration++;
  }

  /**
   * The exit for a caller about to re-init or rebuild the machine, so no landing is owed. A varispeed
   * that is not playing owns the running clock and the open sink, and nothing else would stop them.
   */
  private leaveVarispeedForRebuild(): void {
    if (!this.varispeedActive) return;
    if (this.transport !== 'playing') {
      this.haltPlayback();
      this.sink.end();
    }
    this.endVarispeed();
  }

  /**
   * Leaves varispeed for a player that is not playing, or whose handback is abandoned: silence the
   * chip, stop the clock, and bring the machine to the position silently through the same paused
   * landing a seek while paused takes. The transport reads `paused` even from `stopped` or `ended`,
   * since the position is no longer the top.
   */
  private landPaused(): void {
    this.haltPlayback();
    // Immediate, as in `pause()`: queued behind frames the sink still holds it would land late.
    this.sink.deliverNow(this.gateOffFrame());
    this.sink.end();
    this.endVarispeed();
    this.transport = 'paused';
    void this.session.jumpToFrame(frames(Math.floor(this.varispeed.position)));
    this.markDirty();
  }

  private seekVarispeed(target: Frames, settings?: JumpSettings): Promise<void> {
    if (Number.isNaN(target)) {
      console.warn(`SID player: ignoring a seek to ${target}.`);
      return Promise.resolve();
    }
    const prepared = settings === undefined ? null : this.prepareSettings(settings);
    this.varispeed.moveTo(target);
    this.session.framesRendered = frames(Math.floor(this.varispeed.position));
    if (prepared !== null) this.applyPreparedSettings(prepared);
    // The image asked for was ahead of the old position, so the answer would land in the wrong place.
    if (this.handingBack) void this.requestHandbackImage();
    if (prepared !== null) this.markDirty();
    return Promise.resolve();
  }

  /**
   * Asks for the machine's image `handbackLeadFrames` ahead of the playhead, under a new generation.
   * An answer that is still current and not behind the playhead is held until the playhead reaches
   * it; one behind it asks again with double the lead, since replay time is what outran the record.
   */
  private async requestHandbackImage(): Promise<void> {
    const record = this.varispeed.record;
    if (record === null) return;
    const generation = ++this.handbackGeneration;
    this.handbackImage = null;
    const target = frames(
      Math.min(Math.floor(this.varispeed.position) + this.handbackLeadFrames, record.frames),
    );
    const start = this.chainStartFor(target);
    const image = await this.session.replayImage(target, {
      mutes: NO_VOICES_MUTED,
      ...(start === null ? {} : { start }),
    });
    if (generation !== this.handbackGeneration) return;

    if (image === null) {
      this.fail('the handback could not rebuild the tune ahead of the playhead');
      return;
    }
    const position = Math.floor(this.varispeed.position);
    if (image.frame < position) {
      this.handbackLeadFrames *= 2;
      void this.requestHandbackImage();
    } else if (image.frame === position) {
      // The playhead is already there and its record frame already out: no tick is left to wait for.
      this.adoptHandback(image);
    } else {
      this.handbackImage = image;
    }
  }

  /**
   * Hands the stream to the machine at `image`. The chip state the record has built to this frame
   * is the state live playback would have built, so nothing is gated off or re-sent: the image goes
   * onto the live pair and the next tick runs the tune.
   */
  private adoptHandback(image: ReplayResult): void {
    this.session.adoptState(image.machine, image.registers, image.frame);
    this.endVarispeed();
    this.markDirty();
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
  private async captureEntryImage(startFrame: Frames): Promise<HeldImage | null> {
    if (startFrame === 0) return null;
    return this.replayEntryImage(startFrame);
  }

  /** The replay behind `captureEntryImage`, with no frame-0 shortcut: an image is a replay to
   *  `startFrame` whatever that frame is, checked against the file and subtune it was issued for. */
  private async replayEntryImage(startFrame: Frames): Promise<HeldImage | null> {
    const file = this.session.file;
    if (file === null) return null;
    const subtune = this.session.currentSubtune;

    // The session reads the mutes it seeds the replay with as it issues the request, so this is
    // read at the same moment to say what the image was taken under.
    const mutedAtCapture = this.anyVoiceMuted();
    const result = await this.session.replayImage(startFrame);
    if (result === null) return null;
    if (this.session.file !== file || this.session.currentSubtune !== subtune) return null;
    return { anchor: result, chainable: !mutedAtCapture, mutedAtCapture };
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

    this.trackLoopEntry = result.anchor;
    this.rememberEntryImage(result);
    if (this.activeLoop.get() === null || this.activeLoop.get()?.startFrame === startFrame) {
      this.activeLoop.setEntryImage(result.anchor);
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
    // A declared start is the build scheduler's: it lands the image and hands it to the loop, so a
    // capture here would replay the same frame a second time.
    if (loop === null || this.declared.has(loop.startFrame)) return;
    if (this.capturesInFlight.has(loop.startFrame)) return;
    this.capturesInFlight.add(loop.startFrame);
    let result: HeldImage | null = null;
    try {
      result = await this.captureEntryImage(loop.startFrame);
    } finally {
      this.capturesInFlight.delete(loop.startFrame);
    }
    if (result === null) return;

    this.rememberEntryImage(result);
    if (this.activeLoop.get()?.startFrame !== loop.startFrame) return;
    this.activeLoop.setEntryImage(result.anchor);
  }

  /**
   * Hands the tracker the image for the queued jump `record`: whichever already stands at its start
   * frame, else — for a frame no one declared — a one-off capture. A declared frame's build hands
   * the image over when it lands.
   */
  private armQueuedImage(record: QueuedJump): void {
    const held = this.prepared.get(record.startFrame) ?? this.loopEntries.get(record.startFrame);
    this.activeLoop.setQueuedImage(held?.anchor ?? null);
    if (held === undefined && !this.declared.has(record.startFrame)) {
      void this.captureQueuedImage(record);
    }
  }

  /** Captures the start frame of `record` once, off-thread, and hands it over if `record` is still
   *  the jump queued when the image arrives. Frame 0 is replayed here too: a loop at 0 re-enters
   *  through the ring's seed, but a queued hand-off restores only from an image it is given. */
  private async captureQueuedImage(record: QueuedJump): Promise<void> {
    const result = await this.replayEntryImage(record.startFrame);
    if (result === null) return;

    this.rememberEntryImage(result);
    if (this.queuedJump === record) this.activeLoop.setQueuedImage(result.anchor);
  }

  /** Whichever image already stands at `loop`'s own start frame — prepared first, then the cache —
   *  or the track's own loop's entry when nothing is looping. What `setActiveLoop` arms a loop with
   *  in place of a fresh capture. */
  private entryImageFor(loop: ActiveLoop): PositionAnchor | null {
    if (loop === null) return this.trackLoopEntry;
    const held = this.prepared.get(loop.startFrame) ?? this.loopEntries.get(loop.startFrame);
    return held?.anchor ?? null;
  }

  /** Files `entry` under the frame it was taken at, evicting the oldest once the cache is full.
   *  Re-inserted rather than overwritten in place, so a loop being armed again counts as the newest
   *  and a set of loops played against each other keeps every one of their images. */
  private rememberEntryImage(entry: HeldImage): void {
    const frame = entry.anchor.frame;
    this.loopEntries.delete(frame);
    this.loopEntries.set(frame, entry);
    if (this.loopEntries.size > LOOP_ENTRY_CACHE_SIZE) {
      const oldest = this.loopEntries.keys().next();
      if (!oldest.done) this.loopEntries.delete(oldest.value);
    }
  }

  /** Drops every cached entry image, and the prepared ones with them, along with whatever the
   *  tracker presently holds — the same call whether an image came from the track's own loop or a
   *  marker's, since all of them describe a machine a subtune re-init or a fresh detection has just
   *  invalidated. The declared frames are the caller's to keep or clear. */
  private dropEntryImages(): void {
    this.trackLoopEntry = null;
    this.loopEntries.clear();
    // Whatever is in flight is about to come back describing the replaced machine and be dropped by
    // `captureEntryImage`'s own guard, so it must not stand in the way of the recapture that
    // follows.
    this.capturesInFlight.clear();
    this.activeLoop.setEntryImage(null);
    this.activeLoop.setQueuedImage(null);
    this.dropPreparedImages();
  }

  /** Drops every prepared image and the builds still owed, and strands the one in flight: its answer
   *  fails the generation check when it arrives, and a new build need not wait for it. */
  private dropPreparedImages(): void {
    this.prepared.clear();
    this.buildQueue.clear();
    this.activeBuild = null;
    this.preparedGeneration++;
  }

  /** Starts the lowest-framed owed build unless one is already running. Reached only from promise
   *  callbacks and the discrete calls that change what is owed — never from a tick. */
  private scheduleBuilds(): void {
    if (this.activeBuild !== null) return;
    const file = this.session.file;
    if (file === null) return;

    let next: number | null = null;
    for (const frame of this.buildQueue) {
      if (next === null || frame < next) next = frame;
    }
    if (next === null) return;

    const build: PreparedBuild = {
      frame: next,
      generation: this.preparedGeneration,
      file,
      subtune: this.session.currentSubtune,
    };
    this.activeBuild = build;
    void this.runBuild(build);
  }

  /**
   * Replays one declared frame unmuted, continuing from the nearest earlier chainable image so a set
   * costs about one pass to its deepest frame, and lands the answer if it still describes what is
   * declared. Builds one frame and then starts the next.
   *
   * A failed replay is logged by the session and drops the frame from the queue without a retry:
   * the next declaration that names it asks again.
   */
  private async runBuild(build: PreparedBuild): Promise<void> {
    const start = this.chainStartFor(build.frame);
    const result = await this.session.replayImage(frames(build.frame), {
      mutes: NO_VOICES_MUTED,
      ...(start === null ? {} : { start }),
      ...(this.prepareRunner === undefined ? {} : { runner: this.prepareRunner }),
    });
    if (this.activeBuild === build) this.activeBuild = null;

    const current =
      this.preparedGeneration === build.generation &&
      this.session.file === build.file &&
      this.session.currentSubtune === build.subtune &&
      this.declared.has(build.frame);
    if (current) {
      this.buildQueue.delete(build.frame);
      if (result !== null) {
        this.prepared.set(build.frame, { anchor: result, chainable: true, mutedAtCapture: false });
        if (this.activeLoop.get()?.startFrame === build.frame) {
          this.activeLoop.setEntryImage(result);
        }
        if (this.queuedJump?.startFrame === build.frame) {
          this.activeLoop.setQueuedImage(result);
        }
        this.markDirty();
      }
    }
    this.scheduleBuilds();
  }

  /** The chainable prepared image closest to `target` without passing it, or null to build from
   *  init. */
  private chainStartFor(target: number): PositionAnchor | null {
    let nearest: PositionAnchor | null = null;
    for (const held of this.prepared.values()) {
      const frame = held.anchor.frame;
      if (held.chainable && frame <= target && (nearest === null || frame > nearest.frame)) {
        nearest = held.anchor;
      }
    }
    return nearest;
  }

  /** Whether any voice is silenced right now, by a latched mute or a held button — the same
   *  `effectiveMutes` every replay is seeded with. */
  private anyVoiceMuted(): boolean {
    return this.effectiveMutes().some((muted) => muted);
  }

  private fail(reason: string): void {
    this.clock.stop();
    this.error = reason;
    this.transport = 'error';
    this.endVarispeed();
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
    if (this.transport === 'playing' || this.varispeedActive) {
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

  /** The interval a consumer reads: what the clock is running while playing or in varispeed, and
   *  the rate the next `play()` would start at otherwise. */
  private reportedIntervalUs(): Microseconds {
    if (this.session.file === null) return microseconds(0);
    return (this.transport === 'playing' || this.varispeedActive) && this.runningIntervalUs !== null
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
              preparedFrames: Array.from(this.prepared.keys())
                .sort((a, b) => a - b)
                .map((frame) => frames(frame)),
              queuedJump: this.queuedJump,
              handOffs: this.handOffs,
              recordedFrames: this.recordedFrames(),
            },
      tempo: {
        multiplier: this.tempoMultiplier,
        effectiveIntervalUs: this.reportedIntervalUs(),
        nominalIntervalUs: this.nominalIntervalUs,
        callsPerFrame: rate.roundedCallsPerFrame,
        rate,
        timingMode: this.timingMode,
        varispeed: this.varispeedActive,
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

/** `name`, or `name` of voice `n` — enough to tell a refused hold's field apart in a warning. */
function describeField(field: SidField): string {
  return 'voice' in field ? `${field.name} of voice ${field.voice}` : field.name;
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
