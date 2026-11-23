import { describe, expect, it } from 'vitest';
import { INBOUND_SAMPLES, REPORT_SAMPLES } from '../testing/samples.js';

describe('message round trip', () => {
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
