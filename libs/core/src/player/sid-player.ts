import type { Frames, Microseconds } from '../units.js';
import type { SidFile } from '../sid/sid-file.model.js';
import type { DetectedLoopFrames } from '../timeline/track-structure.js';
import type { TimingMode } from '../clock/play-rate.js';
import type { ScaledRegisterGroup, SidFilterMode } from '../registers/register-frame.js';
import type { PlayerSnapshot, PlayerStats } from './snapshot.js';

/**
 * The shape a consumer sees, decided once and in isolation from the coordinator that populates it
 * (`createSidPlayer`, landing in P05-T07). Every operation the engine it replaces exposed either
 * has a route through here, moved to the application, or moved to the sink — nothing is dropped
 * silently.
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
  seek(frame: Frames): Promise<void>;
  selectSubtune(song: number): void;
  setActiveLoop(loop: { startFrame: Frames; endFrame: Frames } | null): void;
  /** What detection found about this tune: its loop, its end, its measured length. The
   *  application supplies it; core turns it into the position basis and the end behaviour. */
  setTrackStructure(loop: DetectedLoopFrames | null): void;
  setRepeatTrack(enabled: boolean): void;

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
  /** Pitch correction, added in P07-T01. Derived and session-lifetime, not a performance
   *  control. */
  setTargetClock(sourceHz: number, targetHz: number): void;
  /** Live, per voice, user-driven. Composes with the clock ratio and never disturbs it. */
  setVoicePitch(voice: number, coefficient: number): void;

  dispose(): void;
}
