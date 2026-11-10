import { pushArrival } from './arrival-model.js';

// Arrivals of this run only (in memory, never persisted: nothing replays after
// a restart). The sidebar that draws them marks itself as the host each render;
// a new alert with no host falls back to its window, so it is never dropped.
let list = [];
let hostAt = -Infinity;
export const arrivals = () => list;
export function addArrival(arrival, now = Date.now()) { list = pushArrival(list, arrival, now); return list; }
export const markArrivalHost = (now = Date.now()) => { hostAt = now; };
export const hasArrivalHost = (now = Date.now()) => now - hostAt < 10_000;
