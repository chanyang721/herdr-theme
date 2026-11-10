// New-alert arrivals (Slack, Linear): a small popup shows for a few seconds, then
// folds into its space card in short integer-pixel steps, and the card's alert
// badge counts it only once it has landed. With motion off there is no popup and
// no movement: the badge simply counts it. Pure functions; the sidebar owns
// rendering and the clock. Bounded: at most ARRIVAL.ledger entries are kept.
import { projectKey } from './alert-model.js';

export const ARRIVAL = Object.freeze({showMs: 4000, flyMs: 640, steps: 6, unit: 2, visible: 3, ledger: 50, keepMs: 60_000});
export const FALLBACK_SPACE = 'Share';

// The space an alert belongs to, among the spaces on screen; Share otherwise.
export function arrivalTarget(workspace, names = [], fallback = FALLBACK_SPACE) {
  const hit = (names ?? []).find(name => projectKey(name) === projectKey(workspace));
  return hit ?? (names ?? []).find(name => projectKey(name) === projectKey(fallback)) ?? fallback;
}

export function arrivalPhase(arrival, now, motion = true) {
  if (!motion) return 'landed';
  const age = now - arrival.at;
  return age < ARRIVAL.showMs ? 'show' : age < ARRIVAL.showMs + ARRIVAL.flyMs ? 'fly' : 'landed';
}

// Adds one arrival (once per key), drops landed ones past keepMs, keeps the newest `ledger`.
export function pushArrival(list, arrival, now) {
  const kept = (list ?? []).filter(a => a.key !== arrival.key && now - a.at < ARRIVAL.showMs + ARRIVAL.flyMs + ARRIVAL.keepMs);
  return [...kept, {...arrival, at: now}].slice(-ARRIVAL.ledger);
}

// Popups on screen now (show or fly), newest last, at most `visible`.
export function visibleArrivals(list, now, motion = true) {
  return (list ?? []).filter(a => arrivalPhase(a, now, motion) !== 'landed').slice(-ARRIVAL.visible);
}

// Alerts still on their way to a card are not in its badge yet.
export function inFlight(list, space, source, now, motion = true) {
  return (list ?? []).filter(a => projectKey(a.space) === projectKey(space) && (!source || a.source === source)
    && arrivalPhase(a, now, motion) !== 'landed').length;
}

// The next moment the sidebar must re-render for a phase change, or null.
export function nextPhaseAt(list, now, motion = true) {
  if (!motion) return null;
  const edges = (list ?? []).flatMap(a => [a.at + ARRIVAL.showMs, a.at + ARRIVAL.showMs + ARRIVAL.flyMs]).filter(t => t > now);
  return edges.length ? Math.min(...edges) : null;
}

// Integer-pixel steps from the popup to the card's badge, on a `unit` grid,
// accelerating, ending exactly on the target: the same short stepped grammar
// as the message packets. Both points are {x, y} in the sidebar's coordinates.
export function flightPath(from, to, {steps = ARRIVAL.steps, unit = ARRIVAL.unit} = {}) {
  const snap = v => Math.round(v / unit) * unit;
  const points = [];
  for (let k = 1; k <= steps; k++) {
    const t = (k / steps) ** 2;
    const point = k === steps ? {x: snap(to.x), y: snap(to.y)} : {x: snap(from.x + (to.x - from.x) * t), y: snap(from.y + (to.y - from.y) * t)};
    const last = points.at(-1);
    if (!last || last.x !== point.x || last.y !== point.y) points.push(point);
  }
  return points;
}

// Pressing a popup goes straight to that space's inbox for its source.
export const arrivalOpen = arrival => ({source: arrival.source === 'linear' ? 'linear' : 'slack', project: arrival.space});
