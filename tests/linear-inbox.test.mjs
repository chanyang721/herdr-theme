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
  const now = 1_000_000_000;
  assert.ok(popoverOpen({space: 'Alpha', source: 'linear', at: now}, 'alpha', 'linear', now + 1000));
  assert.ok(!popoverOpen({space: 'Alpha', source: 'linear', at: now}, 'Alpha', 'slack', now));
  assert.ok(!popoverOpen({space: 'Alpha', source: 'linear', at: now}, 'Alpha', 'linear', now + POPOVER_TTL));
  assert.ok(!popoverOpen({}, 'Alpha', 'linear', now));
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

test('a new unread Linear assignment opens the Linear window once; history seeds silently', async () => {
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
    spaces: () => [{id: 's1', name: 'Alpha'}],
    run() {},
  };
  let source = await readFile(new URL('../mods/sixfold-desk/linear-feed.js', import.meta.url), 'utf8');
  source = source.replace(/\r\n/g, '\n')
    .replace(/^import .* from 'herdr';/m, 'const {appHome, readTextFile, writeTextFile, setShared, openOverlay, spaces} = globalThis.__linearRuntime;')
    .replace(/^import \{ showPopover \} from .*$/m, 'const showPopover = (space, source, o) => globalThis.__linearRuntime.setShared("sixfold.alertPopover", {space, source, ...o});')
    .replace(/^import \{ projectKey \} from .*$/m, 'const projectKey = n => String(n ?? "").toLowerCase();');
  try {
    const {watchLinear} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#linear');
    watchLinear({}, cx);
    await tasks.at(-1);
    assert.equal(opens.length, 0);
    assert.deepEqual(shared['sixfold.linearSpaces'], ['Alpha']);
    const feed = items => files.set('linear-alerts.json', JSON.stringify({items, spaces: ['Alpha']}));
    feed([{id: 'old', read: false, category: 'assignments'}, {id: 'seen', read: true, category: 'assignments'}, {id: 'remind', read: false, category: 'reminders'}]);
    refresh(cx); await tasks.at(-1);
    assert.equal(opens.length, 0);                       // read or reminder only: no window
    feed([{id: 'new', read: false, category: 'mentions', workspace: 'alpha'}, {id: 'old', read: false, category: 'assignments'}]);
    refresh(cx); await tasks.at(-1);
    assert.equal(opens.length, 0);                       // its space card is on screen: popover beside it
    assert.deepEqual([shared['sixfold.alertPopover'].space, shared['sixfold.alertPopover'].source], ['Alpha', 'linear']);
    feed([{id: 'other', read: false, category: 'mentions', workspace: 'Nowhere'}, {id: 'new', read: false, category: 'mentions'}, {id: 'old', read: false, category: 'assignments'}]);
    refresh(cx); await tasks.at(-1);
    assert.equal(opens.length, 1);                       // no such card: the Linear window
    assert.equal(opens[0].mod, 'sixfold-linear-inbox');
    feed([{id: 'other', read: false, category: 'mentions'}, {id: 'new', read: false, category: 'mentions'}, {id: 'old', read: true, category: 'assignments'}]);
    refresh(cx); await tasks.at(-1);
    assert.equal(opens.length, 1);                       // the same notification never reopens it
    assert.equal(shared['sixfold.linearItems'].length, 3);
  } finally { delete globalThis.__linearRuntime; }
});
