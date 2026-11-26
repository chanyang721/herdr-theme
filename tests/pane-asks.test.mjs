// Pane-scoped question/permission cards: sidebar summary, pane header button
// and the per-pane popup. Synthetic cards and a fake bridge only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {askSummary, groupAsks, summaryFor, unverifiedFor, summaryFromSnapshots, cardsFor, spaceAsks, spaceAskLayout, SPACE_ASK_WIDTH, SPACE_ASK_GAP, reconcile, clampPage, popupHeight, SUMMARY_KEY, errorText} from '../mods/sixfold-desk/ask-model.js';

// The summary as written, without its write generation and read time.
const plain = summary => { if (!summary || typeof summary !== 'object') return summary; const {g, at, ...rest} = summary; return rest; };
const bridge = {python: 'python3', script: '/demo/bridge/provider.py', args: ['--local']};
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
  const node = {kind, id: null, children: [], calls: [], args: {}, click: null};
  const proxy = new Proxy(function () {}, {get(_t, prop) {
    if (prop === '__node') return node;
    if (prop === 'then') return undefined;
    return (...args) => {
      node.calls.push(prop);
      node.args[prop] = args;
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
    .replace(/^import \{(.*)\} from 'gpui-base';\n/m, (_m, names) => `const {${names}} = globalThis.__paneAskRuntime;\n`)
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
  // Retained text states, as the host gives them: usable until released, then every use throws.
  const inputs = [];
  const TextareaState = {new: options => {
    let value = options?.value ?? '', released = false;
    const live = () => { if (released) throw Error('released'); };
    const state = {options, handlers: {}, focused: 0, get released() { return released; },
      value() { live(); return value; }, set_value(next) { live(); value = next; }, on(name, fn) { live(); state.handlers[name] = fn; return true; },
      focus() { live(); state.focused++; }, release() { released = true; return true; },
      type(next, cx) { value = next; state.handlers.change?.({}, cx); }, peek: () => value};
    inputs.push(state); return state;
  }};
  const Textarea = {new: state => { state.value(); const node = el('textarea'); nodeOf(node).state = state; return node; }};
  const snapshot = path => { const raw = files.get(path); if (raw === undefined) return {status: 'missing'}; try { return {status: 'ready', value: JSON.parse(raw)}; } catch { return {status: 'invalid'}; } };
  const h = {
    div: () => el('div'), h_flex: () => el('h_flex'), v_flex: () => el('v_flex'), TextareaState, Textarea,
    appHome: () => '/demo', props: () => currentProps,
    run: (name, args) => focus.push([name, args]),
    shared: key => store.has(key) ? structuredClone(store.get(key)) : undefined,
    setShared: (key, value) => { calls.push(['setShared', key]); store.set(key, structuredClone(value)); },
    openOverlay: spec => { overlays.push(spec); return `ov-${overlays.length}`; },
    closeOverlay: id => { closed.push(id); return null; },
    subscribeJsonFile(_cx, path, callback) { const set = listeners.get(path) ?? new Set(); set.add(callback); listeners.set(path, set); Promise.resolve().then(() => { if (set.has(callback)) callback(snapshot(path)); }); return () => set.delete(callback); },
    readJsonSnapshot: (...args) => impl.readJsonSnapshot(...args),
    readTextFile: (...args) => impl.readTextFile(...args),
    writeTextFile: async (path, value, expected) => { calls.push(['write', path]); if ((files.get(path) ?? null) !== expected) throw Error('File changed'); files.set(path, value); },
    exec: (...args) => impl.exec(...args),
  };
  // Swappable implementations: the module binds the host's functions at load.
  // Like the real bridge, an accepted action removes the card from cards.json.
  const impl = {
    readTextFile: async path => files.get(path) ?? null,
    readJsonSnapshot: async path => snapshot(path),
    exec: async (program, args) => {
      calls.push(['exec', program, args]); const request = JSON.parse(files.get(args.at(-1)));
      const now = JSON.parse(files.get('/demo/data/sixfold/cards.json')).cards.filter(c => c.id !== request.cardId);
      files.set('/demo/data/sixfold/cards.json', JSON.stringify({schema: 1, cards: now}));
      return {code: 0, stdout: JSON.stringify({schema: 1, id: request.id, status: 'accepted'})};
    },
  };
  const emit = path => { for (const cb of listeners.get(path) ?? []) cb(snapshot(path)); };
  const setCards = next => { files.set('/demo/data/sixfold/cards.json', JSON.stringify({schema: 1, cards: next})); emit('/demo/data/sixfold/cards.json'); };
  return {h, impl, snapshot, files, store, calls, overlays, closed, focus, setCards, emit, inputs, setProps: p => { currentProps = p; }};
}
const theme = new Proxy({}, {get: (_t, k) => `#${String(k).length.toString(16).padStart(6, '0')}`});

// ---- space-owned display requests ---------------------------------------
const request = (id, space, extra = {}) => ({id, space, agent: 'a-demo', kind: 'permission', title: `Request ${id}`, ...extra});
const bounds = {x: 7, y: 430, w: 265, h: 128};

test('display requests attach only by an explicit opaque space ID', () => {
  const requests = [request('r-a', 's-a'), request('r-b', 's-b'), request('r-unknown', null),
    {id: 'r-missing', title: 'No owner', terminal: 's-a'}, request('r-native', 'native-space'),
    request('r-again', 's-a'), request('r-again', 's-b'), request('../bad', 's-a')];
  assert.deepEqual(spaceAsks(requests, 's-a').map(r => r.id), ['r-a']);
  assert.deepEqual(spaceAsks(requests, 's-b').map(r => r.id), ['r-b']);
  assert.deepEqual(spaceAsks(requests, null), []);
  assert.deepEqual(spaceAsks(requests, ''), []);
  assert.deepEqual(spaceAsks(null, 's-a'), []);
  assert.deepEqual(spaceAsks([Object.assign(Object.create({space: 's-a'}), {id: 'r-x'})], 's-a'), []);
});

test('display metadata is bounded and never carries action or navigation authority', () => {
  const raw = request('r-a', 's-a', {title: 'X'.repeat(2000), kind: 'other', agent: '../bad',
    actions: [{id: 'approve'}], terminal: 'native-pane', nav: {space_id: 'native-space'}});
  const [clean] = spaceAsks([raw], 's-a');
  assert.deepEqual(clean, {id: 'r-a', space: 's-a', agent: null, kind: null, title: 'X'.repeat(500), answerable: true, createdAt: null});
  assert.deepEqual(spaceAsks([request('r-min', 's-a', {title: undefined, kind: undefined, agent: null})], 's-a'),
    [{id: 'r-min', space: 's-a', agent: null, kind: null, title: '', answerable: true, createdAt: null}], 'an unresolved request without optional text still counts');
  clean.title = 'changed'; assert.equal(raw.title.length, 2000, 'source objects are not mutated');
});

test('space requests come oldest first and keep the display-only flag', () => {
  const requests = [request('r-new', 's-a', {created_at: '2026-11-20T04:00:00Z'}),
    request('r-old', 's-a', {created_at: '2026-11-20T02:00:00Z', answerable: false}),
    request('r-mid', 's-a', {created_at: '2026-11-20T03:00:00Z'})];
  const out = spaceAsks(requests, 's-a');
  assert.deepEqual(out.map(r => r.id), ['r-old', 'r-mid', 'r-new']);
  assert.deepEqual(out.map(r => r.answerable), [false, true, true]);
});

test('space tab geometry follows the card outside its right edge at both panel widths', () => {
  for (const width of [265, 305]) {
    const b = {...bounds, w: width};
    assert.deepEqual(spaceAskLayout(b), {left: b.x + width + SPACE_ASK_GAP, top: b.y, width: SPACE_ASK_WIDTH, height: b.h});
    assert.equal(spaceAskLayout({...b, y: -20, h: 196}).top, -20, 'scroll coordinates are not clamped to another card');
    assert.equal(spaceAskLayout({...b, h: 196}).height, 196, 'expanded cards keep their own height');
  }
  const compact = spaceAskLayout(bounds);
  assert.equal(compact.left, 273);
  assert.ok(compact.left + compact.width <= 320, 'the 45px gutter tab fits the compact panel');
  for (const b of [null, {}, {...bounds, x: NaN}, {...bounds, y: Infinity}, {...bounds, w: 0},
    {...bounds, h: -1}, {...bounds, w: '265'}, {...bounds, x: Number.MAX_VALUE, w: Number.MAX_VALUE}]) {
    assert.equal(spaceAskLayout(b), null);
  }
});

test('space tab aligns to its measured card and opens only that space without responding or focusing', async () => {
  const f = host([]), mod = await load(f.h), opened = [], cx = context();
  const requests = [request('r-a', 's-a'), request('r-b', 's-b'), request('r-a2', 's-a', {agent: null}), request('r-null', null)];
  const tree = mod.spaceAskView(requests, 's-a', theme, 'ko', {bounds, onOpen: (items, context) => opened.push({items, context})});
  const root = nodeOf(tree);
  assert.deepEqual(root.args.left, [273]); assert.deepEqual(root.args.top, [430]);
  assert.deepEqual(root.args.w, [45]); assert.deepEqual(root.args.h, [128]);
  assert.match(text(tree), /확인 대기 2/); assert.doesNotMatch(root.args.tooltip[0], /Request r-b|Request r-null/);
  assert.deepEqual(f.calls, []); assert.deepEqual(opened, [], 'rendering does not auto-open');
  root.click(event, cx);
  assert.deepEqual(opened[0].items.map(r => r.id), ['r-a', 'r-a2']); assert.equal(opened[0].context, cx);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.focus, []); assert.deepEqual(f.overlays, []);
  assert.ok(root.calls.includes('on_mouse_down') && root.calls.includes('on_mouse_up'));
});

test('resolved or relocated requests remove the old tab and never leak to an unknown space', async () => {
  const f = host([]), mod = await load(f.h), render = (items, space = 's-a', b = bounds) => mod.spaceAskView(items, space, theme, 'en', {bounds: b});
  assert.ok(render([request('r-a', 's-a')]));
  assert.equal(render([]), null, 'confirmed removal hides the tab');
  assert.equal(render([request('r-a', 's-b')]), null, 'relocation removes it from the previous owner');
  assert.ok(render([request('r-a', 's-b')], 's-b'));
  assert.equal(render([request('r-a', null)]), null);
  assert.equal(render([request('r-a', 's-a')], 's-a', null), null, 'unmeasured cards do not guess a position');
  nodeOf(render([request('r-a', 's-a')])).click(event, context());
  assert.deepEqual(f.calls, []);
});

test('many requests occupy one tab and a bounded tooltip while every request reaches the opener', async () => {
  const f = host([]), mod = await load(f.h), requests = Array.from({length: 100}, (_, i) => request(`r-${i}`, 's-a'));
  let opened;
  const tree = mod.spaceAskView(requests, 's-a', theme, 'en', {bounds, onOpen: items => { opened = items; }});
  assert.match(text(tree), /Wait 100/);
  const root = nodeOf(tree);
  assert.equal(root.args.tooltip[0].split('\n').length, 10); assert.match(root.args.tooltip[0], /92 more/);
  root.click(event, context()); assert.equal(opened.length, 100); assert.equal(opened.at(-1).id, 'r-99');
  assert.deepEqual(root.args.h, [128], 'request volume never grows the card');
});

test('space tabs coexist with automatic foreign popups without responding or moving focus', async () => {
  for (const spaceAnchored of [false, true]) {
    const f = host([card('a1', 'pane-a')]);
    Object.assign(f.h, {panes: () => [{terminal: 'pane-a', tab: 'tab-a'}],
      spaces: () => [{id: 'native-a', tabs: [{id: 'tab-a'}]}], focused: () => ({space: 'native-b'})});
    const mod = await load(f.h), view = {}, cx = context();
    mod.watchAsks(view, cx, {spaceAnchored}); await Promise.resolve(); await Promise.resolve();
    assert.equal(view.asks.length, 1); assert.equal(f.overlays.length, 1);
    assert.equal(f.overlays[0].props.terminal, 'pane-a');
    const render = () => mod.spaceAskView(view.asks.map(item => ({...item, space: 's-a'})), 's-a', theme, 'ko', {bounds});
    assert.ok(render(), 'the space tab stays visible alongside the automatic popup');
    assert.equal(f.store.get(SUMMARY_KEY).panes['pane-a'].n, 1, 'manual response UI still receives card summaries');
    f.h.closeOverlay('ov-1');
    f.setCards([card('a1', 'pane-a')]);
    assert.equal(f.overlays.length, 1, 'the same request does not reopen a dismissed popup');
    assert.ok(render(), 'closing a popup leaves the unresolved space tab visible');
    f.setCards([card('a1', 'pane-a', {revision: 'r2'})]);
    assert.equal(f.overlays.length, 2, 'a revised foreign request still opens automatically');
    assert.deepEqual(f.focus, []);
    assert.deepEqual(f.calls.filter(([kind]) => kind === 'write' || kind === 'exec'), []);
    f.setCards([]); assert.deepEqual(view.asks, []);
    assert.equal(render(), null, 'confirmed resolution removes the tab');
    view.stopAsks();
  }
});

// ---- pure model ----------------------------------------------------------
test('summary groups cards per terminal, versions by id and revision, and hides without a bridge', () => {
  const cards = [card('a1', 'pane-a'), card('b1', 'pane-b', {kind: 'question'}), card('a2', 'pane-a'), card('u1', null)];
  const summary = askSummary(cards);
  assert.deepEqual(summary.panes, {'pane-a': {n: 2, kind: 'permission'}, 'pane-b': {n: 1, kind: 'question'}, '': {n: 1, kind: 'permission'}});
  assert.notEqual(askSummary([{...cards[0], revision: 'r2'}, ...cards.slice(1)]).v, summary.v, 'a revision change moves the version');
  assert.deepEqual(askSummary(null), {status: 'ready', v: '', panes: {}});
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
  assert.ok(popupHeight(multi) > popupHeight(card('p', 't'))); assert.ok(popupHeight({...multi, detail: "x".repeat(50000)}) <= 720);
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
  assert.deepEqual(plain(f.store.get(SUMMARY_KEY)), {status: 'missing', v: '', panes: {}}, 'no bridge: pane buttons disappear');
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
  // Nothing measured or read yet: still never at the pointer, the window's left edge at the fallback height.
  assert.deepEqual(f.overlays[0].at, {x: 8, y: Math.round((820 - f.overlays[0].height) / 2)});
  mod.recordSidebarBox({width: 900, height: 1200});
  nodeOf(a).click(event, context());
  assert.deepEqual(f.overlays[1].at, {x: 170, y: Math.round((1200 - f.overlays[1].height) / 2)}, 'centred on the sidebar');
  // The popup read window.json in the background for the next one.
  f.files.set('/demo/window.json', JSON.stringify({state: 'windowed', bounds: [0, 30, 1000, 700]}));
  mod.refreshWindowPlace(true); await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(f.store.get('sixfold.asks.windowPlace'), {w: 1000, h: 700, windowed: true});
  assert.deepEqual(f.focus, [], 'no pane.focus/agent.focus');
  assert.ok(nodeOf(a).calls.includes('on_mouse_down'), 'press does not reach the header (which focuses the pane)');
});

// ---- the summary follows the cards file, not its last copy ----------------
test('only a summary read from the files draws a header button; failed reads differ from none', () => {
  assert.equal(summaryFor({v: 'old', panes: {'pane-a': {n: 1, kind: 'permission'}}}, 'pane-a'), null, 'an older-format summary is never drawn');
  const ready = {status: 'ready', value: {schema: 1, cards: [card('a1', 'pane-a')]}}, bridgeOk = {status: 'ready', value: bridge};
  assert.equal(summaryFor(summaryFromSnapshots(bridgeOk, ready), 'pane-a').n, 1);
  assert.deepEqual(summaryFromSnapshots(bridgeOk, {status: 'ready', value: {schema: 1, cards: []}}), {status: 'ready', v: '', panes: {}});
  assert.deepEqual(summaryFromSnapshots({status: 'missing'}, ready), {status: 'missing', v: '', panes: {}}, 'no bridge: nothing waits');
  assert.deepEqual(summaryFromSnapshots(bridgeOk, {status: 'missing'}), {status: 'missing', v: '', panes: {}}, 'no cards file: nothing waits');
  const before = askSummary([card('a1', 'pane-a')]);
  for (const broken of [{status: 'invalid'}, {status: 'ready', value: {schema: 2}}, {status: 'ready'}]) {
    const failed = summaryFromSnapshots(bridgeOk, broken, before);
    assert.equal(failed.status, 'unreadable');
    assert.equal(summaryFor(failed, 'pane-a'), null, 'no old count after a failed read');
    assert.equal(unverifiedFor(failed, 'pane-a'), true, 'the pane that had requests says it is unconfirmed');
    assert.equal(unverifiedFor(failed, 'pane-b'), false);
  }
  const twice = summaryFromSnapshots({status: 'invalid'}, ready, summaryFromSnapshots(bridgeOk, {status: 'invalid'}, before));
  assert.deepEqual(twice.unverified, ['pane-a'], 'a second failed read keeps the unconfirmed panes');
  assert.equal(unverifiedFor(summaryFromSnapshots(bridgeOk, {status: 'invalid'}, null), 'pane-a'), false, 'nothing known, nothing shown');
});

test('a header whose request was already answered re-reads the file and clears the stale button', async () => {
  // The reported case: the shared summary still names a permission for a
  // pane, the cards file is empty, and no sidebar watcher rewrites it.
  const f = host([]), mod = await load(f.h), cx = context();
  f.store.set(SUMMARY_KEY, askSummary([card('a1', 'pane-a')]));
  let reads = 0; f.impl.readJsonSnapshot = async path => { reads++; return f.snapshot(path); };
  assert.match(text(mod.paneAskButton({pane: 'p1', terminal: 'pane-a'}, theme, 'ko', 'Alpha', cx)), /권한/, 'drawn until the read returns');
  await cx.settle();
  assert.deepEqual(plain(f.store.get(SUMMARY_KEY)), {status: 'ready', v: '', panes: {}}, 'the shared summary is corrected for every copy');
  assert.equal(mod.paneAskButton({pane: 'p1', terminal: 'pane-a'}, theme, 'ko', 'Alpha', cx), null);
  assert.equal(reads, 2, 'one read of bridge and cards');
  // A header with nothing to show reads nothing.
  mod.paneAskButton({pane: 'p2', terminal: 'pane-b'}, theme, 'ko', 'Beta', cx); await cx.settle();
  assert.equal(reads, 2);
});

test('header checks are bounded, never overwrite a newer summary, and show unreadable files as unconfirmed', async () => {
  const f = host([card('a1', 'pane-a')]), mod = await load(f.h), cx = context();
  f.store.set(SUMMARY_KEY, askSummary([card('a1', 'pane-a')]));
  let reads = 0; f.impl.readJsonSnapshot = async path => { reads++; return f.snapshot(path); };
  for (let i = 0; i < 5; i++) mod.paneAskButton({pane: 'p1', terminal: 'pane-a'}, theme, 'ko', 'Alpha', cx);
  await cx.settle();
  assert.equal(reads, 2, 'renders within the interval share one read');
  assert.equal(f.calls.filter(c => c[0] === 'setShared').length, 0, 'an agreeing summary is not rewritten');
  // The cards file turns unreadable: the count gives way to "unconfirmed".
  f.files.set('/demo/data/sixfold/cards.json', '{"schema":1,"cards":[');
  assert.equal(mod.checkSummary(cx, Date.now() + 10_000), true); await cx.settle();
  assert.equal(f.store.get(SUMMARY_KEY).status, 'unreadable');
  const unknown = mod.paneAskButton({pane: 'p1', terminal: 'pane-a'}, theme, 'ko', 'Alpha', cx);
  assert.match(text(unknown), /확인 불가/); assert.doesNotMatch(text(unknown), /권한/);
  nodeOf(unknown).click(event, context());
  assert.equal(f.overlays.at(-1).props.terminal, 'pane-a', 'the popup reads again and offers a retry');
  // Readable again with the request answered: nothing left on the header.
  f.files.set('/demo/data/sixfold/cards.json', JSON.stringify({schema: 1, cards: []}));
  mod.checkSummary(cx, Date.now() + 20_000); await cx.settle();
  assert.equal(mod.paneAskButton({pane: 'p1', terminal: 'pane-a'}, theme, 'ko', 'Alpha', cx), null);
  // The watcher publishes while a header read is out: the header's older read does not win.
  const newer = askSummary([card('b1', 'pane-b')]);
  f.impl.readJsonSnapshot = async path => { f.store.set(SUMMARY_KEY, newer); return f.snapshot(path); };
  f.store.set(SUMMARY_KEY, askSummary([card('a1', 'pane-a')]));
  mod.checkSummary(cx, Date.now() + 30_000); await cx.settle();
  assert.deepEqual(plain(f.store.get(SUMMARY_KEY)), newer);
});

test('an older-format summary is unknown, not empty: the header says so and reads the files at once', async () => {
  const f = host([card('a1', 'pane-a')]), mod = await load(f.h), cx = context();
  f.store.set(SUMMARY_KEY, {v: 'old', panes: {'pane-a': {n: 1, kind: 'permission'}}});
  let reads = 0; f.impl.readJsonSnapshot = async path => { reads++; return f.snapshot(path); };
  const first = mod.paneAskButton({pane: 'p1', terminal: 'pane-a'}, theme, 'ko', 'Alpha', cx);
  assert.match(text(first), /확인 중/, 'a real card is not hidden while unknown'); assert.doesNotMatch(text(first), /권한/);
  assert.equal(mod.paneAskButton({pane: 'p2', terminal: 'pane-b'}, theme, 'ko', 'Beta', cx), null);
  await cx.settle();
  assert.equal(reads, 2, 'read on the first render');
  assert.equal(f.store.get(SUMMARY_KEY).status, 'ready');
  assert.match(text(mod.paneAskButton({pane: 'p1', terminal: 'pane-a'}, theme, 'ko', 'Alpha', cx)), /권한/);
});

test('the watcher compares with the shared summary, so a file restored to the same cards is published again', async () => {
  const f = host([card('a1', 'pane-a')]), mod = await load(f.h), view = {}, cx = context();
  mod.watchAsks(view, cx); await Promise.resolve(); await Promise.resolve();
  // A header reads the file while it is briefly absent and records "missing";
  // the watcher never saw that state, so its own last list is unchanged.
  const saved = f.files.get('/demo/data/sixfold/cards.json');
  f.files.delete('/demo/data/sixfold/cards.json');
  mod.checkSummary(cx, Date.now() + 10_000); await cx.settle();
  assert.equal(f.store.get(SUMMARY_KEY).status, 'missing');
  f.files.set('/demo/data/sixfold/cards.json', saved); f.emit('/demo/data/sixfold/cards.json');
  assert.equal(summaryFor(f.store.get(SUMMARY_KEY), 'pane-a')?.n, 1, 'a file event republishes');
  f.store.set(SUMMARY_KEY, askSummary(null, 'missing'));
  await view.refreshAsks(cx); await cx.settle();
  assert.equal(summaryFor(f.store.get(SUMMARY_KEY), 'pane-a')?.n, 1, 'so does a refresh');
  view.stopAsks();
});

test('a header read never overwrites a summary that changed and changed back meanwhile', async () => {
  const f = host([]), mod = await load(f.h), view = {}, cx = context();
  f.setCards([card('a1', 'pane-a')]);
  mod.watchAsks(view, cx); await Promise.resolve(); await Promise.resolve();
  const start = f.store.get(SUMMARY_KEY);
  // The header reads an empty file; meanwhile the watcher publishes
  // A -> empty -> A, ending on the value the header started from.
  f.impl.readJsonSnapshot = async path => {
    if (path.endsWith('cards.json')) {
      const read = {status: 'ready', value: {schema: 1, cards: []}};
      f.setCards([]); f.setCards([card('a1', 'pane-a')]);
      return read;
    }
    return f.snapshot(path);
  };
  mod.checkSummary(cx, Date.now() + 10_000); await cx.settle();
  const end = f.store.get(SUMMARY_KEY);
  assert.equal(summaryFor(end, 'pane-a')?.n, 1, 'the late empty read does not win');
  assert.notEqual(end.g, start.g, 'every write carries a new generation');
  view.stopAsks();
});

test('an activity change never republishes cached cards over a newer header read', async () => {
  const f = host([card('a1', 'pane-a')]), mod = await load(f.h), view = {}, cx = context();
  mod.watchAsks(view, cx); await Promise.resolve(); await Promise.resolve();
  // The card is answered but the event never reaches the watcher.
  f.files.set('/demo/data/sixfold/cards.json', JSON.stringify({schema: 1, cards: []}));
  mod.checkSummary(cx, Date.now() + 10_000); await cx.settle();
  assert.equal(summaryFor(f.store.get(SUMMARY_KEY), 'pane-a'), null);
  view.setAsksActive(false); view.setAsksActive(true);
  assert.equal(summaryFor(f.store.get(SUMMARY_KEY), 'pane-a'), null, 'no read, no publish');
  // A refresh whose read started before a header's later read does not win.
  f.files.set('/demo/data/sixfold/cards.json', JSON.stringify({schema: 1, cards: [card('a1', 'pane-a')]}));
  f.impl.readJsonSnapshot = async path => {
    const read = f.snapshot(path);
    if (path.endsWith('cards.json')) { await new Promise(resolve => setTimeout(resolve, 5)); f.store.set(SUMMARY_KEY, {...askSummary([]), at: Date.now(), g: 'header'}); }
    return read;
  };
  await view.refreshAsks(cx); await cx.settle();
  assert.equal(f.store.get(SUMMARY_KEY).g, 'header', 'a summary from a later read is kept');
  view.stopAsks();
});

test('a read time ahead of this clock is ignored, so it cannot freeze the summary', async () => {
  const f = host([]), mod = await load(f.h), view = {}, cx = context();
  f.store.set(SUMMARY_KEY, {...askSummary([]), at: Date.now() + 3_600_000, g: 'future'});
  f.setCards([card('a1', 'pane-a')]);
  mod.watchAsks(view, cx); await Promise.resolve(); await Promise.resolve();
  assert.equal(summaryFor(f.store.get(SUMMARY_KEY), 'pane-a')?.n, 1);
  assert.ok(f.store.get(SUMMARY_KEY).at <= Date.now());
  view.stopAsks();
});

test('the read poll starts the cards recheck without waiting for it', async () => {
  const source = await readFile(new URL('../mods/sixfold-desk/main.js', import.meta.url), 'utf8');
  const poll = source.slice(source.indexOf('this.readPoll=createPoll(cx,'), source.indexOf('// Optional voice integration'));
  assert.doesNotMatch(poll, /await\s+this\.recheckAsks/, 'a stuck re-read must not hold the message read marks');
  // The job itself: a recheck that never settles still lets the read marks run.
  const job = poll.slice(poll.indexOf('job:async cx=>{'), poll.indexOf('if(!this.messageEvents?.length)return;', poll.indexOf('job:async cx=>{')));
  const view = {recheckAsks: () => new Promise(() => {})};
  const run = new Function('view', 'cx', `return (async function(cx){${job.slice('job:async cx=>{'.length)}}).call(view, cx);`);
  const result = await Promise.race([run(view, {}).then(() => 'done'), new Promise(resolve => setTimeout(() => resolve('stuck'), 50))]);
  assert.equal(result, 'done');
});


test('the read poll recheck finds a missed new card and a recovery to the same file, at most every 10 s', async () => {
  const f = host([]), mod = await load(f.h), view = {}, cx = context();
  mod.watchAsks(view, cx); await Promise.resolve(); await Promise.resolve();
  let reads = 0; f.impl.readJsonSnapshot = async path => { reads++; return f.snapshot(path); };
  // A new card arrives without an event: the summary says nothing waits.
  f.files.set('/demo/data/sixfold/cards.json', JSON.stringify({schema: 1, cards: [card('a1', 'pane-a')]}));
  const now = Date.now();
  await view.recheckAsks(cx, now); await cx.settle();
  assert.equal(summaryFor(f.store.get(SUMMARY_KEY), 'pane-a')?.n, 1);
  assert.equal(view.recheckAsks(cx, now + 5_000), null, 'bounded'); assert.equal(reads, 2);
  // Someone records "missing"; the file is unchanged, so no hub event follows.
  f.store.set(SUMMARY_KEY, {...askSummary(null, 'missing'), at: now});
  await view.recheckAsks(cx, now + 10_000); await cx.settle();
  assert.equal(summaryFor(f.store.get(SUMMARY_KEY), 'pane-a')?.n, 1, 'compared with shared state, corrected');
  view.stopAsks();
});

test('the sidebar read poll carries the cards recheck instead of a timer of its own', async () => {
  const source = await readFile(new URL('../mods/sixfold-desk/main.js', import.meta.url), 'utf8');
  const poll = source.slice(source.indexOf('this.readPoll=createPoll(cx,'), source.indexOf('// Optional voice integration'));
  assert.match(poll, /this\.recheckAsks\?\.\(cx\)/);
  assert.match(poll, /visible:\(\)=>this\.sidebarVisible!==false,/, 'runs without message events too');
});

test('the sidebar watcher publishes a failed cards read as unreadable, not as the last counts', async () => {
  const f = host([card('a1', 'pane-a')]), mod = await load(f.h), view = {}, cx = context();
  mod.watchAsks(view, cx); await Promise.resolve(); await Promise.resolve();
  assert.equal(summaryFor(f.store.get(SUMMARY_KEY), 'pane-a').n, 1);
  f.files.set('/demo/data/sixfold/cards.json', '{"schema":1,"cards":['); f.emit('/demo/data/sixfold/cards.json');
  assert.equal(f.store.get(SUMMARY_KEY).status, 'unreadable');
  assert.equal(unverifiedFor(f.store.get(SUMMARY_KEY), 'pane-a'), true);
  assert.deepEqual(view.asks.map(c => c.id), ['a1'], 'the sidebar list keeps the last valid cards');
  f.setCards([]);
  assert.deepEqual(plain(f.store.get(SUMMARY_KEY)), {status: 'ready', v: '', panes: {}});
  f.files.delete('/demo/data/sixfold/cards.json'); f.emit('/demo/data/sixfold/cards.json');
  assert.equal(f.store.get(SUMMARY_KEY).status, 'missing');
  view.stopAsks();
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
  assert.ok(find(tree, 'sf-ask-body-multi').calls.includes('overflow_y_scroll'));
  click(tree, 'sf-ask-next', a.cx); tree = a.render();
  assert.match(text(tree), /line one\nline two/, 'detail keeps its original text');
  assert.equal(find(tree, 'sf-ask-next').click(event, a.cx), undefined); assert.equal(a.view.askPage, 2, 'last page stays');
  assert.deepEqual(f.focus, []); assert.deepEqual(f.calls.filter(c => c[0] !== 'setShared'), []);
});
test('a card waiting in its pane is shown without buttons and only a click goes to that pane', async () => {
  const waiting = card('w1', 'pane-a', {answerable: false, title: 'Run it?'});
  const f = host([waiting]), mod = await load(f.h);
  f.h.panes = () => [{terminal: 'pane-a', pane: 'p-a', tab: 'tab-a'}];
  const mod2 = await load(f.h), p = await popup(f, mod2, 'pane-a');
  assert.equal(p.view.asks[0].answerable, false); assert.deepEqual(p.view.asks[0].actions, [], 'no answer path');
  let tree = p.render();
  assert.ok(find(tree, 'sf-ask-in-pane-w1')); assert.match(text(tree), /그 페인의 Claude 창에서 직접 답하세요/);
  assert.equal(ids(tree, 'sf-ask-w1-action-').length, 0);
  assert.deepEqual(f.focus, [], 'rendering never moves focus');
  click(tree, 'sf-ask-go-w1', p.cx);
  assert.deepEqual(f.focus, [['tab.select', {id: 'tab-a'}], ['pane.focus', {pane: 'p-a'}]]);
  assert.deepEqual(f.calls.filter(c => c[0] === 'exec' || c[0] === 'write'), [], 'going there answers nothing');
  void mod;
});

test('a space queue shows every asking pane oldest first, one at a time, and the next after an answer', async () => {
  const cards = [card('b-old', 'pane-b', {createdAt: '2026-11-20T01:00:00Z'}), card('a-new', 'pane-a', {createdAt: '2026-11-20T03:00:00Z'}),
    card('a-old', 'pane-a', {createdAt: '2026-11-20T02:00:00Z'}), card('c-x', 'pane-c', {createdAt: '2026-11-20T00:00:00Z'})];
  const f = host(cards), mod = await load(f.h);
  const own = {role: 'ask', terminal: 'pane-b', terminals: ['pane-a', 'pane-b'], names: {'pane-a': 'Alpha', 'pane-b': 'Beta'}, name: 'Demo', overlay: 'ov-1'};
  const view = {}, cx = context(), render = () => { f.setProps(own); return mod.askPopup(view, theme, 'ko', cx); };
  render(); await cx.settle();
  assert.deepEqual(view.asks.map(c => c.id), ['b-old', 'a-old', 'a-new'], 'oldest first; another space stays out');
  let tree = render();
  assert.match(text(tree), /1\/3 · 오래된 순/); assert.match(text(tree), /Demo · Beta/); assert.match(text(tree), /Title b-old/);
  click(tree, 'sf-ask-b-old-action-0', cx); await cx.settle();
  f.store.set(SUMMARY_KEY, askSummary(cards.slice(1))); render(); await cx.settle();
  tree = render();
  assert.match(text(tree), /Title a-old/, 'one answer, then the next oldest'); assert.match(text(tree), /Demo · Alpha/);
  assert.equal(f.calls.filter(c => c[0] === 'exec').length, 1, 'one answer per press');
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
const replyId = `n-${'0123456789abcdef'.repeat(2)}`;
const replyCard = card(replyId, 'pane-a', {kind: 'question', title: 'Waiting for an answer',
  questions: [{id: 'q0', title: 'Type what to send to that pane'}],
  actions: [{id: 'reply', label: 'Reply', requiresText: true, primary: true}]});
test('a text card shows a text box, sends only valid text, and clears it after an accepted send', async () => {
  const f = host([replyCard]), mod = await load(f.h), p = await popup(f, mod, 'pane-a');
  assert.equal(f.inputs.length, 1, 'one state for the one text card, made after the read');
  const [input] = f.inputs;
  assert.equal(input.options.placeholder, '그 칸에 보낼 답을 적으세요');
  let tree = p.render();
  assert.equal(find(tree, `sf-ask-text-${replyId}`).children.length, 1); assert.match(text(tree), /Type what to send to that pane/);
  click(tree, `sf-ask-${replyId}-action-0`, p.cx); await p.cx.settle();
  assert.deepEqual(f.calls.filter(c => c[0] !== 'setShared'), [], 'empty text cannot send');
  input.type(' \n ', p.cx); click(p.render(), `sf-ask-${replyId}-action-0`, p.cx); await p.cx.settle();
  assert.deepEqual(f.calls.filter(c => c[0] !== 'setShared'), [], 'blank text cannot send');
  const before = p.cx.notifications; input.type('Use the second option.\n', p.cx); assert.ok(p.cx.notifications > before, 'typing redraws the button');
  input.handlers.submit({secondary: false}, p.cx); await p.cx.settle();
  assert.equal(f.calls.filter(c => c[0] === 'exec').length, 0, 'a plain Enter is a new line, not a send');
  click(p.render(), `sf-ask-${replyId}-action-0`, p.cx); await p.cx.settle();
  const exec = f.calls.filter(c => c[0] === 'exec'); assert.equal(exec.length, 1);
  const request = JSON.parse(f.files.get(exec[0][2].at(-1)));
  assert.deepEqual({action: request.action, answers: request.answers, text: request.text, cardId: request.cardId},
    {action: 'reply', answers: {}, text: 'Use the second option.', cardId: replyId});
  assert.equal(input.peek(), '', 'accepted: the text box is cleared');
  f.store.set(SUMMARY_KEY, askSummary([])); p.render(); await p.cx.settle();
  assert.equal(input.released, true, 'the card left, so its state is released');
  assert.match(text(p.render()), /응답을 접수했습니다/);
});
test('a failed text send names the reason from the receipt and keeps the typed text', async () => {
  const f = host([replyCard]), mod = await load(f.h), p = await popup(f, mod, 'pane-a');
  const [input] = f.inputs;
  for (const [error, shown] of [['pane_busy', /쓰던 글이 있거나 선택창이 열려 있어 보내지 않았습니다/], ['unconfirmed', /다시 보내지 마세요/],
    ['card_changed', /요청이 바뀌었거나 만료되었습니다/], ['pane_unavailable', /그 칸을 찾지 못했습니다/], ['invalid_text', /4000자까지/], ['private-detail', /전송 실패/]]) {
    f.impl.exec = async (_program, args) => ({code: 1, stdout: JSON.stringify({schema: 1, id: JSON.parse(f.files.get(args.at(-1))).id, status: 'rejected', error})});
    input.type('An answer', p.cx);
    click(p.render(), `sf-ask-${replyId}-action-0`, p.cx); await p.cx.settle();
    const tree = p.render();
    assert.match(text(tree), shown, error); assert.doesNotMatch(text(tree), /private-detail/);
    assert.equal(input.value(), 'An answer', 'the text stays for another try'); assert.equal(p.view.asks.length, 1);
  }
  // A released state is never drawn: the box becomes a click target that makes a fresh one.
  input.release();
  let tree = p.render();
  assert.equal(find(tree, `sf-ask-text-${replyId}`).children.includes('눌러서 답 쓰기'), true);
  click(tree, `sf-ask-text-${replyId}`, p.cx);
  assert.equal(f.inputs.length, 2); assert.equal(f.inputs[1].focused, 1);
  tree = p.render(); assert.equal(nodeOf(find(tree, `sf-ask-text-${replyId}`).children[0]).state, f.inputs[1]);
  p.view.releaseAskInputs(); assert.equal(f.inputs[1].released, true, 'closing the popup releases its states');
});
test('a draft is kept for a new title and dropped for another question, never sent to it', async () => {
  const f = host([replyCard]), mod = await load(f.h), p = await popup(f, mod, 'pane-a');
  const [input] = f.inputs;
  input.type('Answer to the first question', p.cx);
  const refresh = async next => {
    f.files.set('/demo/data/sixfold/cards.json', JSON.stringify({schema: 1, cards: [next]}));
    f.store.set(SUMMARY_KEY, askSummary([next])); p.render(); await p.cx.settle();
  };
  await refresh({...replyCard, revision: 'r2', title: 'Waiting for an answer · 30 min'});
  assert.equal(input.released, false, 'a reminder title keeps the state'); assert.equal(input.value(), 'Answer to the first question');
  const asked = {...replyCard, revision: 'r3', questions: [{id: 'q0', title: 'A different line shown to the person'}]};
  await refresh(asked);
  assert.equal(input.released, true, 'a changed question line drops the old draft');
  assert.equal(f.inputs.length, 2); assert.equal(f.inputs[1].value(), '');
  f.inputs[1].type('second draft', p.cx);
  await refresh({...asked, revision: 'r4', detail: 'Another question entirely'});
  assert.equal(f.inputs[1].released, true, 'another body drops it too');
  assert.equal(f.inputs.length, 3); assert.equal(f.inputs[2].value(), '');
  f.inputs[1] = f.inputs[2];
  // even a draft left on a stale state is never sent to the new question
  const sent = [];
  f.impl.exec = async (_program, args) => { sent.push(JSON.parse(f.files.get(args.at(-1)))); return {code: 0, stdout: ''}; };
  p.view.askInputKeys.set(replyId, 'stale-key');
  f.inputs[1].type('typed before the change', p.cx);
  click(p.render(), `sf-ask-${replyId}-action-0`, p.cx); await p.cx.settle();
  assert.deepEqual(sent, [], 'a draft for another question cannot send');
});
test('option and display-only cards make no text state', async () => {
  const f = host([card('a1', 'pane-a'), multi, card('w1', 'pane-a', {answerable: false, actions: [{id: 'reply', label: 'Reply', requiresText: true}]})]);
  f.h.panes = () => [];
  const mod = await load(f.h), p = await popup(f, mod, 'pane-a');
  assert.equal(p.view.asks.length, 3); assert.equal(f.inputs.length, 0);
  for (let i = 0; i < 3; i++) { assert.equal(ids(p.render(), 'sf-ask-text-').length, 0); click(p.render(), 'sf-ask-next', p.cx); }
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
  f.impl.readJsonSnapshot = async () => { throw Error('io'); };
  const failed = await popup(f, mod, 'pane-a');
  assert.match(text(failed.render()), /카드를 읽지 못했습니다/);
  f.impl.readJsonSnapshot = async path => f.snapshot(path);
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
  f.impl.readJsonSnapshot = async () => { throw Error('io'); };
  p.render(); await p.cx.settle();
  let tree = p.render();
  assert.equal(p.view.asks[0].revision, 'r1'); assert.match(text(tree), /최신 내용을 읽지 못했습니다/); assert.ok(find(tree, 'sf-ask-reload'));
  p.render(); await p.cx.settle(); assert.equal(p.view.askLoading, false, 'no re-read loop on every render');
  f.impl.readJsonSnapshot = async path => f.snapshot(path);
  click(tree, 'sf-ask-reload', p.cx); await p.cx.settle();
  tree = p.render();
  assert.equal(p.view.asks[0].revision, 'r2'); assert.doesNotMatch(text(tree), /최신 내용을 읽지 못했습니다/);
});

test('a half-written bridge file is a failed read, not a missing bridge: cards stay and a retry recovers', async () => {
  const f = host([card('a1', 'pane-a')]), mod = await load(f.h), p = await popup(f, mod, 'pane-a');
  for (const broken of ['{', JSON.stringify({python: 'python3'})]) {
    f.files.set('/demo/data/sixfold/bridge.json', broken);
    f.files.set('/demo/data/sixfold/cards.json', JSON.stringify({schema: 1, cards: [{...card('a1', 'pane-a'), revision: 'r2'}]}));
    f.store.set(SUMMARY_KEY, {v: `broken-${broken.length}`, panes: {}});
    p.render(); await p.cx.settle();
    const tree = p.render();
    assert.equal(p.view.asks.length, 1); assert.equal(p.view.askExpired, 0, 'not reported as expired');
    assert.match(text(tree), /최신 내용을 읽지 못했습니다/); assert.ok(find(tree, 'sf-ask-reload'));
  }
  f.files.set('/demo/data/sixfold/bridge.json', JSON.stringify(bridge));
  click(p.render(), 'sf-ask-reload', p.cx); await p.cx.settle();
  assert.equal(p.view.asks[0].revision, 'r2'); assert.equal(p.view.askLoadFailed, false);
  f.files.delete('/demo/data/sixfold/bridge.json'); p.view.refreshAsks(p.cx); await p.cx.settle();
  assert.deepEqual(p.view.asks, [], 'a really missing bridge still hides the cards');
});

test('a send whose receipt cannot be confirmed stays reported after the card disappears', async () => {
  const f = host([card('a1', 'pane-a'), card('a2', 'pane-a')]), mod = await load(f.h), p = await popup(f, mod, 'pane-a');
  // The bridge removes the card but answers with a receipt for another request id.
  f.impl.exec = async () => {
    f.files.set('/demo/data/sixfold/cards.json', JSON.stringify({schema: 1, cards: [card('a2', 'pane-a')]}));
    return {code: 0, stdout: JSON.stringify({schema: 1, id: 'someone-else', status: 'accepted'})};
  };
  click(p.render(), 'sf-ask-a1-action-0', p.cx); await p.cx.settle();
  f.store.set(SUMMARY_KEY, askSummary([card('a2', 'pane-a')])); p.render(); await p.cx.settle();
  const tree = p.render();
  assert.deepEqual(p.view.asks.map(c => c.id), ['a2']);
  assert.match(text(tree), /응답 접수를 확인하지 못함.*Title a1/); assert.equal(p.view.askExpired, 0, 'not counted as an expiry');
  assert.doesNotMatch(text(tree), /응답을 접수했습니다/);
});
test('popup and pre-send checks use the same typed reader as the sidebar (no 1 MiB text read)', async () => {
  const big = card('big', 'pane-a', {detail: 'x'.repeat(1_500_000)});
  const f = host([big]), mod = await load(f.h);
  f.impl.readTextFile = async () => { throw Error('readTextFile must not be used for cards or bridge'); };
  const p = await popup(f, mod, 'pane-a');
  assert.equal(p.view.asks[0].id, 'big');
  click(p.render(), 'sf-ask-big-action-0', p.cx); await p.cx.settle();
  assert.ok(f.calls.some(c => c[0] === 'exec'), 'the send went through');
});

test('a card moved to another pane leaves the old popup and cannot be sent from it', async () => {
  const f = host([card('a1', 'pane-a')]), mod = await load(f.h), p = await popup(f, mod, 'pane-a');
  const moved = [card('a1', 'pane-b')];
  assert.notEqual(askSummary(moved).v, askSummary([card('a1', 'pane-a')]).v, 'ownership is part of the version');
  f.files.set('/demo/data/sixfold/cards.json', JSON.stringify({schema: 1, cards: moved}));
  click(p.render(), 'sf-ask-a1-action-0', p.cx); await p.cx.settle();
  assert.equal(f.calls.filter(c => c[0] === 'write' || c[0] === 'exec').length, 0, 'never sent from the old pane');
  f.store.set(SUMMARY_KEY, askSummary(moved)); p.render(); await p.cx.settle();
  assert.deepEqual(p.view.asks, []);
  const b = await popup(f, mod, 'pane-b'); assert.equal(b.view.asks[0].id, 'a1');
});

// ---- cards from another space pop up by themselves --------------------
import {autoPopupTarget, prunedOpened, askKey} from '../mods/sixfold-desk/ask-model.js';
const spaceOf = map => terminal => map[terminal] ?? null;

test('a card from another space opens its pane popup once', () => {
  const cards = [card('a', 't-b'), card('b', 't-b')];
  const target = autoPopupTarget(cards, [], spaceOf({'t-b': 'project-b'}), 'hub');
  assert.equal(target.terminal, 't-b');
  assert.deepEqual(target.keys, ['a:r1', 'b:r1']);
  assert.equal(autoPopupTarget(cards, target.keys, spaceOf({'t-b': 'project-b'}), 'hub'), null);
});

test('a card in the focused space stays in the list only', () => {
  assert.equal(autoPopupTarget([card('a', 't-hub')], [], spaceOf({'t-hub': 'hub'}), 'hub'), null);
});

test('an unknown space counts as elsewhere, an unassigned card never pops up', () => {
  assert.equal(autoPopupTarget([card('a', 'home/t5')], [], spaceOf({}), 'hub').terminal, 'home/t5');
  assert.equal(autoPopupTarget([card('a', null)], [], spaceOf({}), 'hub'), null);
});

test('a revised card pops up again, a closed one does not', () => {
  const first = card('a', 't-b');
  const opened = [askKey(first)];
  assert.equal(autoPopupTarget([first], opened, spaceOf({'t-b': 'm'}), 's'), null);
  assert.equal(autoPopupTarget([{...first, revision: 'r2'}], opened, spaceOf({'t-b': 'm'}), 's').terminal, 't-b');
});

test('one pane per call, the next one after its cards are recorded', () => {
  const cards = [card('a', 't-1'), card('b', 't-2')];
  const map = spaceOf({'t-1': 'm', 't-2': 'p'});
  const first = autoPopupTarget(cards, [], map, 's');
  assert.equal(first.terminal, 't-1');
  assert.equal(autoPopupTarget(cards, first.keys, map, 's').terminal, 't-2');
});

test('the opened record keeps only live cards', () => {
  assert.deepEqual(prunedOpened(['a:r1', 'gone:r1', 'a:r1'], [card('a', 't')]), ['a:r1']);
  assert.deepEqual(prunedOpened(undefined, []), []);
});

test('a card popup opens centred on the sidebar, or on the window left edge when it is hidden', async () => {
  const {popupSpec, windowPlace, POPUP_MARGIN: M, FALLBACK_WINDOW_HEIGHT} = await import('../mods/sixfold-desk/ask-model.js');
  const big = {w: 2540, h: 1390, windowed: true};
  // Sidebar wider than the popup: centred both ways (popup size scaled by zoom, `at` is not).
  assert.deepEqual(popupSpec({w: 800, h: 1000}, big, 560, 400, 1), {at: {x: 120, y: 300}, width: 560, height: 400});
  assert.deepEqual(popupSpec({w: 800, h: 1000}, big, 560, 400, 0.5).at, {x: 260, y: 400});
  // Narrower than the popup: pinned to the left margin, still centred vertically on the live sidebar height.
  assert.deepEqual(popupSpec({w: 288, h: 1251}, big, 560, 400, 0.9).at, {x: M, y: 446});
  // Started with the sidebar hidden (never measured): window.json gives the height, not the pointer.
  assert.deepEqual(popupSpec(undefined, {w: 1600, h: 1000, windowed: true}, 560, 400, 1, true).at, {x: M, y: 300});
  // Hidden, then the window resized: window.json's new height wins over the old sidebar measurement.
  assert.deepEqual(popupSpec({w: 320, h: 1390}, {w: 1600, h: 900, windowed: true}, 560, 400, 1, true).at, {x: M, y: 250});
  // Hidden while maximized: window.json holds the restore size, so the last live measurement is used.
  assert.deepEqual(popupSpec({w: 320, h: 1390}, {w: 900, h: 600, windowed: false}, 560, 400, 1, true).at, {x: M, y: 495});
  // Nothing known at all: the left edge at the app's first-start height.
  assert.deepEqual(popupSpec(null, null, 560, 400, 1, true).at, {x: M, y: Math.round((FALLBACK_WINDOW_HEIGHT - 400) / 2)});
  for (const box of [null, {}, {w: 0, h: 0}, {w: 'x', h: 900}]) assert.equal(popupSpec(box, null, 560, 400, 1).at.x, M);
  // A narrow, short window: the popup shrinks to fit inside the margins, both ways, zoom included.
  const narrow = popupSpec({w: 300, h: 380}, {w: 420, h: 380, windowed: true}, 560, 640, 0.9);
  assert.deepEqual(narrow, {at: {x: M, y: M}, width: Math.floor((420 - 2 * M) / 0.9), height: Math.floor((380 - 2 * M) / 0.9)});
  assert.ok(narrow.at.x + narrow.width * 0.9 <= 420 - M && narrow.at.y + narrow.height * 0.9 <= 380 - M);
  // A wide sidebar in a window just wider than it: the right edge stays inside the window.
  const wide = popupSpec({w: 600, h: 800}, {w: 620, h: 800, windowed: true}, 560, 400, 1);
  assert.ok(wide.at.x + wide.width <= 620 - M);
  // window.json: only a well-formed size counts.
  assert.deepEqual(windowPlace('{"state":"windowed","bounds":[0,30,2540,1390]}'), {w: 2540, h: 1390, windowed: true});
  assert.deepEqual(windowPlace({state: 'maximized', bounds: [0, 0, 800, 600]}), {w: 800, h: 600, windowed: false});
  for (const bad of ['{', null, '{}', '{"bounds":[0,0,0,10]}']) assert.equal(windowPlace(bad), null);
});
