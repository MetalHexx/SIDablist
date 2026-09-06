import { describe, expect, it } from 'vitest';
import { describeError } from './errors.js';

describe('describeError', () => {
  it('extracts message from Error instances', () => {
    const error = new Error('Test message');
    expect(describeError(error)).toBe('Test message');
  });

  it('converts non-Error values to string', () => {
    expect(describeError('string error')).toBe('string error');
    expect(describeError(123)).toBe('123');
    expect(describeError({ error: 'object' })).toBe('[object Object]');
  });

  it('handles null and undefined', () => {
    expect(describeError(null)).toBe('null');
    expect(describeError(undefined)).toBe('undefined');
  });
});
