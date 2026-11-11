import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDetail, splitDescription, threads, addChange, removeChange, effective, describeChange, requestOf, parseApply, breadcrumb, related, relationLabel } from '../mods/week-timeline/detail.js';

const C1 = '0f0e0d0c-0b0a-4908-8706-050403020100', C2 = '1f0e0d0c-0b0a-4908-8706-050403020100';
const raw = {
  v: 1, key: 'DEMO-1', read_at: '2026-11-11T09:30:00+09:00', error: '',
  issue: { key: 'DEMO-1', title: '인프라', description: '배경 설명\n\n- [ ] 첫째\n- [x] 둘째\n  * [ ] 셋째', status: 'Todo', status_type: 'unstarted',
           assignee: 'Alex', labels: ['infra'], due: '2026-11-20', start: '', milestone: '④ 인프라', parent: 'DEMO-0', project: 'ALP',
           url: 'https://linear.app/acme/issue/DEMO-1', relations: [{ type: 'related', key: 'DEMO-3', title: 'c', status: 'Todo' }, { type: 'blocked_by', key: 'DEMO-2', title: 'b', status: 'In Review' }, { type: 'x', key: 'bad' }] },
  statuses: [{ name: 'Todo', type: 'unstarted' }, { name: 'In Progress', type: 'started' }], labels: [{ name: 'infra' }, { name: 'ops' }],
  comments: [{ id: C1, parent: '', author: 'Alex', at: '', body: '확인 부탁' }, { id: C2, parent: C1, author: 'Lee', at: '', body: '네' }],
  notices: [{ type: 'issueCommentMention', text: 'Alex 이 언급', at: '', read: false }], slack: [], slack_ready: true,
  herdr: [{ task: 'T1', title: '회신', kind: 'final', done: 'PR 병합', terminal: 't7b' }, { task: 'T2', terminal: '; rm' }],
};
const d = parseDetail(JSON.stringify(raw), 'DEMO-1');
const issue = d.issue;

test('detail parsing checks the key and cleans rows', () => {
  assert.equal(parseDetail(JSON.stringify(raw), 'DEMO-2'), null);
  assert.equal(parseDetail('{', 'DEMO-1'), null);
  assert.equal(issue.relations.length, 2);
  assert.equal(d.herdr[1].terminal, '');
  assert.equal(parseDetail(JSON.stringify({ ...raw, issue: { ...raw.issue, url: 'https://evil.example/x' } }), 'DEMO-1').issue.url, '');
  assert.equal(parseDetail(JSON.stringify({ v: 1, key: 'DEMO-1', error: 'exit=1' }), 'DEMO-1').issue, null);
});

test('description splits into prose and to-do lines', () => {
  const lines = splitDescription(issue.description);
  assert.deepEqual(lines.filter(l => l.kind === 'check').map(l => [l.text, l.done]), [['첫째', false], ['둘째', true], ['셋째', false]]);
  assert.equal(lines[0].text, '배경 설명');
});

test('comment threads', () => {
  assert.deepEqual(threads(d.comments).map(t => [t.author, t.replies.map(r => r.author)]), [['Alex', ['Lee']]]);
});

test('pending: later wins, going back drops, labels net out, replies add up', () => {
  let p = addChange([], { kind: 'status', to: 'In Progress' }, issue);
  p = addChange(p, { kind: 'status', to: 'Todo' }, issue);
  assert.deepEqual(p, []);
  p = addChange(p, { kind: 'status', to: 'In Progress' }, issue);
  p = addChange(p, { kind: 'label', name: 'ops' }, issue);
  p = addChange(p, { kind: 'label', name: 'infra' }, issue);
  assert.deepEqual(p.find(c => c.kind === 'label'), { kind: 'label', add: ['ops'], remove: ['infra'] });
  p = addChange(p, { kind: 'label', name: 'ops' }, issue);
  p = addChange(p, { kind: 'label', name: 'infra' }, issue);
  assert.equal(p.some(c => c.kind === 'label'), false);
  p = addChange(p, { kind: 'check', line: '- [ ] 첫째', done: true }, issue);
  p = addChange(p, { kind: 'check', line: '- [x] 둘째', done: false }, issue);
  p = addChange(p, { kind: 'check', line: '- [ ] 첫째', done: false }, issue);   // back to Linear's value
  assert.deepEqual(p.filter(c => c.kind === 'check').map(c => c.line), ['- [x] 둘째']);
  p = addChange(p, { kind: 'due', to: '2026-11-20' }, issue);                     // same as Linear
  assert.equal(p.some(c => c.kind === 'due'), false);
  p = addChange(p, { kind: 'due', to: null }, issue);
  p = addChange(p, { kind: 'assignee', to: 'me' }, issue);
  p = addChange(p, { kind: 'reply', parent: C1, body: 'a' }, issue);
  p = addChange(p, { kind: 'reply', parent: '', body: 'b' }, issue);
  assert.deepEqual(p.map(c => c.kind), ['status', 'check', 'due', 'assignee', 'reply', 'reply']);
  const shown = effective(issue, p);
  assert.deepEqual([shown.status, shown.assignee, shown.due, shown.checks['- [x] 둘째']], ['In Progress', '나', '', false]);
  assert.deepEqual(p.map(describeChange).slice(0, 3), ['상태 → In Progress', '할 일 해제: 둘째', '마감 → 없음']);
  assert.equal(removeChange(p, 0).length, 5);
  assert.deepEqual(requestOf('DEMO-1', 'r1', p).changes[0], { kind: 'status', to: 'In Progress' });
});

test('apply result, breadcrumb and relations', () => {
  assert.equal(parseApply('{"key":"DEMO-2","at":"x"}', 'DEMO-1'), null);
  assert.deepEqual(parseApply('{"key":"DEMO-1","at":"2026-11-11T10:00:00+09:00","ok":false,"error":"권한","kept":[{"kind":"status","to":"Done"}],"applied":0}', 'DEMO-1').kept, [{ kind: 'status', to: 'Done' }]);
  assert.deepEqual(breadcrumb(d, {}), ['ALP', '④ 인프라', 'DEMO-0', 'DEMO-1']);
  assert.deepEqual(breadcrumb(null, { key: 'DEMO-9', project: 'ALP' }), ['ALP', 'DEMO-9']);
  assert.deepEqual(related(issue).map(r => r.key), ['DEMO-2', 'DEMO-3']);
  assert.equal(relationLabel('blocked_by'), '이 이슈를 막음');
});
