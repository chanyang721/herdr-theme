import { appHome, readTextFile, writeTextFile } from 'herdr';

// Linear details read only when the person looks: an issue when its detail opens, a space's
// milestones, issues and statuses when its issue search opens. While either stays open the panel
// asks again every LOOK_POLL_MS, and an answer older than its FRESH_MS is read again, so a change by
// anyone shows within about a minute (40 s + 5 s + the runner's 1 s look and ~1-2 s read + 1.5 s).
// The sidebar drops a request file; the local collector's read-only runner answers into
// linear-cache/. Nothing here calls Linear, and every map below is bounded.
export const ISSUE_FRESH_MS = 40 * 1000, PROJECT_FRESH_MS = 40 * 1000, LOOK_POLL_MS = 5 * 1000;
// WAIT_MS: how long '읽는 중' shows. WATCH_MS: how long the cache file is still checked for the answer —
// the collector takes a request up to 10 min old and a read lasts up to 7 min, so a late answer still lands.
const ASKED_MS = 30 * 1000, WAIT_MS = 8 * 60 * 1000, WATCH_MS = 18 * 60 * 1000, KEEP = {issue: 30, project: 10};
export const CACHE_POLL_MS = 1500;
const ISSUE_KEY = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/;
// File name of a space's cache: readable ASCII plus a hash of the whole name, so names that differ only
// outside ASCII (가나 / 다라) never share a file. Same function in the collector (space_slug).
const fnv = text => { let h = 0x811c9dc5; for (const byte of new TextEncoder().encode(text)) { h ^= byte; h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
// ASCII-only lowering and one '-' per code point (the u flag), exactly as the collector's per-character pass.
export const projectSlug = space => {
  const name = String(space || '');
  return `${name.replace(/[A-Z]/g, c => c.toLowerCase()).replace(/[^a-z0-9]/gu, '-')}-${fnv(name)}`;
};
const fileName = (kind, target) => kind === 'issue' ? `issue-${target}.json` : `project-${projectSlug(target)}.json`;
const entries = {issue: new Map(), project: new Map()};   // target -> {value, at(read time), asked, waiting}
let changedHook = null;
export const onCacheChanged = hook => { changedHook = hook; };

const entry = (kind, target) => {
  const map = entries[kind];
  let item = map.get(target);
  if (item) { map.delete(target); map.set(target, item); return item; }   // most recently used last
  item = {value: null, asked: 0, waiting: 0, watch: 0, forced: 0};
  map.set(target, item);
  while (map.size > KEEP[kind]) map.delete(map.keys().next().value);
  return item;
};
const validTarget = (kind, target) => kind === 'issue' ? ISSUE_KEY.test(target || '') : typeof target === 'string' && target.length > 0 && target.length <= 80;
export const cached = (kind, target) => entries[kind]?.get(target)?.value ?? null;
export const waiting = (kind, target, now = Date.now()) => {
  const item = entries[kind]?.get(target);
  return Boolean(item?.waiting && now - item.waiting < WAIT_MS);
};
const fresh = (kind, value, now) => {
  const at = Date.parse(value?.at || '');
  return value?.state === 'ok' && Number.isFinite(at) && now - at < (kind === 'issue' ? ISSUE_FRESH_MS : PROJECT_FRESH_MS);
};
const requestId = (now, random = Math.random) => `${now.toString(36)}-${random().toString(36).slice(2, 10).padEnd(8, '0')}`;

// Reads the cache file once (what was answered before shows at once), then asks for a read when it
// is missing or old. `force`: right after a write from the detail, read again even when fresh.
// The runner keeps its own longer freshness (issue 5 min, project 10 min) for a request without
// force, so a good answer that is old here is asked for with force; the runner still reads one
// target at most every 30 s.
export async function ensure(kind, target, {force = false, now = Date.now(), read = readTextFile, write = writeTextFile,
  home = appHome(), random = Math.random} = {}) {
  if (!entries[kind] || !validTarget(kind, target)) return null;
  const item = entry(kind, target);
  if (!item.value) await load(kind, target, {read, home});
  if (!force && (fresh(kind, item.value, now) || now - item.asked < ASKED_MS)) return item.value;
  if (force && now - item.forced < 30 * 1000) return item.value;
  const request = {v: 1, id: requestId(now, random), kind, requested_at: new Date(now).toISOString(),
    ...(kind === 'issue' ? {key: target} : {space: target}), ...(force || item.value?.state === 'ok' ? {force: true} : {})};
  await write(`${home}/data/sixfold/linear-reads/${request.id}.json`, JSON.stringify(request), null);
  item.asked = now; item.waiting = now; item.watch = now;
  if (force) item.forced = now;
  return item.value;
}

async function load(kind, target, {read = readTextFile, home = appHome()} = {}) {
  const text = await read(`${home}/data/sixfold/linear-cache/${fileName(kind, target)}`).catch(() => null);
  if (!text) return false;
  let value = null;
  try { value = JSON.parse(text); } catch { return false; }
  // Only the cache of this very target (never another space's or issue's file).
  if (value?.schema !== 1 || (kind === 'issue' ? value.key !== target : value.space !== target)) return false;
  const item = entry(kind, target), before = item.value?.at;
  item.value = value;
  if (value.at !== before && item.watch && Date.parse(value.at) >= item.watch - 1000) item.waiting = item.watch = 0;   // answered
  return value.at !== before;
}

// While anything is being read, its cache file is checked; true when something new arrived.
export async function checkCaches({read = readTextFile, home = appHome(), now = Date.now()} = {}) {
  let changed = false;
  for (const kind of Object.keys(entries)) {
    for (const [target, item] of [...entries[kind]]) {
      if (!item.watch) continue;
      if (item.waiting && now - item.waiting >= WAIT_MS) { item.waiting = 0; changed = true; }   // '읽는 중' ends
      if (now - item.watch >= WATCH_MS) { item.watch = 0; continue; }                             // no answer at all
      if (await load(kind, target, {read, home})) changed = true;
    }
  }
  if (changed) changedHook?.();
  return changed;
}
// True while any answer may still come (keeps the cache check running; it stops by itself after WATCH_MS).
export const anyWaiting = (now = Date.now()) => Object.values(entries).some(map => [...map.values()].some(item => item.watch && now - item.watch < WATCH_MS));
export const resetCaches = () => { for (const map of Object.values(entries)) map.clear(); };
