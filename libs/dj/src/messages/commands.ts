/**
 * What a host sends a deck: commands that change it and requests that read it. All plain data, so a
 * message survives structured clone and `postMessage`: no classes, functions, `Map`, `Set`, `Date`
 * or `undefined`-only meaning.
 */

/** Names one deck among those a host has added. */
export type DeckId = string;

/** When a command lands. The package fixes it to a stream frame when it receives the command. */
export type When =
  /** The next frame not yet sent. */
  | { readonly at: 'now' }
  /** A stream frame. One already sent lands as `now`. */
  | { readonly at: 'frame'; readonly frame: number }
  /**
   * The running loop's next wrap, as seen from stream frame `from` (default: the next frame not yet
   * sent); `now` with no loop running there. `from` is how a recording replays a pass-end command.
   */
  | { readonly at: 'pass-end'; readonly from?: number };

/** One numbered setting. Numbers are fixed and never reused; a later iteration adds more. */
export interface NumberedSetting {
  /** The setting's number: one of the `SETTING` values. */
  readonly setting: number;
  /** The setting's value: 0 or 1 for the voice mutes. */
  readonly value: number;
}

/** This iteration's settings: the voice mutes, 0 sounding, 1 muted. */
export const SETTING = { VOICE_1_MUTE: 1, VOICE_2_MUTE: 2, VOICE_3_MUTE: 3 } as const;

/** A loop (`endFrame` set) or a cue (`endFrame` null), in tune frames, carrying everything it lands with. */
export interface JumpTarget {
  /** Where the loop or cue starts, in tune frames. */
  readonly startFrame: number;
  /** Where the loop ends, in tune frames; null for a cue. */
  readonly endFrame: number | null;
  /** A thrown or scrubbed record wraps round the loop (loops only). */
  readonly wraps?: boolean;
  /** Core's `ActiveLoop.lapPhase`, for a length that is not whole. */
  readonly lapPhase?: number;
  /** The loop's own settings; absent: it plays with the main ones. */
  readonly settings?: readonly NumberedSetting[];
}

/** The tune's own loop as detection found it: the three fields a host's index record holds. */
export interface TrackLoop {
  /** Where the tune's loop starts, in tune frames; null when none was found. */
  readonly loopStartFrame: number | null;
  /** The loop's length in play calls; null when none was found. */
  readonly loopPeriodFrames: number | null;
  /** The frame the tune ended at, when it ended; null otherwise. */
  readonly endedAtFrame: number | null;
}

/** A grid the host kept. */
export interface Grid {
  /** Whole play calls per beat, at least 1. */
  readonly beatFrames: number;
  /** A frame a beat falls on, at least 0. */
  readonly beatOneFrame: number;
}

interface CommandBase {
  /** The deck the command is for. */
  readonly deck: DeckId;
  /** When it lands; absent: now. */
  readonly when?: When;
  /** Host time (the `TimeSource` timeline) the press happened. */
  readonly pressedAtMs?: number;
}

/** A command: a message that changes a deck. Recorded, and replayable from its `landed` event. */
export type DeckCommand = CommandBase &
  /** Puts a new, empty deck on the desk. */
  (
    | { readonly kind: 'add-deck' }
    /** Takes the deck off the desk and frees what it holds. */
    | { readonly kind: 'remove-deck' }
    /**
     * Loads a tune into the deck. `ends` omitted keeps the deck's transport, and the same `tune`
     * with another `subtune` is how a subtune is chosen.
     */
    | {
        readonly kind: 'load';
        /** The tune's reference, which the host's `fetchTune` resolves to bytes. */
        readonly tune: string;
        /** The subtune to play, from 1. */
        readonly subtune: number;
        /** The deck's speed after the load (default 1). */
        readonly speed?: number;
        /** The main settings; voices it does not name sound. */
        readonly settings?: readonly NumberedSetting[];
        /** The tune's own loop as detection found it. */
        readonly trackLoop?: TrackLoop | null;
        /** The beat grid the host kept for the tune. */
        readonly grid?: Grid | null;
        /** The transport the load ends in. */
        readonly ends?: 'playing' | 'paused' | 'stopped';
      }
    /** Starts the deck playing from where it is. */
    | { readonly kind: 'play' }
    /** Holds the deck where it is. */
    | { readonly kind: 'pause' }
    /** Stops the deck and returns the playhead to the start. */
    | { readonly kind: 'stop' }
    /** Moves the playhead to a tune frame (never a stream frame). */
    | { readonly kind: 'seek'; readonly frame: number }
    /** Sets the deck's own speed, a multiplier above 0. */
    | { readonly kind: 'speed'; readonly value: number }
    /** A signed tempo offset held while the DJ holds it (0 releases it): a pitch-bend nudge. */
    | { readonly kind: 'nudge'; readonly amount: number }
    /**
     * A signed tempo offset kept until it is removed (0 removes it). The tempo is the speed, the
     * nudge and this jump added together.
     */
    | { readonly kind: 'speed-jump'; readonly amount: number }
    /** Turns repeat on or off: whether the tune starts over when it ends. */
    | { readonly kind: 'repeat'; readonly on: boolean }
    /** Sets one numbered setting on the deck's main settings. */
    | { readonly kind: 'setting'; readonly setting: number; readonly value: number }
    /** Names the tune frames the deck keeps ready so a jump to one lands without delay. */
    | { readonly kind: 'targets'; readonly frames: readonly number[] }
    /** Jumps to a loop or cue, in tune frames, when the command lands. */
    | { readonly kind: 'jump'; readonly target: JumpTarget }
    /** A hot-key press on a loop or cue: starts it, queues it, cancels it or lets go. */
    | { readonly kind: 'key'; readonly target: JumpTarget }
    /** Cancels a jump waiting for the end of the pass. */
    | { readonly kind: 'cancel-queued' }
    /** Lets go of the running loop, so play carries on past its end. */
    | { readonly kind: 'let-go' }
    /** Stops the running loop and plays straight on. */
    | { readonly kind: 'stop-loop' }
    /** Moves the running loop's bounds, in tune frames. */
    | {
        readonly kind: 'loop-bounds';
        readonly startFrame: number;
        readonly endFrame: number | null;
        readonly lapPhase?: number;
      }
    /** Sets whether a thrown or scrubbed record wraps round the running loop. */
    | { readonly kind: 'loop-wraps'; readonly wraps: boolean }
    /** Captures the playhead as a cue. */
    | { readonly kind: 'capture' }
    /** The DJ's hand lands on the record at host time `atMs`. */
    | { readonly kind: 'hand-touch'; readonly atMs: number }
    /**
     * The hand moves the record. `travelFrames` is how far it has moved since its touch, in play
     * calls; the host converts its strip with its own reach.
     */
    | { readonly kind: 'hand-move'; readonly travelFrames: number; readonly atMs: number }
    /**
     * The hand lifts and the record is thrown. `gripSeconds` is the seconds friction takes to
     * change the record's rate by 1x.
     */
    | { readonly kind: 'hand-lift'; readonly atMs: number; readonly gripSeconds: number }
    /** Turns slip mode on or off: the record carries on underneath a loop or the hand. */
    | { readonly kind: 'slip'; readonly on: boolean }
    /** Sets the live loop's length in frames, which may be fractional. */
    | { readonly kind: 'live-loop-size'; readonly lengthFrames: number }
    /** Starts a live loop from the playhead. */
    | { readonly kind: 'live-loop' }
    /** Ends the live loop's recording, closing the loop. */
    | { readonly kind: 'live-loop-end' }
    /** Adopts the live loop as the deck's running loop. */
    | { readonly kind: 'live-loop-adopt' }
  );

/** Requests read a deck and change nothing: they are never recorded and take no `when`. */
export type DjRequest =
  /** Answered by a `DeckPicture`. */
  | { readonly kind: 'describe'; readonly deck: DeckId }
  /** Answered by a `DeckRegisters`. */
  | { readonly kind: 'registers'; readonly deck: DeckId }
  /** Keeps the last `capacity` register deliveries for `deliveries` to drain; 0 turns it off. */
  | { readonly kind: 'keep-deliveries'; readonly deck: DeckId; readonly capacity: number }
  /** Answered by a `DeckDeliveries`. */
  | { readonly kind: 'deliveries'; readonly deck: DeckId };

/** Everything a host can send. */
export type DjInbound = DeckCommand | DjRequest;
