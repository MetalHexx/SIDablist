import type { Frames, Microseconds } from '../units.js';
import type { SidFile } from '../sid/sid-file.model.js';
import type { DetectedLoopFrames } from '../timeline/track-structure.js';
import type { TimingMode } from '../clock/play-rate.js';
import type { ScaledRegisterGroup, SidFilterMode } from '../registers/register-frame.js';
import type { RegisterRecord } from '../registers/register-record.js';
import type { SidField } from '../registers/sid-fields.js';
import type { ActiveLoop } from '../timeline/active-loop.js';
import type { DeliveryBatch } from './delivery-history.js';
import type { JumpSettings, PlayerSnapshot, PlayerStats, QueuedJump } from './snapshot.js';

/** Called once a tick while in varispeed, before the tick moves the position. `position` is the
 *  playhead in play calls, fractional; `intervalUs` is this tick's interval. Returns the signed
 *  rate for this tick, in play calls to advance: 1 is normal speed at the current tempo, 0 holds,
 *  negative plays backward. A non-finite return reads as 0. Must not allocate or issue a player
 *  command; pure reads (`getSnapshot`, `getPosition`) are allowed. */
export type VarispeedRateSource = (position: number, intervalUs: number) => number;

/**
 * The shape a consumer sees, decided once and in isolation from the coordinator that populates it
 * (`createSidPlayer`). Every operation a consumer needs has a route: through here, to the
 * application, or to the sink — nothing is dropped silently.
 *
 * The rule that shapes the read side: things a person did notify you; things time did, you go and
 * look at. A performer's action — loading a tune, muting a voice, changing the filter — is a
 * discrete event and rides `subscribe`. The playhead advancing is not something a person caused;
 * it happens fifty times a second whether anyone is watching, so `getPosition()` and `getStats()`
 * are plain reads with no notification, pulled by the consumer on its own schedule.
 */
export interface SidPlayer {
  /** Notifies on discrete state change only. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Referentially stable: identity changes only when the state does. */
  getSnapshot(): PlayerSnapshot;
  /** Not notified — pulled by the consumer on its own schedule. */
  getPosition(): Frames;
  /** Not notified — drift, jitter, lag, late frames, cycle headroom, in-flight depth. */
  getStats(): PlayerStats;

  // Transport and timeline
  loadTune(file: SidFile): void;
  play(): Promise<void>;
  pause(): void;
  stop(): void;
  /** Moves the playhead to `frame`. A target on a held image lands at once; anything else replays
   *  off this thread and resolves once that request has settled — landed, failed or superseded.
   *  With `settings`, they are applied as the jump lands: at once for a frame restored from a held
   *  image, when the replay lands otherwise, and never for a jump that is superseded or discarded
   *  first. In varispeed it moves the varispeed position at once, clamped to the record, with no
   *  replay; settings apply at once. */
  seek(frame: Frames, settings?: JumpSettings): Promise<void>;
  selectSubtune(song: number): void;
  /** Selects the next subtune, clamped to the tune's range. A no-op at the last subtune. */
  nextSubtune(): void;
  /** Selects the previous subtune, clamped to the tune's range. A no-op at the first subtune. */
  previousSubtune(): void;
  /** Replaces the running loop; null clears it. A loop carrying `varispeedStart` also holds
   *  varispeed inside it — see `ActiveLoop`. */
  setActiveLoop(loop: ActiveLoop): void;
  /**
   * Declares the frames the host wants to jump to instantly — loop starts and cue points alike —
   * replacing the previous set; an empty list withdraws all. Each declared frame gets its own
   * snapshot, built off the main thread without moving the playhead; readiness is published in
   * `getSnapshot().tune.preparedFrames`. Cleared by `loadTune` and by a subtune change, so the host
   * declares again after either.
   */
  setJumpTargets(frames: readonly Frames[]): void;
  /** Queues `target` to land at the end of the running loop's current lap, replacing any queued
   *  jump; null cancels. It lands at the first wrap at which its start frame's snapshot is ready —
   *  until then laps continue — and is dropped by `setActiveLoop`, `stop`, `loadTune` and a subtune
   *  change. Ignored, with a warning, when no loop is running: jump now with `setActiveLoop` and
   *  `seek` instead. `target.settings`, when given, are applied as the jump lands, never before,
   *  and are dropped with the queue. */
  queueJump(target: (QueuedJump & { readonly settings?: JumpSettings }) | null): void;
  /**
   * Snapshots the live position into the entry-image cache, a memory copy with no replay, and
   * returns the frame it captured (the same frame `getPosition()` reports), or null with nothing
   * loaded. When that frame is declared, it is ready at once. In varispeed it returns the frame and
   * caches nothing, since the live machine is not at the position.
   */
  capturePosition(): Frames | null;
  /** What detection found about this tune: its loop, its end, its measured length. The
   *  application supplies it; core turns it into the position basis and the end behaviour. */
  setTrackStructure(loop: DetectedLoopFrames | null): void;
  setRepeatTrack(enabled: boolean): void;

  // Varispeed
  /** The record of the tune and subtune loaded now, or null to withdraw it. Dropped by `loadTune`
   *  and by a subtune change that changes the subtune. Refused, with a warning, while in varispeed
   *  or when its shape is unusable. Notifies. */
  setRegisterRecord(record: RegisterRecord | null): void;
  /** Enters varispeed at the current position, or swaps the source when already in it (cancelling
   *  a handback in progress). False, with no effect, when nothing is loaded, the transport is
   *  `error`, there is no record, or the position lies past the record. Notifies. */
  enterVarispeed(source: VarispeedRateSource): boolean;
  /** Leaves varispeed. Playing: hands back to live playback with no seam. Otherwise: the player is
   *  left paused at the position. A no-op outside varispeed. Notifies. */
  leaveVarispeed(): void;

  // Rate
  setTempo(multiplier: number): void;
  setNominalIntervalUs(us: Microseconds): void;
  setTimingMode(mode: TimingMode): void;

  // Register state the performer drives
  setVoiceMuted(voice: number, muted: boolean): void;
  setVoiceHeld(voice: number, held: boolean): void;
  clearVoiceMutes(): void;
  setOutputGain(gain: number): void;
  setFilterMode(mode: SidFilterMode | null): void;
  setRegisterScale(group: ScaledRegisterGroup, coefficient: number): void;
  /** Holds a chip field at `value` (raw, at the field's width) blended by `amount` 0…1 (default 1),
   *  and carries it into every tune loaded after — see `RegisterFrame.holdField`. */
  holdField(field: SidField, value: number, amount?: number): void;
  /** Hands the field back to the tune. The player never releases a hold on its own, except on
   *  dispose. */
  releaseField(field: SidField): void;
  /** Adds `amount` (signed, the field's raw units) to a numeric field on the way out, after any
   *  multiplier and before any hold, and carries it into every tune loaded after — see
   *  `RegisterFrame.setFieldOffset`. An amount of 0 is the same as `clearFieldOffset`. */
  setFieldOffset(field: SidField, amount: number): void;
  /** Hands the field back. The player never clears an offset on its own, except on dispose. */
  clearFieldOffset(field: SidField): void;
  /** Not notified — pulled on the consumer's own schedule, like `getPosition()`. Fills two
   *  caller-owned buffers (≥ SID_REGISTER_COUNT) with the registers as written and as sent;
   *  zeros when nothing is loaded. Allocates nothing. */
  readRegisters(written: Uint8Array, sent: Uint8Array): void;
  /** Keeps the last `capacity` deliveries for the host to drain, so a host that samples slower than
   *  the engine builds frames still sees each one; 0 turns it off and drops what is kept. Carried
   *  into every tune loaded after, like holds and offsets. A non-finite, negative or over-4096
   *  capacity is ignored with a warning. A capacity already in force changes nothing; any other
   *  starts a fresh history, seeded from the registers the live tune last sent when one is loaded.
   *  Allocates here, once. */
  keepDeliveries(capacity: number): void;
  /** Not notified — pulled on the consumer's own schedule. Moves everything delivered since the last
   *  drain into `into`, oldest first, with `dropped` and `restarted` as `DeliveryBatch` defines
   *  them. Allocates nothing. With nothing kept, leaves `into.count` 0. */
  drainDeliveries(into: DeliveryBatch): void;
  /** The φ2 clocks a tune was written for and is playing on. Derived and session-lifetime, not a
   *  performance control — and the application's to supply, since core cannot know the far end. */
  setTargetClock(sourceHz: number, targetHz: number): void;
  /** Live, per voice, user-driven. Composes with the clock ratio and never disturbs it. */
  setVoicePitch(voice: number, coefficient: number): void;

  dispose(): void;
}
