import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {categoryLabel, linearLink, visibleItems, spacesOf, issueLine, buildRequest, requestId, resultLabel} from '../mods/sixfold-linear-inbox/model.js';
import {linearUnread, linearScoped} from '../mods/sixfold-desk/alert-model.js';

const N = '11111111-1111-4111-8111-111111111111';
const items = [
  {id: N, workspace: 'Alpha', read: false, category: 'assignments', issue: 'ABC-1', status: 'Todo', assignee: 'Me', priority: 'High', url: 'https://linear.app/demo/issue/ABC-1/x'},
  {id: 'n2', workspace: 'Beta', read: true, category: 'reminders', issue: 'ABC-2'},
  {id: 'n3', workspace: 'alpha', read: false, category: 'mentions', issue: ''},
];

test('linear items are scoped to their space and counted unread', () => {
  assert.equal(linearUnread(items, 'Alpha'), 2);
  assert.equal(linearUnread(items, 'Beta'), 0);
  assert.equal(linearScoped(items, null).length, 3);
  assert.deepEqual(visibleItems(items, {space: 'ALPHA', unreadOnly: true}).map(i => i.id), [N, 'n3']);
  assert.deepEqual(spacesOf(items), ['Alpha', 'Beta', 'alpha']);
  assert.equal(categoryLabel(items[0]), '배정');
  assert.equal(categoryLabel({category: 'unknown'}), '알림');
  assert.equal(issueLine(items[0]), 'Todo · 담당 Me · 우선순위 High');
});

test('changed fields read before → after; the card popover expires and ranks unread first', async () => {
  const {changeLines: deskLines, popoverOpen, popoverRows, POPOVER_TTL} = await import('../mods/sixfold-desk/alert-model.js');
  const {changeLines} = await import('../mods/sixfold-linear-inbox/model.js');
  const item = {changes: [{field: 'status', from: 'Todo', to: 'Done'}, {field: 'assignee', from: '', to: 'Kim'}, {field: 'secret', from: 'a', to: 'b'}]};
  assert.deepEqual(changeLines(item), ['상태 Todo → Done', '담당 없음 → Kim']);
  assert.deepEqual(deskLines(item), changeLines(item));   // the two copies stay identical
  assert.deepEqual(changeLines({}), []);
  const now = 1_000_000_000, state = {space: 'Alpha', source: 'linear', boot: 'run-1', at: now};
  assert.ok(popoverOpen(state, 'alpha', 'linear', 'run-1', now + 1000));
  assert.ok(!popoverOpen(state, 'Alpha', 'linear', 'run-2', now + 1000));   // restored after a restart
  assert.ok(!popoverOpen({...state, boot: undefined}, 'Alpha', 'linear', 'run-1', now));
  assert.ok(!popoverOpen(state, 'Alpha', 'slack', 'run-1', now));
  assert.ok(!popoverOpen(state, 'Alpha', 'linear', 'run-1', now + POPOVER_TTL));
  assert.ok(!popoverOpen({}, 'Alpha', 'linear', 'run-1', now));
  const rows = popoverRows([{id: 1, read: true, at: '3'}, {id: 2, read: false, at: '1'}, {id: 3, read: false, at: '2'}], 2);
  assert.deepEqual(rows.map(r => r.id), [3, 2]);
});

test('only linear.app links open', () => {
  assert.ok(linearLink(items[0].url));
  for (const url of ['https://evil.example/issue/x', 'javascript:alert(1)', 'https://linear.app.evil.com/x/issue/y', undefined]) assert.equal(linearLink(url), false);
});

test('requests match the collector contract and refuse bad input', () => {
  const now = new Date('2026-11-10T00:00:00Z');
  assert.deepEqual(buildRequest('mark_read', items[0], {}, {now, id: 'req-00000001'}),
    {v: 1, id: 'req-00000001', action: 'mark_read', requested_at: '2026-11-10T00:00:00.000Z', notification: N, read: true});
  assert.equal(buildRequest('set_state', items[0], {state: 'Done'}, {now, id: 'r'}).state, 'Done');
  assert.equal(buildRequest('comment', items[0], {body: '확인'}, {now, id: 'r'}).body, '확인');
  assert.throws(() => buildRequest('comment', items[0], {body: '  '}));
  assert.throws(() => buildRequest('set_state', items[0], {state: 'a\nb'}));
  assert.throws(() => buildRequest('set_state', items[2], {state: 'Done'}));   // no issue
  assert.throws(() => buildRequest('delete', items[0]));
  assert.match(requestId(1, () => 0.5), /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(resultLabel(null), '처리 대기 중…');
  assert.equal(resultLabel({ok: false, error: 'x'}), '실패: x');
});

test('new Linear alerts become arrivals into their space (Share otherwise); no sidebar host opens the window; history seeds silently', async () => {
  const files = new Map([['linear-alerts.json', JSON.stringify({items: [{id: 'old', read: false, category: 'assignments'}], spaces: ['Alpha']})]]);
  const shared = {}, opens = [], tasks = [];
  let refresh;
  const cx = {notify() {}, spawn(fn) { const task = fn(cx); tasks.push(task); return task; }, timer: {every(_ms, fn) { refresh = fn; }}};
  globalThis.__linearRuntime = {
    appHome: () => '/test',
    readTextFile: async path => { const name = path.split('/').at(-1); if (!files.has(name)) throw new Error('missing'); return files.get(name); },
    writeTextFile: async (path, value, expected) => {
      const name = path.split('/').at(-1);
      if ((files.get(name) ?? null) !== expected) throw new Error('compare-and-swap conflict');
      files.set(name, value);
    },
    setShared: (key, value) => { shared[key] = value; },
    openOverlay: value => opens.push(value),
    spaces: () => [{id: 's1', name: 'Alpha'}, {id: 's0', name: 'Share'}],
    run() {},
  };
  const storeUrl = new URL('../mods/sixfold-desk/arrival-store.js', import.meta.url).href;
  const modelUrl = new URL('../mods/sixfold-desk/arrival-model.js', import.meta.url).href;
  let source = await readFile(new URL('../mods/sixfold-desk/linear-feed.js', import.meta.url), 'utf8');
  source = source.replace(/\r\n/g, '\n')
    .replace(/^import .* from 'herdr';/m, 'const {appHome, readTextFile, writeTextFile, setShared, openOverlay, spaces} = globalThis.__linearRuntime;')
    .replace("'./arrival-store.js'", `'${storeUrl}'`).replace("'./arrival-model.js'", `'${modelUrl}'`);
  const store = await import(storeUrl);
  try {
    const {watchLinear} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#linear');
    watchLinear({}, cx);
    await tasks.at(-1);
    assert.equal(opens.length, 0);
    assert.deepEqual(shared['sixfold.linearSpaces'], ['Alpha']);
    const feed = items => files.set('linear-alerts.json', JSON.stringify({items, spaces: ['Alpha']}));
    feed([{id: 'old', read: false, category: 'assignments'}, {id: 'seen', read: true, category: 'assignments'}, {id: 'remind', read: false, category: 'reminders'}]);
    refresh(cx); await tasks.at(-1);
    assert.equal(opens.length, 0);                       // read or reminder only: nothing
    // No sidebar drew arrivals yet (the installed sidebar has none): the window opens instead.
    feed([{id: 'new', read: false, category: 'mentions', workspace: 'alpha'}, {id: 'old', read: false, category: 'assignments'}]);
    refresh(cx); await tasks.at(-1);
    assert.equal(opens.length, 1);
    assert.equal(opens[0].mod, 'sixfold-linear-inbox');
    // A sidebar host: each new alert arrives into its space, an unknown space into Share.
    store.markArrivalHost();
    feed([{id: 'a', read: false, category: 'mentions', workspace: 'Alpha', issue: 'ABC-1', issue_title: 'T'},
          {id: 'b', read: false, category: 'assignments', workspace: 'Nowhere'}, {id: 'new', read: false, category: 'mentions'}, {id: 'old', read: false, category: 'assignments'}]);
    refresh(cx); await tasks.at(-1);
    assert.equal(opens.length, 1);
    const landed = store.arrivals().filter(a => a.key === 'linear:a' || a.key === 'linear:b').map(a => [a.key, a.space, a.source, a.issue]);
    assert.deepEqual(landed, [['linear:a', 'Alpha', 'linear', 'ABC-1'], ['linear:b', 'Share', 'linear', '']]);
    const count = store.arrivals().length;
    feed([{id: 'a', read: false, category: 'mentions', workspace: 'Alpha'}, {id: 'b', read: false, category: 'assignments'}, {id: 'new', read: false, category: 'mentions'}, {id: 'old', read: true, category: 'assignments'}]);
    refresh(cx); await tasks.at(-1);
    assert.equal(store.arrivals().length, count);        // the same notification never arrives twice
    assert.equal(shared['sixfold.linearItems'].length, 4);
  } finally { delete globalThis.__linearRuntime; }
});

test('an arrival shows, flies in integer steps and lands; motion off only counts it', async () => {
  const {ARRIVAL, arrivalPhase, pushArrival, visibleArrivals, inFlight, nextPhaseAt, flightPath, arrivalTarget, arrivalOpen} = await import('../mods/sixfold-desk/arrival-model.js');
  const t0 = 1_000_000;
  let list = pushArrival([], {key: 'k1', source: 'slack', space: 'Alpha'}, t0);
  assert.equal(arrivalPhase(list[0], t0 + 10), 'show');
  assert.equal(arrivalPhase(list[0], t0 + ARRIVAL.showMs + 1), 'fly');
  assert.equal(arrivalPhase(list[0], t0 + ARRIVAL.showMs + ARRIVAL.flyMs), 'landed');
  assert.equal(arrivalPhase(list[0], t0 + 10, false), 'landed');          // motion off: no popup, no move
  assert.equal(inFlight(list, 'alpha', 'slack', t0 + 10), 1);            // not in the badge until it lands
  assert.equal(inFlight(list, 'Alpha', 'slack', t0 + 10, false), 0);
  assert.equal(visibleArrivals(list, t0 + 10, false).length, 0);
  assert.equal(nextPhaseAt(list, t0 + 10), t0 + ARRIVAL.showMs);
  assert.equal(nextPhaseAt(list, t0 + 10, false), null);
  list = pushArrival(list, {key: 'k1', source: 'slack', space: 'Alpha'}, t0 + 5);
  assert.equal(list.length, 1);                                           // one per key
  for (let i = 0; i < 80; i++) list = pushArrival(list, {key: `n${i}`, source: 'linear', space: 'Alpha'}, t0 + i);
  assert.equal(list.length, ARRIVAL.ledger);                              // bounded
  assert.equal(visibleArrivals(list, t0 + 100).length, ARRIVAL.visible);
  const late = pushArrival(list, {key: 'late', source: 'linear', space: 'Alpha'}, t0 + 10 * ARRIVAL.keepMs);
  assert.deepEqual(late.map(a => a.key), ['late']);                       // landed ones age out
  const path = flightPath({x: 101, y: 403}, {x: 13, y: 57});
  assert.ok(path.every(p => Number.isInteger(p.x) && Number.isInteger(p.y) && p.x % 2 === 0 && p.y % 2 === 0));
  assert.deepEqual(path.at(-1), {x: 14, y: 58});                         // ends on the target, snapped
  assert.ok(path.length <= ARRIVAL.steps && path.length >= 3);
  assert.equal(arrivalTarget('medi', ['Alpha', 'Share']), 'Share');
  assert.equal(arrivalTarget('ALPHA', ['Alpha', 'Share']), 'Alpha');
  assert.equal(arrivalTarget('x', []), 'Share');
  assert.deepEqual(arrivalOpen({source: 'linear', space: 'Alpha'}), {source: 'linear', project: 'Alpha'});
});
