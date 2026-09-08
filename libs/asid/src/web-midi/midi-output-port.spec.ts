import { describe, it, expect, vi } from 'vitest';
import { midiOutputPortFrom } from './midi-output-port.js';

describe('midiOutputPortFrom', () => {
  it('returns a port with the output id', () => {
    const output = createFakeMidiOutput({ id: 'port-123' });
    const port = midiOutputPortFrom(output as unknown as MIDIOutput);

    expect(port.portId).toBe('port-123');
  });

  describe('supportsCancel detection', () => {
    it('reports supportsCancel: false when clear() is not present', () => {
      const output = createFakeMidiOutput({
        id: 'no-clear',
        hasClear: false,
      });
      const port = midiOutputPortFrom(output as unknown as MIDIOutput);

      expect(port.supportsCancel).toBe(false);
    });

    it('reports supportsCancel: true when clear() is present', () => {
      const output = createFakeMidiOutput({
        id: 'with-clear',
        hasClear: true,
      });
      const port = midiOutputPortFrom(output as unknown as MIDIOutput);

      expect(port.supportsCancel).toBe(true);
    });
  });

  describe('send', () => {
    it('passes Uint8Array through to the output send method', () => {
      const fakeOutput = createFakeMidiOutput({
        id: 'send-test',
      });
      const port = midiOutputPortFrom(fakeOutput as unknown as MIDIOutput);

      const bytes = Uint8Array.from([0xf0, 0x2d, 0x4c, 0xf7]);
      port.send(bytes);

      expect(fakeOutput.send).toHaveBeenCalledWith(bytes, undefined);
    });

    it('passes timestamp through to the output send method', () => {
      const fakeOutput = createFakeMidiOutput({
        id: 'send-with-timestamp',
      });
      const port = midiOutputPortFrom(fakeOutput as unknown as MIDIOutput);

      const bytes = Uint8Array.from([0x90, 0x45, 0x7f]);
      const timestamp = 12345;
      port.send(bytes, timestamp);

      expect(fakeOutput.send).toHaveBeenCalledWith(bytes, timestamp);
    });
  });

  describe('cancelPending', () => {
    it('calls clear() and returns true when the output supports it', () => {
      const fakeOutput = createFakeMidiOutput({
        id: 'cancel-supported',
        hasClear: true,
      });
      const port = midiOutputPortFrom(fakeOutput as unknown as MIDIOutput);

      const result = port.cancelPending();

      expect(result).toBe(true);
      expect(fakeOutput.clear).toHaveBeenCalled();
    });

    it('returns false and does not call clear() when the output does not support it', () => {
      const fakeOutput = createFakeMidiOutput({
        id: 'cancel-not-supported',
        hasClear: false,
      });
      const port = midiOutputPortFrom(fakeOutput as unknown as MIDIOutput);

      const result = port.cancelPending();

      expect(result).toBe(false);
      // clear is not present, so it was never called
      expect(fakeOutput.clear).toBeUndefined();
    });

    it('returns false and does not propagate when clear() throws', () => {
      const fakeOutput = createFakeMidiOutput({
        id: 'clear-throws',
        hasClear: true,
        clearThrows: true,
      });
      const port = midiOutputPortFrom(fakeOutput as unknown as MIDIOutput);

      expect(() => port.cancelPending()).not.toThrow();
      const result = port.cancelPending();
      expect(result).toBe(false);
    });
  });
});

interface FakeMidiOutputOptions {
  id: string;
  hasClear?: boolean;
  clearThrows?: boolean;
}

function createFakeMidiOutput(options: FakeMidiOutputOptions) {
  const { id, hasClear = false, clearThrows = false } = options;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const output: any = {
    id,
    send: vi.fn(),
  };

  if (hasClear) {
    output.clear = vi.fn(() => {
      if (clearThrows) {
        throw new Error('clear() threw');
      }
    });
  }

  return output;
}
