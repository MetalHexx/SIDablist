import type { DeckCommand, DeckId } from '../messages/commands.js';
import type { WireEvent } from './holding-sink.js';
import { Rig, type RigOptions } from './harness.js';

/** Spec-only. A command pressed at a moment of the run. */
export interface Press {
  /** Fake time the press is sent at, in milliseconds from the start of the run. */
  readonly atMs: number;
  /**
   * The command, made once, when the press happens, so it can read the rig (the frame it means to
   * land on). The straight deck is given the same command with its `when` replaced by the frame
   * the rewound one landed it on.
   */
  readonly command: (deck: DeckId, rig: Rig) => DeckCommand;
}

export interface ComparisonOptions {
  /** A bundled tune's id. Default `still-time`. */
  readonly tune?: string;
  /** How far ahead the deck renders into its holding sink. Default 60. */
  readonly lookaheadMs?: number;
  /** More of the load both decks are sent, such as a `grid`. */
  readonly load?: Partial<Extract<DeckCommand, { kind: 'load' }>>;
  /** Sent to both decks, paused after their load, before they play: targets, settings. */
  readonly prepare?: (deck: DeckId) => readonly DeckCommand[];
  readonly presses: readonly Press[];
  /** How long the run lasts, in milliseconds. */
  readonly runMs: number;
  readonly rig?: RigOptions;
}

export interface Comparison {
  /** The deck that took each press at `now`, with frames held, and rewound for it. */
  readonly rewound: Rig;
  /** The deck that took every command at the frame the rewound one landed it on, before it ran. */
  readonly straight: Rig;
  /** The frame each press landed on in the rewound deck, from its `landed` event. */
  readonly landings: readonly number[];
  /** The first way the two decks' output differs, or null when it is the same. */
  readonly difference: string | null;
}

const DECK: DeckId = 'a';

/** Adds, loads and starts a rig's deck, paused first so `prepare` can finish before frames run. */
async function start(rig: Rig, options: ComparisonOptions): Promise<void> {
  rig.addDeck(DECK, { lookaheadMs: options.lookaheadMs ?? 60 });
  await rig.load(DECK, options.tune ?? 'still-time', { ...options.load, ends: 'paused' });
  for (const command of options.prepare?.(DECK) ?? []) rig.send(command);
  await rig.settle();
  rig.send({ kind: 'play', deck: DECK });
  await rig.settle();
}

/**
 * Moves the rig through `runMs`, calling `press` for each press at its moment, ticking every 5 ms.
 * Presses at the same moment are sent together, so one flush takes them all.
 */
async function run(
  rig: Rig,
  runMs: number,
  moments: readonly number[],
  press: (index: number) => void,
): Promise<void> {
  let at = 0;
  const order = moments.map((atMs, index) => ({ atMs, index })).sort((a, b) => a.atMs - b.atMs);
  for (let i = 0; i < order.length;) {
    const atMs = order[i].atMs;
    rig.advance(atMs - at);
    at = atMs;
    for (; i < order.length && order[i].atMs === atMs; i++) press(order[i].index);
    await rig.microtasks();
  }
  rig.advance(runMs - at);
}

/**
 * Runs the same tune on two decks and compares what reached their sinks, frame for frame, due
 * times and frame numbers included. The first deck takes each press at `now`, in the middle of
 * the frames it holds, so every press rewinds. The second never rewinds: it is given every command
 * up front at the frame the first one landed it on, and renders straight through. Because the
 * second is sent every command up front and only advanced, it cannot express a command that
 * restarts a halted deck (a `play` after a `pause` or `stop`) or a seek to a frame with no prepared
 * image. `deck/deck.spec.ts` exercises both, though not frame for frame against a straight deck.
 */
export async function compareRewound(options: ComparisonOptions): Promise<Comparison> {
  const rewound = new Rig(options.rig);
  await start(rewound, options);
  const sent: DeckCommand[] = [];
  /** The order the rewound deck took them in, which the straight one must take them in too. */
  const arrival: number[] = [];
  await run(
    rewound,
    options.runMs,
    options.presses.map((press) => press.atMs),
    (index) => {
      sent[index] = {
        ...options.presses[index].command(DECK, rewound),
        pressedAtMs: rewound.time.ms,
      };
      arrival.push(index);
      rewound.send(sent[index]);
    },
  );
  const landings = sent.map((command) => {
    const landed = rewound.landed().find((event) => event.command === command);
    if (landed === undefined) throw new Error(`the press of ${command.kind} never landed`);
    return landed.frame;
  });

  const straight = new Rig(options.rig);
  await start(straight, options);
  for (const index of arrival) {
    straight.send({ ...sent[index], when: { at: 'frame', frame: landings[index] } });
  }
  // It pauses at the moments the other was pressed at, so what the engine builds off the frame
  // path (a declared target's image) reaches both at the same frame.
  await run(
    straight,
    options.runMs,
    options.presses.map((press) => press.atMs),
    () => undefined,
  );

  return {
    rewound,
    straight,
    landings,
    difference: firstDifference(wireOf(rewound), wireOf(straight)),
  };
}

function wireOf(rig: Rig): readonly WireEvent[] {
  const sink = rig.sinks.get(DECK);
  if (sink === undefined) throw new Error('the compared deck has no sink');
  return sink.wire;
}

/** Describes where two wires first differ, or null when they are the same. */
export function firstDifference(a: readonly WireEvent[], b: readonly WireEvent[]): string | null {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = JSON.stringify(a[i]);
    const right = JSON.stringify(b[i]);
    if (left !== right)
      return `item ${i}: ${left} against ${right} (${a.length} against ${b.length} items)`;
  }
  return null;
}

/** Spec-only. What `firstFrameDifference` looks at. */
export interface FrameDifferenceOptions {
  /** Compare due times and catch-up marks as well as the frame number, registers and values. Default true. */
  readonly dueTimes?: boolean;
}

/**
 * Describes where two wires first differ, naming the frame and the register, or null when they
 * are the same: a regression then points at the frame it began on.
 */
export function firstFrameDifference(
  a: readonly WireEvent[],
  b: readonly WireEvent[],
  options: FrameDifferenceOptions = {},
): string | null {
  const dueTimes = options.dueTimes ?? true;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = a[i];
    const right = b[i];
    if (left === undefined || right === undefined) {
      return `item ${i}: one run ended (${a.length} against ${b.length} items)`;
    }
    if (left.kind !== right.kind) return `item ${i}: a ${left.kind} against a ${right.kind}`;
    if (left.kind === 'begin' || left.kind === 'end') continue;
    const other = right as typeof left;
    if (left.frameNumber !== other.frameNumber) {
      return `item ${i}: frame ${left.frameNumber} against frame ${other.frameNumber}`;
    }
    const writes = Math.max(left.registers.length, other.registers.length);
    for (let j = 0; j < writes; j++) {
      if (left.registers[j] !== other.registers[j] || left.values[j] !== other.values[j]) {
        return (
          `frame ${left.frameNumber} (item ${i}) write ${j}: register ${left.registers[j]} = ` +
          `${left.values[j]} against register ${other.registers[j]} = ${other.values[j]}`
        );
      }
    }
    if (dueTimes && left.dueAtMs !== other.dueAtMs) {
      return `frame ${left.frameNumber} (item ${i}): due at ${left.dueAtMs} ms against ${other.dueAtMs} ms`;
    }
    if (dueTimes && left.catchUpClamped !== other.catchUpClamped) {
      return `frame ${left.frameNumber} (item ${i}): catch-up mark ${left.catchUpClamped} against ${other.catchUpClamped}`;
    }
  }
  return null;
}
