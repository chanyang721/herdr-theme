import { appHome, readTextFile, writeTextFile, setShared, openOverlay, spaces } from 'herdr';
import { createHash } from 'crypto';
import { readJsonSnapshot, subscribeJsonFile, subscribeFileChanges } from './panel-io.js';
import { addArrival, hasArrivalHost } from './arrival-store.js';
import { arrivalTarget, ARRIVAL } from './arrival-model.js';
import { placeItems } from './alert-model.js';

// Linear inbox feed for the sidebar: data/sixfold/linear-alerts.json and
// linear-live-health.json, written by a machine-local collector. Kept apart from
// the Slack/pane alerts so a bad Linear file or ledger write never holds them back.
// Like watchAlerts it only reacts to file changes (no polling timer), parses
// nothing on the UI thread, and stops with the view's alert subscriptions.

// Notifications that pop up: a person was assigned, named or answered.
// `commentsAndReplies` is the category Linear reports for issue comments.
const POPUP = new Set(['assignments', 'mentions', 'comments', 'commentsAndReplies']);
const LEDGER = 'linear-popup-events.json';
const LEDGER_LIMIT = 500;   // ids of notifications already announced; bounded

export function linearPopupEvents(items) {
  return (items ?? []).filter(item => typeof item?.id === 'string' && item.id)
    .map(item => ({key: `linear:${item.id}`, id: item.id, popup: !item.read && POPUP.has(item.category), workspace: item.workspace ?? '',
      title: item.issue_title || item.title || '', issue: item.issue || '', category: item.category || ''}));
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

// Every id is recorded once, so nothing is announced twice. On the very first
// run the history is recorded too, but alerts still unread in Linear (newest
// ARRIVAL.visible) are announced: Linear's own read state says they are new to
// the person. Later writes use the previous contents as a compare-and-swap guard.
async function announce(events, allowed = () => true) {
  const path = `${appHome()}/data/sixfold/${LEDGER}`;
  const {value: ledger, raw, firstRun} = await ledgerSnapshot(path);
  if (ledger?.schema !== 1 || !Array.isArray(ledger.seen) || !ledger.seen.every(key => typeof key === 'string')) {
    throw new Error('Invalid Linear popup event ledger');
  }
  const seen = new Set(ledger.seen);
  const fresh = events.filter(event => !seen.has(event.key));
  if (!fresh.length && !firstRun) return [];
  const next = {schema: 1, seen: [...ledger.seen, ...fresh.map(event => event.key)].slice(-LEDGER_LIMIT)};
  if (!allowed()) throw new Error('View no longer displays alerts');
  await writeTextFile(path, JSON.stringify(next), raw);
  // The feed is newest first: announce the newest few, oldest of them first so the newest lands last.
  return fresh.filter(event => event.popup).slice(0, ARRIVAL.visible).reverse();
}

export function publishLinear(feed, health, names = []) {
  const items = placeItems(feed.items ?? [], names);
  setShared('sixfold.linearItems', items);
  setShared('sixfold.linearSpaces', names.length ? [...new Set(items.map(i => i.workspace).filter(Boolean))] : feed.spaces ?? []);
  setShared('sixfold.linearStatuses', feed.statuses ?? {});
  setShared('sixfold.linearHealth', health ?? {});
}

// A new alert becomes an arrival: a popup that folds into its space card (Share
// when no space matches). A sidebar that draws arrivals marks itself as host;
// without one the Linear window opens, so an alert is never dropped.
export function announceLinear(events) {
  if (!events.length) return;
  if (!hasArrivalHost()) return openLinearWindow();
  const names = (spaces() ?? []).map(s => s.name);
  for (const event of events) {
    addArrival({key: event.key, id: event.id, source: 'linear', space: arrivalTarget(event.workspace, names),
      title: event.title, issue: event.issue, category: event.category});
  }
}

export function openLinearWindow() {
  openOverlay({mod: 'sixfold-linear-inbox', kind: 'window', key: 'linear-inbox', keep: true, width: 980, height: 760, props: {window: true}});
}

export function watchLinear(view, cx) {
  view.stopLinear?.();
  const base = `${appHome()}/data/sixfold`;
  const inputs = [['feed', 'linear-alerts.json', () => ({items: []})], ['health', 'linear-live-health.json', () => ({})]];
  const cached = new Map(), subscriptions = [];
  let loading = false, previous, disposed = false, scheduled = null, dirty = false, version = 0;
  const allowed = () => !disposed && view.sidebarVisible !== false;
  const schedule = () => {
    dirty = true;
    if (!allowed() || loading || scheduled || cached.size !== inputs.length) return;
    scheduled = cx.timer.after(20, () => { scheduled = null; refresh(cx); });
  };
  const refresh = context => {
    if (!allowed() || cached.size !== inputs.length) return;
    if (loading) { dirty = true; return; }
    dirty = false;
    const signature = JSON.stringify(inputs.map(([key]) => cached.get(key).token));
    if (signature === previous) return;
    loading = true;
    (context ?? cx).spawn(async cx => {
      try {
        const feed = cached.get('feed').value, health = cached.get('health').value;
        const names = (spaces() ?? []).map(s => s.name);
        publishLinear(feed, health, names);
        cx.notify();
        const events = await announce(linearPopupEvents(placeItems(feed.items ?? [], names)), allowed);
        if (!allowed()) return;
        previous = signature;   // after the ledger write, so a failed write is retried
        announceLinear(events);
        if (events.length) cx.notify();   // the sidebar draws the new arrivals
      } catch { /* A partial collector write keeps the last valid list; retried on the next change. */ }
      finally { loading = false; if (dirty) schedule(); }
    });
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
  const stop = () => { if (disposed) return; disposed = true; scheduled?.cancel?.(); scheduled = null; subscriptions.forEach(unsubscribe => unsubscribe()); };
  view.refreshLinear = refresh; view.stopLinear = stop; (view.fileSubscriptions ??= []).push(stop);
  return stop;
}
