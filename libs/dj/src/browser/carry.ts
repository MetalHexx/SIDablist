import type { EngineLog } from '@sidablist/core';
import type { DjInbound } from '../messages/commands.js';
import type { DjReport } from '../messages/reports.js';
import type { Dj } from '../plugs.js';

/**
 * Anything a message can be carried over: a `MessagePort`, a `Worker`, or a worker's own global
 * (declare its minimal shape locally; `DedicatedWorkerGlobalScope` is not in the DOM lib).
 */
export interface PortLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  /** A `MessagePort` needs it after `addEventListener`; called when present. */
  start?(): void;
}

/** The wire: plain data, one message per thing carried. */
type Wire =
  | { readonly type: 'inbound'; readonly message: DjInbound }
  | { readonly type: 'report'; readonly report: DjReport }
  | { readonly type: 'fetch-tune'; readonly id: number; readonly tune: string }
  | { readonly type: 'tune-bytes'; readonly id: number; readonly bytes: Uint8Array }
  | { readonly type: 'tune-failed'; readonly id: number; readonly reason: string };

/** Narrows an arriving message to the wire's shapes; anything else is not ours. */
function readWire(data: unknown): Wire | null {
  if (typeof data !== 'object' || data === null) return null;
  const wire = data as Record<string, unknown>;
  switch (wire['type']) {
    case 'inbound':
      return typeof wire['message'] === 'object' && wire['message'] !== null
        ? (data as Wire)
        : null;
    case 'report':
      return typeof wire['report'] === 'object' && wire['report'] !== null ? (data as Wire) : null;
    case 'fetch-tune':
      return typeof wire['id'] === 'number' && typeof wire['tune'] === 'string'
        ? (data as Wire)
        : null;
    case 'tune-bytes':
      return typeof wire['id'] === 'number' && wire['bytes'] instanceof Uint8Array
        ? (data as Wire)
        : null;
    case 'tune-failed':
      return typeof wire['id'] === 'number' && typeof wire['reason'] === 'string'
        ? (data as Wire)
        : null;
    default:
      return null;
  }
}

/** Listens for wire messages on `port` and hands each to `handle`; returns the detach. */
function listen(
  port: PortLike,
  log: EngineLog | undefined,
  side: string,
  handle: (wire: Wire) => boolean,
): () => void {
  const listener = (event: MessageEvent): void => {
    const wire = readWire(event.data);
    if (wire === null || !handle(wire)) log?.warn(`dj carry: ${side} ignored an unknown message`);
  };
  port.addEventListener('message', listener);
  port.start?.();
  return () => port.removeEventListener('message', listener);
}

/** The plugs the package's side gets for the two things that cross the port outward. */
export interface ServedPlugs {
  /** Posts each report as it comes: one message per update, never batched. `postMessage` copies the reused update at once. */
  readonly report: (message: DjReport) => void;
  /** Asks the host's side for a tune's bytes. */
  readonly fetchTune: (tune: string) => Promise<Uint8Array>;
}

/**
 * The package's side of the carry. `start` receives the remote `report` and `fetchTune` and returns
 * the `Dj` the caller made with them and the rest of its plugs (wake, time, heavy work and outputs
 * stay on this side). Inbound messages go to `dj.send`. `dispose` detaches from the port and
 * disposes that `Dj`; tune fetches still waiting fail.
 */
export function serveDj(
  port: PortLike,
  start: (plugs: ServedPlugs) => Dj,
  options: { readonly log?: EngineLog } = {},
): { dispose(): void } {
  const waiting = new Map<
    number,
    { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }
  >();
  let nextId = 1;

  const dj = start({
    report: (report) => port.postMessage({ type: 'report', report } satisfies Wire, []),
    fetchTune: (tune) =>
      new Promise<Uint8Array>((resolve, reject) => {
        const id = nextId++;
        waiting.set(id, { resolve, reject });
        port.postMessage({ type: 'fetch-tune', id, tune } satisfies Wire, []);
      }),
  });

  const detach = listen(port, options.log, 'package side', (wire) => {
    switch (wire.type) {
      case 'inbound':
        dj.send(wire.message);
        return true;
      case 'tune-bytes':
        waiting.get(wire.id)?.resolve(wire.bytes);
        waiting.delete(wire.id);
        return true;
      case 'tune-failed':
        waiting.get(wire.id)?.reject(new Error(wire.reason));
        waiting.delete(wire.id);
        return true;
      default:
        return false;
    }
  });

  return {
    dispose(): void {
      detach();
      dj.dispose();
      for (const request of waiting.values()) request.reject(new Error('the carry was disposed'));
      waiting.clear();
    },
  };
}

/** The host's side of the carry. */
export interface DjRemote {
  send(message: DjInbound): void;
  /** Listens for every report; returns the way to stop. */
  onReport(listener: (report: DjReport) => void): () => void;
  /** Detaches from the port and drops the listeners. */
  dispose(): void;
}

/**
 * The host's side of the carry. It answers the package side's tune requests with
 * `options.fetchTune`, sending a copy of the bytes: `fetchTune` may return bytes it keeps. A
 * `fetchTune` that throws or rejects fails the load with its message.
 */
export function connectDj(
  port: PortLike,
  options: {
    readonly fetchTune: (tune: string) => Promise<Uint8Array>;
    readonly log?: EngineLog;
  },
): DjRemote {
  const listeners = new Set<(report: DjReport) => void>();
  let disposed = false;

  const answer = (id: number, tune: string): void => {
    const fail = (error: unknown): void => {
      if (disposed) return;
      const reason = error instanceof Error ? error.message : String(error);
      port.postMessage({ type: 'tune-failed', id, reason } satisfies Wire, []);
    };
    // Started inside the chain so a `fetchTune` that throws before returning a promise fails the load too.
    Promise.resolve()
      .then(() => options.fetchTune(tune))
      .then((bytes) => {
        if (disposed) return;
        port.postMessage({ type: 'tune-bytes', id, bytes } satisfies Wire, []);
      })
      .catch(fail);
  };

  const detach = listen(port, options.log, 'host side', (wire) => {
    switch (wire.type) {
      case 'report':
        for (const listener of listeners) listener(wire.report);
        return true;
      case 'fetch-tune':
        answer(wire.id, wire.tune);
        return true;
      default:
        return false;
    }
  });

  return {
    send(message: DjInbound): void {
      if (!disposed) port.postMessage({ type: 'inbound', message } satisfies Wire, []);
    },
    onReport(listener: (report: DjReport) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      detach();
      listeners.clear();
    },
  };
}
