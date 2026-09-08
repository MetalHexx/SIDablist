import type { PlayerSnapshot } from './snapshot.js';

/**
 * Holds the listener set and the currently held `PlayerSnapshot`, keeping identity stability a
 * property of this module rather than a discipline every caller has to remember.
 *
 * A caller hands `markDirty` a way to recompute the snapshot rather than a finished object — the
 * store rebuilds, compares the result structurally against what it already holds, and only swaps
 * the reference and notifies when a discrete field actually differs. A `markDirty` call that
 * changes nothing costs one comparison and produces neither a new identity nor a notification.
 */
export interface PlayerSnapshotStore {
  /** Notifies on discrete state change only. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Referentially stable: identity changes only when the state does. */
  getSnapshot(): PlayerSnapshot;
  /** Recomputes the snapshot via `producer` and adopts it — swapping identity and notifying every
   *  listener — only when the result differs from the one already held. */
  markDirty(producer: () => PlayerSnapshot): void;
}

export function createPlayerSnapshotStore(initial: PlayerSnapshot): PlayerSnapshotStore {
  let snapshot = initial;
  const listeners = new Set<() => void>();

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot: (): PlayerSnapshot => snapshot,

    markDirty(producer: () => PlayerSnapshot): void {
      const next = producer();
      if (snapshotsEqual(snapshot, next)) return;
      snapshot = next;

      // Copied before iterating: an unsubscribe fired from inside a listener replaces `listeners`
      // wholesale rather than mutating it in place, so this round's order and length stay fixed
      // regardless of what a listener does mid-round. The membership check against the live set is
      // what then keeps a listener removed mid-round from being called if its turn has not
      // come yet, while the ones after it still get theirs.
      for (const listener of Array.from(listeners)) {
        if (listeners.has(listener)) listener();
      }
    },
  };
}

/**
 * Structural equality over the plain data a snapshot is built from — primitives, arrays and plain
 * objects only, never a function or a class instance. Generic on purpose: it needs no update when
 * P07-T02 adds a field or a group, because the addition is more of the same shapes.
 */
function snapshotsEqual(a: PlayerSnapshot, b: PlayerSnapshot): boolean {
  return valuesEqual(a, b);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => valuesEqual(value, b[index]))
    );
  }

  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  return (
    aKeys.length === Object.keys(bRecord).length &&
    aKeys.every((key) => valuesEqual(aRecord[key], bRecord[key]))
  );
}
