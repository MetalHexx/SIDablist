import { describe, expect, it } from 'vitest';
import { INBOUND_SAMPLES } from '../testing/samples.js';
import { validateInbound } from './validate.js';

/** A copy of a sample with fields changed; `undefined` removes a field. */
function variant(kind: keyof typeof INBOUND_SAMPLES, changes: Record<string, unknown>): unknown {
  const copy: Record<string, unknown> = { ...INBOUND_SAMPLES[kind] };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete copy[key];
    else copy[key] = value;
  }
  return copy;
}

function reasonFor(message: unknown): string {
  const result = validateInbound(message);
  if (result.ok) throw new Error('expected a refusal');
  return result.reason;
}

describe('validateInbound', () => {
  it.each(Object.entries(INBOUND_SAMPLES))('accepts a well-formed %s', (_kind, sample) => {
    const result = validateInbound(sample);
    expect(result).toEqual({ ok: true, message: sample });
  });

  it('accepts the minimal form of a command with every option left out', () => {
    expect(validateInbound({ kind: 'load', deck: 'a', tune: 't', subtune: 1 }).ok).toBe(true);
    expect(
      validateInbound({ kind: 'jump', deck: 'a', target: { startFrame: 0, endFrame: null } }).ok,
    ).toBe(true);
  });

  const refused: readonly (readonly [string, unknown, string, string])[] = [
    ['an empty deck', variant('play', { deck: '' }), 'play', 'deck'],
    ['a missing deck', variant('play', { deck: undefined }), 'play', 'deck'],
    ['a non-string deck', variant('play', { deck: 3 }), 'play', 'deck'],
    ['an unknown kind', { kind: 'explode', deck: 'a' }, 'message', 'kind'],
    ['a missing kind', { deck: 'a' }, 'message', 'kind'],
    ['an unknown extra field', variant('play', { loudness: 11 }), 'play', 'loudness'],
    [
      'an unknown extra field on a target',
      variant('jump', { target: { startFrame: 0, endFrame: null, x: 1 } }),
      'jump',
      'target.x',
    ],
    ['an unknown when form', variant('play', { when: { at: 'soon' } }), 'play', 'when.at'],
    ['a when that is not an object', variant('play', { when: 'now' }), 'play', 'when'],
    [
      'a negative when frame',
      variant('play', { when: { at: 'frame', frame: -1 } }),
      'play',
      'when.frame',
    ],
    [
      'a fractional when frame',
      variant('play', { when: { at: 'frame', frame: 1.5 } }),
      'play',
      'when.frame',
    ],
    [
      'a frame when with no frame',
      variant('play', { when: { at: 'frame' } }),
      'play',
      'when.frame',
    ],
    [
      'a negative pass-end from',
      variant('play', { when: { at: 'pass-end', from: -2 } }),
      'play',
      'when.from',
    ],
    [
      'a fractional pass-end from',
      variant('play', { when: { at: 'pass-end', from: 0.5 } }),
      'play',
      'when.from',
    ],
    ['a non-finite pressedAtMs', variant('play', { pressedAtMs: Infinity }), 'play', 'pressedAtMs'],
    ['a speed of zero', variant('speed', { value: 0 }), 'speed', 'value'],
    ['a load speed below zero', variant('load', { speed: -1 }), 'load', 'speed'],
    ['a subtune of zero', variant('load', { subtune: 0 }), 'load', 'subtune'],
    ['a fractional subtune', variant('load', { subtune: 1.5 }), 'load', 'subtune'],
    ['an empty tune', variant('load', { tune: '' }), 'load', 'tune'],
    ['an unknown ends', variant('load', { ends: 'dancing' }), 'load', 'ends'],
    ['a non-finite nudge', variant('nudge', { amount: NaN }), 'nudge', 'amount'],
    ['a non-finite seek', variant('seek', { frame: 'x' }), 'seek', 'frame'],
    ['a non-boolean repeat', variant('repeat', { on: 1 }), 'repeat', 'on'],
    ['a negative target frame', variant('targets', { frames: [0, -1] }), 'targets', 'frames[1]'],
    ['targets that are not a list', variant('targets', { frames: 5 }), 'targets', 'frames'],
    [
      'a jump target starting below zero',
      variant('jump', { target: { startFrame: -1, endFrame: null } }),
      'jump',
      'target.startFrame',
    ],
    [
      'a jump target ending before its start',
      variant('jump', { target: { startFrame: 10, endFrame: 10 } }),
      'jump',
      'target.endFrame',
    ],
    [
      'a key target with a non-boolean wraps',
      variant('key', { target: { startFrame: 1, endFrame: 5, wraps: 'yes' } }),
      'key',
      'target.wraps',
    ],
    [
      'a key target missing its end',
      variant('key', { target: { startFrame: 1 } }),
      'key',
      'target.endFrame',
    ],
    [
      'loop bounds ending before their start',
      variant('loop-bounds', { startFrame: 20, endFrame: 10 }),
      'loop-bounds',
      'endFrame',
    ],
    [
      'a live loop shorter than two frames',
      variant('live-loop-size', { lengthFrames: 1 }),
      'live-loop-size',
      'lengthFrames',
    ],
    ['a grip of zero', variant('hand-lift', { gripSeconds: 0 }), 'hand-lift', 'gripSeconds'],
    [
      'a hand move with no travel',
      variant('hand-move', { travelFrames: undefined }),
      'hand-move',
      'travelFrames',
    ],
    ['an unknown setting', variant('setting', { setting: 9 }), 'setting', 'setting'],
    ['a setting value other than 0 or 1', variant('setting', { value: 2 }), 'setting', 'value'],
    [
      'a repeated setting in a list',
      variant('load', {
        settings: [
          { setting: 1, value: 0 },
          { setting: 1, value: 1 },
        ],
      }),
      'load',
      'settings[1].setting',
    ],
    [
      'a setting entry value out of range',
      variant('load', { settings: [{ setting: 1, value: 5 }] }),
      'load',
      'settings[0].value',
    ],
    [
      'a grid with beatFrames below 1',
      variant('load', { grid: { beatFrames: 0, beatOneFrame: 0 } }),
      'load',
      'grid.beatFrames',
    ],
    [
      'a grid with a negative beat one',
      variant('load', { grid: { beatFrames: 4, beatOneFrame: -1 } }),
      'load',
      'grid.beatOneFrame',
    ],
    [
      'a trackLoop with a non-numeric field',
      variant('load', {
        trackLoop: { loopStartFrame: 'x', loopPeriodFrames: null, endedAtFrame: null },
      }),
      'load',
      'trackLoop.loopStartFrame',
    ],
    [
      'a negative keep-deliveries capacity',
      variant('keep-deliveries', { capacity: -1 }),
      'keep-deliveries',
      'capacity',
    ],
    [
      'a keep-deliveries capacity above 4096',
      variant('keep-deliveries', { capacity: 4097 }),
      'keep-deliveries',
      'capacity',
    ],
    [
      'a fractional keep-deliveries capacity',
      variant('keep-deliveries', { capacity: 1.5 }),
      'keep-deliveries',
      'capacity',
    ],
    ['a request with a when', variant('describe', { when: { at: 'now' } }), 'describe', 'when'],
    [
      'a request with a pressedAtMs',
      variant('registers', { pressedAtMs: 1 }),
      'registers',
      'pressedAtMs',
    ],
  ];

  it.each(refused)('refuses %s, naming the kind and the field', (_name, message, kind, field) => {
    const reason = reasonFor(message);
    expect(reason).toContain(kind);
    expect(reason).toContain(field);
  });

  it('words the jump target refusal as the contract shows', () => {
    expect(reasonFor(variant('jump', { target: { startFrame: 10, endFrame: 5 } }))).toBe(
      'jump: target.endFrame must be after target.startFrame',
    );
  });

  it('never throws on garbage', () => {
    const cyclic: Record<string, unknown> = { kind: 'jump', deck: 'a' };
    cyclic.target = cyclic;
    const cyclicField: Record<string, unknown> = { kind: 'play', deck: 'a' };
    cyclicField.self = cyclicField;
    const throwing = {
      kind: 'play',
      get deck(): string {
        throw new Error('boom');
      },
    };
    const garbage: unknown[] = [
      null,
      undefined,
      42,
      'play',
      [],
      [{ kind: 'play', deck: 'a' }],
      Symbol('x'),
      () => 1,
      cyclic,
      cyclicField,
      throwing,
      { kind: 'constructor', deck: 'a' },
      { kind: '__proto__', deck: 'a' },
    ];
    for (const message of garbage) {
      expect(validateInbound(message).ok).toBe(false);
    }
  });
});
