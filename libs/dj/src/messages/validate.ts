import type { DeckCommand, DjInbound, DjRequest } from './commands.js';
import { describeSetting } from './setting-table.js';
import type { SettingInfo } from './setting-table.js';

/** The verdict on one inbound message: the message itself, or why it was refused. */
export type ValidationResult =
  | { readonly ok: true; readonly message: DjInbound }
  | { readonly ok: false; readonly reason: string };

type Obj = Record<string, unknown>;

/** Per-kind rules: the fields the kind may carry beyond the common ones, and a check of their values. */
interface Spec {
  readonly fields: readonly string[];
  readonly check?: (o: Obj, kind: string) => void;
}

/** A refusal, thrown inside this module only and turned into a result at the edge. */
class Refusal extends Error {}

function fail(kind: string, field: string, rule: string): never {
  throw new Refusal(`${kind}: ${field} ${rule}`);
}

function isRecord(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function has(o: Obj, field: string): boolean {
  return Object.hasOwn(o, field);
}

function finite(kind: string, field: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(kind, field, 'must be a finite number');
  return v;
}

function atLeast(kind: string, field: string, v: unknown, min: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) {
    fail(kind, field, `must be a finite number >= ${min}`);
  }
  return v;
}

function above(kind: string, field: string, v: unknown, min: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= min) {
    fail(kind, field, `must be a finite number > ${min}`);
  }
  return v;
}

function integerAtLeast(kind: string, field: string, v: unknown, min: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    fail(kind, field, `must be an integer >= ${min}`);
  }
  return v;
}

function bool(kind: string, field: string, v: unknown): void {
  if (typeof v !== 'boolean') fail(kind, field, 'must be true or false');
}

function oneOf(kind: string, field: string, v: unknown, allowed: readonly unknown[]): void {
  if (!allowed.includes(v)) fail(kind, field, `must be one of ${allowed.map(String).join(', ')}`);
}

function nonEmptyString(kind: string, field: string, v: unknown): void {
  if (typeof v !== 'string' || v.length === 0) fail(kind, field, 'must be a non-empty string');
}

function record(kind: string, field: string, v: unknown, allowed: readonly string[]): Obj {
  if (!isRecord(v)) fail(kind, field, 'must be an object');
  for (const key of Object.keys(v)) {
    if (!allowed.includes(key)) fail(kind, `${field}.${key}`, 'is not a known field');
  }
  return v;
}

/**
 * The most frames one `targets` command may declare. Core holds about 68 KB per declared frame
 * (`libs/core/AGENTS.md`), so 256 frames are about 17 MB a deck.
 */
const MAX_TARGET_FRAMES = 256;

function settingInfo(kind: string, field: string, v: unknown): SettingInfo {
  const info = typeof v === 'number' ? describeSetting(v) : null;
  if (info === null) fail(kind, field, 'must be a setting number');
  return info;
}

function settingValue(kind: string, field: string, info: SettingInfo, v: unknown): void {
  const range = `from ${info.min} to ${info.max}`;
  if (typeof v !== 'number' || !Number.isFinite(v) || (info.whole && !Number.isInteger(v))) {
    fail(kind, field, `must be ${info.whole ? 'a whole' : 'a finite'} number ${range}`);
  }
  if (v < info.min || v > info.max) fail(kind, field, `must be ${range}`);
}

function settingList(kind: string, field: string, v: unknown, nonEmpty = false): void {
  if (!Array.isArray(v)) fail(kind, field, 'must be an array');
  if (nonEmpty && v.length === 0) fail(kind, field, 'must not be empty');
  const seen = new Set<number>();
  v.forEach((entry: unknown, i) => {
    const at = `${field}[${i}]`;
    const e = record(kind, at, entry, ['setting', 'value']);
    const info = settingInfo(kind, `${at}.setting`, e.setting);
    if (seen.has(info.setting)) fail(kind, `${at}.setting`, 'is repeated');
    seen.add(info.setting);
    settingValue(kind, `${at}.value`, info, e.value);
  });
}

function bounds(kind: string, field: string, o: Obj): void {
  const start = atLeast(kind, `${field}startFrame`, o.startFrame, 0);
  const end = o.endFrame;
  if (end === null) return;
  if (typeof end !== 'number' || !Number.isFinite(end)) {
    fail(kind, `${field}endFrame`, 'must be null or a finite number');
  }
  if (end <= start) fail(kind, `${field}endFrame`, `must be after ${field}startFrame`);
}

function jumpTarget(kind: string, v: unknown): void {
  const t = record(kind, 'target', v, ['startFrame', 'endFrame', 'wraps', 'lapPhase', 'settings']);
  if (!has(t, 'endFrame')) fail(kind, 'target.endFrame', 'must be null or a finite number');
  bounds(kind, 'target.', t);
  if (has(t, 'wraps')) bool(kind, 'target.wraps', t.wraps);
  if (has(t, 'lapPhase')) finite(kind, 'target.lapPhase', t.lapPhase);
  if (has(t, 'settings')) settingList(kind, 'target.settings', t.settings);
}

function nullableFinite(kind: string, field: string, v: unknown): void {
  if (v !== null) finite(kind, field, v);
}

function trackLoop(kind: string, v: unknown): void {
  if (v === null) return;
  const t = record(kind, 'trackLoop', v, ['loopStartFrame', 'loopPeriodFrames', 'endedAtFrame']);
  for (const key of ['loopStartFrame', 'loopPeriodFrames', 'endedAtFrame']) {
    if (!has(t, key)) fail(kind, `trackLoop.${key}`, 'must be null or a finite number');
    nullableFinite(kind, `trackLoop.${key}`, t[key]);
  }
}

function grid(kind: string, v: unknown): void {
  if (v === null) return;
  const g = record(kind, 'grid', v, ['beatFrames', 'beatOneFrame']);
  atLeast(kind, 'grid.beatFrames', g.beatFrames, 1);
  atLeast(kind, 'grid.beatOneFrame', g.beatOneFrame, 0);
}

function when(kind: string, v: unknown): void {
  if (!isRecord(v)) fail(kind, 'when', 'must be an object');
  switch (v.at) {
    case 'now':
      record(kind, 'when', v, ['at']);
      return;
    case 'frame':
      record(kind, 'when', v, ['at', 'frame']);
      integerAtLeast(kind, 'when.frame', v.frame, 0);
      return;
    case 'pass-end':
      record(kind, 'when', v, ['at', 'from']);
      if (has(v, 'from')) integerAtLeast(kind, 'when.from', v.from, 0);
      return;
    default:
      fail(kind, 'when.at', "must be 'now', 'frame' or 'pass-end'");
  }
}

const COMMANDS = {
  'add-deck': { fields: [] },
  'remove-deck': { fields: [] },
  load: {
    fields: ['tune', 'subtune', 'speed', 'settings', 'trackLoop', 'grid', 'ends'],
    check(o, kind) {
      nonEmptyString(kind, 'tune', o.tune);
      integerAtLeast(kind, 'subtune', o.subtune, 1);
      if (has(o, 'speed')) above(kind, 'speed', o.speed, 0);
      if (has(o, 'settings')) settingList(kind, 'settings', o.settings);
      if (has(o, 'trackLoop')) trackLoop(kind, o.trackLoop);
      if (has(o, 'grid')) grid(kind, o.grid);
      if (has(o, 'ends')) oneOf(kind, 'ends', o.ends, ['playing', 'paused', 'stopped']);
    },
  },
  play: { fields: [] },
  pause: { fields: [] },
  stop: { fields: [] },
  seek: {
    fields: ['frame'],
    check: (o, kind) => void finite(kind, 'frame', o.frame),
  },
  speed: {
    fields: ['value'],
    check: (o, kind) => void above(kind, 'value', o.value, 0),
  },
  nudge: {
    fields: ['amount'],
    check: (o, kind) => void finite(kind, 'amount', o.amount),
  },
  'speed-jump': {
    fields: ['amount'],
    check: (o, kind) => void finite(kind, 'amount', o.amount),
  },
  repeat: {
    fields: ['on'],
    check: (o, kind) => bool(kind, 'on', o.on),
  },
  setting: {
    fields: ['setting', 'value'],
    check(o, kind) {
      settingValue(kind, 'value', settingInfo(kind, 'setting', o.setting), o.value);
    },
  },
  settings: {
    fields: ['settingsIn', 'changes'],
    check(o, kind) {
      oneOf(kind, 'settingsIn', o.settingsIn, ['main', 'loop']);
      settingList(kind, 'changes', o.changes, true);
    },
  },
  'voice-hold': {
    fields: ['voice', 'held'],
    check(o, kind) {
      if (typeof o.voice !== 'number' || !Number.isInteger(o.voice) || o.voice < 0 || o.voice > 2) {
        fail(kind, 'voice', 'must be an integer from 0 to 2');
      }
      bool(kind, 'held', o.held);
    },
  },
  'flip-lock': {
    fields: ['setting', 'lock'],
    check(o, kind) {
      const info = settingInfo(kind, 'setting', o.setting);
      if (info.kind !== 'hold' || info.max !== 1) {
        fail(kind, 'setting', 'must be the hold of a one-bit switch');
      }
      if (has(o, 'lock')) bool(kind, 'lock', o.lock);
    },
  },
  tap: {
    fields: ['atMs'],
    check: (o, kind) => void finite(kind, 'atMs', o.atMs),
  },
  'tap-end': { fields: [] },
  targets: {
    fields: ['frames'],
    check(o, kind) {
      if (!Array.isArray(o.frames)) fail(kind, 'frames', 'must be an array');
      if (o.frames.length > MAX_TARGET_FRAMES) {
        fail(kind, 'frames', `must hold at most ${MAX_TARGET_FRAMES} entries`);
      }
      o.frames.forEach((f: unknown, i) => atLeast(kind, `frames[${i}]`, f, 0));
    },
  },
  jump: {
    fields: ['target'],
    check: (o, kind) => jumpTarget(kind, o.target),
  },
  'hot-cue': {
    fields: ['target'],
    check: (o, kind) => jumpTarget(kind, o.target),
  },
  'cancel-queued': { fields: [] },
  'let-go': { fields: [] },
  'stop-loop': { fields: [] },
  'loop-bounds': {
    fields: ['startFrame', 'endFrame', 'lapPhase'],
    check(o, kind) {
      if (!has(o, 'endFrame')) fail(kind, 'endFrame', 'must be null or a finite number');
      bounds(kind, '', o);
      if (has(o, 'lapPhase')) finite(kind, 'lapPhase', o.lapPhase);
    },
  },
  'loop-wraps': {
    fields: ['wraps'],
    check: (o, kind) => bool(kind, 'wraps', o.wraps),
  },
  capture: { fields: [] },
  'hand-touch': {
    fields: ['atMs'],
    check: (o, kind) => void finite(kind, 'atMs', o.atMs),
  },
  'hand-move': {
    fields: ['travelFrames', 'atMs'],
    check(o, kind) {
      finite(kind, 'travelFrames', o.travelFrames);
      finite(kind, 'atMs', o.atMs);
    },
  },
  'hand-lift': {
    fields: ['atMs', 'gripSeconds'],
    check(o, kind) {
      finite(kind, 'atMs', o.atMs);
      above(kind, 'gripSeconds', o.gripSeconds, 0);
    },
  },
  slip: {
    fields: ['on'],
    check: (o, kind) => bool(kind, 'on', o.on),
  },
  'live-loop-size': {
    fields: ['lengthFrames'],
    check: (o, kind) => void atLeast(kind, 'lengthFrames', o.lengthFrames, 2),
  },
  'live-loop': { fields: [] },
  'live-loop-end': { fields: [] },
  'live-loop-adopt': { fields: [] },
} as const satisfies Record<DeckCommand['kind'], Spec>;

const REQUESTS = {
  describe: { fields: [] },
  registers: { fields: [] },
  'keep-deliveries': {
    fields: ['capacity'],
    check(o, kind) {
      const capacity = integerAtLeast(kind, 'capacity', o.capacity, 0);
      if (capacity > 4096) fail(kind, 'capacity', 'must be an integer <= 4096');
    },
  },
  deliveries: { fields: [] },
} as const satisfies Record<DjRequest['kind'], Spec>;

const COMMAND_COMMON = ['kind', 'deck', 'when', 'pressedAtMs'];
const REQUEST_COMMON = ['kind', 'deck'];

function inspect(message: unknown): DjInbound {
  if (!isRecord(message)) fail('message', 'must be', 'an object');
  const kind = message.kind;
  if (typeof kind !== 'string') fail('message', 'kind', 'must be a string');

  const isRequest = Object.hasOwn(REQUESTS, kind);
  if (!isRequest && !Object.hasOwn(COMMANDS, kind)) {
    fail('message', 'kind', `is not known: ${JSON.stringify(kind.slice(0, 40))}`);
  }
  const spec: Spec = isRequest
    ? REQUESTS[kind as keyof typeof REQUESTS]
    : COMMANDS[kind as keyof typeof COMMANDS];

  nonEmptyString(kind, 'deck', message.deck);
  if (isRequest && has(message, 'when')) fail(kind, 'when', 'is not allowed on a request');
  const allowed = [...(isRequest ? REQUEST_COMMON : COMMAND_COMMON), ...spec.fields];
  for (const key of Object.keys(message)) {
    if (!allowed.includes(key)) fail(kind, key, 'is not a known field');
  }
  if (!isRequest) {
    if (has(message, 'when')) when(kind, message.when);
    if (has(message, 'pressedAtMs')) finite(kind, 'pressedAtMs', message.pressedAtMs);
  }
  spec.check?.(message, kind);
  return message as unknown as DjInbound;
}

/**
 * Checks an untrusted message's shape and ranges, by kind. Total: it never throws, whatever it is
 * given. A refusal's reason names the kind and the field; unknown extra fields are refused so a
 * typo is never silently ignored.
 */
export function validateInbound(message: unknown): ValidationResult {
  try {
    return { ok: true, message: inspect(message) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Refusal ? error.message : 'message: could not be read',
    };
  }
}
