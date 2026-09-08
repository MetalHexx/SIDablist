import { describe, expect, it } from 'vitest';
import { describeError } from './errors.js';

describe('describeError', () => {
  it('reads the message off an Error', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('stringifies anything that is not an Error', () => {
    expect(describeError('boom')).toBe('boom');
    expect(describeError(42)).toBe('42');
    expect(describeError(null)).toBe('null');
  });
});
