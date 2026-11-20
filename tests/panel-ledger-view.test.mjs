import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPanelFeed, agentGroups, projectPanelFeed, issueLinearKind, issueRowLabel, agentOtherIssues, localDay } from '../mods/sixfold-desk/panel-model.js';
import { makeLedgerFieldFeed } from './panel-fixtures.mjs';

const NOW = Date.now();
const field = (options = {}) => {
  const made = makeLedgerFieldFeed({ now: NOW, ...options });
  return { ...made, space: cleanPanelFeed(made.feed).spaces[0] };
};
const keys = result => result.groups.filter(group => group.issue).map(group => group.issue.key);
const under = (result, key) => result.groups.find(group => (group.issue?.key ?? null) === key)?.agents.map(agent => agent.id) ?? null;
const groupOf = (result, key) => result.groups.find(group => group.issue?.key === key);

test('the sanitizer keeps the new optional producer fields and drops malformed ones', () => {
  const { space, ids } = field();
  const integrator = space.agents.find(agent => agent.id === ids[3]);
  assert.equal(integrator.role, 'integrate');
  assert.equal(integrator.own_issue, 'DEMO-490');
  assert.deepEqual(integrator.issues, ['DEMO-490', 'DEMO-503', 'DEMO-504', 'DEMO-393']);
  assert.equal(space.agents.find(agent => agent.id === ids[6]).own_issue, null, 'an explicit null own issue is kept as null');
  assert.equal(space.issues[0].done_at.length > 0, true);
  const raw = makeLedgerFieldFeed({ now: NOW }).feed;
  Object.assign(raw.spaces[0].agents[0], { role: 'owner', own_issue: 7, issues: ['A-1', 'A-1', 3, ...Array.from({ length: 30 }, (_, i) => `B-${i}`)] });
  raw.spaces[0].issues[0].done_at = 'yesterday';
  const clean = cleanPanelFeed(raw).spaces[0];
  assert.equal(clean.agents[0].role, null);
  assert.equal(clean.agents[0].own_issue, null);
  assert(clean.agents[0].issues.length <= 20);
  assert.equal(clean.agents[0].issues.filter(key => key === 'A-1').length, 1);
  assert.equal('done_at' in clean.issues[0], false);
  // Copies made for retained display keep them too.
  const projected = projectPanelFeed(cleanPanelFeed(makeLedgerFieldFeed({ now: NOW }).feed));
  assert.equal(projected.agents.get(ids[3]).role, 'integrate');
  assert.deepEqual(projected.agents.get(ids[3]).issues, ['DEMO-490', 'DEMO-503', 'DEMO-504', 'DEMO-393']);
  assert.equal(typeof projected.spaces[0].issues[0].done_at, 'string');
});

test('Linear kind comes from status_type first, then closed, then the status name; unknown stays null', () => {
  assert.equal(issueLinearKind({ status: 'Done', status_type: 'started' }), 'started');
  for (const type of ['completed', 'canceled', 'duplicate']) assert.equal(issueLinearKind({ status_type: type }), 'closed');
  for (const type of ['unstarted', 'backlog', 'triage']) assert.equal(issueLinearKind({ status_type: type }), 'unstarted');
  assert.equal(issueLinearKind({ closed: 'duplicate' }), 'closed');
  for (const name of ['Done', 'Canceled', 'Duplicate', '완료', '취소']) assert.equal(issueLinearKind({ status: name }), 'closed', name);
  for (const name of ['In Progress', 'In Review', '진행 중']) assert.equal(issueLinearKind({ status: name }), 'started', name);
  for (const name of ['Todo', 'Backlog']) assert.equal(issueLinearKind({ status: name }), 'unstarted', name);
  assert.equal(issueLinearKind({ state: 'done' }), null, 'the producer state is not a Linear status');
  assert.equal(issueLinearKind({ status: 'Waiting on vendor' }), null);
});

test('field case: finished issues leave the list, today\'s wait folded, started ones stay', () => {
  const { space, ids } = field();
  const result = agentGroups(space, { today: localDay(NOW) });
  const shown = keys(result);
  for (const key of ['DEMO-417', 'DEMO-502', 'DEMO-573', 'DEMO-504', 'DEMO-610', 'DEMO-411']) assert(!shown.includes(key), `${key} is hidden`);
  for (const key of ['DEMO-490', 'DEMO-412', 'DEMO-393', 'DEMO-503', 'DEMO-611', 'DEMO-612']) assert(shown.includes(key), `${key} is shown`);
  assert.deepEqual(result.doneFold, { count: 1, expanded: false }, 'only DEMO-417 finished today; canceled/duplicate without a time are just hidden');
  for (const n of [1, 2, 15]) assert(!result.agents.some(agent => agent.id === ids[n]), `empty shell ${n} under a finished or backlog issue is hidden`);
  assert.equal(result.issuesFiltered, 4, 'DEMO-504 is only held by a session, so it is not counted either');
  const open = agentGroups(space, { today: localDay(NOW), expandedIssueSpaces: new Set([space.id]) });
  assert.deepEqual(open.doneFold, { count: 1, expanded: true });
  assert.deepEqual(open.groups.filter(group => group.section === 'done').map(group => group.issue.key), ['DEMO-417']);
  assert.equal(open.groups.at(-1).issue.key, 'DEMO-417', 'the 오늘 마무리 issues come last');
  // Another day: the same Done issue is only hidden.
  assert.equal(agentGroups(space, { today: '1999-01-01' }).doneFold, null);
});

test('field case: unstarted issues show only while a pane works; unknown status stays as before', () => {
  const { space, ids } = field();
  const result = agentGroups(space, { today: localDay(NOW) });
  assert.deepEqual(under(result, 'DEMO-611'), [ids[14]], 'Todo with a working pane stays');
  assert.equal(groupOf(result, 'DEMO-610'), undefined, 'Backlog with an idle pane leaves');
  assert.deepEqual(under(result, 'DEMO-612'), [ids[16]], 'a row without a Linear status is kept (conservative)');
  // A blocked or waiting-for-a-person pane keeps a finished issue on screen too.
  const raw = makeLedgerFieldFeed({ now: NOW }).feed;
  raw.spaces[0].agents[0].state = 'needs_human';
  assert(keys(agentGroups(cleanPanelFeed(raw).spaces[0], { today: localDay(NOW) })).includes('DEMO-502'));
});

test('field case: an issue row reads 작업 중 only with a working pane, else 쉬는 중', () => {
  const { space } = field();
  const result = agentGroups(space, { today: localDay(NOW) });
  assert.equal(issueRowLabel(groupOf(result, 'DEMO-490')), '작업 중 1');
  assert.equal(issueRowLabel(groupOf(result, 'DEMO-412')), '쉬는 중', 'idle pane under a working-state issue');
  assert.equal(issueRowLabel(groupOf(result, 'DEMO-393')), '쉬는 중');
  assert.equal(groupOf(result, 'DEMO-411'), undefined, 'In Progress without a pane leaves');
  assert.equal(groupOf(result, 'DEMO-412').working, 0);
  assert.equal(result.groups[0].issue.key, 'DEMO-490', 'the issue with working panes sorts first');
  // Older feeds: the producer's working state no longer claims work the panes do not do.
  const old = agentGroups(field({ ledger: false }).space, { today: localDay(NOW) });
  assert.equal(issueRowLabel(groupOf(old, 'DEMO-412')), '쉬는 중');
  assert.equal(issueRowLabel(groupOf(old, 'DEMO-490')), '작업 중 1');
});

test('field case: an issue missing from the space list gets its row from the ledger only while a pane sits under it', () => {
  const { space, ids } = field();
  const result = agentGroups(space, { today: localDay(NOW) });
  // DEMO-411 is In Progress, but only held by a pane that sits under DEMO-503: once the pane that
  // worked on it is cleaned up, the issue leaves the space (2026-11-20).
  assert.equal(groupOf(result, 'DEMO-411'), undefined);
  const sync = groupOf(result, 'DEMO-503');
  assert.equal(sync.issue.title, 'Stock sync');
  assert.equal(sync.issue.from_ledger, true);
  assert.deepEqual(new Set(sync.agents.map(agent => agent.id)), new Set([ids[5], ids[12], ids[13]]));
});

test('field case: subtasks sit under their own issue; unknown ones fold under the parent', () => {
  const { space, ids } = field();
  const result = agentGroups(space, { today: localDay(NOW) });
  assert.deepEqual(under(result, 'DEMO-490'), [ids[3], ids[9], ids[4]]);
  assert.equal(result.rowMeta.get(ids[9]).parent, ids[3]);
  assert(under(result, 'DEMO-503').includes(ids[5]), 'the 503+504 merge subtask moves to its own issue');
  assert.equal(result.rowMeta.get(ids[5]).parent, null, 'there it is a root row');
  assert(under(result, 'DEMO-393').includes(ids[8]));
  const fold = groupOf(result, 'DEMO-490').folds.find(item => item.parent === ids[3]);
  assert.deepEqual(fold, { parent: ids[3], after: ids[9], hidden: 2, count: 2, expanded: false, unknown: 2 });
  for (const n of [6, 7]) assert(!result.agents.some(agent => agent.id === ids[n]));
  const expanded = agentGroups(space, { today: localDay(NOW), expandedParents: new Set([ids[3]]) });
  assert.deepEqual(under(expanded, 'DEMO-490'), [ids[3], ids[6], ids[7], ids[9], ids[4]]);
  assert.equal(expanded.rowMeta.get(ids[6]).parent, ids[3]);
  assert.equal(groupOf(expanded, 'DEMO-490').folds.find(item => item.parent === ids[3]).expanded, true, 'a 접기 row stays');
  // The fold joins an existing +N fold of more than three children instead of adding a second row.
  const raw = makeLedgerFieldFeed({ now: NOW }).feed;
  for (const n of [5, 8]) raw.spaces[0].agents[n - 1].own_issue = 'DEMO-490';
  raw.spaces[0].agents.push({ ...raw.spaces[0].agents[8], id: 'extra-child', title: 'Extra' });
  const many = agentGroups(cleanPanelFeed(raw).spaces[0], { today: localDay(NOW) });
  const folds = groupOf(many, 'DEMO-490').folds.filter(item => item.parent === ids[3]);
  assert.equal(folds.length, 1);
  assert.deepEqual([folds[0].hidden, folds[0].count, folds[0].unknown], [3, 6, 2]);
});

test('field case: roles and held issues are display data on each row', () => {
  const { space, ids } = field();
  const byId = new Map(space.agents.map(agent => [agent.id, agent]));
  assert.equal(byId.get(ids[12]).title, byId.get(ids[13]).title, 'implementer and reviewer share a title');
  assert.deepEqual([byId.get(ids[12]).role, byId.get(ids[13]).role], ['implement', 'review']);
  assert.deepEqual(agentOtherIssues(byId.get(ids[13])), ['DEMO-411']);
  assert.deepEqual(agentOtherIssues(byId.get(ids[3])), ['DEMO-503', 'DEMO-504', 'DEMO-393']);
  assert.deepEqual(agentOtherIssues(byId.get(ids[12])), []);
  assert.deepEqual(agentOtherIssues({ issue: 'X-1' }), []);
});

test('work sent by a coordinating session is never hidden: only Linear status filters', () => {
  const { space, ids } = field();
  const result = agentGroups(space, { today: localDay(NOW) });
  // Every row under a started or unknown-status issue is drawn, whatever its role, title or origin.
  for (const n of [3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 16]) assert(result.agents.some(agent => agent.id === ids[n]), `row ${n}`);
  assert(result.agents.some(agent => agent.title === '기록을 읽지 못한 작업'));
});

test('without the new fields the panel keeps its earlier placement', () => {
  const { space, ids } = field({ ledger: false });
  const result = agentGroups(space, { today: localDay(NOW), expandedParents: new Set([ids[3]]) });
  assert.deepEqual(keys(result).sort(), space.issues.map(issue => issue.key).sort(), 'every listed issue shows; nothing is added from the catalog');
  assert.equal(result.doneFold, null);
  assert.equal(result.issuesFiltered, 0);
  assert.deepEqual(new Set(under(result, 'DEMO-490')), new Set([3, 4, 5, 6, 7, 8, 9, 12, 13].map(n => ids[n])));
  assert.deepEqual(result.agents.length, 16);
  assert(result.groups.flatMap(group => group.folds).every(fold => !fold.unknown));
});

test('a new day recomputes the cached groups; the same day reuses them', () => {
  const feed = cleanPanelFeed(makeLedgerFieldFeed({ now: NOW }).feed);
  const first = projectPanelFeed(feed, null, { now: NOW });
  assert.equal(first.groups.get(feed.spaces[0].id).doneFold.count, 1);
  const same = projectPanelFeed(feed, first, { now: NOW });
  assert.equal(same.stats.groupsComputed, 0);
  const next = projectPanelFeed(feed, same, { now: NOW + 2 * 86400000 });
  assert.equal(next.stats.groupsComputed, 1);
  assert.equal(next.groups.get(feed.spaces[0].id).doneFold, null);
});

test('review fix: blocked-looking and waiting-for-a-person panes keep finished and unstarted issues', () => {
  const cases = { report_missing: { report_missing: true }, error: { error: 'Connection unavailable' },
    closing: { closing: { step: 2, blocked_reason: 'Save pending' } }, unseen: { state: 'unseen_result' }, input: { wait_kind: 'input' } };
  for (const [name, extra] of Object.entries(cases)) {
    for (const [index, key] of [[0, 'DEMO-502'], [14, 'DEMO-610']]) {
      const raw = makeLedgerFieldFeed({ now: NOW }).feed;
      Object.assign(raw.spaces[0].agents[index], extra);
      assert(keys(agentGroups(cleanPanelFeed(raw).spaces[0], { today: localDay(NOW) })).includes(key), `${name} keeps ${key}`);
    }
  }
  const plain = makeLedgerFieldFeed({ now: NOW }).feed;
  Object.assign(plain.spaces[0].agents[0], { keep_reason: 'work left', wait_kind: 'status' });
  assert(!keys(agentGroups(cleanPanelFeed(plain).spaces[0], { today: localDay(NOW) })).includes('DEMO-502'), 'a plain kept shell does not');
});

test('review fix: an unknown-issue subtask that works, is blocked or waits for a person is never folded', () => {
  for (const extra of [{ status: 'working' }, { status: 'blocked' }, { state: 'needs_human' }, { state: 'unseen_result' }, { error: 'failed' }]) {
    const made = makeLedgerFieldFeed({ now: NOW });
    Object.assign(made.feed.spaces[0].agents[5], extra);
    const result = agentGroups(cleanPanelFeed(made.feed).spaces[0], { today: localDay(NOW) });
    assert(under(result, 'DEMO-490').includes(made.ids[6]), JSON.stringify(extra));
    assert.equal(result.rowMeta.get(made.ids[6]).parent, made.ids[3], 'it stays under its parent');
    const fold = groupOf(result, 'DEMO-490').folds.find(item => item.parent === made.ids[3]);
    assert.deepEqual([fold.hidden, fold.unknown], [1, 1], 'only the idle one stays folded');
  }
  const both = makeLedgerFieldFeed({ now: NOW });
  for (const n of [6, 7]) both.feed.spaces[0].agents[n - 1].status = 'working';
  const result = agentGroups(cleanPanelFeed(both.feed).spaces[0], { today: localDay(NOW) });
  assert(!groupOf(result, 'DEMO-490').folds.some(item => item.parent === both.ids[3]), 'nothing left to fold: no +0 row');
});

test('review fix: without new fields, sorting follows working panes and catalog-known issues get their own row', () => {
  const { space, ids } = field({ ledger: false });
  const result = agentGroups(space, { today: localDay(NOW) });
  // (a) DEMO-417 and DEMO-412 say working but no pane works: they sort after DEMO-490 and the working waiting ones.
  const order = keys(result);
  assert(order.indexOf('DEMO-490') < order.indexOf('DEMO-417'));
  assert(order.indexOf('DEMO-611') < order.indexOf('DEMO-412'), 'a waiting issue with a working pane sorts with the working ones');
  // (b) a pane whose issue the space does not list but the catalog knows sits under that issue.
  const raw = makeLedgerFieldFeed({ now: NOW, ledger: false }).feed;
  raw.spaces[0].agents[11].issue = 'DEMO-503';
  raw.spaces[0].agents[12].issue = 'DEMO-999';
  const moved = agentGroups(cleanPanelFeed(raw).spaces[0], { today: localDay(NOW) });
  assert.deepEqual(under(moved, 'DEMO-503'), [ids[12]]);
  assert.equal(groupOf(moved, 'DEMO-503').issue.title, 'Stock sync');
  assert.deepEqual(under(moved, null), [ids[13]], 'a key nothing knows stays under 이슈 없음');
});
