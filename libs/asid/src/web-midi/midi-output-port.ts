import type { MidiOutputPort } from '../sink/midi-output-port.js';

/**
 * TypeScript's bundled DOM lib declares `Navigator.requestMIDIAccess` itself, but the types behind
 * it are incomplete: `MIDIOutput.send` is typed to take `number[]` rather than the `Uint8Array`
 * every browser actually accepts. Rather than pull in `@types/webmidi` for the full surface, this
 * file works against its own minimal shape and casts the real output into it once, at the boundary.
 */
interface MIDIOutputLike {
  id: string;
  send(data: Uint8Array, timestamp?: number): void;
  /**
   * Specified by Web MIDI, but the API is not baseline — Chrome's implementation tracked a draft
   * that omitted it. Detected on the port object itself (see `supportsCancel`), never assumed from
   * a browser check, and `cancelPending()` never calls it without confirming it exists first.
   */
  clear?: () => void;
}

/**
 * Wraps a browser MIDI output as an ASID sink's port. Requests nothing — the caller has already
 * been granted access and chosen this output.
 */
export function midiOutputPortFrom(output: MIDIOutput): MidiOutputPort {
  const midiOutput = output as unknown as MIDIOutputLike;
  const supportsCancel = typeof midiOutput.clear === 'function';

  return {
    portId: midiOutput.id,
    supportsCancel,
    send(bytes: Uint8Array, timestampMs?: number) {
      // TypeScript's DOM lib types MIDIOutput.send as taking number[], but all browsers accept
      // Uint8Array. Cast to unknown then number[] here at the boundary to satisfy the type checker
      // while actually passing the Uint8Array that browsers expect.
       
      midiOutput.send(bytes as unknown as number[], timestampMs);
    },
    cancelPending(): boolean {
      if (typeof midiOutput.clear !== 'function') {
        return false;
      }
      try {
        midiOutput.clear();
        return true;
      } catch {
        // clear() exists but threw — treat as "did not cancel" rather than propagating
        return false;
      }
    },
  };
}
