import { appHome, readTextFile, writeTextFile } from 'herdr';

// Linear details read only when the person looks: an issue when its detail opens (fresh 5 min), a
// space's milestones, issues and statuses when its issue search opens (fresh 10 min). The sidebar
// drops a request file; the local collector's read-only runner answers into linear-cache/. Nothing
// here calls Linear, and every map below is bounded.
export const ISSUE_FRESH_MS = 5 * 60 * 1000, PROJECT_FRESH_MS = 10 * 60 * 1000;
const ASKED_MS = 60 * 1000, WAIT_MS = 4 * 60 * 1000, KEEP = {issue: 30, project: 10};
export const CACHE_POLL_MS = 1500;
const ISSUE_KEY = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/;
export const projectSlug = space => String(space || '').toLowerCase().replace(/[^a-z0-9]/g, '-');
const fileName = (kind, target) => kind === 'issue' ? `issue-${target}.json` : `project-${projectSlug(target)}.json`;
const entries = {issue: new Map(), project: new Map()};   // target -> {value, at(read time), asked, waiting}
let changedHook = null;
export const onCacheChanged = hook => { changedHook = hook; };

const entry = (kind, target) => {
  const map = entries[kind];
  let item = map.get(target);
  if (item) { map.delete(target); map.set(target, item); return item; }   // most recently used last
  item = {value: null, asked: 0, waiting: 0, forced: 0};
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
export async function ensure(kind, target, {force = false, now = Date.now(), read = readTextFile, write = writeTextFile,
  home = appHome(), random = Math.random} = {}) {
  if (!entries[kind] || !validTarget(kind, target)) return null;
  const item = entry(kind, target);
  if (!item.value) await load(kind, target, {read, home});
  if (!force && (fresh(kind, item.value, now) || now - item.asked < ASKED_MS)) return item.value;
  if (force && now - item.forced < 30 * 1000) return item.value;
  const request = {v: 1, id: requestId(now, random), kind, requested_at: new Date(now).toISOString(),
    ...(kind === 'issue' ? {key: target} : {space: target}), ...(force ? {force: true} : {})};
  await write(`${home}/data/sixfold/linear-reads/${request.id}.json`, JSON.stringify(request), null);
  item.asked = now; item.waiting = now;
  if (force) item.forced = now;
  return item.value;
}

async function load(kind, target, {read = readTextFile, home = appHome()} = {}) {
  const text = await read(`${home}/data/sixfold/linear-cache/${fileName(kind, target)}`).catch(() => null);
  if (!text) return false;
  let value = null;
  try { value = JSON.parse(text); } catch { return false; }
  if (value?.schema !== 1) return false;
  const item = entry(kind, target), before = item.value?.at;
  item.value = value;
  if (value.at !== before && Date.parse(value.at) >= item.waiting - 1000) item.waiting = 0;   // answered
  return value.at !== before;
}

// While anything is being read, its cache file is checked; true when something new arrived.
export async function checkCaches({read = readTextFile, home = appHome(), now = Date.now()} = {}) {
  let changed = false;
  for (const kind of Object.keys(entries)) {
    for (const [target, item] of [...entries[kind]]) {
      if (!item.waiting) continue;
      if (now - item.waiting >= WAIT_MS) { item.waiting = 0; changed = true; continue; }   // no answer: stop waiting
      if (await load(kind, target, {read, home})) changed = true;
    }
  }
  if (changed) changedHook?.();
  return changed;
}
export const anyWaiting = (now = Date.now()) => Object.values(entries).some(map => [...map.values()].some(item => item.waiting && now - item.waiting < WAIT_MS));
export const resetCaches = () => { for (const map of Object.values(entries)) map.clear(); };
