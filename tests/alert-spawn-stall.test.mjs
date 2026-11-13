import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {linearReadsUrl} from './linear-reads-url.mjs';

// The sidebar's alert watchers set `loading` before cx.spawn. The host can refuse a spawn before
// its task runs (outstanding host task limit); the task's finally then never ran, `loading` stayed
// true and every later collection was skipped: Linear alerts stopped arriving for good (2026-11-12).

const digest = raw => createHash('sha256').update(raw).digest('hex');
const refusal = () => new Error('outstanding host task limit of 1024');

async function settle(timers, tasks, cx) {
  for (let n = 0; n < 20; n++) {
    const due = [...timers]; timers.clear();
    for (const t of due) { try { t.callback(cx); } catch { /* a refused spawn surfaces in the timer callback */ } }
    // A hung task never settles: give the others one turn instead of waiting for all of them.
    await Promise.race([Promise.all(tasks.splice(0)), new Promise(resolve => setTimeout(resolve, 5))]);
    await Promise.resolve();
    if (!timers.size) return;
  }
  assert.fail('did not settle');
}

async function linearHarness() {
  const files = new Map([['linear-alerts.json', JSON.stringify({items: [], spaces: ['Alpha']})]]);
  const shared = {}, tasks = [], timers = new Set(), callbacks = new Map(), changes = new Set();
  const control = {refuse: 0, hang: 0, holdRead: null, holdWrite: null};
  const cx = {notify() {},
    spawn(fn) { if (control.refuse > 0) { control.refuse--; throw refusal(); } const task = fn(cx); tasks.push(task); return task; },
    timer: {after(ms, callback) { if (ms !== 20) return {ms, cancel() {}};   // a delayed retry stays pending here
      const timer = {callback, cancel() { timers.delete(timer); }}; timers.add(timer); return timer; },
      every() { assert.fail('no polling'); }}};
  const snapshot = path => { const raw = files.get(path.split('/').at(-1)); if (raw === undefined) return {status: 'missing', hash: null};
    return {status: 'ready', hash: digest(raw), value: JSON.parse(raw)}; };
  const runtime = {
    appHome: () => '/test', createHash,
    readJsonSnapshot: path => {
      // A native read that never settles.
      if (control.hang > 0 && path.endsWith('linear-popup-events.json')) { control.hang--; return new Promise(() => {}); }
      // A native read that answers only when released (with the file as it was when asked).
      if (control.holdRead && path.endsWith('linear-popup-events.json')) { const value = snapshot(path), hold = control.holdRead; control.holdRead = null; return hold.then(() => value); }
      return Promise.resolve(snapshot(path));
    },
    readTextFile: async path => files.get(path.split('/').at(-1)) ?? null,
    writeTextFile: async (path, value, expected) => {
      const name = path.split('/').at(-1);
      if ((files.get(name) ?? null) !== expected) throw new Error('compare-and-swap conflict');
      files.set(name, value); for (const [watched, c] of changes) if (watched === path) c();   // only the subscribed file
      // A native write that commits at once but answers only when released.
      if (control.holdWrite && name === 'linear-popup-events.json') { const hold = control.holdWrite; control.holdWrite = null; await hold; }
    },
    subscribeJsonFile: (_cx, path, callback) => { callbacks.set(path, callback); return () => callbacks.delete(path); },
    subscribeFileChanges: (_cx, watched, callback) => { const entry = [watched, callback]; changes.add(entry); return () => changes.delete(entry); },
    setShared: (key, value) => { shared[key] = value; },
    openOverlay: () => {},
    spaces: () => [{id: 's1', name: 'Alpha'}, {id: 's0', name: 'Share'}],
  };
  const key = `__linearStall${Math.random().toString(36).slice(2)}`;
  globalThis[key] = runtime;
  const storeUrl = new URL('../mods/sixfold-desk/arrival-store.js', import.meta.url).href;
  let source = await readFile(new URL('../mods/sixfold-desk/linear-feed.js', import.meta.url), 'utf8');
  source = source.replace(/\r\n/g, '\n').replace(/^import .* from '(herdr|crypto|\.\/panel-io\.js)';\n/gm, '')
    .replace("'./arrival-store.js'", `'${storeUrl}'`)
    .replace("'./arrival-model.js'", `'${new URL('../mods/sixfold-desk/arrival-model.js', import.meta.url).href}'`)
    .replace("'./alert-model.js'", `'${new URL('../mods/sixfold-desk/alert-model.js', import.meta.url).href}'`)
    .replace("'./linear-reads.js'", `'${await linearReadsUrl()}'`)
    .replace("'./watch-guard.js'", `'${new URL('../mods/sixfold-desk/watch-guard.js', import.meta.url).href}'`);
  source = `const {${Object.keys(runtime).join(',')}} = globalThis[${JSON.stringify(key)}];\n` + source;
  const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#' + key);
  const store = await import(storeUrl);
  const publish = () => { for (const [path, callback] of callbacks) callback(snapshot(path)); };
  return {
    module, store, shared, control, files, cx, flush: () => settle(timers, tasks, cx),
    feed: items => { files.set('linear-alerts.json', JSON.stringify({items, spaces: ['Alpha']})); publish(); },
    health: at => { files.set('linear-live-health.json', JSON.stringify({state: 'ok', last_success: at})); publish(); },
    done: () => { delete globalThis[key]; },
  };
}

test('Linear: after one refused spawn the next collection still publishes and its new alert arrives', async () => {
  const h = await linearHarness();
  h.store.setArrivalHost(() => true);
  const stop = h.module.watchLinear({}, h.cx);
  try {
    h.health('17:23'); await h.flush();                                       // first run: empty history recorded
    h.control.refuse = 1;                                                     // the host refuses the next spawn once
    h.health('17:25'); await h.flush();
    assert.equal(h.control.refuse, 0);
    assert.equal(h.shared['sixfold.linearHealth'].last_success, '17:23', 'the refused run published nothing');
    h.feed([{id: 'n1', read: false, category: 'commentsAndReplies', workspace: 'Alpha', issue: 'ZED-1', subtitle: 'Kim commented: hi'}]);
    await h.flush();
    assert.deepEqual(h.shared['sixfold.linearItems'].map(i => i.id), ['n1'], 'the next collection publishes again');
    assert.ok(JSON.parse(h.files.get('linear-popup-events.json')).seen.includes('linear:n1'));
    assert.ok(h.store.arrivals().some(a => a.key === 'linear:n1'), 'the new alert arrives');
  } finally { stop(); h.store.setArrivalHost(null); h.done(); }
});

test('Linear: a refused spawn is not retried on its own; the next input change retries', async () => {
  const h = await linearHarness();
  const stop = h.module.watchLinear({}, h.cx);
  try {
    h.health('a'); await h.flush();
    h.control.refuse = 1;
    h.health('b'); await h.flush();
    assert.equal(h.shared['sixfold.linearHealth'].last_success, 'a', 'no timer re-ran the refused refresh by itself');
    h.health('c'); await h.flush();
    assert.equal(h.shared['sixfold.linearHealth'].last_success, 'c');
  } finally { stop(); h.done(); }
});

test('Linear: a refresh whose native read never settles stops blocking after LOAD_STUCK_MS', async () => {
  const h = await linearHarness();
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  const stop = h.module.watchLinear({}, h.cx);
  try {
    h.health('a'); await h.flush();
    h.control.hang = 1;                                                       // the next ledger read never settles
    h.health('b'); await h.flush();
    assert.equal(h.shared['sixfold.linearHealth'].last_success, 'b', 'publishing runs before the hung ledger read');
    h.feed([{id: 'n2', read: false, category: 'mentions', workspace: 'Alpha'}]); await h.flush();
    assert.deepEqual(h.shared['sixfold.linearItems'], [], 'still held by the hung refresh');
    now += h.module.LOAD_STUCK_MS + 1;
    h.health('d'); await h.flush();
    assert.deepEqual(h.shared['sixfold.linearItems'].map(i => i.id), ['n2'], 'a later change runs again');
    assert.ok(JSON.parse(h.files.get('linear-popup-events.json')).seen.includes('linear:n2'));
  } finally { Date.now = realNow; stop(); h.done(); }
});

const gate = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return {promise, open}; };

test('Linear: an alert whose ledger write commits but answers after the run is replaced still arrives', async () => {
  const h = await linearHarness();
  h.store.setArrivalHost(() => true);
  const realNow = Date.now; let now = realNow(); Date.now = () => now;
  const stop = h.module.watchLinear({}, h.cx);
  try {
    h.health('a'); await h.flush();
    const write = gate(); h.control.holdWrite = write.promise;
    h.feed([{id: 'n3', read: false, category: 'mentions', workspace: 'Alpha'}]); await h.flush();
    assert.ok(JSON.parse(h.files.get('linear-popup-events.json')).seen.includes('linear:n3'), 'the write committed');
    assert.ok(!h.store.arrivals().some(a => a.key === 'linear:n3'), 'its answer has not come back');
    now += h.module.LOAD_STUCK_MS + 1;
    h.health('b'); await h.flush();
    assert.equal(h.shared['sixfold.linearHealth'].last_success, 'b', 'the replacement published');
    write.open(); await new Promise(r => setTimeout(r, 10)); await h.flush();
    assert.equal(h.store.arrivals().filter(a => a.key === 'linear:n3').length, 1, 'arrives once, from the run whose write committed');
  } finally { Date.now = realNow; stop(); h.store.setArrivalHost(null); h.done(); }
});

test('Linear: restoring the last published inputs while a run is stuck keeps them published when it returns', async () => {
  const h = await linearHarness();
  const realNow = Date.now; let now = realNow(); Date.now = () => now;
  const stop = h.module.watchLinear({}, h.cx);
  try {
    h.health('A'); await h.flush();
    const read = gate(); h.control.holdRead = read.promise;
    h.health('B'); await h.flush();                                           // no new alert, so no ledger write follows
    assert.equal(h.shared['sixfold.linearHealth'].last_success, 'B', 'the stuck run published what it read');
    now += h.module.LOAD_STUCK_MS + 1;
    h.health('A'); await h.flush();                                           // back to the published inputs
    read.open(); await new Promise(r => setTimeout(r, 10)); await h.flush();
    assert.equal(h.shared['sixfold.linearHealth'].last_success, 'A', 'the restored inputs are published again');
    h.health('C'); await h.flush();
    assert.equal(h.shared['sixfold.linearHealth'].last_success, 'C', 'later changes still publish');
  } finally { Date.now = realNow; stop(); h.done(); }
});

test('Slack alerts: after one refused spawn the next change still publishes', async () => {
  const files = new Map(), tasks = [], timers = new Set(), callbacks = new Map(), shared = new Map();
  let refuse = 0;
  const cx = {notify() {},
    spawn(fn) { if (refuse > 0) { refuse--; throw refusal(); } const task = fn(cx); tasks.push(task); return task; },
    timer: {after(ms, callback) { if (ms !== 20) return {ms, cancel() {}};   // a delayed retry stays pending here
      const timer = {callback, cancel() { timers.delete(timer); }}; timers.add(timer); return timer; },
      every() { assert.fail('no polling'); }}};
  const snapshot = path => { const raw = files.get(path.split('/').at(-1)); if (raw === undefined) return {status: 'missing', hash: null};
    return {status: 'ready', hash: digest(raw), value: JSON.parse(raw)}; };
  const runtime = {appHome: () => '/test', createHash, setShared: (key, value) => shared.set(key, value), openOverlay: () => {},
    spaces: () => [], addArrival: () => {}, hasArrivalHost: () => false, arrivalTarget: () => 'Share', ARRIVAL: {visible: 3},
    subscribeJsonFile: (_cx, name, callback) => { callbacks.set(name, callback); return () => callbacks.delete(name); },
    subscribeFileChanges: () => () => {},
    readJsonSnapshot: async name => snapshot(name),
    readTextFile: async name => files.get(name.split('/').at(-1)) ?? null,
    writeTextFile: async (name, value, expected) => { const key = name.split('/').at(-1); if ((files.get(key) ?? null) !== expected) throw Error('conflict'); files.set(key, value); },
    ...await import(new URL('../mods/sixfold-desk/watch-guard.js', import.meta.url).href)};
  const key = `__alertStall${Math.random().toString(36).slice(2)}`;
  globalThis[key] = runtime;
  let source = (await readFile(new URL('../mods/sixfold-desk/alerts.js', import.meta.url), 'utf8')).replace(/\r?\n/g, '\n').replace(/^import .*;\n/gm, '');
  source = `const {${Object.keys(runtime).join(',')}}=globalThis[${JSON.stringify(key)}];\n${source}`;
  const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const publish = () => { for (const [file, callback] of callbacks) callback(snapshot(file)); };
  const health = at => { files.set('slack-live-health.json', JSON.stringify({last_success: at})); publish(); };
  const stop = module.watchAlerts({alerts: []}, cx);
  try {
    health('17:09'); await settle(timers, tasks, cx);
    assert.equal(shared.get('sixfold.slackHealth').last_success, '17:09');
    refuse = 1;
    health('17:10'); await settle(timers, tasks, cx);
    assert.equal(shared.get('sixfold.slackHealth').last_success, '17:09', 'the refused run published nothing');
    health('18:34'); await settle(timers, tasks, cx);
    assert.equal(shared.get('sixfold.slackHealth').last_success, '18:34', 'the next change publishes again');
  } finally { stop(); delete globalThis[key]; }
});
