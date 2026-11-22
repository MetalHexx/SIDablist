import type { SidSink } from '../ports/sink.js';
import type { SidFrame } from '../registers/sid-frame.js';
import { SID_VOLUME_REGISTER, VOICE_CONTROL_REGISTERS } from '../registers/sid-constants.js';
import { frames, microseconds, milliseconds } from '../units.js';
import { assertEqual, assertOrdered, assertSameMultiset } from './assert.js';

/** What a consumer hands the suite: a fresh sink, plus a reader for what it has emitted.
 *  `emitted()` returns one entry per write the sink actually put on its wire, in order —
 *  for ASID that means decoding its own packets back, which is the point: a sink that
 *  cannot show its output cannot be conformance-tested. */
export interface ConformanceHarness {
  readonly sink: SidSink;
  emitted(): readonly { readonly register: number; readonly value: number }[];
  /** Advances the harness's notion of time so due frames are released. */
  advanceMs(ms: number): void;
}

export interface ConformanceCase {
  readonly name: string;
  /** Throws on failure. The consumer wraps each case in its own `it()`. */
  run(makeHarness: () => ConformanceHarness): Promise<void> | void;
}

interface Write {
  readonly register: number;
  readonly value: number;
}

/** Builds a `SidFrame` from a plain list of writes. Per-write offsets are always 0, matching
 *  what every real tune produces today (see `SidFrame.offsetsUs`). */
function frame(writes: readonly Write[]): SidFrame {
  return {
    count: writes.length,
    registers: Uint8Array.from(writes.map((write) => write.register)),
    values: Uint8Array.from(writes.map((write) => write.value)),
    offsetsUs: new Int32Array(writes.length),
  };
}

const GATE_REGISTER = VOICE_CONTROL_REGISTERS[0] ?? 4;

const preservesWriteOrdering: ConformanceCase = {
  name: 'preserves write ordering within a frame, including a register written twice',
  run(makeHarness) {
    const harness = makeHarness();
    harness.sink.begin({ chipModel: 'mos6581' });
    // A sink that packs a whole frame into one fixed-layout snapshot cannot represent
    // cross-register arrival order on its wire at all — nothing to prove here for it. Its own
    // specs are where a slot-based encoding proves the narrower, protocol-specific guarantee this
    // case bundles in for a streaming sink: that a register written twice keeps its two values.
    if (!harness.sink.capabilities.preservesWriteOrder) return;
    const writes: Write[] = [
      { register: GATE_REGISTER, value: 0x21 },
      { register: SID_VOLUME_REGISTER, value: 0x0f },
      { register: GATE_REGISTER, value: 0x20 },
    ];
    harness.sink.deliver(frame(writes), frames(0), milliseconds(0), false);
    harness.advanceMs(100);
    assertEqual(
      harness.emitted(),
      writes,
      'writes must reach the wire in the exact order the frame carried them',
    );
  },
};

const drainsGateOffAheadOfResync: ConformanceCase = {
  name: 'drains a gate-off ahead of a resync instead of coalescing them',
  run(makeHarness) {
    const harness = makeHarness();
    harness.sink.begin({ chipModel: 'mos6581' });
    const gateOff = frame([{ register: GATE_REGISTER, value: 0x20 }]);
    const resync = frame([
      { register: 0, value: 0x50 },
      { register: GATE_REGISTER, value: 0x21 },
    ]);
    harness.sink.deliverNow(gateOff);
    harness.sink.deliver(resync, frames(0), milliseconds(0), false);
    harness.advanceMs(100);
    assertOrdered(
      harness.emitted(),
      [
        { register: GATE_REGISTER, value: 0x20 },
        { register: GATE_REGISTER, value: 0x21 },
      ],
      'the gate-off must land on the wire before the resync re-attacks the same voice',
    );
  },
};

const releasesCleanlyOnUnderrun: ConformanceCase = {
  name: 'releases cleanly on underrun and accepts delivery again afterwards',
  run(makeHarness) {
    const harness = makeHarness();
    harness.sink.begin({ chipModel: 'mos6581' });
    harness.sink.deliver(
      frame([{ register: GATE_REGISTER, value: 0x21 }]),
      frames(0),
      milliseconds(0),
      false,
    );
    harness.advanceMs(20);
    harness.advanceMs(5000); // starve it well past any normal frame interval
    assertEqual(
      harness.sink.readAt().inFlight,
      0,
      'a sink starved of frames should show nothing outstanding, not a stuck queue',
    );
    harness.sink.deliver(
      frame([{ register: SID_VOLUME_REGISTER, value: 0x0f }]),
      frames(1),
      milliseconds(5020),
      false,
    );
    harness.advanceMs(20);
    assertEqual(
      harness.emitted(),
      [
        { register: GATE_REGISTER, value: 0x21 },
        { register: SID_VOLUME_REGISTER, value: 0x0f },
      ],
      'a frame delivered after an underrun must still reach the wire',
    );
  },
};

const honorsNoCancellationOnRetime: ConformanceCase = {
  name: 'does not drop an outstanding frame on retime when it reports no cancellation support',
  run(makeHarness) {
    const harness = makeHarness();
    harness.sink.begin({ chipModel: 'mos6581' });
    if (harness.sink.capabilities.cancellation) return; // nothing to prove for a sink that may withdraw
    harness.sink.deliver(
      frame([{ register: GATE_REGISTER, value: 0x21 }]),
      frames(0),
      milliseconds(1000),
      false,
    );
    harness.sink.retime(microseconds(20000));
    harness.advanceMs(1000);
    assertEqual(
      harness.emitted(),
      [{ register: GATE_REGISTER, value: 0x21 }],
      'a sink without cancellation support must still deliver a frame that was outstanding through a retime',
    );
  },
};

const honorsNoPerWriteOffsetsOnDeliver: ConformanceCase = {
  name: 'delivers every write in a frame when it reports no per-write offset support',
  run(makeHarness) {
    const harness = makeHarness();
    harness.sink.begin({ chipModel: 'mos6581' });
    if (harness.sink.capabilities.perWriteOffsets) return; // nothing to prove for a sink that honours offsets
    const writes: Write[] = [
      { register: GATE_REGISTER, value: 0x21 },
      { register: SID_VOLUME_REGISTER, value: 0x0f },
    ];
    harness.sink.deliver(frame(writes), frames(0), milliseconds(0), false);
    harness.advanceMs(100);
    // Exact order is only meaningful for a sink that can represent cross-register arrival order
    // on its wire in the first place (see `preservesWriteOrdering`); either way, none of the
    // writes may go missing.
    const assertDelivered = harness.sink.capabilities.preservesWriteOrder
      ? assertEqual
      : assertSameMultiset;
    assertDelivered(
      harness.emitted(),
      writes,
      'a sink without per-write-offset support must still deliver every write in the frame',
    );
  },
};

const resetDropsOutstandingAndReopens: ConformanceCase = {
  name: 'reset drops everything outstanding and leaves the sink able to accept new frames',
  run(makeHarness) {
    const harness = makeHarness();
    harness.sink.begin({ chipModel: 'mos6581' });
    harness.sink.deliver(
      frame([{ register: GATE_REGISTER, value: 0x21 }]),
      frames(0),
      milliseconds(1000),
      false,
    );
    harness.sink.reset();
    harness.advanceMs(2000);
    // What actually survived, rather than a guess from `capabilities.cancellation`: a sink whose own
    // reset() has full control over its queue (nothing external to consult) can honour "drops
    // everything" regardless of what it reports there, so this reads the real outcome instead of
    // predicting it — see `SidSink.reset()`'s own doc for why a transport that cannot withdraw an
    // already-handed-over send is exempt from the strict half below. Copied rather than held live:
    // a harness's `emitted()` is free to return its backing array by reference, which the next
    // `deliver()` would then mutate out from under this snapshot.
    const survivedReset = [...harness.emitted()];
    if (harness.sink.capabilities.cancellation) {
      assertEqual(
        survivedReset,
        [],
        'a sink that can cancel must drop a frame before its due time, not merely delay it',
      );
    }
    harness.sink.deliver(
      frame([{ register: SID_VOLUME_REGISTER, value: 0x0f }]),
      frames(1),
      milliseconds(2020),
      false,
    );
    harness.advanceMs(30);
    assertEqual(
      harness.emitted(),
      [...survivedReset, { register: SID_VOLUME_REGISTER, value: 0x0f }],
      'a sink must accept and deliver new frames after a reset, on top of whatever reset itself could not withdraw',
    );
  },
};

const reportsInFlightDepthRegardlessOfKind: ConformanceCase = {
  name: 'reports in-flight depth through readAt even when kind is unknown',
  run(makeHarness) {
    const harness = makeHarness();
    harness.sink.begin({ chipModel: 'mos6581' });
    assertEqual(harness.sink.readAt().inFlight, 0, 'a fresh sink has nothing outstanding');
    harness.sink.deliver(
      frame([{ register: GATE_REGISTER, value: 0x21 }]),
      frames(0),
      milliseconds(1000),
      false,
    );
    harness.sink.deliver(
      frame([{ register: SID_VOLUME_REGISTER, value: 0x0f }]),
      frames(1),
      milliseconds(1020),
      false,
    );
    assertEqual(
      harness.sink.readAt().inFlight,
      2,
      'two undelivered frames must be reflected as in-flight depth, whatever kind is reported',
    );
  },
};

/** One write per frame, so which frame a write came from is readable off `emitted()`: `value` is the
 *  frame's own tag and nothing else in a case reuses it. */
function taggedFrame(tag: number): SidFrame {
  return frame([{ register: 0, value: tag }]);
}

const ORIGINAL_TAG = 0x10;
const REPLACEMENT_TAG = 0x40;
const FRAME_COUNT = 5;
const FIRST_DUE_MS = 100;
const FRAME_INTERVAL_MS = 20;

function dueAt(position: number) {
  return milliseconds(FIRST_DUE_MS + FRAME_INTERVAL_MS * position);
}

/** Begins a run and delivers `FRAME_COUNT` tagged frames, then advances time far enough that a sink
 *  holding frames until they fall due has passed the first few and still holds the rest. */
function deliverOriginals(harness: ConformanceHarness): void {
  harness.sink.begin({ chipModel: 'mos6581' });
  for (let position = 0; position < FRAME_COUNT; position++) {
    harness.sink.deliver(
      taggedFrame(ORIGINAL_TAG + position),
      frames(position),
      dueAt(position),
      false,
    );
  }
  harness.advanceMs(FIRST_DUE_MS + 2 * FRAME_INTERVAL_MS - 10);
}

function emittedValues(harness: ConformanceHarness): number[] {
  return harness.emitted().map((write) => write.value);
}

const passedCountNeverExceedsDeliveries: ConformanceCase = {
  name: 'passedCount starts at 0, never exceeds the deliveries and never decreases',
  run(makeHarness) {
    const harness = makeHarness();
    harness.sink.begin({ chipModel: 'mos6581' });
    assertEqual(harness.sink.passedCount(), 0, 'nothing has been delivered after begin');
    let previous = 0;
    const check = (delivered: number): void => {
      const passed = harness.sink.passedCount();
      assertEqual(
        passed >= previous && passed <= delivered,
        true,
        `passedCount was ${passed} after ${delivered} deliveries, and ${previous} before`,
      );
      previous = passed;
    };
    for (let position = 0; position < FRAME_COUNT; position++) {
      harness.sink.deliver(
        taggedFrame(ORIGINAL_TAG + position),
        frames(position),
        dueAt(position),
        false,
      );
      check(position + 1);
    }
    for (let step = 0; step < 20; step++) {
      harness.advanceMs(10);
      check(FRAME_COUNT);
    }
  },
};

const replaceFromReturnsWhereReplacementsBegin: ConformanceCase = {
  name: 'replaceFrom returns min(max(fromCount, passedCount), delivered) and leaves what passed alone',
  run(makeHarness) {
    for (const fromCount of [0, 1, 3, FRAME_COUNT, FRAME_COUNT + 4]) {
      const harness = makeHarness();
      deliverOriginals(harness);
      const passedBefore = harness.sink.passedCount();
      const returned = harness.sink.replaceFrom(fromCount);
      assertEqual(
        returned,
        Math.min(Math.max(fromCount, passedBefore), FRAME_COUNT),
        `replaceFrom(${fromCount}) with ${passedBefore} passed of ${FRAME_COUNT}`,
      );
      assertEqual(
        harness.sink.passedCount(),
        passedBefore,
        'replaceFrom must not change how many frames have passed',
      );
    }
  },
};

const replacedFramesNeverReachTheWire: ConformanceCase = {
  name: 'every frame replaceFrom dropped stays off the wire and every replacement reaches it',
  run(makeHarness) {
    for (const fromCount of [0, 1, 3]) {
      const harness = makeHarness();
      deliverOriginals(harness);
      const begin = harness.sink.replaceFrom(fromCount);
      for (let position = begin; position < FRAME_COUNT; position++) {
        harness.sink.deliver(
          taggedFrame(REPLACEMENT_TAG + position),
          frames(position),
          dueAt(position),
          false,
        );
      }
      harness.advanceMs(1000);
      const values = emittedValues(harness);
      for (let position = 0; position < FRAME_COUNT; position++) {
        const original = values.includes(ORIGINAL_TAG + position);
        const replacement = values.includes(REPLACEMENT_TAG + position);
        assertEqual(
          original,
          position < begin,
          `replaceFrom(${fromCount}) returned ${begin}: original ${position} ${original ? 'was' : 'was not'} emitted`,
        );
        assertEqual(
          replacement,
          position >= begin,
          `replaceFrom(${fromCount}) returned ${begin}: replacement ${position} ${replacement ? 'was' : 'was not'} emitted`,
        );
      }
    }
  },
};

const replaceFromPastTheEndChangesNothing: ConformanceCase = {
  name: 'replaceFrom past the last delivery changes nothing and returns the delivery count',
  run(makeHarness) {
    const harness = makeHarness();
    harness.sink.begin({ chipModel: 'mos6581' });
    for (let position = 0; position < 3; position++) {
      harness.sink.deliver(
        taggedFrame(ORIGINAL_TAG + position),
        frames(position),
        dueAt(position),
        false,
      );
    }
    const passedBefore = harness.sink.passedCount();
    assertEqual(harness.sink.replaceFrom(3), 3, 'replaceFrom at the delivery count');
    assertEqual(harness.sink.replaceFrom(100), 3, 'replaceFrom well past the delivery count');
    assertEqual(harness.sink.passedCount(), passedBefore, 'nothing was dropped or passed');
    harness.sink.deliver(taggedFrame(ORIGINAL_TAG + 3), frames(3), dueAt(3), false);
    harness.advanceMs(1000);
    assertEqual(
      emittedValues(harness),
      [ORIGINAL_TAG, ORIGINAL_TAG + 1, ORIGINAL_TAG + 2, ORIGINAL_TAG + 3],
      'every frame delivered must still reach the wire, in order',
    );
  },
};

const resetAndBeginRestartTheCounts: ConformanceCase = {
  name: 'reset and begin restart both counts',
  run(makeHarness) {
    const harness = makeHarness();
    deliverOriginals(harness);
    harness.sink.reset();
    assertEqual(harness.sink.passedCount(), 0, 'passedCount after reset');
    assertEqual(harness.sink.replaceFrom(FRAME_COUNT), 0, 'no deliveries are counted after reset');
    harness.sink.deliver(taggedFrame(REPLACEMENT_TAG), frames(0), dueAt(0), false);
    harness.sink.deliver(taggedFrame(REPLACEMENT_TAG + 1), frames(1), dueAt(1), false);
    assertEqual(
      harness.sink.replaceFrom(FRAME_COUNT),
      2,
      'deliveries are counted from 0 after reset',
    );

    harness.sink.begin({ chipModel: 'mos6581' });
    assertEqual(harness.sink.passedCount(), 0, 'passedCount after begin');
    assertEqual(harness.sink.replaceFrom(FRAME_COUNT), 0, 'no deliveries are counted after begin');
    harness.sink.deliver(taggedFrame(REPLACEMENT_TAG), frames(0), dueAt(0), false);
    assertEqual(
      harness.sink.replaceFrom(FRAME_COUNT),
      1,
      'deliveries are counted from 0 after begin',
    );
  },
};

/** The cases for `passedCount` and `replaceFrom`, also exported alone so a sink that cannot be run
 *  through the whole suite (a recorder with no notion of time) can still be held to them. */
export const SINK_REPLACE_CASES: readonly ConformanceCase[] = [
  passedCountNeverExceedsDeliveries,
  replaceFromReturnsWhereReplacementsBegin,
  replacedFramesNeverReachTheWire,
  replaceFromPastTheEndChangesNothing,
  resetAndBeginRestartTheCounts,
];

export const SINK_CONFORMANCE_CASES: readonly ConformanceCase[] = [
  preservesWriteOrdering,
  drainsGateOffAheadOfResync,
  releasesCleanlyOnUnderrun,
  honorsNoCancellationOnRetime,
  honorsNoPerWriteOffsetsOnDeliver,
  resetDropsOutstandingAndReopens,
  reportsInFlightDepthRegardlessOfKind,
  ...SINK_REPLACE_CASES,
];
