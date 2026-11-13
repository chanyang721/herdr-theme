import { appHome, readTextFile, writeTextFile, setShared, openOverlay, spaces } from 'herdr';
import { createHash } from 'crypto';
import { readJsonSnapshot, subscribeJsonFile, subscribeFileChanges } from './panel-io.js';
import { addArrival, hasArrivalHost } from './arrival-store.js';
import { arrivalTarget, ARRIVAL } from './arrival-model.js';
import { placeItems, alertKind, alertLine } from './alert-model.js';
import { withLocalReads, onReadConfirmed } from './linear-reads.js';
import { createRetry, watchRecorder } from './watch-guard.js';

// Linear inbox feed for the sidebar: data/sixfold/linear-alerts.json and
// linear-live-health.json, written by a machine-local collector. Kept apart from
// the Slack/pane alerts so a bad Linear file or ledger write never holds them back.
// Like watchAlerts it only reacts to file changes (no polling timer), parses
// nothing on the UI thread, and stops with the view's alert subscriptions.

// Notifications that pop up: a person was assigned, named or answered.
// `commentsAndReplies` is the category Linear reports for issue comments.
// Every kind pops up (new issue, comment, reply, assignment, status change, due, mention, review)
// except reactions and Linear's own system notices.
const QUIET = new Set(['reactions', 'system']);
const POPUP = {has: category => !QUIET.has(category)};
const LEDGER = 'linear-popup-events.json';
const LEDGER_LIMIT = 500;   // ids of notifications already announced; bounded
export const LOAD_STUCK_MS = 120000;   // a refresh still loading after this no longer blocks the next one

export function linearPopupEvents(items) {
  return (items ?? []).filter(item => typeof item?.id === 'string' && item.id)
    .map(item => ({key: `linear:${item.id}`, id: item.id, popup: !item.read && POPUP.has(item.category), workspace: item.workspace ?? '',
      title: item.issue_title || item.title || '', issue: item.issue || '', category: item.category || '',
      // What changed, in one line: Linear's own subtitle ("Kim commented: …") or the comment read for it.
      line: alertLine(item), label: alertKind(item).label, kind: alertKind(item).kind, url: item.url || ''}));
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
  onReadConfirmed(() => publishLinear(feed, health, names));   // a confirmed read is shown before the next collection
  const items = withLocalReads(placeItems(feed.items ?? [], names));
  setShared('sixfold.linearItems', items);
  setShared('sixfold.linearSpaces', names.length ? [...new Set(items.map(i => i.workspace).filter(Boolean))] : feed.spaces ?? []);
  setShared('sixfold.linearStatuses', feed.statuses ?? {});
  setShared('sixfold.linearHealth', health ?? {});
  // Writes the collector accepts on this computer (an opened row marks read only when mark_read is on).
  setShared('sixfold.linearWrites', Array.isArray(feed.writes) ? feed.writes : []);
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
      title: event.title, issue: event.issue, category: event.category, line: event.line, label: event.label, kind: event.kind, url: event.url});
  }
}

export function openLinearWindow() {
  openOverlay({mod: 'sixfold-linear-inbox', kind: 'window', key: 'linear-inbox', keep: true, width: 980, height: 760, props: {window: true}});
}

export function watchLinear(view, cx) {
  view.stopLinear?.();
  const base = `${appHome()}/data/sixfold`;
  const inputs = [['feed', 'linear-alerts.json', () => ({items: []})], ['health', 'linear-live-health.json', () => ({})],
                  ['auto', 'linear-auto.json', () => ({entries: []})]];   // Linear auto work: the issue search's '자동 작업'
  const cached = new Map(), subscriptions = [];
  let loading = false, loadingAt = 0, run = 0, previous, disposed = false, scheduled = null, dirty = false, version = 0;
  const allowed = () => !disposed && view.sidebarVisible !== false;
  // A refresh whose native read or write never settles stops holding the next one after LOAD_STUCK_MS.
  const busy = () => loading && Date.now() - loadingAt < LOAD_STUCK_MS;
  // A failed or refused refresh is retried after a delay even when no input changes (watch-guard.js);
  // the kind and time of a problem go to data/sixfold/linear-alert-watch.json.
  const statePath = `${base}/linear-alert-watch.json`;
  const retry = createRetry({timer: (ms, fn) => cx.timer.after(ms, fn), retry: () => schedule(),
    record: watchRecorder(text => cx.spawn(async () => { try { await writeTextFile(statePath, text, await readTextFile(statePath).catch(() => null)); } catch { /* best effort */ } }))});
  // Alerts whose ledger write committed but that are not announced yet (a hidden view announces them when shown).
  const held = [];
  const deliver = () => {
    if (!held.length || !allowed()) return;
    announceLinear(held.splice(0));
    cx.notify(); view.panelRetained?.alertsChanged?.();   // arrivals drawn; chips count them once landed
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
    // Inputs back at the last published value while a run is still out (timed out) still refresh: that run
    // already published what it read, and the new run replaces it so it cannot publish more when it returns.
    if (signature === previous && !loading) return;
    if (loading) retry.note('stalled');   // the previous run never settled; it is replaced
    const mine = ++run;
    const live = () => allowed() && mine === run;   // a replaced run never writes the ledger or publishes late
    loading = true; loadingAt = Date.now();
    const release = () => { if (mine !== run) return; loading = false; if (dirty) schedule(); };
    try { (context ?? cx).spawn(async cx => {
      try {
        const feed = cached.get('feed').value, health = cached.get('health').value;
        const names = (spaces() ?? []).map(s => s.name);
        publishLinear(feed, health, names);
        setShared('sixfold.linearAuto', cached.get('auto').value);
        cx.notify();
        view.panelRetained?.alertsChanged?.();   // an open issue search shows its issues' new alerts
        // Once the ledger write returns these alerts are seen for every run, so they are delivered even
        // when this run was replaced meanwhile (the replacement already saw them as seen).
        held.push(...await announce(linearPopupEvents(placeItems(feed.items ?? [], names)), live));
        deliver();
        if (!live()) return;
        previous = signature;   // after the ledger write, so a failed write is retried
        retry.ok();
      } catch (error) { if (mine === run) retry.fail(error); /* a partial collector write keeps the last valid list */ }
      finally { release(); }
    }); } catch (error) {
      // cx.spawn can refuse before the task runs (the host's outstanding-task limit under load). The
      // task's finally then never runs and `loading` stayed true forever: every later collection was
      // skipped and no Linear alert arrived again. Release here; the next input change retries
      // (no immediate retry: a refusing host would get one every 20 ms).
      if (mine === run) loading = false;
      dirty = true;
      retry.fail(error);   // retried after a delay (5 s, 30 s, 2 min), not every 20 ms
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
  view.refreshLinear = refresh; view.stopLinear = stop; (view.fileSubscriptions ??= []).push(stop);
  return stop;
}
