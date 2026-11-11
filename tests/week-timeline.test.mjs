import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFeed, rootOf, weekMarker, weekRows, windowOf, dayCells, kindOf, projectRange, projectRows, freshness, bridgeFrom, mix, monday, addDays } from '../mods/week-timeline/model.js';

const TODAY = '2026-11-11';
const issue = (key, state, extra = {}) => ({ key, title: `${key} 제목`, status: state, state, due: '', start: '', done_at: '', parent: '', milestone: '', ...extra });
const raw = {
  v: 2, updated: '2026-11-11T09:30:00+09:00', attempted: '2026-11-11T09:30:00+09:00', error: '', week: { start: '2026-11-09', end: '2026-11-15' },
  projects: [{ key: 'ALP', name: 'ALPHA', workspace: 'alpha', milestones: [
    { id: 'm1', name: '① 로그인', target: '2026-10-22', progress: 100 },
    { id: 'm3', name: '③ 공통 구현', target: '2026-11-13', progress: 16.2 },
    { id: 'm4', name: '④ 인프라', target: '2026-11-25', progress: 5 },
    { id: 'm9', name: '⑨ 본런칭', target: '2027-02-18', progress: 0 }], issues: [
    issue('DEMO-373', 'started', { start: '2026-11-09' }),                                   // top issue (group only)
    issue('DEMO-400', 'todo', { due: '2026-11-12', parent: 'DEMO-373', milestone: 'm3' }),
    issue('DEMO-480', 'todo', { due: '2026-11-11', parent: 'DEMO-400', milestone: 'm3' }),     // grandchild → same group
    issue('DEMO-401', 'review', { start: '2026-11-09', due: '2026-12-03', parent: 'DEMO-373', milestone: 'm3' }),
    issue('DEMO-399', 'done', { done_at: '2026-11-09', parent: 'DEMO-373' }),                  // counts toward progress
    issue('DEMO-533', 'started', { start: '2026-11-09', parent: 'DEMO-418', milestone: 'm4', url: 'https://linear.app/acme/issue/DEMO-533' }), // parent not mine
    issue('DEMO-185', 'todo', { due: '2026-12-18' }),                                          // later than the week: not shown in A
    issue('DEMO-700', 'todo', { due: '2026-11-13' }),                                          // loose item with a due day
    issue('DEMO-371', 'started', { start: '2026-11-09' }),                                    // umbrella without work: hidden in A
    issue('DEMO-555', 'todo', { due: '2026-11-05', parent: 'DEMO-373' }),                       // late
    issue('DEMO-600', 'todo', { milestone: 'm4' }),                                            // undated
    { key: 'bad' }, issue('DEMO-9', 'weird')]
  }, { key: 'Beta', name: 'Commerce Cloud', workspace: 'Beta', milestones: [], issues: [] }],
};
const feed = parseFeed(JSON.stringify(raw));

test('feed v2 parsing keeps valid rows only', () => {
  assert.equal(parseFeed('{"v":1,"projects":[]}'), null);
  assert.equal(parseFeed('{'), null);
  assert.equal(feed.projects[0].issues.length, 11);
  assert.equal(feed.projects[0].issues.find(i => i.key === 'DEMO-533').url, 'https://linear.app/acme/issue/DEMO-533');
  assert.equal(feed.projects[0].milestones.length, 4);
});

test('root issue: the highest known ancestor', () => {
  const byKey = new Map(feed.projects[0].issues.map(i => [i.key, i]));
  assert.equal(rootOf('DEMO-480', byKey), 'DEMO-373');
  assert.equal(rootOf('DEMO-533', byKey), 'DEMO-418');
  assert.equal(rootOf('DEMO-373', byKey), 'DEMO-373');
  const loop = new Map([['A-1', { parent: 'A-2' }], ['A-2', { parent: 'A-1' }]]);
  assert.ok(['A-1', 'A-2'].includes(rootOf('A-1', loop)));
});

test('week markers: deadline day only, future week is text, no date has no mark', () => {
  const win = windowOf(feed, TODAY, 7);
  assert.deepEqual(weekMarker('2026-11-12', win), { at: 3, edge: '', label: '' });
  assert.deepEqual(weekMarker('2026-12-03', win), { at: 6, edge: 'future', label: '→ 12/3' });
  assert.equal(weekMarker('', win), null);
  assert.deepEqual(weekMarker('2026-11-05', win), { at: 0, edge: 'past', label: '11/5 지남' });
  const two = windowOf(feed, TODAY, 14);
  assert.deepEqual(weekMarker('2026-11-20', two), { at: 11, edge: '', label: '' });
});

test('lozenge kind: late and due today win over the state', () => {
  assert.equal(kindOf(issue('A', 'todo', { due: '2026-11-10' }), TODAY), 'late');
  assert.equal(kindOf(issue('A', 'todo', { due: TODAY }), TODAY), 'hot');
  assert.equal(kindOf(issue('A', 'started', { blocked: true }), TODAY), 'blocked');
  assert.equal(kindOf(issue('A', 'review'), TODAY), 'review');
  assert.equal(kindOf(issue('A', 'done', { due: '2026-11-01' }), TODAY), 'done');
});

test('A rows: project > top issue > work, like the design', () => {
  const { rows } = weekRows(feed, { today: TODAY });
  assert.deepEqual(rows.map(r => [r.kind, r.key]), [
    ['project', 'ALP'],
    ['epic', 'DEMO-373'], ['item', 'DEMO-555'], ['item', 'DEMO-480'], ['item', 'DEMO-400'], ['item', 'DEMO-401'],
    ['item', 'DEMO-700'],
    ['epic', 'DEMO-418'], ['item', 'DEMO-533'],
    ['project', 'Beta'],
  ]);
  const epic = rows[1];
  assert.equal(epic.title, 'DEMO-373 제목');
  assert.deepEqual([epic.done, epic.total], [1, 5]);
  assert.equal(rows.find(r => r.kind === 'epic' && r.key === 'DEMO-418').title, '');   // a parent outside my issues is named by key only
  assert.deepEqual([rows[0].done, rows[0].total], [1, 7]);
  assert.equal(rows[9].empty, true);
  assert.equal(rows.find(r => r.key === 'DEMO-480').look, 'hot');
});

test('A rows: filter, folding and two weeks', () => {
  assert.deepEqual(weekRows(feed, { today: TODAY, filter: 'Beta' }).rows.map(r => r.key), ['Beta']);
  const folded = weekRows(feed, { today: TODAY, open: { 'ALP/DEMO-373': false } }).rows.map(r => r.key);
  assert.ok(folded.includes('DEMO-373') && !folded.includes('DEMO-480'));
  assert.deepEqual(weekRows(feed, { today: TODAY, open: { ALP: false } }).rows.map(r => r.key), ['ALP', 'Beta']);
  // two weeks: DEMO-185 (12/18) still out, a due on 11/20 would be in
  const two = weekRows(feed, { today: TODAY, days: 14 }).rows.map(r => r.key);
  assert.ok(!two.includes('DEMO-185'));
});

test('day cells mark today and the weekend', () => {
  const cells = dayCells(windowOf(feed, TODAY, 7), TODAY);
  assert.equal(cells[2].label, '수 11/11 오늘');
  assert.deepEqual(cells.map(c => c.weekend), [false, false, false, false, false, true, true]);
  assert.equal(dayCells(windowOf(feed, TODAY, 14), TODAY)[8].label, '화 17');
});

test('B range: weeks from three weeks back to the last target', () => {
  const r = projectRange(feed.projects[0], TODAY);
  assert.equal(r.start, '2026-10-19');
  assert.equal(r.end, '2027-02-21');
  assert.equal(r.weeks.length, 18);
  assert.equal(r.weeks.findIndex(w => w.now), 3);
  assert.deepEqual(r.months.map(m => m.label), ['10월', '11월', '12월', '1월', '2월']);
  assert.equal(r.months.reduce((n, m) => n + m.days, 0), r.span);
  assert.equal(monday('2026-11-15'), '2026-11-09');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('B rows: project > milestones (current ones open) > my dated issues, undated counted', () => {
  const { rows } = projectRows(feed.projects[0], { today: TODAY });
  const kinds = rows.map(r => r.kind === 'milestone' ? `m:${r.id}` : r.kind === 'item' ? r.key : r.kind);
  assert.deepEqual(kinds.slice(0, 2), ['project', 'm:m1']);
  const m3 = kinds.indexOf('m:m3'), m4 = kinds.indexOf('m:m4'), m9 = kinds.indexOf('m:m9');
  assert.deepEqual(kinds.slice(m3 + 1, m4), ['DEMO-480', 'DEMO-400', 'DEMO-401']);
  assert.deepEqual(kinds.slice(m4 + 1, m9), ['DEMO-533', 'undated']);
  assert.equal(kinds.includes('m:'), true);   // issues without a milestone are grouped last
  const ms = rows.filter(r => r.kind === 'milestone' && r.id);
  assert.deepEqual(ms.map(m => m.open), [false, true, true, false]);
  assert.equal(ms[0].done, true);
  assert.equal(ms[1].from, ms[0].to + 1);   // previous target → this target
  const i401 = rows.find(r => r.key === 'DEMO-401');
  assert.deepEqual([i401.label, Boolean(i401.bar)], ['11/9 – 12/3', true]);
  const i480 = rows.find(r => r.key === 'DEMO-480');
  assert.deepEqual([i480.label, i480.diamond], ['11/11', 23]);
  assert.equal(rows.find(r => r.key === 'DEMO-533').label, '11/9 – 기한 없음');
  const undated = rows.find(r => r.kind === 'undated');
  assert.deepEqual([undated.count, undated.items.length], [1, 0]);
  assert.equal(projectRows(feed.projects[0], { today: TODAY, undated: true }).rows.find(r => r.kind === 'undated').items[0].key, 'DEMO-600');
  assert.deepEqual(projectRows(feed.projects[1], { today: TODAY }).rows.map(r => [r.kind, r.empty]), [['project', true]]);
});

test('status line keeps the last value and names a failed refresh', () => {
  assert.match(freshness(feed).text, /^확인 \d\d:\d\d$/);
  const failed = freshness({ ...feed, error: 'claude -p exit=1', attempted: '2026-11-11T09:51:00+09:00' });
  assert.equal(failed.failed, true);
  assert.match(failed.text, /^갱신 실패 \d\d:\d\d$/);
  assert.match(failed.since, /^마지막 값 \d\d:\d\d$/);
  assert.equal(freshness(null).text, '아직 읽지 않음');
});

test('bridge and colour helpers', () => {
  assert.equal(bridgeFrom('{"command":"python3"}'), null);
  assert.deepEqual(bridgeFrom('{"command":"/usr/bin/python3","args":["/x/w.py",1]}'), { command: '/usr/bin/python3', args: ['/x/w.py'], apply: null });
  assert.deepEqual(bridgeFrom({ command: '/p', apply: { command: '/p', args: ['/x/a.py'] } }).apply, { command: '/p', args: ['/x/a.py'] });
  assert.equal(bridgeFrom({ command: '/p', apply: { command: 'sh' } }).apply, null);
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
});

test('layout: header chip only, no permanent timeline band or footer', () => {
  const layout = JSON.parse(readFileSync(new URL('../layouts/sixfold.json', import.meta.url), 'utf8'));
  const find = (n, id) => n?.id === id ? n : (n?.children || []).map(c => find(c, id)).find(Boolean);
  assert.deepEqual(find(layout, 'work').children.map(c => c.id), ['monitor-strip', 'tabs', 'body']);
  assert.equal(find(layout, 'week-timeline'), undefined);
  assert.equal(find(layout, 'status'), undefined);
  assert.equal(find(layout, 'toolbar'), undefined);
  assert.equal(find(layout, 'monitor-strip').window_drag, true);
  assert.equal(find(layout, 'mcp-cli').type,'column');
  assert.deepEqual(find(layout, 'mcp-header').children.map(c => c.content.mod), ['mcp-status','week-timeline']);
  assert.equal(find(layout, 'cli-status').content.mod,'cli-status');
  assert.equal(find(layout, 'week-timeline-chip').size.px,180);
  assert.match(readFileSync(new URL('../mods/sixfold-desk/main.js', import.meta.url), 'utf8'), /role === 'footer'/);
});
