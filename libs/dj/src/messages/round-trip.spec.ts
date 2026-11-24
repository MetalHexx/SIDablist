import { describe, expect, it } from 'vitest';
import { INBOUND_SAMPLES, REPORT_SAMPLES } from '../testing/samples.js';
import type { DjReport } from './reports.js';

/** Every report kind: a kind added to `DjReport` fails the compile here until it is listed. */
const REPORT_KINDS = {
  update: 0,
  landed: 0,
  loaded: 0,
  'load-failed': 0,
  'jump-landed': 0,
  captured: 0,
  picture: 0,
  registers: 0,
  deliveries: 0,
} satisfies Record<DjReport['kind'], 0>;

describe('message round trip', () => {
  it('has a sample for every report kind', () => {
    expect(new Set(REPORT_SAMPLES.map((report) => report.kind))).toEqual(
      new Set(Object.keys(REPORT_KINDS)),
    );
  });

  it.each(Object.entries(INBOUND_SAMPLES))(
    'inbound %s survives structured clone',
    (_kind, sample) => {
      expect(structuredClone(sample)).toEqual(sample);
    },
  );

  it.each(REPORT_SAMPLES.map((report) => [report.kind, report] as const))(
    'report %s survives structured clone',
    (_kind, report) => {
      expect(structuredClone(report)).toEqual(report);
    },
  );
});
