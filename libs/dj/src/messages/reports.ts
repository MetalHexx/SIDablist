import type { DeliveryBatch } from '@sidablist/core';
import type { DeckCommand, DeckId, Grid, JumpTarget, NumberedSetting, When } from './commands.js';

/** One per deck per delivered frame. The package reuses one object per deck: copy what you keep. */
export interface DeckUpdate {
  readonly kind: 'update';
  readonly deck: DeckId;
  /** The frame just delivered. */
  readonly streamFrame: number;
  /** When it is due, on the `TimeSource` timeline. */
  readonly dueAtMs: number;
  /** The play-call interval it was paced at (tempo and the tune's rate). */
  readonly intervalUs: number;
  /** The playhead, in tune frames (fractional under the hand). */
  readonly position: number;
  /** 0 <= p < 1 through the running loop's lap; null with none. */
  readonly lapProgress: number | null;
  /** Where slip will land; null with no departure. */
  readonly slipPosition: number | null;
}

/** How a `key` press resolved. */
export type KeyResolution = 'start' | 'queue' | 'cancel' | 'let-go';

/** Something that happened to a deck. */
export type DeckEvent =
  | {
      /** A command took effect. */
      readonly kind: 'landed';
      readonly deck: DeckId;
      /** As the host asked, its own `when` included. */
      readonly command: DeckCommand;
      /**
       * The replayable form: `{ at: 'frame', frame }` for now and frame, `{ at: 'pass-end', from }`
       * for pass-end. Sending `{ ...command, when: fixed }` again gives the same output.
       */
      readonly fixed: When;
      /** The stream frame it took effect on. */
      readonly frame: number;
      /** Milliseconds from the press to the landing; null when the command carried no press time. */
      readonly waitMs: number | null;
      /** For a `key` command: how the press resolved. */
      readonly resolved?: KeyResolution;
      /** Which settings the deck plays with after this landing. */
      readonly settingsIn?: 'main' | 'loop';
    }
  | {
      /** A tune finished loading. */
      readonly kind: 'loaded';
      readonly deck: DeckId;
      readonly tune: string;
      readonly subtune: number;
      /** How many subtunes the tune holds. */
      readonly subtuneCount: number;
      readonly frame: number;
    }
  | {
      /** A tune could not be loaded. */
      readonly kind: 'load-failed';
      readonly deck: DeckId;
      readonly tune: string;
      readonly reason: string;
    }
  | {
      /** A queued or waiting jump landed. */
      readonly kind: 'jump-landed';
      readonly deck: DeckId;
      readonly frame: number;
      /** At the loop's wrap, or as soon as its target was ready. */
      readonly via: 'pass-end' | 'ready';
      readonly startFrame: number;
      readonly endFrame: number | null;
    }
  | {
      /** The playhead was captured. */
      readonly kind: 'captured';
      readonly deck: DeckId;
      readonly frame: number;
      readonly position: number;
    };

/** A deck as it stands, answering `describe`. */
export interface DeckPicture {
  readonly kind: 'picture';
  readonly deck: DeckId;
  readonly transport: 'empty' | 'loading' | 'stopped' | 'playing' | 'paused' | 'ended' | 'failed';
  /** The loaded tune; null with none. */
  readonly tune: {
    readonly tune: string;
    readonly subtune: number;
    readonly subtuneCount: number;
    /** The tune's length in frames; null while unknown. */
    readonly lengthFrames: number | null;
    /** Whether the record (the render the hand and rewind work on) is ready. */
    readonly recordReady: boolean;
  } | null;
  /** The tempo's parts and their sum. */
  readonly tempo: {
    readonly speed: number;
    readonly nudge: number;
    readonly jump: number;
    readonly effective: number;
  };
  readonly repeat: boolean;
  /** The bounds actually playing; null with no loop. */
  readonly loop: {
    readonly startFrame: number;
    readonly endFrame: number;
    readonly wraps: boolean;
    readonly lapPhase?: number;
    readonly live: boolean;
  } | null;
  /** Waiting for the end of the pass. */
  readonly queued: JumpTarget | null;
  /** Waiting for its target to be ready. */
  readonly waiting: JumpTarget | null;
  /** Loop bounds set but not yet playing. */
  readonly pendingBounds: { readonly startFrame: number; readonly endFrame: number } | null;
  /** The live loop; null with none. */
  readonly liveLoop: {
    readonly lengthFrames: number;
    readonly pendingEndFrame: number | null;
    readonly overLoop: boolean;
  } | null;
  /** The size the next live loop starts at; null when unset. */
  readonly liveLoopSize: number | null;
  readonly slip: { readonly on: boolean; readonly departed: boolean };
  /** Where the hand is: off the record, on it, or the record thrown. */
  readonly hand: 'up' | 'down' | 'thrown';
  readonly settingsInPlay: 'main' | 'loop';
  readonly settings: {
    readonly main: readonly NumberedSetting[];
    readonly loop: readonly NumberedSetting[] | null;
  };
  /** The tune frames whose targets are ready to land on. */
  readonly readyFrames: readonly number[];
  readonly grid: Grid | null;
  /** The tune's play rate; null before a tune is loaded. */
  readonly rate: { readonly exactCallsPerFrame: number; readonly nominalIntervalUs: number } | null;
  /** The deck's output; null with none set. */
  readonly output: {
    readonly lookaheadMs: number;
    readonly heldFrames: number;
    readonly ringSlots: number;
    readonly ringBytes: number;
  } | null;
  /** Delivery timing counters since the load. */
  readonly timing: {
    readonly framesDelivered: number;
    readonly lateFrames: number;
    readonly worstLateMs: number;
    readonly rewinds: number;
    readonly rewoundFrames: number;
    readonly lastRewindMs: number;
    readonly worstRewindMs: number;
    readonly ringShort: number;
    readonly frontierLandings: number;
  };
  /** The last error's text; null with none. */
  readonly error: string | null;
}

/** The chip's 25 registers as the tune wrote them and as they were sent, at the render frontier. */
export interface DeckRegisters {
  readonly kind: 'registers';
  readonly deck: DeckId;
  readonly streamFrame: number;
  /** The registers as the tune wrote them. */
  readonly written: Uint8Array;
  /** The registers as they were sent to the sink. */
  readonly sent: Uint8Array;
}

/**
 * Every delivery since the last drain, in core's `DeliveryBatch` shape (plain typed arrays). It is
 * the engine's own history of what it delivered, not of what the sink passed: a rewind leaves it
 * alone, so a drained batch can hold a frame a rewind replaced and then its replacement.
 */
export interface DeckDeliveries {
  readonly kind: 'deliveries';
  readonly deck: DeckId;
  readonly batch: DeliveryBatch;
}

/** Everything a deck reports. */
export type DjReport = DeckUpdate | DeckEvent | DeckPicture | DeckRegisters | DeckDeliveries;
