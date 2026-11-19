import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {cleanPanelFeed, projectPanelFeed} from '../mods/sixfold-desk/panel-model.js';
import {spaceAsks, spaceAskLayout} from '../mods/sixfold-desk/ask-model.js';
import {workspaceAlertTimeline, workspaceAlertCounts} from '../mods/sixfold-desk/alert-model.js';
import {repoFlowModel} from '../mods/sixfold-desk/repo-flow-model.js';
import {makePanelFixture} from './panel-fixtures.mjs';

// The panel feed's per-space notifications, pending requests and Repo Flow stages reach the
// sidebar through the panel model. Made-up spaces, channels and repositories only.
const NOW = Date.parse('2026-11-20T03:00:00Z');
function feed() {
  const raw = makePanelFixture({tool: 'linear', slack: true, share: 'local', now: NOW});
  const [space, other] = raw.spaces;
  space.alerts = {items: [
    {id: 'n-1111111111111111', source: 'slack', ref: 'C1', sender: 'Dana', summary: 'Review please', at: '2026-11-20T02:58:00Z', read: false, raw_payload: {token: 'never kept'}},
    {id: 'n-2222222222222222', source: 'github', ref: 'demo/app#7', sender: null, summary: 'CI failed', at: '2026-11-19T10:00:00Z', read: true},
    {id: 'n-3333333333333333', source: 'linear', ref: 'DEMO-12', sender: 'Lee', summary: 'Status changed', at: null, read: null},
    {id: 'n-4444444444444444', source: 'email', ref: 'x', summary: 'not a source', read: false},
  ], unread: 99, connections: {slack: ['C1'], linear: ['DEMO'], github: ['demo/app'], extra: ['x']},
  sources: {slack: 'ready', linear: 'missing', github: 'ready'}, mapping: {slack: 'config', linear: 'none', github: 'collector'}};
  raw.asks = [
    {id: 'ask-1', revision: 'r1', kind: 'permission', title: 'Run the migration?', space: space.id, agent: space.agents[0].id, session_id: 'private'},
    {id: 'ask-2', revision: 'r1', kind: 'question', title: 'Which branch?', space: 's-9999999999999999', agent: space.agents[0].id},
    {id: 'ask-3', revision: 'r2', kind: 'plan', title: 'Plan', space: other.id, agent: 'a-9999999999999999'},
  ];
  return {raw, space, other};
}

test('space alerts are kept as display values: unknown read stays null and is never counted', () => {
  const {raw, space} = feed();
  const clean = cleanPanelFeed(raw), alerts = clean.spaces.find(item => item.id === space.id).alerts;
  assert.deepEqual(alerts.items.map(item => item.id), ['n-1111111111111111', 'n-2222222222222222', 'n-3333333333333333'], 'an unknown source is dropped');
  assert.equal(alerts.unread, 1, 'counted from the items, not the producer total; null is not unread');
  assert.equal(alerts.items[2].read, null);
  assert.equal(Object.hasOwn(alerts.items[0], 'raw_payload'), false, 'no private payload');
  assert.deepEqual(alerts.connections, {slack: ['C1'], linear: ['DEMO'], github: ['demo/app']});
  assert.deepEqual(alerts.mapping, {slack: 'config', linear: 'none', github: 'collector'});
  assert.equal(clean.spaces.find(item => item.id !== space.id).alerts, undefined, 'a space without alerts gets none');
  const projected = projectPanelFeed(clean, null, {now: NOW}).feed.spaces.find(item => item.id === space.id);
  assert.deepEqual(projected.alerts, alerts, 'the projection carries the same alerts');
  const timeline = workspaceAlertTimeline({alerts: projected.alerts, now: NOW});
  // The tab lists the items whose read state is known (alert-model.js); the unknown one is left out.
  assert.deepEqual(timeline.groups.map(group => group.id), ['recent', 'yesterday']);
  assert.equal(workspaceAlertCounts({alerts: projected.alerts}).total, 1);
});

test('requests keep the asking space only when it is a space of this feed', () => {
  const {raw, space, other} = feed();
  const clean = cleanPanelFeed(raw);
  assert.deepEqual(clean.asks.map(ask => [ask.id, ask.space, ask.agent]),
    [['ask-1', space.id, space.agents[0].id], ['ask-2', null, null], ['ask-3', other.id, null]]);
  assert.equal(Object.hasOwn(clean.asks[0], 'session_id'), false);
  const projected = projectPanelFeed(clean, null, {now: NOW}).feed;
  assert.deepEqual(spaceAsks(projected.asks, space.id).map(ask => ask.id), ['ask-1'], 'the tab beside this card');
  assert.deepEqual(spaceAsks(projected.asks, other.id).map(ask => ask.id), ['ask-3']);
  assert.deepEqual(spaceAskLayout({x: 7, y: 120, w: 265, h: 90}), {left: 273, top: 120, width: 45, height: 90}, 'inside the 48px right gutter');
});

test('repo_flow reaches REPOS only with stage data; without it the repository section stays', () => {
  const {raw} = feed();
  const dto = {schema: 'repo_activity_v1', accounts: [{id: 'personal', name: 'Example', kind: 'personal'}],
    repositories: [{id: 'theme', account_id: 'personal', name: 'theme', namespace: 'example'}], bindings: [], events: []};
  assert.equal(cleanPanelFeed({...raw, repo_activity: dto, repo_flow: dto}).repo_flow, undefined, 'git events only: no stage row');
  dto.repositories[0].flow = {commit: {issue: 'APP-1', title: 'Spacing', sha: 'a1b2c3d'}, push: {state: 'succeeded'}};
  const clean = cleanPanelFeed({...raw, repo_activity: dto, repo_flow: dto});
  assert.equal(clean.repo_flow, dto);
  const projected = projectPanelFeed(clean, null, {now: NOW}).feed;
  const model = repoFlowModel(projected.repo_flow);
  assert.deepEqual(model.repositories.map(repo => [repo.name, repo.push.state, repo.ci.state, repo.cd.state]),
    [['theme', 'succeeded', 'unknown', 'unknown']], 'an unobserved CI or CD stays an empty slot');
});

test('the sidebar wires the alerts tab, the request tab, REPOS and the role chip', async () => {
  const main = await readFile(new URL('../mods/sixfold-desk/main.js', import.meta.url), 'utf8');
  const retained = await readFile(new URL('../mods/sixfold-desk/panel-retained.js', import.meta.url), 'utf8');
  const view = await readFile(new URL('../mods/sixfold-desk/panel-view.js', import.meta.url), 'utf8');
  assert.match(main, /spaceUnread:\{/);
  assert.match(main, /spaceAskView\(feedAsks,task\.id,/);
  assert.match(main, /mountRepoFlow\(this,this\.panelState\.feed\.repo_flow,t,cx\)/);
  assert.match(main, /repoComputerChips\(repoFlow,taskComputerRecord\(/);
  assert.match(main, /sf-space-role-/);
  assert.match(retained, /state\.scope==='alerts'\?\{alerts:space\.alerts/);
  assert.match(view, /view\.unreadBadge\?\.\(space\)/);
  assert.match(view, /'레포 반영'\]/);
});
