import { appHome, readTextFile, writeTextFile, setShared, openOverlay } from 'herdr';

// Linear inbox feed for the sidebar: data/sixfold/linear-alerts.json and
// linear-live-health.json, written by a machine-local collector. Kept apart from
// the Slack/pane alerts so a bad Linear file or ledger write never holds them back.

// Notifications that open the window: a person was assigned or named.
const POPUP = new Set(['assignments', 'mentions', 'comments']);
const LEDGER = 'linear-popup-events.json';
const LEDGER_LIMIT = 500;   // ids of notifications already announced; bounded

export function linearPopupEvents(items) {
  return (items ?? []).filter(item => typeof item?.id === 'string' && item.id)
    .map(item => ({key: `linear:${item.id}`, popup: !item.read && POPUP.has(item.category)}));
}

// First run seeds the existing history silently. Later writes use the previous
// contents as a compare-and-swap guard across several views.
async function announce(events) {
  const path = `${appHome()}/data/sixfold/${LEDGER}`;
  const text = await readTextFile(path).catch(() => null);
  const firstRun = text === null;
  const ledger = firstRun ? {schema: 1, seen: []} : JSON.parse(text);
  if (ledger?.schema !== 1 || !Array.isArray(ledger.seen) || !ledger.seen.every(key => typeof key === 'string')) {
    throw new Error('Invalid Linear popup event ledger');
  }
  const seen = new Set(ledger.seen);
  const fresh = events.filter(event => !seen.has(event.key));
  if (!fresh.length && !firstRun) return null;
  const next = {schema: 1, seen: [...ledger.seen, ...fresh.map(event => event.key)].slice(-LEDGER_LIMIT)};
  await writeTextFile(path, JSON.stringify(next), text);
  return firstRun ? null : fresh.find(event => event.popup) ?? null;
}

export function publishLinear(feed, health) {
  setShared('sixfold.linearItems', feed.items ?? []);
  setShared('sixfold.linearSpaces', feed.spaces ?? []);
  setShared('sixfold.linearStatuses', feed.statuses ?? {});
  setShared('sixfold.linearHealth', health ?? {});
}

export function openLinearWindow() {
  openOverlay({mod: 'sixfold-linear-inbox', kind: 'window', key: 'linear-inbox', keep: true, width: 980, height: 760, props: {window: true}});
}

export function watchLinear(view, cx) {
  let loading = false, previous;
  const base = `${appHome()}/data/sixfold`;
  const refresh = cx => {
    if (loading) return;
    loading = true;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${base}/linear-alerts.json`).catch(() => '{"items":[]}');
        const health = await readTextFile(`${base}/linear-live-health.json`).catch(() => '{}');
        const snapshot = text + '\u0000' + health;
        if (snapshot === previous) return;
        const feed = JSON.parse(text || '{}'), status = JSON.parse(health || '{}');
        publishLinear(feed, status);
        cx.notify();
        const event = await announce(linearPopupEvents(feed.items));
        previous = snapshot;   // after the ledger write, so a failed write is retried
        if (event) openLinearWindow();
      } catch { /* A partial collector write keeps the last valid list; retried next tick. */ }
      finally { loading = false; }
    });
  };
  refresh(cx);
  cx.timer.every(2000, refresh);
}
