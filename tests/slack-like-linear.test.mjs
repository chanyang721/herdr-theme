import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// 2026-11-17: a new Slack alert showed two different Slack popups — the arrival peek drew its own
// '공간 · Slack 알림' surface, and the card's Slack chip opened another one (the alert popover).
// A new Slack alert now takes the Linear way: one arrival path, one surface (the card's own popover),
// and no extra window while a sidebar draws arrivals. Made-up spaces and people only (public repository).
const base = new URL('../mods/sixfold-desk/', import.meta.url);
const asUrl = s => 'data:text/javascript;base64,' + Buffer.from(s).toString('base64');

function element() {
  let proxy; const data = {nodes: [], calls: [], handlers: {}};
  proxy = new Proxy(data, {get(t, k) {
    if (k === 'then') return undefined; if (k in t) return t[k];
    if (['child', 'trigger', 'content'].includes(k)) return n => { t.calls.push([k, n]); if (n != null) t.nodes.push(n); return proxy; };
    if (k === 'children') return ns => { t.nodes.push(...ns.filter(Boolean)); return proxy; };
    if (k === 'when') return (b, f) => { if (b) f(proxy); return proxy; };
    if (['on_click', 'on_open_change'].includes(k)) return fn => { t.handlers[k] = fn; return proxy; };
    if (k === 'id') return id => { t.elementId = id; return proxy; };
    return (...a) => { t.calls.push([k, ...a]); return proxy; };
  }}); return proxy;
}
const texts = node => typeof node === 'string' ? [node] : (node?.nodes ?? []).flatMap(texts);
const byId = (node, id) => typeof node === 'object' && node?.elementId === id ? node : (node?.nodes ?? []).map(n => byId(n, id)).find(Boolean) ?? null;
const ids = node => [node?.elementId, ...(node?.nodes ?? []).flatMap(ids)].filter(id => typeof id === 'string');
const theme = new Proxy({}, {get: (_t, k) => `#${String(k)}`});
const cx = {stop_propagation() {}, notify() {}};

// alerts.js and linear-feed.js with their imports replaced by one runtime: the real arrival store and
// model, so both announcements go through the very same arrival path.
async function announcers() {
  const store = await import(new URL('arrival-store.js', base).href + `?${Math.random()}`);
  const model = await import(new URL('arrival-model.js', base).href);
  const opens = [], noted = [];
  const runtime = {...store, arrivalTarget: model.arrivalTarget, ARRIVAL: model.ARRIVAL,
    openOverlay: o => opens.push(o), spaces: () => [{name: 'Alpha'}, {name: 'Hub'}], noteArrived: (space, item) => noted.push([space, item?.id]),
    run() {}, div: element, h_flex: element, v_flex: element, readTextFile: async () => null, writeTextFile: async () => {}, appHome: () => '/h',
    setShared() {}, createHash() {}, readJsonSnapshot() {}, subscribeJsonFile() {}, subscribeFileChanges() {}, createRetry() {}, watchRecorder() {},
    setSpaceMentions() {}, setSpaceNeeds() {}, setNeedsDismisser() {}, restoreSpaceNeed() {}, createSharedPublisher() {}, slackHealthView() {}, linearHealthView() {}, placeItems: x => x, alertKind: () => ({}), alertLine: () => '',
    withLocalReads: x => x, onReadConfirmed() {}};
  const key = `__slackLikeLinear${Math.random().toString(36).slice(2)}`; globalThis[key] = runtime;
  const load = async name => {
    const src = (await readFile(new URL(name, base), 'utf8')).replace(/^import .*;\r?\n/gm, '');
    return import(asUrl(`const {${Object.keys(runtime).join(',')}}=globalThis[${JSON.stringify(key)}];\n${src}`));
  };
  const [slack, linear] = [await load('alerts.js'), await load('linear-feed.js')];
  return {store, opens, noted, announceSlack: slack.announceSlack, announceLinear: linear.announceLinear};
}

test('a new Slack alert takes the same arrival path as a new Linear alert, with no extra window', async () => {
  const a = await announcers();
  const host = () => true; a.store.setArrivalHost(host);
  const checks = []; a.store.setPeekCheck((space, source) => { checks.push([space, source]); return 'peek'; });
  a.announceSlack([{key: 'mention:s1', id: 's1', project: 'Alpha', title: '김가나', line: '확인 부탁드려요', author: '김가나', url: '', item: {id: 's1', project: 'Alpha', text: '확인 부탁드려요'}}]);
  a.announceLinear([{key: 'linear:l1', id: 'l1', workspace: 'Alpha', title: '이슈', issue: 'AL-1', category: 'commentsAndReplies', line: '댓글', label: '댓글', kind: 'comment', url: ''}]);
  assert.equal(a.opens.length, 0, 'no window and no second popup while a sidebar draws arrivals');
  assert.deepEqual(checks, [['Alpha', 'slack'], ['Alpha', 'linear']], 'both ask the sidebar the same question');
  const list = a.store.arrivals();
  assert.deepEqual(list.map(x => [x.source, x.space, x.peek]), [['slack', 'Alpha', true], ['linear', 'Alpha', true]], 'both become a peek of their card');
  assert.deepEqual(a.noted, [['Alpha', 's1']], 'the card remembers the mention, so its chip popover lists it');

  // Unmapped mentions land in Hub, as unmapped Linear alerts do.
  a.announceSlack([{key: 'mention:s2', id: 's2', project: '미연결', title: '', line: 'DM', item: {id: 's2', project: '미연결'}}]);
  assert.equal(a.store.arrivals().at(-1).space, 'Hub');
  a.store.clearArrivalHost(host);
});

test('without a sidebar each source opens its own window once, with the same props', async () => {
  const a = await announcers();
  a.announceSlack([{key: 'mention:s1', id: 's1', project: 'Alpha', line: 'a', item: {id: 's1'}}, {key: 'mention:s2', id: 's2', project: 'Alpha', line: 'b', item: {id: 's2'}}]);
  a.announceLinear([{key: 'linear:l1', id: 'l1', workspace: 'Alpha'}]);
  assert.equal(a.store.arrivals().length, 0, 'no arrivals without a host');
  assert.deepEqual(a.opens.map(o => [o.mod, o.kind, o.keep, o.props]),
    [['sixfold-slack-inbox', 'window', true, {window: true}], ['sixfold-linear-inbox', 'window', true, {window: true}]]);
  assert.deepEqual(a.noted, [], 'nothing is remembered for a card that is not drawn');
});

async function popover() {
  const store = new Map();
  globalThis.__slackLikeLinearPop = {div: element, image: element, h_flex: element, v_flex: element, Popover: {new: element},
    shared: k => store.get(k), setShared: (k, v) => store.set(k, v), appHome: () => '/h', readTextFile: async () => null, writeTextFile: async () => {}};
  const transform = s => s.replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base|herdr)';/g, 'const {$1}=globalThis.__slackLikeLinearPop;')
    .replace("'./alert-model.js'", JSON.stringify(new URL('alert-model.js', base).href)).replace("'./alert-slack.js'", JSON.stringify(new URL('alert-slack.js', base).href));
  const mentionsUrl = asUrl((await readFile(new URL('alert-mentions.js', base), 'utf8'))
    .replace("'./alert-model.js'", JSON.stringify(new URL('alert-model.js', base).href)).replace("'./arrival-model.js'", JSON.stringify(new URL('arrival-model.js', base).href)) + `//${Math.random()}`);
  const filesUrl = asUrl(transform(await readFile(new URL('alert-files.js', base), 'utf8')) + `//${Math.random()}`);
  const src = transform(await readFile(new URL('alert-popover.js', base), 'utf8')).replace("'./alert-files.js'", JSON.stringify(filesUrl))
    .replace("'./alert-mentions.js'", JSON.stringify(mentionsUrl));
  const pop = await import(asUrl(src + `//${Math.random()}`));
  return {store, ...pop, mentions: await import(mentionsUrl)};
}

test('the Slack peek is the card popover surface, not a separate Slack-only popup', async () => {
  const pop = await popover();
  const reply = {id: 'slack:C0TEST04:300.1', project: 'Hub', kind: 'thread', author: 'U0BBB0002', author_name: '이다라', at: '2026-11-17T01:00:00Z', text: '스레드 답글입니다'};
  pop.store.set('sixfold.alertItems', []);
  pop.mentions.noteArrived('Hub', reply);   // as announceSlack does
  const opened = [];
  const peek = pop.slackPeek('Hub', theme, [reply.id], () => opened.push('all'), [reply], {onOpen: source => opened.push(source)});
  pop.showPopover('Hub', 'slack');
  const card = pop.alertPopover({id: 'c1', project: 'Hub', trigger: element(), t: theme, hasSlack: true, hasLinear: false, onAll() {}});
  const cardBody = card.calls.find(([k]) => k === 'content')[1];
  const peekTexts = texts(peek), cardTexts = texts(cardBody);
  assert.ok(peekTexts.includes('Hub 알림') && cardTexts.includes('Hub 알림'), 'the same title');
  assert.ok(!peekTexts.some(s => /Slack 알림$/.test(s)), 'no Slack-only title');
  for (const shared of ['Slack', '전체 보기', 'Slack 앱 읽음 상태와 별도', '스레드 답글입니다']) assert.ok(peekTexts.includes(shared), `peek: ${shared} | ${peekTexts.join(' | ')}`);
  assert.ok(peekTexts.includes('새 알림') && !peekTexts.includes('✕'), 'a peek is marked new and has no close button');
  // The same element ids (tabs, list, 전체 보기), keyed per surface.
  const shape = node => ids(node).map(id => id.replace(/-(peek-[^-]+|c1)(?=-|$)/, '-X')).filter(id => !/-head-|-close-/.test(id));
  assert.deepEqual(shape(peek), shape(cardBody));

  // The peek's title and its tab open the card's popover itself, like the Linear peek opens the issue search.
  byId(peek, 'sf-alert-pop-head-peek-hub').handlers.on_click(null, cx);
  byId(peek, 'sf-alert-pop-tab-peek-hub-slack').handlers.on_click(null, cx);
  byId(peek, 'sf-alert-pop-all-peek-hub').handlers.on_click(null, cx);
  assert.deepEqual(opened, ['slack', 'slack', 'all']);
});

test('pressing the chip after a peek shows the arrived mention first in its popover', async () => {
  const pop = await popover();
  const newer = Array.from({length: 5}, (_, i) => ({id: `slack:C0TEST01:${400 + i}.1`, project: 'Alpha', author: 'U0AAA0001', at: `2026-11-17T02:0${i}:00Z`, text: `새 글 ${i}`}));
  const arrived = {id: 'slack:D0TEST01:100.9', project: '미연결', kind: 'dm', author: 'U0AAA0001', at: '2026-11-15T00:00:00Z', text: '방금 온 멘션'};
  pop.store.set('sixfold.alertItems', newer);
  pop.mentions.noteArrived('Alpha', arrived);
  pop.showPopover('Alpha', 'slack');
  const card = () => texts(pop.alertPopover({id: 'c2', project: 'Alpha', trigger: element(), t: theme, hasSlack: true, hasLinear: false, onAll() {}}));
  const first = card();
  assert.ok(first.includes('방금 온 멘션'), first.join(' | '));
  assert.equal(first.filter(s => /^새 글 /.test(s)).length, 4, 'five rows in all, the arrived one first');
  // Read: it no longer jumps the queue.
  pop.store.set('sixfold.alertRead', {[arrived.id]: arrived.id});
  assert.ok(!card().includes('방금 온 멘션'));
});

test('a peek yields to an open popover instead of falling back to a second, smaller popup', async () => {
  const src = (await readFile(new URL('arrival-view.js', base), 'utf8'))
    .replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base)';/g, 'const {$1}=globalThis.__slackLikeLinearView;')
    .replace("'./pixel.js'", JSON.stringify(asUrl((await readFile(new URL('pixel.js', base), 'utf8')).replace(/import \{([^}]+)\} from 'gpui-kit';/, 'const {$1}=globalThis.__slackLikeLinearView;'))))
    .replace("'./arrival-model.js'", JSON.stringify(new URL('arrival-model.js', base).href)).replace("'./alert-model.js'", JSON.stringify(new URL('alert-model.js', base).href));
  globalThis.__slackLikeLinearView = {div: element, image: element, h_flex: element, v_flex: element};
  const {arrivalLayer} = await import(asUrl(src));
  const now = Date.now(), list = [{key: 'mention:s1', id: 's1', source: 'slack', space: 'Alpha', peek: true, at: now - 10, line: '안녕'}];
  const anchors = () => ({top: 0, left: 11, right: 11, badgeX: 26, badgeY: 40, edge: 200});
  const popups = layer => layer.filter(node => typeof node.elementId === 'string' && /^sf-arrival-mention/.test(node.elementId));
  assert.equal(popups(arrivalLayer({list, now, motion: true, anchors, t: theme, onOpen() {}, peek: () => false})).length, 0, 'the open popover already shows it');
  assert.equal(popups(arrivalLayer({list, now, motion: true, anchors, t: theme, onOpen() {}, peek: () => null})).length, 1, 'no surface at all: the small popup, never silent');
  const surface = element();
  const drawn = arrivalLayer({list, now, motion: true, anchors, t: theme, onOpen() {}, peek: () => surface});
  assert.ok(drawn.includes(surface) && popups(drawn).length === 0, 'one surface only');
});
