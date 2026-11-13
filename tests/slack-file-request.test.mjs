import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as desk from '../mods/sixfold-desk/alert-slack.js';
import * as inbox from '../mods/sixfold-slack-inbox/model.js';

// 본문 보기 with no local text copy asks the collector through data/sixfold/slack-file-requests.json and
// looks for the copy again while the text stays open (never a busy loop, never a Slack write).

const REQUESTS = '/h/data/sixfold/slack-file-requests.json';
const COPY = id => `/h/data/sixfold/slack-files/${id}.txt`;

test('the request ledger: one entry per safe id, no repeat within 10 minutes, a day and 50 entries kept', () => {
  for (const m of [desk, inbox]) {
    const now = Date.parse('2026-11-09T01:00:00Z');
    assert.equal(m.fileRequestText(null, '../x', now), null, 'unsafe id');
    const first = m.fileRequestText(null, 'F0TEST0001', now);
    assert.deepEqual(JSON.parse(first), {schema: 1, requests: {F0TEST0001: '2026-11-09T01:00:00.000Z'}});
    assert.equal(m.fileRequestText(first, 'F0TEST0001', now + 60000), null, 'asked a minute ago');
    assert.equal(JSON.parse(m.fileRequestText(first, 'F0TEST0001', now + 700000)).requests.F0TEST0001, '2026-11-09T01:11:40.000Z');
    const old = JSON.stringify({requests: {F0OLD0001: '2026-11-07T00:00:00Z', 'bad/id': '2026-11-09T00:59:00Z', F0TEST0002: '2026-11-09T00:59:00Z'}});
    assert.deepEqual(Object.keys(JSON.parse(m.fileRequestText(old, 'F0TEST0003', now)).requests), ['F0TEST0003', 'F0TEST0002']);
    const many = JSON.stringify({requests: Object.fromEntries(Array.from({length: 80}, (_, i) => [`F0MANY${String(i).padStart(4, '0')}`, new Date(now - i * 1000).toISOString()]))});
    assert.equal(Object.keys(JSON.parse(m.fileRequestText(many, 'F0TEST0004', now)).requests).length, 50);
    assert.equal(m.fileRequestText('{broken', 'F0TEST0005', now) !== null, true, 'a broken ledger is replaced');
  }
});

// A fake cx: spawned tasks and timers run only when the test says so.
function fakeCx() {
  const tasks = [], timers = [];
  const cx = {notify() {}, stop_propagation() {}, open_url() {},
    spawn(fn) { const task = Promise.resolve().then(() => fn(cx)); tasks.push(task); return task; },
    timer: {after(ms, fn) { const t = {ms, fn}; timers.push(t); return {cancel() { timers.splice(timers.indexOf(t), 1); }}; }}};
  const settle = async () => { for (let n = 0; n < 10; n++) await Promise.all(tasks.splice(0)); };
  const tick = async () => { const due = timers.splice(0); for (const t of due) t.fn(cx); await settle(); return due.map(t => t.ms); };
  return {cx, settle, tick, timers};
}

function element() {
  const t = {nodes: [], calls: [], handlers: {}};
  const proxy = new Proxy(t, {get(_t, k) {
    if (k === 'then') return undefined; if (k in t) return t[k];
    if (['child', 'trigger', 'content'].includes(k)) return n => { if (n != null) t.nodes.push(n); return proxy; };
    if (k === 'children') return ns => { t.nodes.push(...ns.filter(Boolean)); return proxy; };
    if (k === 'when') return (b, f) => { if (b) f(proxy); return proxy; };
    if (['on_click', 'on_open_change'].includes(k)) return fn => { t.handlers[k] = fn; return proxy; };
    if (k === 'id') return id => { t.elementId = id; return proxy; };
    return () => proxy;
  }}); return proxy;
}
const texts = node => typeof node === 'string' ? [node] : (node?.nodes ?? []).flatMap(texts);
const byId = (node, id) => node?.elementId === id ? node : (node?.nodes ?? []).map(n => byId(n, id)).find(Boolean) ?? null;
const asUrl = s => 'data:text/javascript;base64,' + Buffer.from(s).toString('base64');
const disk = () => {
  const files = new Map(), writes = [];
  return {files, writes,
    readTextFile: async p => files.get(p) ?? null,
    writeTextFile: async (p, v, old) => { if ((files.get(p) ?? null) !== old) throw new Error('compare-and-swap conflict'); writes.push(p); files.set(p, v); }};
};
const theme = new Proxy({}, {get: (_t, k) => `#${String(k)}`});

test('card popover: a file without a copy is asked for once, looked for every 3 s, and shown when it lands', async () => {
  const store = new Map(), io = disk();
  globalThis.__fileReq = {div: element, image: element, h_flex: element, v_flex: element, Popover: {new: element},
    shared: k => store.get(k), setShared: (k, v) => store.set(k, v), appHome: () => '/h', ...io};
  const base = new URL('../mods/sixfold-desk/', import.meta.url);
  const transform = s => s.replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base|herdr)';/g, 'const {$1}=globalThis.__fileReq;')
    .replace("'./alert-model.js'", JSON.stringify(new URL('alert-model.js', base).href)).replace("'./alert-slack.js'", JSON.stringify(new URL('alert-slack.js', base).href));
  const filesUrl = asUrl(transform(await readFile(new URL('alert-files.js', base), 'utf8')) + `//${Math.random()}`);
  const pop = await import(asUrl(transform(await readFile(new URL('alert-popover.js', base), 'utf8')).replace("'./alert-files.js'", JSON.stringify(filesUrl)) + `//${Math.random()}`));
  const item = {id: 'slack:C0TEST01:100.1', project: 'Alpha', channel: 'C0TEST01', author: 'U0TEST01', text: '자료 첨부합니다',
    files: [{id: 'F0TEST0009', name: '메모.md', mimetype: 'markdown'}]};
  store.set('sixfold.alertItems', [item]);
  pop.showPopover('Alpha', 'slack');
  const draw = () => pop.alertPopover({id: 's1', project: 'Alpha', trigger: element(), t: theme, hasSlack: true, hasLinear: false, onAll() {}});
  const {cx, settle, tick, timers} = fakeCx();
  byId(draw(), 'sf-alert-pop-slack-0-file-view-0').handlers.on_click({}, cx); await settle();
  assert.ok(texts(draw()).includes('본문 준비 중'));
  assert.deepEqual(Object.keys(JSON.parse(io.files.get(REQUESTS)).requests), ['F0TEST0009'], 'asked the collector');
  assert.deepEqual(io.writes, [REQUESTS], 'asked once (a repeat ask within 10 minutes writes nothing)');
  assert.deepEqual(await tick(), [3000]);
  assert.deepEqual(timers.map(t => t.ms), [3000], 'still no copy: one more look, not a loop');
  io.files.set(COPY('F0TEST0009'), '# 제목\n본문');
  await tick();
  assert.ok(texts(draw()).includes('# 제목\n본문'), texts(draw()).join(' | '));
  assert.equal(timers.length, 0, 'stops once shown');
  assert.deepEqual(io.writes, [REQUESTS]);
  // Closed while waiting: no more looks.
  io.files.delete(COPY('F0TEST0009'));
  const second = {...item, id: 'slack:C0TEST01:100.2', files: [{id: 'F0TEST0010', name: 'b.md'}]};
  store.set('sixfold.alertItems', [second]);
  byId(draw(), 'sf-alert-pop-slack-0-file-view-0').handlers.on_click({}, cx); await settle();
  byId(draw(), 'sf-alert-pop-slack-0-file-view-0').handlers.on_click({}, cx); await settle();   // 본문 닫기
  await tick();
  assert.equal(timers.length, 0);
});

test('inbox window: 본문 보기 asks for a missing copy and picks it up while its popover stays open', async () => {
  const io = disk();
  class View {}
  globalThis.__fileInbox = {View, div: element, image: element, h_flex: element, v_flex: element, Popover: {new: element},
    theme: () => theme, props: () => ({window: true}), appHome: () => '/h', home: () => '/h', shared: () => null, setShared() {},
    openOverlay() {}, closeOverlay() {}, exec() {}, ...io};
  const base = new URL('../mods/sixfold-slack-inbox/', import.meta.url);
  const src = (await readFile(new URL('main.js', base), 'utf8'))
    .replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base|herdr)';/g, 'const {$1}=globalThis.__fileInbox;')
    .replace("'./model.js'", JSON.stringify(new URL('model.js', base).href));
  const {default: MentionInbox} = await import(asUrl(src + `//${Math.random()}`));
  const view = new MentionInbox();
  view.fileTexts = new Map();
  const {cx, settle, tick, timers} = fakeCx();
  const file = {id: 'F0TEST0011', name: '메모.md'}, key = `slack:C0TEST01:1.1|${file.id}`;
  view.viewFile(key, file, cx); await settle();
  assert.equal(view.fileTexts.get(file.id), null);
  assert.deepEqual(Object.keys(JSON.parse(io.files.get(REQUESTS)).requests), ['F0TEST0011']);
  await tick();
  assert.equal(timers.length, 1, 'looks again later');
  io.files.set(COPY(file.id), '본문');
  await tick();
  assert.equal(view.fileTexts.get(file.id), '본문');
  assert.equal(timers.length, 0);
  assert.deepEqual(io.writes, [REQUESTS], 'one ask');
  view.viewFile(null, file, cx); await tick();
  assert.equal(timers.length, 0);
});

// Review 01M79TKV1PNRZPKWW06DQ341XE: the wait ended at 120 s, before the collector's retry (its first read
// fails, it may read again 120 s after that attempt). The wait now covers the retry window, and past it
// the text says it has not arrived instead of '본문 준비 중' for good.
test('the wait covers the collector retry window: 3 s for a minute, then 10 s, until 7 minutes', () => {
  for (const m of [desk, inbox]) {
    assert.equal(m.nextFileWait(0), 3000);
    assert.equal(m.nextFileWait(59999), 3000);
    assert.equal(m.nextFileWait(60000), 10000);
    assert.equal(m.nextFileWait(419999), 10000);
    assert.equal(m.nextFileWait(420000), null);
  }
});

// A clocked cx: timers fire in time order; `at(ms, fn)` runs fn when the clock passes ms.
function clockCx() {
  let now = 0;
  const tasks = [], timers = [], events = [];
  const cx = {notify() {}, spawn(fn) { const task = Promise.resolve().then(() => fn(cx)); tasks.push(task); return task; },
    timer: {after(ms, fn) { timers.push({at: now + ms, fn}); return {cancel() {}}; }}};
  const settle = async () => { for (let n = 0; n < 10; n++) await Promise.all(tasks.splice(0)); };
  const run = async (until = Infinity) => {
    while (timers.length) {
      timers.sort((a, b) => a.at - b.at);
      if (timers[0].at > until) break;
      const t = timers.shift(); now = t.at;
      for (const e of events.filter(e => !e.done && e.at <= now)) { e.done = true; e.fn(); }
      t.fn(cx); await settle();
    }
  };
  return {cx, settle, run, timers, at: (ms, fn) => events.push({at: ms, fn}), now: () => now};
}

async function deskFiles(io) {
  globalThis.__fileReq2 = {div: element, h_flex: element, v_flex: element, appHome: () => '/h', ...io};
  const base = new URL('../mods/sixfold-desk/', import.meta.url);
  const src = (await readFile(new URL('alert-files.js', base), 'utf8'))
    .replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base|herdr)';/g, 'const {$1}=globalThis.__fileReq2;')
    .replace("'./alert-slack.js'", JSON.stringify(new URL('alert-slack.js', base).href));
  return import(asUrl(src + `//${Math.random()}`));
}

test('card popover: a first read that fails and a retry at 125 s still shows the text', async () => {
  const io = disk(), files = await deskFiles(io), {cx, settle, run, at} = clockCx();
  let shown = 0;
  at(125000, () => io.files.set(COPY('F0TEST0021'), '재시도 본문'));
  files.followFileText('F0TEST0021', cx, () => true, () => { shown++; });
  await settle(); await run();
  assert.equal(shown, 1);
  assert.deepEqual(files.fileText('F0TEST0021'), {state: 'ready', text: '재시도 본문'});
});

test('card popover: with no copy by 7 minutes the text says so and the looks stop', async () => {
  const io = disk(), files = await deskFiles(io), {cx, settle, run, timers, now} = clockCx();
  let shown = 0;
  files.followFileText('F0TEST0022', cx, () => true, () => { shown++; });
  await settle(); await run();
  assert.equal(files.fileText('F0TEST0022').state, 'late');
  assert.equal(shown, 1, 'redrawn once to say so');
  assert.equal(timers.length, 0);
  assert.ok(now() >= 420000 && now() < 440000, String(now()));
});

test('inbox window: a retry at 125 s is shown, and past 7 minutes it says the text has not arrived', async () => {
  const io = disk();
  class View {}
  globalThis.__fileInbox2 = {View, div: element, image: element, h_flex: element, v_flex: element, Popover: {new: element},
    theme: () => theme, props: () => ({window: true}), appHome: () => '/h', home: () => '/h', shared: () => null, setShared() {},
    openOverlay() {}, closeOverlay() {}, exec() {}, ...io};
  const base = new URL('../mods/sixfold-slack-inbox/', import.meta.url);
  const src = (await readFile(new URL('main.js', base), 'utf8'))
    .replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base|herdr)';/g, 'const {$1}=globalThis.__fileInbox2;')
    .replace("'./model.js'", JSON.stringify(new URL('model.js', base).href));
  const {default: MentionInbox} = await import(asUrl(src + `//${Math.random()}`));
  const view = new MentionInbox();
  view.fileTexts = new Map();
  let c = clockCx();
  c.at(125000, () => io.files.set(COPY('F0TEST0023'), '재시도 본문'));
  view.viewFile('k|F0TEST0023', {id: 'F0TEST0023'}, c.cx); await c.settle(); await c.run();
  assert.equal(view.fileTexts.get('F0TEST0023'), '재시도 본문');
  c = clockCx();
  view.viewFile('k|F0TEST0024', {id: 'F0TEST0024'}, c.cx); await c.settle(); await c.run();
  assert.equal(view.fileTexts.get('F0TEST0024'), null);
  assert.ok(view.fileLate.has('F0TEST0024'), 'past the wait it says so');
  assert.equal(c.timers.length, 0);
});
