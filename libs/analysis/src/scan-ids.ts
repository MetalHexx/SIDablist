// Session and request ids only need to be unique across the process, never persisted or compared
// across one — a module counter is the whole requirement. Shared so that `indexTune` and
// `recordRegisters` never hand one scanner the same session twice.
let sessionCounter = 0;
let requestCounter = 0;

export function nextSessionId(): number {
  return ++sessionCounter;
}

export function nextRequestId(): number {
  return ++requestCounter;
}
