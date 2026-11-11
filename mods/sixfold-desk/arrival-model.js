// New-alert arrivals (Slack, Linear): a small popup shows for a few seconds, then
// folds into its space card in short integer-pixel steps, and the card's alert
// badge counts it only once it has landed. With motion off there is no popup and
// no movement: the badge simply counts it. Pure functions; the sidebar owns
// rendering and the clock. Bounded: at most ARRIVAL.ledger entries are kept.
import { projectKey } from './alert-model.js';

export const ARRIVAL = Object.freeze({showMs: 4000, flyMs: 640, steps: 6, unit: 2, blinkMs: 480, visible: 3, ledger: 50, keepMs: 60_000,
  peekMs: 8000, holdMs: 60_000});

// How an arrival is shown, decided when it is added (see arrival-store's peek check):
// - peek: the space's own popover (issue search for Linear, alert popover for Slack) opens
//   beside its card without taking focus, for ARRIVAL.peekMs (held while the pointer rests
//   on it, at most holdMs), then folds into the card's chip. One peek at a time: a peek for
//   another space waits its turn; more alerts for the open one join it and restart its time.
// - quiet: something else is open (another popover, typing): no popup, the chip counts it.
// - otherwise the small popup of a card without merged chips.
export const showFor = a => a?.peek ? ARRIVAL.peekMs : ARRIVAL.showMs;
const held = (a, now) => Boolean(a?.held) && now - a.held < ARRIVAL.holdMs;
const WAITING = Number.MAX_SAFE_INTEGER;   // a peek queued behind one that is held open
export const FALLBACK_SPACE = 'Share';

// The space an alert belongs to, among the spaces on screen; Share otherwise.
export function arrivalTarget(workspace, names = [], fallback = FALLBACK_SPACE) {
  const hit = (names ?? []).find(name => projectKey(name) === projectKey(workspace));
  return hit ?? (names ?? []).find(name => projectKey(name) === projectKey(fallback)) ?? fallback;
}

export function arrivalPhase(arrival, now, motion = true) {
  if (!motion || arrival.quiet) return 'landed';
  if (held(arrival, now)) return 'show';
  const age = now - arrival.at, show = showFor(arrival);
  return age < 0 ? 'queued' : age < show ? 'show' : age < show + ARRIVAL.flyMs ? 'fly' : 'landed';
}
const sameCard = (a, b) => projectKey(a.space) === projectKey(b.space) && a.source === b.source;
// When the peeks other than `group` are done showing (held ones count as not yet).
function peekEnd(list, now, group = null) {
  let end = now;
  for (const a of list) {
    if (!a.peek || (group && sameCard(a, group))) continue;
    const phase = arrivalPhase(a, now);
    if (phase === 'show' || phase === 'queued') end = Math.max(end, held(a, now) ? WAITING : a.at + ARRIVAL.peekMs);
  }
  return end;
}

const cardId = a => `${projectKey(a.space)}:${a.source}`;

// Queued peeks start one card after another, in their order, never before the card ahead of
// them is done: a card whose time restarted (more alerts joined it) pushes the ones behind it,
// so no two cards show at once and each queued card gets its full peekMs.
function requeue(list, now) {
  const cards = new Map();
  for (const a of list) {
    const phase = a.peek ? arrivalPhase(a, now) : '';
    if (phase !== 'show' && phase !== 'queued') continue;
    const card = cards.get(cardId(a)) ?? {at: a.at, queued: true, held: false};
    card.at = Math.min(card.at, a.at);
    card.queued &&= phase === 'queued';
    card.held ||= held(a, now);
    cards.set(cardId(a), card);
  }
  let end = now;
  const starts = new Map();
  for (const [id, card] of [...cards].sort((x, y) => x[1].at - y[1].at)) {
    if (!card.queued) { end = Math.max(end, card.held ? WAITING : card.at + ARRIVAL.peekMs); continue; }
    const start = end === WAITING ? WAITING : Math.max(card.at, end);
    starts.set(id, start);
    end = start === WAITING ? WAITING : start + ARRIVAL.peekMs;
  }
  return list.map(a => a.peek && starts.has(cardId(a)) && arrivalPhase(a, now) === 'queued' && a.at !== starts.get(cardId(a))
    ? {...a, at: starts.get(cardId(a))} : a);
}

// Adds one arrival (once per key), drops landed ones past keepMs, keeps the newest `ledger`.
export function pushArrival(list, arrival, now) {
  const kept = (list ?? []).filter(a => a.key !== arrival.key && (a.at > now || now - a.at < showFor(a) + ARRIVAL.flyMs + ARRIVAL.keepMs));
  if (!arrival.peek) return [...kept, {...arrival, at: now}].slice(-ARRIVAL.ledger);
  const open = kept.filter(a => a.peek && sameCard(a, arrival) && ['show', 'queued'].includes(arrivalPhase(a, now)));
  // Joins its card's open (or queued) peek: they show and fold together, from the later start.
  const start = open.length ? Math.max(now, ...open.map(a => a.at)) : peekEnd(kept, now);
  const timed = kept.map(a => open.includes(a) ? {...a, at: start} : a);
  return requeue([...timed, {...arrival, at: start}], now).slice(-ARRIVAL.ledger);
}

// The pointer rests on a peek (hovered) or leaves it. Leaving restarts its peekMs and
// moves the peeks queued behind it to after it, in their order.
export function holdPeek(list, space, source, hovered, now) {
  const card = {space, source};
  let changed = false;
  const next = (list ?? []).map(a => {
    if (!a.peek || !sameCard(a, card) || arrivalPhase(a, now) !== 'show') return a;
    changed = true;
    return hovered ? {...a, held: now} : {...a, held: 0, at: now};
  });
  if (!changed) return list;
  // Re-queue the others: one peek after another, each card's alerts together.
  let end = hovered ? WAITING : now + ARRIVAL.peekMs;
  const starts = new Map();
  return next.map(a => {
    if (!a.peek || sameCard(a, card) || arrivalPhase(a, now) !== 'queued') return a;
    const id = cardId(a);
    if (!starts.has(id)) { starts.set(id, end); if (end !== WAITING) end += ARRIVAL.peekMs; }
    return {...a, at: starts.get(id)};
  });
}

// Peeks queued behind a hold that ended by itself (holdMs) start again, one card after another.
export function settleQueue(list, now) {
  if (!(list ?? []).some(a => a.at === WAITING) || (list ?? []).some(a => a.peek && held(a, now))) return list;
  let end = peekEnd(list.filter(a => a.at !== WAITING), now);
  const starts = new Map();
  return list.map(a => {
    if (a.at !== WAITING) return a;
    const id = cardId(a);
    if (!starts.has(id)) { starts.set(id, end); end += ARRIVAL.peekMs; }
    return {...a, at: starts.get(id)};
  });
}

// The peeks to draw now: one card at a time (its alerts together), or null.
export function activePeek(list, now, motion = true) {
  if (!motion) return null;
  const shown = (list ?? []).filter(a => a.peek && arrivalPhase(a, now, motion) === 'show');
  if (!shown.length) return null;
  const first = shown[0];
  return {space: first.space, source: first.source, arrivals: shown.filter(a => sameCard(a, first))};
}

// Popups on screen now (show or fly), newest last, at most `visible`.
// Peeks are drawn by activePeek; queued ones are not on screen yet.
export function visibleArrivals(list, now, motion = true) {
  return (list ?? []).filter(a => !a.peek && ['show', 'fly'].includes(arrivalPhase(a, now, motion))).slice(-ARRIVAL.visible);
}
// Peeks folding into their chip now (the block flies from the card's edge).
export const foldingPeeks = (list, now, motion = true) => (list ?? []).filter(a => a.peek && arrivalPhase(a, now, motion) === 'fly');

// Alerts still on their way to a card are not in its badge yet.
export function inFlight(list, space, source, now, motion = true) {
  return (list ?? []).filter(a => projectKey(a.space) === projectKey(space) && (!source || a.source === source)
    && arrivalPhase(a, now, motion) !== 'landed').length;
}

// Which of the ARRIVAL.steps flight points the block is on now (0-based).
export function flightStep(arrival, now) {
  const into = now - arrival.at - showFor(arrival);
  return Math.max(0, Math.min(ARRIVAL.steps - 1, Math.floor(into / (ARRIVAL.flyMs / ARRIVAL.steps))));
}

// Landed a moment ago: the card blinks once where it came in.
export function justLanded(list, now, motion = true) {
  if (!motion) return [];
  return (list ?? []).filter(a => { if (a.quiet || held(a, now)) return false; const since = now - a.at - showFor(a) - ARRIVAL.flyMs; return since >= 0 && since < ARRIVAL.blinkMs; });
}

// The next moment the sidebar must re-render (popup ends, each flight step,
// landing, blink end), or null. Finite: at most steps + 2 per arrival.
export function nextPhaseAt(list, now, motion = true) {
  if (!motion) return null;
  const step = ARRIVAL.flyMs / ARRIVAL.steps;
  const edges = (list ?? []).flatMap(a => {
    if (a.quiet || a.at >= WAITING) return [];
    if (held(a, now)) return [a.held + ARRIVAL.holdMs];   // a hold that outlives holdMs lets go
    const fly = a.at + showFor(a);
    return [a.at, ...Array.from({length: ARRIVAL.steps}, (_, k) => fly + k * step), fly + ARRIVAL.flyMs, fly + ARRIVAL.flyMs + ARRIVAL.blinkMs];
  }).filter(t => t > now);
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

// Ids of the alerts still on their way, so each badge counts exactly the items
// that have landed (an arrival whose item the badge does not list changes nothing).
export function flyingIds(list, now, motion = true) {
  return new Set((list ?? []).filter(a => a.id && arrivalPhase(a, now, motion) !== 'landed').map(a => a.id));
}
