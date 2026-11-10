import { pushArrival } from './arrival-model.js';

// Arrivals of this run only (in memory, never persisted: nothing replays after
// a restart). A sidebar that draws them registers itself as the host while it
// is shown; a new alert with no host falls back to its window, so it is never dropped.
let list = [];
let host = null;
export const arrivals = () => list;
export function addArrival(arrival, now = Date.now()) { list = pushArrival(list, arrival, now); return list; }
export const setArrivalHost = check => { host = typeof check === 'function' ? check : null; };
export const clearArrivalHost = check => { if (host === check) host = null; };
export const hasArrivalHost = () => { try { return Boolean(host?.()); } catch { return false; } };
