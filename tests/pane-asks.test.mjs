// Pane-scoped question/permission cards: sidebar summary, pane header button
// and the per-pane popup. Synthetic cards and a fake bridge only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {askSummary, groupAsks, summaryFor, cardsFor, reconcile, clampPage, popupHeight, SUMMARY_KEY, errorText} from '../mods/sixfold-desk/ask-model.js';

const bridge = {python: 'python3', script: '/demo/bridge/dispatch.py', args: ['--local']};
const card = (id, terminal, extra = {}) => ({id, revision: 'r1', kind: 'permission', terminal, title: `Title ${id}`,
  actions: [{id: 'approve', label: 'Allow', primary: true}, {id: 'cancel', label: 'Deny'}], ...extra});
const longLabel = 'A very long option label that explains exactly what will happen when it is chosen, '.repeat(3).trim();
const multi = card('multi', 'pane-a', {kind: 'question', title: 'Two questions',
  questions: [
    {id: 'color', title: 'Color', options: [{id: 'red', label: 'Red'}, {id: 'long', label: longLabel}]},
    {id: 'tags', title: 'Tags', multi: true, options: [{id: 'x', label: 'X'}, {id: 'y', label: 'Y'}]},
  ],
  actions: [{id: 'submit', label: 'Send', requiresAnswers: true, primary: true}, {id: 'cancel', label: 'Cancel'}]});

// ---- fake element tree -------------------------------------------------
function el(kind) {
  const node = {kind, id: null, children: [], calls: [], click: null};
  const proxy = new Proxy(function () {}, {get(_t, prop) {
    if (prop === '__node') return node;
    if (prop === 'then') return undefined;
    return (...args) => {
      node.calls.push(prop);
      if (prop === 'child') { if (args[0] != null) node.children.push(args[0]); }
      else if (prop === 'children') { for (const c of args[0] ?? []) if (c != null) node.children.push(c); }
      else if (prop === 'when') { return args[0] ? args[1](proxy) : proxy; }
      else if (prop === 'id') node.id = args[0];
      else if (prop === 'on_click') node.click = args[0];
      return proxy;
    };
  }});
  return proxy;
}
const nodeOf = value => value?.__node;
function walk(value, visit) {
  const node = nodeOf(value); if (!node) return;
  visit(node); for (const child of node.children) walk(child, visit);
}
function find(tree, id) { let found = null; walk(tree, node => { if (node.id === id) found ??= node; }); return found; }
function ids(tree, prefix) { const out = []; walk(tree, node => { if (node.id?.startsWith(prefix)) out.push(node.id); }); return out; }
function text(tree) { const out = []; const go = v => { if (typeof v === 'string') out.push(v); const n = nodeOf(v); if (n) n.children.forEach(go); }; go(tree); return out.join(' '); }
const event = {};
function click(tree, id, cx) { const node = find(tree, id); assert.ok(node, `missing ${id}`); assert.ok(node.click, `${id} not clickable`); node.click(event, cx); }

// ---- module loader with a fake host ------------------------------------
let loads = 0;
async function load(host) {
  globalThis.__paneAskRuntime = host;
  let source = (await readFile(new URL('../mods/sixfold-desk/asks.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  source = source.replace(/^import .* from 'gpui-kit';\n/m, 'const {div} = globalThis.__paneAskRuntime;\n')
    .replace(/^import .* from 'gpui-base';\n/m, 'const {h_flex,v_flex} = globalThis.__paneAskRuntime;\n')
    .replace(/^import \{(.*)\} from 'herdr';/m, (_m, names) => `const {${names}} = globalThis.__paneAskRuntime;`)
    .replace(/^import .* from '.\/panel-io.js';/m, 'const {subscribeJsonFile,readJsonSnapshot}=globalThis.__paneAskRuntime;')
    .replace("from './ask-model.js'", `from ${JSON.stringify(new URL('../mods/sixfold-desk/ask-model.js', import.meta.url).href)}`);
  return import(`data:text/javascript;base64,${Buffer.from(source + `\n// ${++loads}`).toString('base64')}`);
}
function context() {
  const tasks = [];
  const cx = {notifications: 0, notify() { this.notifications++; }, stop_propagation() {},
    spawn(fn) { const p = Promise.resolve().then(() => fn(cx)); tasks.push(p); return p; }, tasks,
    async settle() { for (let i = 0; i < 20; i++) { const pending = tasks.splice(0); if (!pending.length) return; await Promise.all(pending); } }};
  return cx;
}
function host(cards) {
  const files = new Map([['/demo/data/sixfold/bridge.json', JSON.stringify(bridge)], ['/demo/data/sixfold/cards.json', JSON.stringify({schema: 1, cards})]]);
  const store = new Map(), calls = [], overlays = [], closed = [], focus = [], listeners = new Map();
  let currentProps = {};
  const snapshot = path => { const raw = files.get(path); if (raw === undefined) return {status: 'missing'}; return {status: 'ready', value: JSON.parse(raw)}; };
  const h = {
    div: () => el('div'), h_flex: () => el('h_flex'), v_flex: () => el('v_flex'),
    appHome: () => '/demo', props: () => currentProps,
    run: (name, args) => focus.push([name, args]),
    shared: key => store.has(key) ? structuredClone(store.get(key)) : undefined,
    setShared: (key, value) => { calls.push(['setShared', key]); store.set(key, structuredClone(value)); },
    openOverlay: spec => { overlays.push(spec); return `ov-${overlays.length}`; },
    closeOverlay: id => { closed.push(id); return null; },
    subscribeJsonFile(_cx, path, callback) { const set = listeners.get(path) ?? new Set(); set.add(callback); listeners.set(path, set); Promise.resolve().then(() => { if (set.has(callback)) callback(snapshot(path)); }); return () => set.delete(callback); },
    readJsonSnapshot: async path => snapshot(path),
    readTextFile: (...args) => impl.readTextFile(...args),
    writeTextFile: async (path, value, expected) => { calls.push(['write', path]); if ((files.get(path) ?? null) !== expected) throw Error('File changed'); files.set(path, value); },
    exec: (...args) => impl.exec(...args),
  };
  // Swappable implementations: the module binds the host's functions at load.
  // Like the real bridge, an accepted action removes the card from cards.json.
  const impl = {
    readTextFile: async path => files.get(path) ?? null,
    exec: async (program, args) => {
      calls.push(['exec', program, args]); const request = JSON.parse(files.get(args.at(-1)));
      const now = JSON.parse(files.get('/demo/data/sixfold/cards.json')).cards.filter(c => c.id !== request.cardId);
      files.set('/demo/data/sixfold/cards.json', JSON.stringify({schema: 1, cards: now}));
      return {code: 0, stdout: JSON.stringify({schema: 1, id: request.id, status: 'accepted'})};
    },
  };
  const emit = path => { for (const cb of listeners.get(path) ?? []) cb(snapshot(path)); };
  const setCards = next => { files.set('/demo/data/sixfold/cards.json', JSON.stringify({schema: 1, cards: next})); emit('/demo/data/sixfold/cards.json'); };
  return {h, impl, files, store, calls, overlays, closed, focus, setCards, emit, setProps: p => { currentProps = p; }};
}
const theme = new Proxy({}, {get: (_t, k) => `#${String(k).length.toString(16).padStart(6, '0')}`});

// ---- pure model ----------------------------------------------------------
test('summary groups cards per terminal, versions by id and revision, and hides without a bridge', () => {
  const cards = [card('a1', 'pane-a'), card('b1', 'pane-b', {kind: 'question'}), card('a2', 'pane-a'), card('u1', null)];
  const summary = askSummary(cards);
  assert.deepEqual(summary.panes, {'pane-a': {n: 2, kind: 'permission'}, 'pane-b': {n: 1, kind: 'question'}, '': {n: 1, kind: 'permission'}});
  assert.notEqual(askSummary([{...cards[0], revision: 'r2'}, ...cards.slice(1)]).v, summary.v, 'a revision change moves the version');
  assert.deepEqual(askSummary(null), {v: '', panes: {}});
  assert.deepEqual(groupAsks(cards).map(g => [g.terminal, g.cards.map(c => c.id)]), [['pane-a', ['a1', 'a2']], ['pane-b', ['b1']], [null, ['u1']]]);
  assert.deepEqual(cardsFor(cards, 'pane-b').map(c => c.id), ['b1']);
  assert.deepEqual(cardsFor(cards, null).map(c => c.id), ['u1']);
  assert.equal(summaryFor(summary, 'pane-c'), null);
  assert.equal(summaryFor({panes: {'pane-a': {n: 0, kind: 'permission'}}}, 'pane-a'), null);
  assert.equal(summaryFor({panes: {constructor: {n: 1, kind: 'bogus'}}}, 'constructor'), null);
  assert.equal(summaryFor('garbage', 'pane-a'), null);
});
test('reconcile drops revised choices and counts cards that vanished without our send', () => {
  const before = [card('a', 't'), card('b', 't'), card('c', 't')];
  const after = [{...card('a', 't'), revision: 'r2'}, card('b', 't')];
  const result = reconcile(before, after, {a: {q: ['x']}, b: {q: ['y']}, c: {q: ['z']}}, new Set());
  assert.deepEqual(Object.keys(result.choices), ['b']); assert.equal(result.revised, true); assert.equal(result.expired, 1);
  assert.equal(reconcile(before, after, {}, new Set(['c'])).expired, 0, 'our own accepted send is not an expiry');
  assert.equal(clampPage(5, 2), 1); assert.equal(clampPage(-1, 2), 0); assert.equal(clampPage(3, 0), 0);
  assert.ok(popupHeight(multi) > popupHeight(card('p', 't'))); assert.ok(popupHeight({...multi, detail: 'x'.repeat(50000)}) <= 640);
  assert.equal(errorText('ko', 'nonsense'), errorText('ko', 'failed'));
});

// ---- sidebar watcher publishes the summary -----------------------------
test('the sidebar watcher publishes the per-pane summary only when it changes', async () => {
  const f = host([card('a1', 'pane-a')]), mod = await load(f.h), view = {}, cx = context();
  mod.watchAsks(view, cx); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.store.get(SUMMARY_KEY).panes, {'pane-a': {n: 1, kind: 'permission'}});
  const writes = () => f.calls.filter(c => c[0] === 'setShared').length, first = writes();
  f.setCards([card('a1', 'pane-a')]); assert.equal(writes(), first, 'same cards do not rewrite shared state');
  f.setCards([card('a1', 'pane-a'), card('b1', 'pane-b')]); assert.equal(f.store.get(SUMMARY_KEY).panes['pane-b'].n, 1);
  f.files.delete('/demo/data/sixfold/bridge.json'); f.emit('/demo/data/sixfold/bridge.json');
  assert.deepEqual(f.store.get(SUMMARY_KEY), {v: '', panes: {}}, 'no bridge: pane buttons disappear');
  view.stopAsks();
});

// ---- pane header button --------------------------------------------------
test('pane header shows a decision button only for its own terminal and opens without moving focus', async () => {
  const f = host([]), mod = await load(f.h);
  f.store.set(SUMMARY_KEY, askSummary([card('a1', 'pane-a'), card('a2', 'pane-a'), card('b1', 'pane-b', {kind: 'question'})]));
  assert.equal(mod.paneAskButton({pane: 'p9', terminal: 'pane-z'}, theme, 'ko', 'Z'), null);
  const a = mod.paneAskButton({pane: 'p1', terminal: 'pane-a'}, theme, 'ko', 'Alpha');
  assert.match(text(a), /권한 2/);
  const b = mod.paneAskButton({pane: 'p2', terminal: 'pane-b'}, theme, 'ko', 'Beta');
  assert.match(text(b), /질문/); assert.doesNotMatch(text(b), /\d/);
  nodeOf(a).click(event, context());
  assert.equal(f.overlays.length, 1);
  assert.deepEqual(f.overlays[0].props, {role: 'ask', terminal: 'pane-a', name: 'Alpha'});
  assert.equal(f.overlays[0].kind, 'popup'); assert.ok(f.overlays[0].width >= 520);
  assert.deepEqual(f.focus, [], 'no pane.focus/agent.focus');
  assert.ok(nodeOf(a).calls.includes('on_mouse_down'), 'press does not reach the header (which focuses the pane)');
});

// ---- sidebar compact summary ----------------------------------------------
test('sidebar lists one compact row per pane, including unassigned, and opens that pane only', async () => {
  const f = host([]), mod = await load(f.h);
  const view = {asks: [card('a1', 'pane-a'), card('b1', 'pane-b'), card('a2', 'pane-a'), card('u1', null)], askErrors: {b1: 'failed'}};
  const tree = mod.askSection(view, theme, 'ko', t => `name-${t}`);
  assert.deepEqual(ids(tree, 'sf-ask-group-'), ['sf-ask-group-0', 'sf-ask-group-1', 'sf-ask-group-2']);
  assert.equal(ids(tree, 'sf-ask-multi-').length, 0, 'no inline options in the sidebar');
  assert.match(text(tree), /name-pane-a/); assert.match(text(tree), /2건/); assert.match(text(tree), /소속 미확인/);
  click(tree, 'sf-ask-group-2', context());
  assert.deepEqual(f.overlays.at(-1).props, {role: 'ask', terminal: null, name: '소속 미확인'});
  click(tree, 'sf-ask-group-0', context());
  assert.equal(f.overlays.at(-1).props.terminal, 'pane-a');
  assert.deepEqual(f.focus, []);
  // Every group is listed in a bounded, scrolling area: a late unassigned card stays reachable.
  const many = {asks: [...Array.from({length: 99}, (_, i) => card(`c${i}`, `pane-${i}`)), card('late', null)], askErrors: {}};
  const list = mod.askSection(many, theme, 'ko', t => t), area = find(list, 'sf-ask-groups');
  assert.equal(ids(list, 'sf-ask-group-').length, 100);
  assert.ok(area.calls.includes('max_h') && area.calls.includes('overflow_y_scrollbar'), 'bounded and scrollable');
  assert.match(text(list), /100개 페인 · 목록을 스크롤해 모두 보기/);
  click(list, 'sf-ask-group-99', context());
  assert.deepEqual(f.overlays.at(-1).props, {role: 'ask', terminal: null, name: '소속 미확인'});
});

// ---- popup ----------------------------------------------------------------
async function popup(f, mod, terminal, name = 'Alpha') {
  // Each overlay copy has its own props; set them before every render.
  const own = {role: 'ask', terminal, name, overlay: 'ov-1'}, view = {}, cx = context();
  const render = () => { f.setProps(own); return mod.askPopup(view, theme, 'ko', cx); };
  render(); await cx.settle();
  return {view, cx, render};
}
test('popup shows only its pane, pages through several cards, and keeps long options whole', async () => {
  const cards = [card('a1', 'pane-a'), card('b1', 'pane-b'), multi, card('a3', 'pane-a', {detail: 'line one\nline two'})];
  const f = host(cards), mod = await load(f.h);
  const a = await popup(f, mod, 'pane-a'), b = await popup(f, mod, 'pane-b', 'Beta');
  assert.deepEqual(a.view.asks.map(c => c.id), ['a1', 'multi', 'a3']);
  assert.deepEqual(b.view.asks.map(c => c.id), ['b1'], 'two panes at once never mix');
  let tree = a.render();
  assert.match(text(tree), /1\/3/); assert.match(text(tree), /Title a1/); assert.doesNotMatch(text(tree), /Title b1/);
  click(tree, 'sf-ask-next', a.cx); tree = a.render();
  assert.match(text(tree), /2\/3/); assert.match(text(tree), /Two questions/);
  assert.ok(find(tree, 'sf-ask-multi-q0-o1')); assert.ok(text(tree).includes(longLabel), 'full long label is rendered');
  walk(tree, node => { if (node.children.includes(longLabel)) assert.ok(!node.calls.includes('truncate'), 'long option is not truncated'); });
  assert.ok(find(tree, 'sf-ask-body-multi').calls.includes('overflow_y_scrollbar'));
  click(tree, 'sf-ask-next', a.cx); tree = a.render();
  assert.match(text(tree), /line one\nline two/, 'detail keeps its original text');
  assert.equal(find(tree, 'sf-ask-next').click(event, a.cx), undefined); assert.equal(a.view.askPage, 2, 'last page stays');
  assert.deepEqual(f.focus, []); assert.deepEqual(f.calls.filter(c => c[0] !== 'setShared'), []);
});
test('multiple questions need every answer; multi-select toggles; send goes through the fake bridge only', async () => {
  const f = host([multi]), mod = await load(f.h), p = await popup(f, mod, 'pane-a');
  let tree = p.render();
  const send = () => find(p.render(), 'sf-ask-multi-action-0');
  click(tree, 'sf-ask-multi-action-0', p.cx); assert.deepEqual(f.calls, [], 'incomplete answers cannot send');
  click(tree, 'sf-ask-multi-q0-o1', p.cx);
  click(p.render(), 'sf-ask-multi-q1-o0', p.cx); click(p.render(), 'sf-ask-multi-q1-o1', p.cx); click(p.render(), 'sf-ask-multi-q1-o0', p.cx);
  assert.deepEqual(p.view.askChoices.multi, {color: ['long'], tags: ['y']});
  send().click(event, p.cx); await p.cx.settle();
  const exec = f.calls.find(c => c[0] === 'exec');
  assert.deepEqual(exec.slice(1, 2), ['python3']); assert.deepEqual(exec[2].slice(0, 2), [bridge.script, '--local']);
  const request = JSON.parse(f.files.get(exec[2].at(-1)));
  assert.deepEqual(request.answers, {color: ['long'], tags: ['y']}); assert.equal(request.revision, 'r1'); assert.equal(request.cardId, 'multi');
  tree = p.render(); assert.match(text(tree), /응답을 접수했습니다/); assert.equal(p.view.askExpired, 0, 'our own send is not an expiry');
});
test('send failure keeps the card, shows a generic error and never exposes output', async () => {
  const f = host([card('a1', 'pane-a')]), mod = await load(f.h), p = await popup(f, mod, 'pane-a');
  f.impl.exec = async () => ({code: 1, stdout: 'secret-token-output', stderr: 'secret-token-output'});
  click(p.render(), 'sf-ask-a1-action-0', p.cx); await p.cx.settle();
  const tree = p.render();
  assert.equal(p.view.asks.length, 1); assert.match(text(tree), /응답 실패: 전송 실패/); assert.doesNotMatch(text(tree), /secret/);
});
test('a revision that moved on disk is refused before writing, and the popup resets its choices', async () => {
  const q = card('q', 'pane-a', {kind: 'question', questions: [{id: 'c', title: 'C', options: [{id: 'x', label: 'X'}, {id: 'y', label: 'Y'}]}],
    actions: [{id: 'submit', label: 'Send', requiresAnswers: true}]});
  const f = host([q]), mod = await load(f.h), p = await popup(f, mod, 'pane-a');
  click(p.render(), 'sf-ask-q-q0-o0', p.cx);
  f.files.set('/demo/data/sixfold/cards.json', JSON.stringify({schema: 1, cards: [{...q, revision: 'r2'}]}));
  click(p.render(), 'sf-ask-q-action-0', p.cx); await p.cx.settle();
  assert.equal(f.calls.filter(c => c[0] === 'write' || c[0] === 'exec').length, 0, 'stale revision never reaches the bridge');
  const tree = p.render();
  assert.equal(p.view.asks[0].revision, 'r2'); assert.deepEqual(Object.keys(p.view.askChoices), []);
  assert.match(text(tree), /요청 내용이 바뀌어 선택을 초기화했습니다/);
  f.store.set(SUMMARY_KEY, askSummary([{...q, revision: 'r2'}])); p.render(); await p.cx.settle();
  assert.match(text(p.render()), /요청 내용이 바뀌어 선택을 초기화했습니다/, 'a later re-read keeps the notice');
  click(p.render(), 'sf-ask-q-q0-o1', p.cx); assert.doesNotMatch(text(p.render()), /선택을 초기화했습니다/, 'choosing again clears it');
});
test('an expired card is reported, summary changes trigger one re-read, and a vanished pane shows none', async () => {
  const f = host([card('a1', 'pane-a'), card('a2', 'pane-a')]), mod = await load(f.h), p = await popup(f, mod, 'pane-a');
  f.files.set('/demo/data/sixfold/cards.json', JSON.stringify({schema: 1, cards: [card('a2', 'pane-a')]}));
  p.render(); await p.cx.settle(); assert.equal(p.view.asks.length, 2, 'no re-read without a summary change');
  f.store.set(SUMMARY_KEY, askSummary([card('a2', 'pane-a')]));
  p.render(); p.render(); await p.cx.settle();
  assert.deepEqual(p.view.asks.map(c => c.id), ['a2']); assert.match(text(p.render()), /처리되었거나 만료된 요청: 1/);
  f.files.set('/demo/data/sixfold/cards.json', JSON.stringify({schema: 1, cards: []})); f.store.set(SUMMARY_KEY, askSummary([]));
  p.render(); await p.cx.settle();
  assert.match(text(p.render()), /이 페인에 남은 확인 요청이 없습니다/);
});
test('closing answers nothing and a reopened popup shows the same card; read failures offer a retry', async () => {
  const f = host([card('a1', 'pane-a')]), mod = await load(f.h), p = await popup(f, mod, 'pane-a');
  click(p.render(), 'sf-ask-close', p.cx);
  assert.deepEqual(f.closed, ['ov-1']); assert.deepEqual(f.calls.filter(c => c[0] !== 'setShared'), []);
  assert.match(text(p.render()), /닫아도 거절·답변되지 않습니다/);
  const again = await popup(f, mod, 'pane-a'); assert.equal(again.view.asks[0].id, 'a1');
  f.impl.readTextFile = async () => { throw Error('io'); };
  const failed = await popup(f, mod, 'pane-a');
  assert.match(text(failed.render()), /카드를 읽지 못했습니다/);
  f.impl.readTextFile = async path => f.files.get(path) ?? null;
  click(failed.render(), 'sf-ask-retry', failed.cx); await failed.cx.settle();
  assert.equal(failed.view.asks[0].id, 'a1');
});
test('a missing bridge hides cards in the popup and never runs a command', async () => {
  const f = host([card('a1', 'pane-a')]); f.files.delete('/demo/data/sixfold/bridge.json');
  const mod = await load(f.h), p = await popup(f, mod, 'pane-a');
  assert.deepEqual(p.view.asks, []); assert.match(text(p.render()), /남은 확인 요청이 없습니다/);
  assert.deepEqual(f.calls, []);
});

test('a failed re-read while cards are shown says so, offers a retry, and recovers the new revision', async () => {
  const f = host([card('a1', 'pane-a')]), mod = await load(f.h), p = await popup(f, mod, 'pane-a');
  f.files.set('/demo/data/sixfold/cards.json', JSON.stringify({schema: 1, cards: [{...card('a1', 'pane-a'), revision: 'r2'}]}));
  f.store.set(SUMMARY_KEY, askSummary([{...card('a1', 'pane-a'), revision: 'r2'}]));
  f.impl.readTextFile = async () => { throw Error('io'); };
  p.render(); await p.cx.settle();
  let tree = p.render();
  assert.equal(p.view.asks[0].revision, 'r1'); assert.match(text(tree), /최신 내용을 읽지 못했습니다/); assert.ok(find(tree, 'sf-ask-reload'));
  p.render(); await p.cx.settle(); assert.equal(p.view.askLoading, false, 'no re-read loop on every render');
  f.impl.readTextFile = async path => f.files.get(path) ?? null;
  click(tree, 'sf-ask-reload', p.cx); await p.cx.settle();
  tree = p.render();
  assert.equal(p.view.asks[0].revision, 'r2'); assert.doesNotMatch(text(tree), /최신 내용을 읽지 못했습니다/);
});
