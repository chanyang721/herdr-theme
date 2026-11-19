import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// The GitHub bundle of the sidebar: the collector's feed (data/sixfold/github-alerts.json) published by
// github-feed.js, the card's GitHub chip and popover tab, new work arriving like Slack and Linear, and the
// GitHub inbox window. Made-up repositories, spaces and people only (public repository).
const desk = new URL('../mods/sixfold-desk/', import.meta.url);
const inboxMod = new URL('../mods/sixfold-github-inbox/', import.meta.url);
const asUrl = s => 'data:text/javascript;base64,' + Buffer.from(s).toString('base64');

const ITEMS = [
  {id: 'review:R1', kind: 'review', repo: 'demo/alpha-api', number: 4, title: 'Add login', url: 'https://github.com/demo/alpha-api/pull/4',
    at: '2026-11-18T01:00:00Z', workspace: 'Alpha', author: 'kim', needs: ['review'], unread: true, event: 'review:R1'},
  {id: 'pr:P1', kind: 'pr', repo: 'demo/alpha-api', number: 9, title: 'Fix cache', url: 'https://github.com/demo/alpha-api/pull/9',
    at: '2026-11-18T02:00:00Z', workspace: 'Alpha', ci: 'failure', review: '', merge: 'conflicting', needs: ['ci', 'conflict'], unread: true, event: 'pr:P1:ci+conflict'},
  {id: 'pr:P2', kind: 'pr', repo: 'demo/tools', number: 2, title: 'Docs', url: 'https://github.com/demo/tools/pull/2',
    at: '2026-11-17T02:00:00Z', workspace: 'Hub', ci: 'success', review: 'approved', merge: 'mergeable', needs: [], unread: false, event: ''},
  {id: 'mention:77', kind: 'mention', repo: 'demo/gone-space', number: 3, title: 'Question', url: 'https://github.com/demo/gone-space/issues/3',
    at: '2026-11-18T03:00:00Z', workspace: 'Closed', reason: 'mention', subject: 'issue', needs: ['mention'], unread: true, event: 'mention:77:t'},
];

test('the GitHub helpers in the sidebar and in the inbox window are the same code', async () => {
  const block = s => s.slice(s.indexOf('// --- shared GitHub alert code'), s.indexOf('// --- end of the shared GitHub alert code'));
  const a = block(await readFile(new URL('alert-model.js', desk), 'utf8')), b = block(await readFile(new URL('model.js', inboxMod), 'utf8'));
  assert.ok(a.length > 200);
  assert.equal(b, a);
});

test('each item says what kind it is and what needs me', async () => {
  const m = await import(new URL('alert-model.js', desk).href);
  assert.deepEqual(ITEMS.map(i => m.githubKind(i).label), ['리뷰 요청', '내 PR', '내 PR', '멘션']);
  assert.deepEqual(ITEMS.map(m.githubLine), ['kim 님이 리뷰 요청', 'CI 실패 · 충돌', 'CI 통과 · 승인됨 · 병합 가능', '나를 멘션 · 이슈']);
  assert.equal(m.githubRef(ITEMS[0]), 'demo/alpha-api#4');
  assert.equal(m.githubLink('https://github.com/demo/alpha-api/pull/4'), true);
  assert.equal(m.githubLink('https://example.com/demo/alpha-api/pull/4'), false);
  assert.equal(m.githubLink('javascript:alert(1)'), false);
  assert.deepEqual(m.githubScoped(ITEMS, 'alpha').map(i => i.id), ['review:R1', 'pr:P1']);
});

// github-feed.js with its native imports replaced by one runtime: the real arrival store, arrival model,
// alert model and shared publisher.
async function feed({host = true, overrides = {}} = {}) {
  const store = await import(new URL('arrival-store.js', desk).href + `?${Math.random()}`);
  const model = await import(new URL('arrival-model.js', desk).href);
  const alerts = await import(new URL('alert-model.js', desk).href);
  const {createSharedPublisher} = await import(new URL('shared-publish.js', desk).href);
  const shared = new Map(), opens = [];
  const runtime = {...store, arrivalTarget: model.arrivalTarget, ARRIVAL: model.ARRIVAL, placeItems: alerts.placeItems,
    githubKind: alerts.githubKind, githubLine: alerts.githubLine, githubRef: alerts.githubRef, createSharedPublisher,
    appHome: () => '/h', readTextFile: async () => null, writeTextFile: async () => {}, setShared: (k, v) => shared.set(k, v),
    openOverlay: o => opens.push(o), spaces: () => [{name: 'Alpha'}, {name: 'Hub'}], createHash() {}, readJsonSnapshot() {},
    subscribeJsonFile() {}, subscribeFileChanges() {}, createRetry() {}, watchRecorder() {}, ...overrides};
  const key = `__githubFeed${Math.random().toString(36).slice(2)}`; globalThis[key] = runtime;
  const src = (await readFile(new URL('github-feed.js', desk), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  const m = await import(asUrl(`const {${Object.keys(runtime).join(',')}}=globalThis[${JSON.stringify(key)}];\n${src}`));
  if (host) store.setArrivalHost(() => true);
  return {m, store, shared, opens};
}

test('the feed is published per key, and a space not on the sidebar counts on the hub', async () => {
  const {m, shared} = await feed();
  const publish = (await import(new URL('shared-publish.js', desk).href)).createSharedPublisher((k, v) => shared.set(k, v));
  const names = ['Alpha', 'Hub'];
  assert.equal(m.publishGithub({items: ITEMS, spaces: ['Alpha', 'Gamma', 'Hub']}, {state: 'ok', count: 4, token: 'never shown'}, names, publish), true);
  assert.deepEqual(shared.get('sixfold.githubSpaces'), ['Alpha', 'Hub'], 'a mapped space that is not shown is the hub');
  assert.equal(shared.get('sixfold.githubItems').find(i => i.id === 'mention:77').workspace, 'Hub');
  assert.deepEqual(shared.get('sixfold.githubHealth'), {state: 'ok', count: 4}, 'only the drawn health fields');
  assert.equal(m.publishGithub({items: ITEMS, spaces: ['Alpha', 'Gamma', 'Hub']}, {state: 'ok', count: 4}, names, publish), false, 'unchanged: nothing rewritten');
});

test('new work becomes an arrival like Slack and Linear; nothing pops up for a pull request with nothing to do', async () => {
  const {m, store, opens} = await feed();
  const checks = []; store.setPeekCheck((space, source) => { checks.push([space, source]); return 'peek'; });
  const events = m.githubPopupEvents(ITEMS);
  assert.deepEqual(events.map(e => e.key), ['github:review:R1', 'github:pr:P1:ci+conflict', 'github:mention:77:t']);
  m.announceGithub(events);
  assert.equal(opens.length, 0, 'no window while a sidebar draws arrivals');
  assert.deepEqual(checks, [['Alpha', 'github'], ['Alpha', 'github'], ['Hub', 'github']]);
  const list = store.arrivals();
  assert.deepEqual(list.map(a => [a.source, a.space, a.issue, a.label]),
    [['github', 'Alpha', 'demo/alpha-api#4', '리뷰 요청'], ['github', 'Alpha', 'demo/alpha-api#9', '내 PR'], ['github', 'Hub', 'demo/gone-space#3', '멘션']]);
  const model = await import(new URL('arrival-model.js', desk).href);
  assert.deepEqual(model.arrivalOpen(list[0]), {source: 'github', project: 'Alpha'});
});

test('with no sidebar drawing arrivals the GitHub window opens instead, so nothing is dropped', async () => {
  const {m, opens} = await feed({host: false});
  m.announceGithub(m.githubPopupEvents(ITEMS.slice(0, 1)));
  assert.equal(opens.length, 1);
  assert.equal(opens[0].mod, 'sixfold-github-inbox');
});

// alert-inbox.js with stubbed native modules (as tests/alert-inbox.test.mjs loads it).
function element() {
  let proxy; const data = {nodes: [], calls: []};
  proxy = new Proxy(data, {get(t, k) {
    if (k === 'then') return undefined; if (k in t) return t[k];
    if (['child', 'trigger', 'content'].includes(k)) return n => { t.calls.push([k, n]); if (n != null) t.nodes.push(n); return proxy; };
    if (k === 'children') return ns => { t.nodes.push(...ns.filter(Boolean)); return proxy; };
    if (k === 'when') return (b, f) => { if (b) f(proxy); return proxy; };
    return (...a) => { t.calls.push([k, ...a]); return proxy; };
  }}); return proxy;
}
async function inbox() {
  const store = new Map([['sixfold.alertProjects', []], ['sixfold.linearSpaces', ['Alpha']], ['sixfold.alertItems', []], ['sixfold.linearItems', []],
    ['sixfold.githubSpaces', ['Alpha', 'Hub']], ['sixfold.githubItems', ITEMS.map(i => i.workspace === 'Closed' ? {...i, workspace: 'Hub'} : i)]]);
  globalThis.__githubInbox = {div: element, image: element, h_flex: element, v_flex: element, Popover: {new: element}, shared: k => store.get(k),
    setShared: (k, v) => store.set(k, v), openOverlay: o => store.set('opened', [...(store.get('opened') ?? []), o]), arrivals: () => [],
    readTextFile: async () => null, appHome: () => '/test'};
  const transform = s => s.replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base|herdr)';/g, 'const {$1}=globalThis.__githubInbox;');
  const slackUrl = JSON.stringify(new URL('alert-slack.js', desk).href), modelUrl = JSON.stringify(new URL('alert-model.js', desk).href);
  const filesUrl = asUrl(transform(await readFile(new URL('alert-files.js', desk), 'utf8')).replace("'./alert-slack.js'", slackUrl));
  const popUrl = asUrl(transform(await readFile(new URL('alert-popover.js', desk), 'utf8')).replace("'./alert-model.js'", modelUrl)
    .replace("'./alert-slack.js'", slackUrl).replace("'./alert-files.js'", JSON.stringify(filesUrl)).replace("'./alert-mentions.js'", JSON.stringify(new URL('alert-mentions.js', desk).href)) + `//${Math.random()}`);
  const src = transform(await readFile(new URL('alert-inbox.js', desk), 'utf8')).replace("'./alert-model.js'", modelUrl)
    .replace("'./alert-popover.js'", JSON.stringify(popUrl)).replace("'./alert-mentions.js'", JSON.stringify(new URL('alert-mentions.js', desk).href))
    .replace("import { arrivals } from './arrival-store.js';", 'const {arrivals}=globalThis.__githubInbox;')
    .replace("'./arrival-model.js'", JSON.stringify(new URL('arrival-model.js', desk).href));
  const popover = await import(popUrl); popover.setSpaceMentions([]);
  return {store, ...await import(asUrl(src) + `#${Math.random()}`), popover};
}

test('a space with GitHub work gets the chip in its alerts row, counted by what needs me', async () => {
  const {hasGithubAlerts, hasWorkspaceAlerts, githubBadge, alertsOnMetaLine, alertSignature, store} = await inbox();
  assert.equal(hasGithubAlerts('Alpha'), true);
  assert.equal(hasGithubAlerts('Beta'), false);
  assert.equal(hasWorkspaceAlerts('Hub'), true, 'Hub has only GitHub here and still gets its alerts row');
  assert.equal(alertsOnMetaLine({work: {tool: 'linear'}, slack: {channel: 'c'}}, 'Alpha'), false, 'the meta line has no room for a third chip: the alerts row draws all three');
  const badge = githubBadge('x', new Proxy({}, {get: (_t, k) => `#${String(k)}`}), {project: 'Alpha', popover: true});
  assert.ok(badge.nodes.some(n => n.calls?.some(c => c[0] === 'child' && c[1] === '2')), 'Alpha: a review request and a failing pull request');
  const before = alertSignature('Hub');
  store.set('sixfold.githubItems', store.get('sixfold.githubItems').map(i => i.id === 'pr:P2' ? {...i, needs: ['ci'], unread: true} : i));
  assert.notEqual(alertSignature('Hub'), before, 'the card redraws when GitHub work appears');
});

test('the card popover has a GitHub tab whose rows open github.com, and 전체 보기 opens the GitHub inbox', async () => {
  const {workspaceAlertsRow, popover, store} = await inbox();
  const t = new Proxy({}, {get: (_t, k) => `#${String(k)}`});
  popover.showPopover('Alpha', 'github');
  const row = workspaceAlertsRow({id: 'a', name: 'Alpha'}, t);
  const texts = node => typeof node === 'string' ? [node] : (node?.nodes ?? []).flatMap(texts).concat((node?.calls ?? []).filter(c => c[0] === 'content' || c[0] === 'trigger').flatMap(c => texts(c[1])));
  const all = texts(row);
  assert.ok(all.includes('GitHub'), 'the GitHub tab');
  assert.ok(all.includes('demo/alpha-api#9') && all.includes('CI 실패 · 충돌'));
  assert.ok(all.includes('GitHub 상태 기준 · 읽기 전용'));
  const findAll = (node, id) => (node?.calls ?? []).some(c => c[0] === 'id' && c[1] === id) ? [node]
    : [...(node?.nodes ?? []), ...(node?.calls ?? []).filter(c => c[0] === 'content' || c[0] === 'trigger').map(c => c[1])].flatMap(n => findAll(n, id));
  const opened = [];
  const rowEl = findAll(row, 'sf-alert-pop-github-0')[0];
  rowEl.calls.find(c => c[0] === 'on_click')[1](null, {stop_propagation() {}, open_url: url => opened.push(url), notify() {}});
  assert.match(opened[0], /^https:\/\/github\.com\/demo\/alpha-api\/pull\/\d+$/);
  const all2 = findAll(row, 'sf-alert-pop-all-a')[0];
  all2.calls.find(c => c[0] === 'on_click')[1](null, {stop_propagation() {}, notify() {}});
  assert.equal(store.get('opened').at(-1).mod, 'sixfold-github-inbox');
  assert.deepEqual(store.get('opened').at(-1).props, {project: 'Alpha'});
});

test('the GitHub inbox groups work by kind and says how the collector is doing', async () => {
  const m = await import(new URL('model.js', inboxMod).href);
  const groups = m.sections(ITEMS, {workOnly: true});
  assert.deepEqual(groups.map(g => [g.kind, g.items.map(i => i.id)]), [['review', ['review:R1']], ['mention', ['mention:77']], ['pr', ['pr:P1']]]);
  assert.deepEqual(m.sections(ITEMS, {space: 'Hub'}).map(g => g.items.length), [0, 0, 1]);
  assert.equal(m.workCount(ITEMS, 'Alpha'), 2);
  assert.deepEqual(m.spacesOf(['Alpha', 'Hub'], ITEMS), ['Alpha', 'Hub', 'Closed']);
  assert.equal(m.collectLine({}), 'GitHub 수집 기록 없음 · 아직 받은 GitHub 데이터가 없습니다');
  assert.equal(m.collectLine({state: 'partial', last_success: '2026-11-19T17:53:25+09:00', errors: {mentions: 'auth'}}), '마지막 수집 11-19 17:53 · 멘션 gh 로그인 필요');
  assert.match(m.collectLine({state: 'error', error_kind: 'network', last_success: '2026-11-19T17:53:25+09:00'}), /^GitHub 조회 실패 \(연결 실패\)/);
});

test('the GitHub inbox window reads only shared values: no file reads, no timer', async () => {
  const src = await readFile(new URL('main.js', inboxMod), 'utf8');
  assert.doesNotMatch(src, /timer\.|readTextFile|writeTextFile|exec\(/);
  assert.match(src, /shared\('sixfold\.githubItems'\)/);
});

// 2026-11-19 (실화면): the sidebar loaded before the collector's first run. The missing feed wrote an empty
// popup ledger, so the first real feed was taken as all new and three old pull requests popped up.
test('the first real feed is recorded silently even when the sidebar started before the collector', async () => {
  const {createHash} = await import('node:crypto');
  const files = new Map(), subs = new Map();
  const {m, store} = await feed({overrides: {
    readTextFile: async path => files.has(path) ? files.get(path) : Promise.reject(new Error('missing')),
    writeTextFile: async (path, text) => { files.set(path, text); },
    readJsonSnapshot: async path => files.has(path) ? {status: 'ready', value: JSON.parse(files.get(path)), hash: createHash('sha256').update(files.get(path)).digest('hex')} : {status: 'missing'},
    createHash, subscribeJsonFile: (_cx, path, cb) => { subs.set(path, cb); return () => {}; }, subscribeFileChanges: () => () => {},
    createRetry: () => ({note() {}, ok() {}, fail(e) { throw e; }, dispose() {}}), watchRecorder: () => () => {},
  }});
  const tasks = [];
  // A timer runs on the next drain, as a real one runs after the current call returns.
  const cx = {timer: {after: (_ms, fn) => { tasks.push(Promise.resolve().then(fn)); return {cancel() {}}; }}, spawn: fn => tasks.push(fn(cx)), notify() {}};
  const view = {sidebarVisible: true};
  m.watchGithub(view, cx);
  const drain = async () => { while (tasks.length) await tasks.shift(); };
  subs.get('/h/data/sixfold/github-live-health.json')({status: 'missing'});
  subs.get('/h/data/sixfold/github-alerts.json')({status: 'missing'});
  await drain();
  assert.equal(files.has('/h/data/sixfold/github-popup-events.json'), false, 'no ledger before there is a feed');
  subs.get('/h/data/sixfold/github-alerts.json')({status: 'ready', value: {items: ITEMS}, hash: 'h1'});
  await drain();
  assert.equal(store.arrivals().length, 0, 'the first feed pops nothing up');
  assert.equal(JSON.parse(files.get('/h/data/sixfold/github-popup-events.json')).seen.length, 3, 'but records it');
  subs.get('/h/data/sixfold/github-alerts.json')({status: 'ready', value: {items: [...ITEMS, {...ITEMS[0], id: 'review:R2', event: 'review:R2'}]}, hash: 'h2'});
  await drain();
  assert.deepEqual(store.arrivals().map(a => a.id), ['review:R2'], 'later work still arrives');
});
