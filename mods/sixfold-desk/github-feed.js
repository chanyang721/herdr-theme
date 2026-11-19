import { appHome, readTextFile, writeTextFile, setShared, openOverlay, spaces } from 'herdr';
import { createHash } from 'crypto';
import { readJsonSnapshot, subscribeJsonFile, subscribeFileChanges } from './panel-io.js';
import { addArrival, hasArrivalHost } from './arrival-store.js';
import { arrivalTarget, ARRIVAL } from './arrival-model.js';
import { placeItems, githubKind, githubLine, githubRef } from './alert-model.js';
import { createRetry, watchRecorder } from './watch-guard.js';
import { createSharedPublisher } from './shared-publish.js';

// GitHub feed for the sidebar: data/sixfold/github-alerts.json and github-live-health.json, written by a
// machine-local collector (`gh`, read only). Built like linear-feed.js: it only reacts to file changes (no
// polling timer), parses nothing on the UI thread, publishes a shared key only when it changed, and stops
// with the view's alert subscriptions. Nothing here writes to GitHub.

const LEDGER = 'github-popup-events.json';
const LEDGER_LIMIT = 500;   // events already announced; bounded
export const LOAD_STUCK_MS = 120000;
// Only the health fields a reader draws (the inbox's collect line).
const HEALTH = ['source', 'state', 'error_kind', 'errors', 'last_success', 'count', 'unread'];
export const githubHealthView = health => Object.fromEntries(HEALTH.filter(k => health && typeof health === 'object' && Object.hasOwn(health, k)).map(k => [k, health[k]]));

// A popup for each new piece of work: a review request once, a mention once, my pull request each time it
// newly needs me (the collector's `event` changes then). An item with no event (my pull request with
// nothing to do) never pops up.
export function githubPopupEvents(items) {
  return (items ?? []).filter(item => typeof item?.id === 'string' && item.id && typeof item.event === 'string' && item.event)
    .map(item => ({key: `github:${item.event}`, id: item.id, popup: Boolean(item.unread), workspace: item.workspace ?? '',
      title: item.title || '', issue: githubRef(item), line: githubLine(item), label: githubKind(item).label, kind: githubKind(item).kind,
      url: item.url || ''}));
}

async function ledgerSnapshot(path) {
  const typed = await readJsonSnapshot(path);
  const raw = await readTextFile(path).catch(() => null);
  if (typed.status === 'missing' && raw === null) return {value: {schema: 1, seen: []}, raw: null, firstRun: true};
  if (typed.status !== 'ready' || typeof raw !== 'string' || createHash('sha256').update(raw).digest('hex') !== typed.hash) {
    throw new Error('File changed while reading its typed snapshot');
  }
  return {value: typed.value, raw, firstRun: false};
}

// Every event is recorded once, so nothing is announced twice. The first run records what is already
// there silently (as Slack does): a pull request that failed CI last week is not news today.
async function announce(events, allowed = () => true) {
  const path = `${appHome()}/data/sixfold/${LEDGER}`;
  const {value: ledger, raw, firstRun} = await ledgerSnapshot(path);
  if (ledger?.schema !== 1 || !Array.isArray(ledger.seen) || !ledger.seen.every(key => typeof key === 'string')) {
    throw new Error('Invalid GitHub popup event ledger');
  }
  const seen = new Set(ledger.seen);
  const fresh = events.filter(event => !seen.has(event.key));
  if (!fresh.length && !firstRun) return [];
  const next = {schema: 1, seen: [...ledger.seen, ...fresh.map(event => event.key)].slice(-LEDGER_LIMIT)};
  if (!allowed()) throw new Error('View no longer displays alerts');
  await writeTextFile(path, JSON.stringify(next), raw);
  return firstRun ? [] : fresh.filter(event => event.popup).slice(0, ARRIVAL.visible).reverse();
}

// The spaces that show a GitHub chip: the ones the collector maps a repository to, and those with items;
// one not on the sidebar counts on the fallback space (placeItems).
export function githubSpaces(feed, names) {
  const listed = Array.isArray(feed?.spaces) ? feed.spaces.filter(s => typeof s === 'string' && s) : [];
  const placed = placeItems(listed.map(workspace => ({workspace})), names).map(i => i.workspace);
  return [...new Set(placed)];
}

// Readers outside this file (alert-inbox.js, alert-popover.js, the GitHub inbox mod) read these keys with
// shared(); a key is written only when its value changed. Returns whether anything was written.
export function publishGithub(feed, health, names = [], publish = createSharedPublisher(setShared)) {
  const items = placeItems(Array.isArray(feed?.items) ? feed.items : [], names);
  let changed = publish('sixfold.githubItems', items);
  changed = publish('sixfold.githubSpaces', githubSpaces(feed, names)) || changed;
  changed = publish('sixfold.githubHealth', githubHealthView(health)) || changed;
  return changed;
}

// A new piece of work becomes an arrival that folds into its space card (the fallback space when no space matches);
// without a sidebar drawing arrivals the GitHub window opens, so it is never dropped.
export function announceGithub(events) {
  if (!events.length) return;
  if (!hasArrivalHost()) return openGithubWindow();
  const names = (spaces() ?? []).map(s => s.name);
  for (const event of events) {
    addArrival({key: event.key, id: event.id, source: 'github', space: arrivalTarget(event.workspace, names),
      title: event.title, issue: event.issue, line: event.line, label: event.label, kind: event.kind, url: event.url});
  }
}

export function openGithubWindow() {
  openOverlay({mod: 'sixfold-github-inbox', kind: 'window', key: 'github-inbox', keep: true, width: 900, height: 720, props: {window: true}});
}

export function watchGithub(view, cx) {
  view.stopGithub?.();
  const base = `${appHome()}/data/sixfold`;
  const inputs = [['feed', 'github-alerts.json', () => ({items: []})], ['health', 'github-live-health.json', () => ({})]];
  const cached = new Map(), subscriptions = [];
  let loading = false, loadingAt = 0, run = 0, previous, disposed = false, scheduled = null, dirty = false, version = 0, announced = null;
  const publish = createSharedPublisher(setShared);
  const allowed = () => !disposed && view.sidebarVisible !== false;
  const busy = () => loading && Date.now() - loadingAt < LOAD_STUCK_MS;
  // A failed or refused refresh is retried after a delay even when no input changes (watch-guard.js).
  const statePath = `${base}/github-alert-watch.json`;
  const retry = createRetry({timer: (ms, fn) => cx.timer.after(ms, fn), retry: () => schedule(),
    record: watchRecorder(text => cx.spawn(async () => { try { await writeTextFile(statePath, text, await readTextFile(statePath).catch(() => null)); } catch { /* best effort */ } }))});
  const held = [];
  const deliver = () => {
    if (!held.length || !allowed()) return;
    announceGithub(held.splice(0));
    cx.notify(); view.panelRetained?.alertsChanged?.();
  };
  const schedule = () => {
    dirty = true;
    if (!allowed() || busy() || scheduled || cached.size !== inputs.length) return;
    scheduled = cx.timer.after(20, () => { scheduled = null; refresh(cx); });
  };
  const refresh = context => {
    if (!allowed() || cached.size !== inputs.length) return;
    if (busy()) { dirty = true; return; }
    dirty = false;
    const signature = JSON.stringify(inputs.map(([key]) => cached.get(key).token));
    deliver();
    if (signature === previous && !loading) return;
    if (loading) retry.note('stalled');
    const mine = ++run;
    const live = () => allowed() && mine === run;
    loading = true; loadingAt = Date.now();
    const release = () => { if (mine !== run) return; loading = false; if (dirty) schedule(); };
    try { (context ?? cx).spawn(async cx => {
      try {
        const feedEntry = cached.get('feed'), feed = feedEntry.value, health = cached.get('health').value;
        const names = (spaces() ?? []).map(s => s.name);
        if (publishGithub(feed, health, names, publish)) { cx.notify(); view.panelRetained?.alertsChanged?.(); }
        const popups = JSON.stringify([feedEntry.token, names]);
        // No feed yet (the collector has not run): the ledger is left alone, so the first real feed is the
        // one recorded silently, not announced as if all of it were new.
        if (popups !== announced && feedEntry.token !== 'missing') {
          held.push(...await announce(githubPopupEvents(placeItems(feed.items ?? [], names)), live));
          deliver();
        }
        if (!live()) return;
        previous = signature; announced = popups;
        retry.ok();
      } catch (error) { if (mine === run) retry.fail(error); }
      finally { release(); }
    }); } catch (error) {
      // cx.spawn can refuse before the task runs; release here so a later change retries.
      if (mine === run) loading = false;
      dirty = true;
      retry.fail(error);
    }
  };
  for (const [key, name, fallback] of inputs) {
    subscriptions.push(subscribeJsonFile(cx, `${base}/${name}`, snapshot => {
      if (disposed) return;
      const last = cached.get(key);
      if (snapshot.status === 'missing') {
        if (!last) { cached.set(key, {value: fallback(), hash: null, token: 'missing'}); schedule(); }
        return;
      }
      if (snapshot.status !== 'ready' || !snapshot.value || typeof snapshot.value !== 'object' || Array.isArray(snapshot.value)) return;
      const hash = typeof snapshot.hash === 'string' ? snapshot.hash : null;
      if (last && ((hash !== null && hash === last.hash) || (hash === null && snapshot.value === last.value))) return;
      cached.set(key, {value: snapshot.value, hash, token: hash ?? `value-${++version}`}); schedule();
    }));
  }
  subscriptions.push(subscribeFileChanges(cx, `${base}/${LEDGER}`, () => { if (!disposed) schedule(); }));
  const stop = () => { if (disposed) return; disposed = true; retry.dispose(); scheduled?.cancel?.(); scheduled = null; subscriptions.forEach(unsubscribe => unsubscribe()); };
  view.refreshGithub = refresh; view.stopGithub = stop; (view.fileSubscriptions ??= []).push(stop);
  return stop;
}
