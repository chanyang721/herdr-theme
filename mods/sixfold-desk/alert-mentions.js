import { projectKey, folded, currentFallbackSpace } from './alert-model.js';
import { arrivalTarget } from './arrival-model.js';

// Mentions routed to a space (slack-mentions.json: unmapped channels, DMs and thread replies go to the fallback space).
// They give that space its Slack badge and rows even when the tracked feed (project-alerts.json) has none.
// Module state grouped by space, set by alerts.js on each load: not a shared value, which is persisted
// and copied on every read — the badge reads this several times per card, and copying the whole list
// each time pushed the sidebar past its render budget ("could not be re-rendered … interrupted").
// A mention whose space is not on the sidebar ('미연결', a closed space) is grouped under the fallback space, the
// card its arrival lands on (arrivalTarget), so it stays in the fallback space's badge and popover after the peek.
// With no sidebar names (not loaded yet) each mention keeps its own space.
let mentionsBySpace = new Map();
export function setSpaceMentions(items, names = []) {
  const next = new Map(), onScreen = (names ?? []).length > 0;
  for (const item of items ?? []) {
    if (!item || typeof item.id !== 'string' || folded(item)) continue;
    const space = onScreen ? arrivalTarget(item.project, names) : item.project, key = projectKey(space);
    if (!next.has(key)) next.set(key, []);
    // A moved mention carries the fallback space as its project (as placeItems does for Linear), so the badge's
    // per-space filter (scopedAlerts) counts it; the collector's value stays in project_raw.
    next.get(key).push(key === projectKey(item.project) ? item : {...item, project: space, project_raw: item.project ?? ''});
  }
  mentionsBySpace = next;
}
export const spaceMentions = project => mentionsBySpace.get(projectKey(project)) ?? [];
// A new object on every load: alerts.js publishes sixfold.alertItems together with this call,
// so it doubles as the tracked feed's version (alert-inbox.js reads that feed once per load).
export const mentionsEpoch = () => mentionsBySpace;

// The Slack mentions that arrived in this run, per space (newest last, bounded). A new Slack alert shows
// in its card's own alert popover, as a Linear alert shows in its card's issue search: the peek draws
// that popover's surface, and the chip opens the same popover with the arrived ones listed first.
const ARRIVED_LIMIT = 20;
let arrivedBySpace = new Map();
export function noteArrived(space, item) {
  if (!item || typeof item.id !== 'string') return;
  const key = projectKey(space), list = (arrivedBySpace.get(key) ?? []).filter(other => other.id !== item.id);
  const next = new Map(arrivedBySpace);
  next.set(key, [...list, key === projectKey(item.project) ? item : {...item, project: space, project_raw: item.project ?? ''}].slice(-ARRIVED_LIMIT));
  arrivedBySpace = next;
}
export const arrivedFor = project => arrivedBySpace.get(projectKey(project)) ?? [];
export const clearArrived = () => { arrivedBySpace = new Map(); };

// Requests that need the person (alerts.json, status needs-you: a pane waiting, a mention to sort).
// Each belongs to its own space's card; one whose space is not among the cards the sidebar draws (none
// named, closed, another computer's) goes to the fallback space, as mentions do. alerts.js sets the items
// on each load and the sidebar sets the names it draws on each render; placement is redone only when the
// items, those names or the fallback space change. Module state, not a shared value.
const NEEDS = 'needs-you';
let needsItems = [], needsNames = null, needsBySpace = new Map(), needsKey = '', needsVersion = 0;
function placeNeeds() {
  const names = needsNames ?? [], key = JSON.stringify([needsVersion, names, currentFallbackSpace()]);
  if (key === needsKey) return;
  const next = new Map(), onScreen = names.length > 0;
  for (const item of needsItems) {
    const space = onScreen ? arrivalTarget(item.project, names) : item.project || '', group = projectKey(space);
    if (!next.has(group)) next.set(group, []);
    next.get(group).push(item);
  }
  needsBySpace = next; needsKey = key;
}
export function setSpaceNeeds(items) {
  needsItems = (items ?? []).filter(item => item && typeof item.id === 'string' && item.status === NEEDS);
  needsVersion++;
}
// The names of the space cards the sidebar draws now (its computer and space filter applied).
export function setNeedsNames(names) {
  const next = (names ?? []).filter(name => typeof name === 'string');
  if (!needsNames || next.length !== needsNames.length || next.some((name, i) => name !== needsNames[i])) needsNames = next;
}
export const spaceNeeds = project => { placeNeeds(); return needsBySpace.get(projectKey(project)) ?? []; };
// What a card draws of its requests and what a press on each does: the card's redraw key.
export const needsSignature = project => JSON.stringify(spaceNeeds(project).map(i => [i.id, i.title, i.summary, i.text, i.source, i.at, i.terminal, i.link]));
export function dropSpaceNeed(id) {
  const item = needsItems.find(other => other.id === id);
  if (!item) return null;
  needsItems = needsItems.filter(other => other.id !== id); needsVersion++;
  return item;
}
export function restoreSpaceNeed(item) {
  if (!item || needsItems.some(other => other.id === item.id)) return;
  needsItems = [...needsItems, item]; needsVersion++;
}
// The dismiss ledger lives with the alerts watcher (alerts.js); the popover only asks for it here.
let dismisser = null;
export const setNeedsDismisser = fn => { dismisser = typeof fn === 'function' ? fn : null; };
export function dismissNeed(id) {
  const item = dropSpaceNeed(id);
  return item && dismisser ? dismisser(item) : Promise.resolve();
}
