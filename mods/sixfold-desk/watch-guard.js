// The sidebar's alert watchers refresh on input changes. When a refresh fails (or the host refuses its
// task), waiting for the next input change can mean waiting for good when the inputs stay the same, so a
// failure is retried after a growing delay (one retry at a time, never a busy loop). Only the kind and
// time of a problem are recorded, never file contents or messages.
export const RETRY_MS = Object.freeze([5000, 30000, 120000]);

export function errorKind(error) {
  const message = String(error?.message || '');
  if (/changed while reading/i.test(message)) return 'ledger-changed';
  if (/no longer displays/i.test(message)) return 'hidden';
  if (/invalid .*ledger/i.test(message)) return 'ledger-invalid';
  if (/compare-and-swap|conflict/i.test(message)) return 'write-conflict';
  if (/task limit|spawn/i.test(message)) return 'spawn-refused';
  const name = String(error?.name || 'Error').replace(/[^A-Za-z]/g, '').slice(0, 40);
  return `error:${name || 'Error'}`;
}

// timer(ms, fn) -> {cancel()}; retry() asks the watcher to refresh again; record(entry) stores the state.
export function createRetry({timer, retry, record = () => {}, now = Date.now, delays = RETRY_MS}) {
  let failures = 0, pending = null, disposed = false;
  const cancel = () => { try { pending?.cancel?.(); } catch { /* an old generation may have released it */ } pending = null; };
  return {
    // A failed refresh (an Error or a kind string). A hidden view is refreshed when shown, so no retry.
    fail(error) {
      if (disposed) return;
      const kind = typeof error === 'string' ? error : errorKind(error);
      failures++; record({kind, at: now(), failures});
      if (kind === 'hidden' || pending) return;
      const ms = delays[Math.min(failures, delays.length) - 1];
      pending = timer(ms, () => { pending = null; if (!disposed) retry(); });
    },
    // Recorded only: something to know about that needs no retry of its own (e.g. a stalled run that
    // the next refresh is already replacing).
    note(kind) { if (!disposed) { failures++; record({kind, at: now(), failures}); } },
    ok() { if (disposed || !failures) return; failures = 0; cancel(); record({kind: 'ok', at: now(), failures: 0}); },
    get failures() { return failures; },
    dispose() { disposed = true; cancel(); },
  };
}

// The state file a watcher keeps: {schema, state, since, failures, last_error:{kind, at}}. A repeat of the
// same failure is written at most once a minute; a recovery is always written.
export function watchRecorder(write, {throttleMs = 60000} = {}) {
  let last = null, lastError = null;
  return entry => {
    const state = entry.kind === 'ok' ? 'ok' : 'failing';
    if (state === 'failing') lastError = {kind: entry.kind, at: new Date(entry.at).toISOString()};
    if (last && state === 'failing' && last.state === 'failing' && last.kind === entry.kind && entry.at - last.at < throttleMs) return;
    last = {state, kind: entry.kind, at: entry.at};
    try {
      write(JSON.stringify({schema: 1, state, since: new Date(entry.at).toISOString(), failures: entry.failures, last_error: lastError}));
    } catch { /* recording must never stop the watcher */ }
  };
}
