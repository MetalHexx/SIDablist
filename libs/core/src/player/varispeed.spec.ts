import { describe, expect, it } from 'vitest';
import type { SidWriteSink } from '../cpu/c64-machine.js';
import type { RegisterRecord } from '../registers/register-record.js';
import { SID_REGISTER_COUNT } from '../registers/sid-constants.js';
import { createVarispeed } from './varispeed.js';

interface Write {
  readonly register: number;
  readonly value: number;
}

class RecordingSink implements SidWriteSink {
  writes: Write[] = [];

  onSidWrite(register: number, value: number): void {
    this.writes.push({ register, value });
  }

  /** The writes since the last call. */
  take(): Write[] {
    const taken = this.writes;
    this.writes = [];
    return taken;
  }
}

interface Retrigger {
  readonly entry: number;
  readonly register: number;
  readonly first: number;
}

/** A record whose register `r` at entry `e` reads `byteAt(e, r)`. */
function recordOf(
  frames: number,
  byteAt: (entry: number, register: number) => number,
  retriggers: readonly Retrigger[] = [],
): RegisterRecord {
  const values = new Uint8Array(frames * SID_REGISTER_COUNT);
  for (let entry = 0; entry < frames; entry++) {
    for (let register = 0; register < SID_REGISTER_COUNT; register++) {
      values[entry * SID_REGISTER_COUNT + register] = byteAt(entry, register);
    }
  }
  return {
    frames,
    values,
    retriggerEntries: Uint32Array.from(retriggers.map((retrigger) => retrigger.entry)),
    retriggerRegisters: Uint8Array.from(retriggers.map((retrigger) => retrigger.register)),
    retriggerValues: Uint8Array.from(retriggers.map((retrigger) => retrigger.first)),
  };
}

/** Every register changes with the entry in its low bits only for registers 0 and 2. */
const RAMP = (entry: number, register: number): number =>
  register === 0 || register === 2 ? entry + 1 : register + 0x10;

function varispeedOver(record: RegisterRecord, position: number) {
  const varispeed = createVarispeed();
  varispeed.setRecord(record);
  varispeed.begin(position);
  return varispeed;
}

describe('createVarispeed', () => {
  it('writes all 25 registers of the entry on the first feed, in register order', () => {
    const sink = new RecordingSink();
    const varispeed = varispeedOver(recordOf(10, RAMP), 5);

    varispeed.feed(sink);

    expect(sink.writes.map((write) => write.register)).toEqual(
      Array.from({ length: SID_REGISTER_COUNT }, (_, register) => register),
    );
    expect(sink.writes[0].value).toBe(5); // position 5 is entry 4, whose ramp byte is 5
  });

  it('reads entry 0 at position 0 and at position 1', () => {
    for (const position of [0, 1]) {
      const sink = new RecordingSink();
      varispeedOver(recordOf(10, RAMP), position).feed(sink);
      expect(sink.writes[0].value).toBe(1);
    }
  });

  it('writes only what differs from the last entry fed, and nothing for the same entry', () => {
    const sink = new RecordingSink();
    const varispeed = varispeedOver(recordOf(10, RAMP), 5);
    varispeed.feed(sink);
    sink.take();

    varispeed.moveBy(0.5);
    varispeed.feed(sink);
    expect(sink.take()).toEqual([]);

    varispeed.moveBy(0.5);
    varispeed.feed(sink);
    expect(sink.take()).toEqual([
      { register: 0, value: 6 },
      { register: 2, value: 6 },
    ]);
  });

  it('measures a jump against what it has fed, not against the entry before it', () => {
    const sink = new RecordingSink();
    const varispeed = varispeedOver(recordOf(20, RAMP), 3);
    varispeed.feed(sink);
    sink.take();

    varispeed.moveTo(15);
    varispeed.feed(sink);
    expect(sink.take()).toEqual([
      { register: 0, value: 15 },
      { register: 2, value: 15 },
    ]);

    varispeed.moveTo(3);
    varispeed.feed(sink);
    expect(sink.take()).toEqual([
      { register: 0, value: 3 },
      { register: 2, value: 3 },
    ]);
  });

  it('forgets what it fed when begun again, and keeps it across a move', () => {
    const sink = new RecordingSink();
    const varispeed = varispeedOver(recordOf(10, RAMP), 3);
    varispeed.feed(sink);
    sink.take();

    varispeed.begin(3);
    varispeed.feed(sink);

    expect(sink.take()).toHaveLength(SID_REGISTER_COUNT);
  });

  it('clamps the playhead to the record', () => {
    const varispeed = varispeedOver(recordOf(10, RAMP), 4);

    varispeed.moveBy(100);
    expect(varispeed.position).toBe(10);
    varispeed.moveBy(-100);
    expect(varispeed.position).toBe(0);
    varispeed.moveTo(99);
    expect(varispeed.position).toBe(10);
  });

  describe('retriggers', () => {
    const retriggers: readonly Retrigger[] = [
      { entry: 2, register: 4, first: 0x40 },
      { entry: 2, register: 18, first: 0x20 },
      { entry: 6, register: 11, first: 0x80 },
    ];
    const record = recordOf(
      10,
      (entry, register) => (register === 4 ? 0x41 : RAMP(entry, register)),
      retriggers,
    );

    it('sends the first byte and then the entry byte, even when the chip already holds it', () => {
      const sink = new RecordingSink();
      const varispeed = varispeedOver(record, 2);
      varispeed.feed(sink); // entry 1
      sink.take();

      varispeed.moveTo(3); // entry 2: register 4 reads 0x41 again
      varispeed.feed(sink);

      const writes = sink.take();
      expect(writes.filter((write) => write.register === 4)).toEqual([
        { register: 4, value: 0x40 },
        { register: 4, value: 0x41 },
      ]);
      expect(writes.filter((write) => write.register === 18)).toEqual([
        { register: 18, value: 0x20 },
        { register: 18, value: RAMP(2, 18) },
      ]);
    });

    it('finds a retrigger from either side of the cursor', () => {
      const sink = new RecordingSink();
      const varispeed = varispeedOver(record, 1);
      varispeed.feed(sink);
      sink.take();

      varispeed.moveTo(7); // entry 6, jumping over the entry-2 retriggers
      varispeed.feed(sink);
      expect(sink.take().filter((write) => write.register === 11)).toEqual([
        { register: 11, value: 0x80 },
        { register: 11, value: RAMP(6, 11) },
      ]);

      varispeed.moveTo(3); // back to entry 2
      varispeed.feed(sink);
      expect(sink.take().filter((write) => write.register === 4)).toEqual([
        { register: 4, value: 0x40 },
        { register: 4, value: 0x41 },
      ]);
    });

    it('releases a gate the shadow would hide: the next write is measured against the second byte', () => {
      // Entry 0 writes 0x40 then 0x41; entry 1 writes 0x40 alone. The shadow keeps 0x40 from
      // entry 0, so a comparison against it would skip entry 1's write and the note would hang.
      const hanging = recordOf(
        3,
        (entry, register) => (register === 4 ? (entry === 0 ? 0x41 : 0x40) : 0),
        [{ entry: 0, register: 4, first: 0x40 }],
      );
      const sink = new RecordingSink();
      const varispeed = varispeedOver(hanging, 1);
      varispeed.feed(sink);
      sink.take();

      varispeed.moveBy(1);
      varispeed.feed(sink);

      expect(sink.take()).toEqual([{ register: 4, value: 0x40 }]);
    });

    it('sends the retrigger on the first feed too, in place of the register alone', () => {
      const sink = new RecordingSink();
      varispeedOver(record, 3).feed(sink);

      const controlWrites = sink.writes.filter((write) => write.register === 4);
      expect(controlWrites).toEqual([
        { register: 4, value: 0x40 },
        { register: 4, value: 0x41 },
      ]);
      expect(sink.writes).toHaveLength(SID_REGISTER_COUNT + 2);
    });
  });

  it('feeds nothing without a record', () => {
    const sink = new RecordingSink();
    const varispeed = createVarispeed();

    varispeed.feed(sink);
    varispeed.moveBy(5);

    expect(sink.writes).toEqual([]);
    expect(varispeed.position).toBe(0);
  });
});
