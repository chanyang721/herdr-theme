import { pushArrival, holdPeek, settleQueue } from './arrival-model.js';

// Arrivals of this run only (in memory, never persisted: nothing replays after
// a restart). A sidebar that draws them registers itself as the host while it
// is shown; a new alert with no host falls back to its window, so it is never dropped.
let list = [];
let host = null;
let peekCheck = null;
export const arrivals = (now = Date.now()) => (list = settleQueue(list, now));
// The host decides how a new arrival shows: 'peek' (its space's popover, no focus taken),
// 'quiet' (another popover is open: the chip counts it) or anything else (the small popup).
export const setPeekCheck = check => { peekCheck = typeof check === 'function' ? check : null; };
export function addArrival(arrival, now = Date.now()) {
  let mode = '';
  try { mode = peekCheck?.(arrival.space, arrival.source) || ''; } catch { mode = ''; }
  list = pushArrival(list, {...arrival, peek: mode === 'peek', quiet: mode === 'quiet'}, now);
  return list;
}
export function holdArrivals(space, source, hovered, now = Date.now()) {
  const next = holdPeek(list, space, source, hovered, now);
  if (next === list) return false;
  list = next; return true;
}
export const setArrivalHost = check => { host = typeof check === 'function' ? check : null; };
export const clearArrivalHost = check => { if (host === check) host = null; };
export const hasArrivalHost = () => { try { return Boolean(host?.()); } catch { return false; } };
