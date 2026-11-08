import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPanelFeed, reconcilePanelFeed, panelSpaces, panelSpacePartners, agentGroups, agentState, panelEventStates, projectPanelFeed, createPanelProjection, PANEL_TIMING } from '../mods/sixfold-desk/panel-model.js';
import { makePanelFixture, makePanelMatrix, makePanelLoadFixture, PANEL_IDS, eventSequence, makePanelScenario, localCollaborationMessage } from './panel-fixtures.mjs';

const NOW = 1780000000000;
const stamp = at => new Date(at).toISOString();
const agent = (id, extra = {}) => ({ id, family: 'codex', title: `Task ${id}`, stage: 2, status: 'working', ...extra });
const space = (id, extra = {}) => ({ id, name: `Space ${id}`, computer: 'studio', bundle: 'violet', share: null, slack: null, work: null, issues: [], memory: { proposals: 0 }, agents: [agent(`${id}-agent`)], ...extra });
const feed = extra => ({ v: 1, at: stamp(NOW), computers: [{ id: 'studio', name: 'Studio', local: true }, { id: 'worker', name: 'Worker', linked: true }], spaces: [space('one')], links: [], events: [], ...extra });
const normalize = extra => cleanPanelFeed(feed(extra));
const boot = value => panelEventStates(value, NOW);
const advance = (value, previous, delta, motion = true) => panelEventStates(value, NOW + delta, { previous, motion });

test('allocation metadata supplies finite default tags and distinguishes new rows from reused rows',()=>{
  const initial=normalize(),prior=boot(initial),from=initial.spaces[0].agents[0].id;
  for(const kind of ['existing','new']){
    const next={...initial,events:[{id:`event-${kind}`,at:NOW,kind:'dispatch',from,to:from,label:'',allocation:{kind,count:2}}]};
    const playing=advance(next,prior,0);
    assert.equal(playing.spawning.has(from),kind==='new');
    assert.equal(playing.tags.get(from).label,kind==='new'?'조정: 새로 열어 맡김':'계획: 일 2개로 나눔');
    assert(!advance(next,playing,1700).tags.has(from));
    assert.equal(advance(next,playing,3000).nextAt,null);
  }
});

test('unlabeled final close remains visible for its finite default label only',()=>{
  const initial=normalize(),prior=boot(initial),from=initial.spaces[0].agents[0].id;
  const next=normalize({spaces:[space('one',{agents:[agent(from,{stage:5,status:'done',closing:{step:4}})]})],
    events:[{id:'close-last',kind:'close_step',at:stamp(NOW),from,to:null,step:4,label:''}]});
  const playing=advance(next,prior,0);
  assert.equal(playing.tags.get(from).label,'닫힘');
  assert.equal(agentGroups(next.spaces[0],{includeClosedIds:new Set(playing.tags.keys())}).agents.length,1);
  assert.equal(agentGroups(next.spaces[0],{includeClosedIds:new Set(advance(next,playing,1700).tags.keys())}).agents.length,0);
});

test('all 24 space combinations retain independent local or remote collaboration, tool and Slack facts', () => {
  const combinations = makePanelMatrix(NOW);
  assert.equal(combinations.length, 24);
  assert.equal(new Set(combinations.map(item => item.name)).size, 24);
  for (const { options, feed } of combinations) {
    const actual = cleanPanelFeed(feed).spaces[0];
    assert.equal(actual.share?.kind ?? 'none', options.share === 'local' ? 'none' : options.share);
    const partners=panelSpacePartners(cleanPanelFeed(feed),actual.id);
    assert.equal(partners.length,options.share==='local'?1:0);
    if(options.share==='local'){
      assert.equal(feed.spaces.length,2);assert.equal(feed.spaces[0].computer,feed.spaces[1].computer);
      assert.equal(partners[0].name,'Reference workspace');assert.notEqual(actual.id,partners[0].id);
      assert.equal(feed.computers[1].linked,false);
    }
    assert.equal(actual.work?.tool ?? null, options.tool);
    assert.equal(Boolean(actual.slack?.channel), options.slack);
    assert.equal(agentGroups(actual).grouped, Boolean(options.tool));
  }
});

test('malformed/versioned snapshots are rejected, previous valid data survives partial writes', () => {
  const first = reconcilePanelFeed(feed(), null, { now: NOW });
  assert.equal(first.status, 'ready');
  assert.equal(first.changed, true);
  const partial = reconcilePanelFeed('{"v":1,', first, { now: NOW + 10 });
  assert.equal(partial.status, 'invalid');
  assert.equal(partial.feed, first.feed);
  assert.equal(partial.changed, false);
  const missing = reconcilePanelFeed(null, partial);
  assert.equal(missing.status, 'missing');
  assert.equal(missing.stale, false, 'the data timestamp is never treated as a heartbeat');
  assert.equal(reconcilePanelFeed(feed({ at: stamp(0) })).status, 'ready');
  for (const raw of [null, [], {}, feed({ v: 2 }), feed({ at: 'not-a-date' }), feed({ spaces: {} }), 'x'.repeat(2 * 1024 * 1024 + 1)]) assert.equal(cleanPanelFeed(raw), null);
});

test('only neutral bounded display fields survive, unknown agent state stays idle', () => {
  const raw = feed({ secret: 'private', command: 'do not execute', spaces: [space('one', {
    agents: [agent('first', { title: '\u0000 Visible\n task ', status: 'invented', stage: 90, tooltip_addr: 'demo-address', private_record: 'omit' }), agent('first'), agent('second', { family: 'other' })],
    share: { kind: 'agent', computer: 'worker', agent_id: 'missing' },
  })] });
  const value = cleanPanelFeed(raw);
  assert.equal(value.secret, undefined);
  assert.equal(value.command, undefined);
  assert.equal(value.spaces[0].agents.length, 2);
  assert.equal(value.spaces[0].agents[0].title, 'Visible  task');
  assert.equal(value.spaces[0].agents[0].status, 'idle');
  assert.equal(value.spaces[0].agents[0].stage, 0);
  assert.equal(value.spaces[0].agents[0].private_record, undefined);
  assert.equal(value.spaces[0].agents[0].tooltip_addr, null);
  assert.equal(value.spaces[0].agents[1].family, 'unknown');
  assert.equal(value.spaces[0].share, null);
  assert.equal(raw.spaces[0].agents.length, 3, 'input is never mutated');
});

test('native metadata joins only explicit navigation space ID and machine, never feed IDs or names', () => {
  const value = normalize({ spaces: [space('one', { nav: { space_id: 'native-one', machine: null } }), space('remote', { computer: 'worker', name: 'Space one', nav: { space_id: 'native-one', machine: 'Worker' } }), space('native-one', { computer: 'worker', name: 'Local native name' })] });
  const native = [{ id: 'wrong', name: 'Space one' }, { id: 'native-one', name: 'Local native name' }, { id: 'Worker/native-one', machine: 'Worker', name: 'Remote native name' }];
  assert.equal(panelSpaces(value, native, 'studio').length, 1);
  assert.equal(panelSpaces(value, native, 'studio')[0].native.name, 'Local native name');
  assert.equal(panelSpaces(value, native, 'worker')[0].native.name, 'Remote native name');
  assert.equal(panelSpaces(value, native, 'worker')[1].native, null);
  assert.deepEqual(panelSpaces(value, native, 'absent'), []);
  assert.equal(panelSpaces(value, [...native, { id: 'native-one', name: 'Ambiguous duplicate' }], 'studio')[0].native, null);
});

test('flat agents sort blocked, working, review, waiting and done; producer recency order stays stable', () => {
  const item = normalize({ spaces: [space('one', { agents: [
    agent('done', { status: 'done', at: NOW + 99 }), agent('waiting', { status: 'idle' }),
    agent('review', { status: 'idle', stage: 3 }), agent('newer'),
    agent('older'), agent('blocked', { status: 'blocked' }),
  ] })] }).spaces[0];
  const group = agentGroups(item);
  assert.deepEqual(group.agents.map(a => a.id), ['blocked', 'newer', 'older', 'review', 'waiting', 'done']);
  assert.equal(group.hidden, 0);
  assert.equal(agentState(item.agents.find(a => a.id === 'review')), 'review');
  assert.equal(agentState(item.agents.find(a => a.id === 'waiting')), 'waiting');
});

test('tool issue groups use the same priority order and keep unassigned agents last', () => {
  const states = ['done', 'waiting', 'review', 'working', 'blocked'];
  const item = normalize({ spaces: [space('one', {
    work: { tool: 'jira', key: 'OPS', open: 5 },
    issues: states.map((state, index) => ({ key: `OPS-${index}`, title: state, state, at: NOW + index })),
    agents: [...states.map((state, index) => agent(`agent-${index}`, { issue: `OPS-${index}` })), agent('unassigned', { issue: 'gone' })],
  })] }).spaces[0];
  const result = agentGroups(item);
  assert.equal(result.grouped, true);
  assert.deepEqual(result.groups.map(group => group.issue?.state ?? null), ['blocked', 'working', 'review', null]);
  assert.equal(result.groupsHidden,2);
  const expanded=agentGroups(item,{expandedIssueSpaces:new Set(['one'])});
  assert.deepEqual(expanded.groups.map(group=>group.issue?.state??null),['blocked','working','review','waiting','done',null]);
  assert.equal(expanded.issuesExpanded,true);assert.equal(expanded.groupsHidden,0);
  assert.deepEqual(result.groups.at(-1).agents.map(a => a.id), ['unassigned']);
});

test('root agent rows are never truncated inside an issue', () => {
  for (const size of [3, 4, 5, 9]) {
    const item = normalize({ spaces: [space('one', { work: { tool: 'linear', key: 'ENG' }, issues: [{ key: 'ENG-1', title: 'Example', state: 'working' }], agents: Array.from({ length: size }, (_, n) => agent(`agent-${n}`, { issue: 'ENG-1' })) })] }).spaces[0];
    const group = agentGroups(item).groups[0];
    assert.equal(group.agents.length, size);
    assert.equal(group.hidden, 0);
  }
});

test('closed phase four is removed after its last tag; blocked close stays visible with reason', () => {
  const item = normalize({ spaces: [space('one', { agents: [agent('closed', { closing: { step: 4 } }), agent('blocked-close', { closing: { step: 4, blocked_reason: 'Save needs confirmation' } })] })] }).spaces[0];
  assert.deepEqual(agentGroups(item).agents.map(a => a.id), ['blocked-close']);
  assert.deepEqual(agentGroups(item, { includeClosedIds: new Set(['closed']) }).agents.map(a => a.id), ['blocked-close', 'closed']);
  assert.equal(agentState(item.agents[1]), 'blocked');
  assert.equal(item.agents[1].closing.blocked_reason, 'Save needs confirmation');
});

test('all four closing phases retain producer state and only the explicit final phase is hidden', () => {
  const item = normalize({ spaces: [space('one', { agents: [1, 2, 3, 4].map(step => agent(`close-${step}`, { closing: { step, blocked_reason: null } })) })] }).spaces[0];
  assert.deepEqual(item.agents.map(a => a.closing.step), [1, 2, 3, 4]);
  assert.deepEqual(agentGroups(item).agents.map(a => a.id), ['close-1', 'close-2', 'close-3']);
});

test('task links and events retain exact existing endpoints and discard invented relationships', () => {
  const result = normalize({ spaces: [space('one', { agents: [agent('implementer'), agent('reviewer')] })],
    links: [{ a: 'implementer', b: 'reviewer', kind: 'task' }, { a: 'implementer', b: 'missing', kind: 'task' }, { a: 'implementer', b: 'implementer', kind: 'task' }],
    events: [{ id: 'memory-event', at: NOW, kind: 'memory', from: 'implementer', to: 'one', label: 'Memory proposal' }, { id: 'unknown-end', at: NOW, kind: 'message', from: 'missing', to: null }],
  });
  assert.deepEqual(result.links, [{ a: 'implementer', b: 'reviewer', kind: 'task' }]);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].to, 'one');
  assert.equal(result.events[1].from, null);
  assert.equal(result.events[1].to, null);
});

test('unmeasured computer traffic stays null while a measured zero remains zero', () => {
  const value = normalize({ computers: [{ id: 'studio', name: 'Studio', traffic: { up: null, down: 0 } }, { id: 'worker', name: 'Worker' }, { id: 'mobile', name: 'Mobile', traffic: { up: 2.5, down: 'unknown' } }] });
  assert.deepEqual(value.computers[0].traffic, { up: null, down: 0 });
  assert.deepEqual(value.computers[1].traffic, { up: null, down: null });
  assert.deepEqual(value.computers[2].traffic, { up: 2.5, down: null });
});

test('initial feed is only a watermark, a newly observed ID plays once', () => {
  const event = { id: 'send', at: NOW, kind: 'message', from: 'one-agent', to: 'one', label: 'Message' };
  const historical = normalize({ events: [event] });
  const state = boot(historical);
  assert.equal(state.active.length, 0);
  assert.equal(advance(historical, state, 10).active.length, 0);
  const initial = boot(normalize({ events: [] }));
  const active = advance(historical, initial, 10);
  assert.equal(active.active.length, 1);
  assert.equal(advance(historical, active, 100).pending.length, 1, 'same ID does not start twice');
  assert.equal(advance(historical, active, 3010).active.length, 0);
});

test('distribution, review, verdict, acceptance and closing labels occupy the same finite tag slot', () => {
  for (const kind of ['dispatch', 'review_request', 'verdict', 'accept', 'close_step', 'memory']) {
    const value = normalize({ events: [{ id: `event-${kind}`, at: NOW, kind, from: 'one-agent', to: 'one', label: `Label ${kind}` }] });
    const started = advance(value, boot(normalize({ events: [] })), 0);
    assert.equal(started.tags.get('one-agent').label, `Label ${kind}`);
    assert.equal(advance(value, started, 1699).tags.has('one-agent'), true);
    assert.equal(advance(value, started, 1700).tags.size, 0);
    assert.equal(value.spaces[0].agents[0].title, 'Task one-agent', 'a tag never rewrites the task title');
  }
});

test('dispatch/new session, packet arrival and fade have finite boundaries, tags stay 1700ms', () => {
  const value = normalize({ events: [{ id: 'spawn', at: NOW, kind: 'spawn', from: 'one', to: 'one-agent', label: 'New task' }] });
  let state = boot(normalize({ events: [] }));
  const checks = [[0, 'start', 40], [40, 'travel', 1640], [1640, 'ping', 1700], [1700, 'ping', 2100], [2100, 'fade', 3000]];
  for (const [at, phase, next] of checks) {
    state = advance(value, state, at);
    assert.equal(state.packets[0].phase, phase);
    assert.equal(state.nextAt, NOW + next);
    assert.equal(state.tags.has('one-agent'), at < 1700);
    assert.equal(state.spawning.has('one-agent'), at < 1700);
  }
  assert.equal(advance(value, state, 3000).nextAt, null);
});

test('motion off keeps tags, static connections and terminal state but emits no moving packets', () => {
  const value = normalize({ events: [{ id: 'review', at: NOW, kind: 'review_request', from: 'one-agent', to: 'one', label: 'Review requested' }, { id: 'message', at: NOW, kind: 'message', from: 'one-agent', to: 'one', label: 'Sent' }] });
  const state = advance(value, boot(normalize({ events: [] })), 200, false);
  assert.equal(state.packets.length, 0);
  assert.equal(state.connections.length, 1);
  assert.equal(state.tags.get('one-agent').label, 'Sent');
  assert.equal(state.nextAt, NOW + 1900);
  const end = advance(value, state, 1900, false);
  assert.equal(end.tags.size, 0);
  assert.equal(end.packets.length, 0);
});

test('delayed polling starts a new packet at observation time without changing source data', () => {
  const value = normalize({ events: [{ id: 'delayed', at: NOW - 1000, kind: 'message', from: 'one-agent', to: 'one', label: 'New message' }] });
  const before = JSON.stringify(value);
  const state = advance(value, boot(normalize({ events: [] })), 1000);
  assert.equal(state.packets[0].phase, 'start');
  assert.equal(state.packets[0].at, NOW + 1000);
  assert.equal(state.packets[0].sourceAt, NOW - 1000);
  assert.equal(state.nextAt, NOW + 1040);
  assert.equal(JSON.stringify(value), before);
});

test('unknown ordering and tag hints are ignored rather than creating an extra data contract', () => {
  const value = normalize({ spaces: [space('one', { agents: [agent('first', { at: NOW, updated_at: NOW, state: 'blocked' }), agent('second')] })], events: [{ id: 'hint', at: NOW, kind: 'dispatch', from: 'first', to: 'second', label: 'Task sent', tag_agent: 'second' }] });
  assert.equal(Object.hasOwn(value.spaces[0].agents[0], 'at'), false);
  assert.equal(Object.hasOwn(value.spaces[0].agents[0], 'state'), false);
  assert.deepEqual(agentGroups(value.spaces[0]).agents.map(a => a.id), ['first', 'second']);
  const state = advance(value, boot(normalize({ events: [] })), 0);
  assert.equal(state.tags.has('first'), true);
  assert.equal(state.tags.has('second'), false);
});

test('shared UI fixture sequence is deterministic, schema-shaped and does not mutate earlier frames', () => {
  let current = makePanelFixture({ share: 'agent', tool: 'jira', slack: true, now: NOW, motion: false });
  assert.deepEqual(current.events, []);
  assert.equal(Object.hasOwn(current, 'motion'), false);
  const ids = [];
  for (const [index, transition] of eventSequence.entries()) {
    const before = JSON.stringify(current);
    const expected = transition.apply(current, NOW + index * 5000);
    assert.deepEqual(transition.apply(current, NOW + index * 5000), expected);
    assert.equal(JSON.stringify(current), before, `${transition.name} mutates its input`);
    const clean = cleanPanelFeed(expected);
    assert.ok(clean, transition.name);
    assert.equal(clean.events.length, expected.events.length, transition.name);
    const last = clean.events.at(-1);
    assert.match(last.id, /^e-[0-9a-f]{16}$/);
    assert.ok(last.from && last.to, `${transition.name} endpoints exist`);
    ids.push(last.id);
    for (const computer of clean.computers) assert.match(computer.id, /^c-[0-9a-f]{16}$/);
    for (const space of clean.spaces) {
      assert.match(space.id, /^s-[0-9a-f]{16}$/);
      assert.match(space.bundle, /^b-[0-9a-f]{16}$/);
      for (const agent of space.agents) { assert.match(agent.id, /^a-[0-9a-f]{16}$/); assert.equal(agent.tooltip_addr, null); }
    }
    current = expected;
  }
  assert.equal(new Set(ids).size, eventSequence.length);
  assert.equal(current.spaces[0].memory.proposals, 1);
  assert.equal(current.spaces[1].computer, PANEL_IDS.worker);
});

test('shared sorting, no-issue, overflow and remote fixtures exercise the actual grouping model', () => {
  const sorting = cleanPanelFeed(makePanelScenario('sorting', { now: NOW })).spaces[0];
  assert.deepEqual(agentGroups(sorting,{expandedIssueSpaces:new Set([sorting.id])}).groups.map(group => group.issue?.state ?? null), ['blocked', 'working', 'review', 'waiting', 'done', null]);
  const noIssue = cleanPanelFeed(makePanelScenario('no-issue', { now: NOW })).spaces[0];
  assert.equal(agentGroups(noIssue).groups.at(-1).issue, null);
  assert.equal(agentGroups(noIssue).groups.at(-1).agents.length, 3);
  const overflow = cleanPanelFeed(makePanelScenario('overflow', { now: NOW })).spaces[0];
  assert.equal(agentGroups(overflow).agents.length, 7);
  assert.equal(agentGroups(overflow).hidden, 0);
  for (const name of ['cross-space', 'cross-computer']) {
    const value = cleanPanelFeed(makePanelScenario(name, { now: NOW }));
    assert.equal(value.spaces.length, 2);
    assert.equal(value.spaces.flatMap(space => space.agents).length, 3);
    assert.equal(value.spaces[1].computer, name === 'cross-space' ? PANEL_IDS.studio : PANEL_IDS.worker);
    assert.equal(value.links.length, 1);
  }
});

test('navigation is explicit, bounded and contains only native target fields', () => {
  const value = normalize({ spaces: [space('one', {
    nav: { space_id: 'native-space', machine: null, command: 'ignored', name: 'ignored' },
    agents: [agent('one-agent', { nav: { pane_id: 'native-pane', machine: 'Worker', script: 'ignored' } })],
  })] });
  assert.deepEqual(value.spaces[0].nav, { space_id: 'native-space', machine: null });
  assert.deepEqual(value.spaces[0].agents[0].nav, { pane_id: 'native-pane', machine: 'Worker' });
  for (const nav of [null, {}, { space_id: 'native-space' }, { space_id: '', machine: null }, { space_id: 'has whitespace', machine: null }, { space_id: 'native-space', machine: 3 }, { space_id: 'native-space', machine: ' Worker' }, { space_id: 'native-space', machine: 'Worker\ncommand' }, { space_id: 'x'.repeat(161), machine: null }]) {
    assert.equal(normalize({ spaces: [space('one', { nav })] }).spaces[0].nav, null);
  }
});

test('reduced motion is nullable display data and combines with the local motion switch', () => {
  const event = { id: 'motion-event', at: NOW, kind: 'message', from: 'one-agent', to: 'one', label: 'Sent' };
  for (const [reduced_motion, setting, expected] of [[true, true, false], [false, true, true], [null, true, true], [false, false, false]]) {
    const value = normalize({ reduced_motion, events: [event] });
    assert.equal(value.reduced_motion, reduced_motion);
    const state = advance(value, boot(normalize({ events: [] })), 0, setting);
    assert.equal(state.motion, expected);
    assert.equal(state.packets.length > 0, expected);
    assert.equal(state.tags.size, 1);
  }
  assert.equal(normalize({ reduced_motion: 'true' }).reduced_motion, null);
  const fixture = makePanelFixture({ now: NOW, reduced_motion: true, nav: { space_id: 'native-demo-space', machine: null }, agents: [{ title: 'Demo task', nav: { pane_id: 'native-demo-pane', machine: null } }] });
  assert.equal(cleanPanelFeed(fixture).reduced_motion, true);
  assert.equal(cleanPanelFeed(fixture).spaces[0].agents[0].nav.pane_id, 'native-demo-pane');
});

function manySpaces() {
  return makePanelLoadFixture({ now: NOW });
}

test('20-space/60-agent projection reuses every unchanged entity and grouping result', () => {
  const raw = manySpaces();
  const first = projectPanelFeed(cleanPanelFeed(raw));
  assert.equal(first.stats.agentsChanged, 60);
  assert.equal(first.stats.spacesChanged, 20);
  assert.equal(first.stats.groupsComputed, 20);
  const same = projectPanelFeed(cleanPanelFeed(JSON.parse(JSON.stringify(raw))), first);
  assert.equal(same.feed, first.feed);
  assert.equal(same.spaces, first.spaces);
  assert.equal(same.agents, first.agents);
  assert.equal(same.groups, first.groups);
  assert.equal(same.stats.agentsReused, 60);
  assert.equal(same.stats.groupsComputed, 0);
  raw.at = stamp(NOW + 100);
  raw.spaces[7].agents[1].status = 'blocked';
  const changed = projectPanelFeed(cleanPanelFeed(raw), same);
  assert.equal(changed.stats.agentsChanged, 1);
  assert.equal(changed.stats.agentsReused, 59);
  assert.equal(changed.stats.spacesChanged, 1);
  assert.equal(changed.stats.spacesReused, 19);
  assert.equal(changed.stats.groupsComputed, 1);
  assert.equal(changed.stats.groupsReused, 19);
  for (let index = 0; index < 20; index++) {
    assert.equal(changed.spaces[index] === first.spaces[index], index !== 7);
    assert.equal(changed.groups.get(changed.spaces[index].id) === first.groups.get(first.spaces[index].id), index !== 7);
    for (let a = 0; a < 3; a++) assert.equal(changed.spaces[index].agents[a] === first.spaces[index].agents[a], index !== 7 || a !== 1);
  }
  assert.equal(first.spaces[7].agents[1].status, 'working', 'earlier projection stays immutable');
});

test('only the closed-row visibility group changes at a finite tag boundary', () => {
  const raw = manySpaces();
  raw.spaces[3].agents[0].closing = { step: 4, blocked_reason: null };
  const clean = cleanPanelFeed(raw), first = projectPanelFeed(clean);
  const closed = raw.spaces[3].agents[0].id;
  const tagged = projectPanelFeed(clean, first, { includeClosedIds: new Set([closed]) });
  assert.equal(tagged.feed, first.feed);
  assert.equal(tagged.stats.agentsChanged, 0);
  assert.equal(tagged.stats.spacesChanged, 0);
  assert.equal(tagged.stats.groupsComputed, 1);
  assert.equal(tagged.stats.groupsReused, 19);
  assert.equal(tagged.groups.get(raw.spaces[3].id).agents.some(agent => agent.id === closed), true);
  const expired = projectPanelFeed(clean, tagged);
  assert.equal(expired.stats.groupsComputed, 1);
  assert.equal(expired.groups.get(raw.spaces[3].id).agents.some(agent => agent.id === closed), false);
});

test('projection factory retains cached derivations until an explicit reset', () => {
  const projection = createPanelProjection(), clean = cleanPanelFeed(makePanelFixture({ now: NOW }));
  const first = projection.project(clean);
  const second = projection.project(clean);
  assert.equal(second.feed, first.feed);
  assert.equal(second.stats.groupsComputed, 0);
  assert.equal(second.stats.signaturesComputed, 0, 'immutable source identity skips signatures on redraw');
  projection.reset();
  assert.notEqual(projection.project(clean).feed, first.feed);
});

test('a newly observed old-timestamp event plays once but initial history remains only a watermark', () => {
  const value = normalize({ events: [{ id: 'late-observation', at: stamp(0), kind: 'message', from: 'one-agent', to: 'one', label: 'Delivered' }] });
  assert.equal(boot(value).packets.length, 0);
  const observed = advance(value, boot(normalize({ events: [] })), 0);
  assert.equal(observed.packets[0].phase, 'start');
  assert.equal(observed.packets[0].sourceAt, 0);
  assert.equal(advance(value, observed, 3000).active.length, 0);
  assert.equal(advance(value, observed, 5000).active.length, 0);
});

test('shared 20-space load fixture has 60 unique rows and a single visible change marker', () => {
  const first = makePanelLoadFixture({ now: NOW, reduced_motion: true });
  assert.equal(first.spaces.length, 20);
  const agents = first.spaces.flatMap(space => space.agents);
  assert.equal(agents.length, 60);
  assert.equal(new Set(agents.map(agent => agent.id)).size, 60);
  assert.equal(new Set(first.spaces.map(space => space.id)).size, 20);
  assert.equal(agents[0].title, 'Load 0000');
  assert.equal(first.reduced_motion, true);
  const changed = makePanelLoadFixture({ now: NOW, reduced_motion: true, changedRow: 23, marker: 'Load UPDATED 0023' });
  const changedAgents = changed.spaces.flatMap(space => space.agents);
  assert.deepEqual(changedAgents.filter((agent, index) => JSON.stringify(agent) !== JSON.stringify(agents[index])).map(agent => agent.title), ['Load UPDATED 0023']);
  assert.equal(makePanelLoadFixture({ now: NOW, marker: 'Load VISIBLE UPDATE' }).spaces[0].agents[0].title, 'Load VISIBLE UPDATE');
  assert.equal(makePanelLoadFixture({ now: NOW, status: 'idle' }).spaces[0].agents[0].status, 'idle');
});

test('typed projection never parses JSON, including changed nested display data', () => {
  const raw = makePanelLoadFixture({ now: NOW });
  raw.spaces[0].nav = { space_id: 'demo-native-space', machine: null };
  raw.spaces[0].agents[0].nav = { pane_id: 'demo-native-pane', machine: null };
  raw.spaces[0].agents[0].closing = { step: 1, blocked_reason: null };
  raw.spaces[0].slack = { channel: 'demo-room' };
  raw.spaces[0].work = { tool: 'linear', key: 'DEMO', open: 1 };
  raw.spaces[0].issues = [{ key: 'DEMO-1', title: 'Demo issue', state: 'working' }];
  const firstInput = cleanPanelFeed(raw);
  const changedRaw = JSON.parse(JSON.stringify(raw));
  changedRaw.at = stamp(NOW + 10);
  changedRaw.spaces[0].agents[0].closing.step = 2;
  changedRaw.spaces[0].agents[0].nav.pane_id = 'demo-other-pane';
  const changedInput = cleanPanelFeed(changedRaw), sameInput = cleanPanelFeed(changedRaw);
  const parse = JSON.parse;
  JSON.parse = () => { throw new Error('Projection attempted JSON parsing'); };
  try {
    const first = projectPanelFeed(firstInput);
    const changed = projectPanelFeed(changedInput, first);
    const same = projectPanelFeed(sameInput, changed);
    assert.equal(changed.stats.agentsReused, 59);
    assert.equal(changed.stats.spacesReused, 19);
    assert.equal(changed.stats.groupsComputed, 1);
    assert.equal(same.feed, changed.feed);
    assert.equal(same.stats.groupsComputed, 0);
    assert.equal(first.spaces[0].agents[0].closing.step, 1);
    assert.equal(first.spaces[0].agents[0].nav.pane_id, 'demo-native-pane');
    assert.equal(changed.spaces[0].agents[0].closing.step, 2);
    assert.equal(changed.spaces[0].agents[0].nav.pane_id, 'demo-other-pane');
    assert.notEqual(first.spaces[0].agents[0].closing, firstInput.spaces[0].agents[0].closing);
    assert.notEqual(first.spaces[0].nav, firstInput.spaces[0].nav);
    assert.notEqual(first.spaces[0].slack, firstInput.spaces[0].slack);
    assert.notEqual(first.spaces[0].work, firstInput.spaces[0].work);
    assert.notEqual(first.spaces[0].issues[0], firstInput.spaces[0].issues[0]);
    assert.notEqual(first.feed.computers[0].traffic, firstInput.computers[0].traffic);
  } finally {
    JSON.parse = parse;
  }
});

test('optional extension fields leave older v1 object shapes unchanged', () => {
  const raw = feed({spaces:[space('one',{agents:[agent('first',{closing:{step:1,blocked_reason:null}})]})],events:[{id:'event',at:stamp(NOW),kind:'close_step',from:'first',to:null,label:'Closing'}]});
  const value=cleanPanelFeed(raw), projected=projectPanelFeed(value).feed;
  assert.deepEqual(projected,value);
  assert.deepEqual(Object.keys(value.spaces[0].agents[0]),['id','family','title','stage','status','issue','closing','tooltip_addr','nav']);
  assert.deepEqual(Object.keys(value.spaces[0].agents[0].closing),['step','blocked_reason']);
  assert.equal(Object.hasOwn(value.spaces[0],'issue_catalog'),false);
  assert.deepEqual(Object.keys(value.events[0]),['id','at','kind','from','to','label']);
});

test('optional parent relations preserve globally known forward references and reject self or missing IDs', () => {
  const raw=feed({spaces:[space('one',{agents:[agent('child',{parent_id:'parent',subagent_kind:'task'}),agent('parent',{parent_id:'parent',subagent_kind:'agent'}),agent('orphan',{parent_id:'remote'}),agent('invalid',{parent_id:{id:'parent'},subagent_kind:'private'})]}),space('two',{agents:[agent('remote')]})]});
  const agents=cleanPanelFeed(raw).spaces[0].agents;
  assert.equal(agents[0].parent_id,'parent');assert.equal(agents[0].subagent_kind,'task');
  assert.equal(agents[1].parent_id,null);assert.equal(agents[1].subagent_kind,'agent');
  assert.equal(agents[2].parent_id,'remote');assert.equal(agentGroups(cleanPanelFeed(raw).spaces[0]).rowMeta.get('orphan').parent,null);
  assert.equal(agents[3].parent_id,null);assert.equal(agents[3].subagent_kind,null);
  assert.equal(raw.spaces[0].agents[1].parent_id,'parent','sanitization never mutates input relations');
});

test('allocation and closing memory details are bounded optional display data', () => {
  const value=normalize({spaces:[space('one',{agents:[agent('first',{closing:{step:3,memory:{state:'proposed',proposals:2,private:'omit'}}})]})],events:[
    {id:'existing',at:stamp(NOW),kind:'dispatch',from:'first',to:null,allocation:{kind:'existing',count:4}},
    {id:'new',at:stamp(NOW),kind:'spawn',from:null,to:'first',allocation:{kind:'new',count:999999}},
    {id:'close',at:stamp(NOW),kind:'close_step',from:'first',to:null,step:2,memory:{state:'saved',proposals:0}},
    {id:'invalid',at:stamp(NOW),kind:'close_step',from:'first',to:null,step:7,memory:{state:'unknown',proposals:-1},allocation:{kind:'unknown',count:2}},
  ]});
  assert.deepEqual(value.spaces[0].agents[0].closing.memory,{state:'proposed',proposals:2});
  assert.deepEqual(value.events[0].allocation,{kind:'existing',count:4});assert.equal(value.events[1].allocation.count,9999);
  assert.equal(value.events[2].step,2);assert.deepEqual(value.events[2].memory,{state:'saved',proposals:0});
  assert.equal(value.events[3].step,null);assert.equal(value.events[3].memory,null);assert.equal(value.events[3].allocation,null);
  assert.deepEqual(projectPanelFeed(value).feed,value);
});

test('issue catalog scopes have independent bounds and only an exact neutral import target survives', () => {
  const issues=Array.from({length:2050},(_,index)=>({key:`DEMO-${index}`,title:`Demo ${index}`,state:'working',private:'omit'}));
  const value=normalize({spaces:[space('one',{issues,issue_catalog:{week:issues,milestone:[{key:'DEMO-X',title:'Milestone',state:'unknown'}],all:issues,import_request:{path:'panel-issue-requests',space:'one',command:'omit'}}}),space('two',{issue_catalog:{week:[],milestone:null,all:[],import_request:{path:'../escape',space:'two'}}}),space('three',{issue_catalog:{import_request:{path:'panel-issue-requests',space:'one'}}})]});
  const catalog=value.spaces[0].issue_catalog;
  assert.equal(value.spaces[0].issues.length,128);assert.equal(catalog.week.length,2048);assert.equal(catalog.all.length,2048);
  assert.deepEqual(catalog.milestone,[{id:'DEMO-X',key:'DEMO-X',title:'Milestone',state:'waiting'}]);
  assert.deepEqual(catalog.import_request,{path:'panel-issue-requests',space:'one'});
  assert.equal(value.spaces[1].issue_catalog.import_request,null);assert.deepEqual(value.spaces[1].issue_catalog.milestone,[]);
  assert.equal(value.spaces[2].issue_catalog.import_request,null);
});

test('extended projection copies typed data and reuses every unaffected entity and group', () => {
  const raw=makePanelLoadFixture({now:NOW});
  const firstSpace=raw.spaces[0], child=firstSpace.agents[0],parent=firstSpace.agents[1];
  child.parent_id=parent.id;child.subagent_kind='agent';child.closing={step:2,memory:{state:'pending',proposals:0}};
  firstSpace.issue_catalog={week:[],milestone:[],all:[{key:'DEMO-1',title:'Demo catalog',state:'waiting'}],import_request:{path:'panel-issue-requests',space:firstSpace.id}};
  raw.events=[{id:'extension-event',kind:'close_step',at:stamp(NOW),from:child.id,to:null,step:2,memory:{state:'pending',proposals:0},allocation:{kind:'existing',count:1}}];
  const before=cleanPanelFeed(raw),first=projectPanelFeed(before);
  raw.spaces[0].agents[0].closing.memory.state='saved';raw.events[0].memory.state='saved';
  const incoming=cleanPanelFeed(raw),parse=JSON.parse;
  JSON.parse=()=>{throw new Error('Typed projection parsed JSON');};
  try{
    const changed=projectPanelFeed(incoming,first),same=projectPanelFeed(cleanPanelFeed(raw),changed);
    assert.equal(changed.stats.agentsReused,59);assert.equal(changed.stats.spacesReused,19);assert.equal(changed.stats.groupsComputed,1);
    assert.equal(same.feed,changed.feed);assert.equal(same.stats.groupsComputed,0);
    assert.equal(first.spaces[0].agents[0].closing.memory.state,'pending');assert.equal(changed.spaces[0].agents[0].closing.memory.state,'saved');
    assert.notEqual(first.spaces[0].agents[0].closing.memory,before.spaces[0].agents[0].closing.memory);
    assert.notEqual(first.spaces[0].issue_catalog.all[0],before.spaces[0].issue_catalog.all[0]);
    assert.notEqual(first.feed.events[0].memory,before.events[0].memory);assert.notEqual(first.feed.events[0].allocation,before.events[0].allocation);
  }finally{JSON.parse=parse;}
});

test('only issue groups overflow, with unassigned rows outside the issue count',()=>{
  for(const size of [4,5,9]){
    const item=normalize({spaces:[space('one',{work:{tool:'linear',key:'DEMO'},issues:Array.from({length:size},(_,i)=>({key:`DEMO-${i}`,title:'Demo',state:'working'})),agents:[agent('unassigned')]})]}).spaces[0];
    const result=agentGroups(item),expanded=agentGroups(item,{expandedIssueSpaces:new Set(['one'])});
    assert.equal(result.groups.length,(size>4?3:size)+1);assert.equal(result.issueHidden,size>4?size-3:0);
    assert.equal(result.groups.at(-1).issue,null);assert.equal(expanded.groups.length,size+1);assert.equal(expanded.groupsExpandable,size>4);
  }
});

test('parent trees stay inside issue buckets and fold after the last visible descendant',()=>{
  const item=normalize({spaces:[space('one',{work:{tool:'jira',key:'DEMO'},issues:[{key:'DEMO-1',state:'working'},{key:'DEMO-2',state:'working'}],agents:[
    agent('root',{issue:'DEMO-1'}),...Array.from({length:5},(_,i)=>agent(`child${i}`,{issue:'DEMO-1',parent_id:'root'})),
    agent('grandchild',{issue:'DEMO-1',parent_id:'child2'}),agent('cross',{issue:'DEMO-2',parent_id:'root'}),
    agent('cycle1',{issue:'DEMO-2',parent_id:'cycle2'}),agent('cycle2',{issue:'DEMO-2',parent_id:'cycle1'}),
  ]})]}).spaces[0];
  const result=agentGroups(item),group=result.groups[0];
  assert.deepEqual(group.agents.map(agent=>agent.id),['root','child0','child1','child2','grandchild']);
  assert.deepEqual(group.rowMeta.get('grandchild'),{depth:2,parent:'child2',childCount:0});
  assert.deepEqual(group.folds,[{parent:'root',after:'grandchild',hidden:2,count:5,expanded:false}]);
  assert.equal(result.rowMeta.get('cross').parent,null);assert.equal(result.rowMeta.get('cycle1').parent,null);
  const expanded=agentGroups(item,{expandedParents:new Set(['root'])});
  assert.equal(expanded.groups[0].agents.length,7);assert.equal(expanded.groups[0].folds[0].expanded,true);
  assert.equal(item.agents.length,10,'source rows remain complete');
});

test('completed children leave both expanded rows and collapsed branch counts',()=>{
  const initial=space('one',{agents:[agent('root'),...Array.from({length:6},(_,i)=>agent(`child${i}`,{parent_id:'root'}))]});
  assert.equal(agentGroups(initial).folds[0].hidden,3);
  const next={...initial,agents:initial.agents.map(row=>row.id==='child0'?{...row,status:'done'}:row.id==='child1'?{...row,stage:5}:row)};
  const collapsed=agentGroups(next),expanded=agentGroups(next,{expandedParents:new Set(['root'])});
  assert.equal(collapsed.rowMeta.get('root').childCount,4);assert.equal(collapsed.hidden,0);assert.equal(collapsed.folds.length,0);
  assert.deepEqual(expanded.agents.map(row=>row.id),['root','child2','child3','child4','child5']);
  assert.equal(initial.agents[1].status,'working');assert.equal(next.agents.length,7,'display filtering does not change the producer snapshot');
});

test('completion filtering preserves independent roots, blocked work and active descendants',()=>{
  const item=space('one',{work:{tool:'linear'},issues:[{key:'DEMO-1'},{key:'DEMO-2'}],agents:[
    agent('root',{issue:'DEMO-1',stage:5,status:'done'}),
    agent('ended',{issue:'DEMO-1',parent_id:'root',stage:5,status:'done'}),
    agent('active-leaf',{issue:'DEMO-1',parent_id:'ended'}),
    agent('blocked-end',{issue:'DEMO-1',parent_id:'root',stage:5,status:'done',closing:{step:3,blocked_reason:'Save pending'}}),
    agent('cross-issue',{issue:'DEMO-2',parent_id:'root',stage:5,status:'done'}),
    agent('orphan',{issue:'DEMO-2',parent_id:'absent',stage:5,status:'done'}),
  ]});
  const result=agentGroups(item,{includeClosedIds:new Set(['ended'])});
  assert(!result.agents.some(row=>row.id==='ended'),'a completion tag cannot restore an ended child');
  for(const id of ['root','active-leaf','blocked-end','cross-issue','orphan'])assert(result.agents.some(row=>row.id===id));
  assert.equal(result.rowMeta.get('active-leaf').parent,null);assert.equal(result.rowMeta.get('cross-issue').parent,null);
  const closed=space('closed',{agents:[agent('parent',{closing:{step:4},stage:5,status:'done'}),agent('child',{parent_id:'parent',stage:5,status:'done'})]});
  assert.equal(agentGroups(closed).agents.length,0,'an already hidden parent does not resurrect its completed child as a root');
});

test('issue and parent expansion recompute only the owning space with stable feed references',()=>{
  const raw=makePanelLoadFixture({now:NOW}),target=raw.spaces[0];
  target.work={tool:'linear',key:'DEMO'};target.issues=Array.from({length:5},(_,i)=>({key:`DEMO-${i}`,state:'working'}));
  target.agents[0].issue='DEMO-0';
  const parent=target.agents[0].id;
  for(let i=0;i<5;i++)target.agents.push(agent(`extra${i}`,{issue:'DEMO-0',parent_id:parent}));
  const input=cleanPanelFeed(raw),first=projectPanelFeed(input);
  const parents=new Set([parent]),expanded=projectPanelFeed(input,first,{expandedParents:parents});
  assert.equal(expanded.stats.groupsComputed,1);assert.equal(expanded.stats.spacesChanged,0);assert.equal(expanded.feed,first.feed);
  assert.notEqual(expanded.groups.get(target.id),first.groups.get(target.id));assert.equal(expanded.groups.get(raw.spaces[1].id),first.groups.get(raw.spaces[1].id));
  const issues=new Set([target.id]),both=projectPanelFeed(input,expanded,{expandedParents:parents,expandedIssueSpaces:issues});
  assert.equal(both.stats.groupsComputed,1);assert.equal(both.groups.get(target.id).issuesExpanded,true);
  const same=projectPanelFeed(input,both,{expandedParents:new Set([parent,'not-present']),expandedIssueSpaces:issues});
  assert.equal(same.stats.groupsComputed,0);assert.equal(same.stats.signaturesComputed,0);
  const collapsed=projectPanelFeed(input,both);
  assert.equal(collapsed.stats.groupsComputed,1);assert.equal(collapsed.groups.get(target.id).issueHidden,2);
});

test('candidate issue catalog metadata is bounded display data and omitted fields stay absent',()=>{
  const raw=feed({spaces:[space('one',{issues:[{key:'DEMO-1',title:'Demo',state:'working',week:true,pinned:true,milestone_id:'m-demo'}],issue_catalog:{
    week:[{key:'DEMO-1',week:'true',pinned:1,milestone_id:'bad id'}],all:[],milestone:[],
    milestones:[{id:'m-demo',name:' Demo\n milestone ',due:'2026-11-20',progress:50,private:'omit'},{id:'m-null',name:7,due:{},progress:0}],updated_at:'2026-11-07T00:00:00Z',
    results:[{id:'r-one',space:'one',status:'imported',keys:['DEMO-1'],message:'Imported'},{id:'r-two',space:'one',status:'rejected',keys:['DEMO-2'],message:' Not\n available '},{id:'wrong-space',space:'two',status:'imported'},{id:'bad',space:'one',status:'unknown'}],
    requests:[{id:'obsolete',status:'done'}],
  }})]});
  const value=cleanPanelFeed(raw),catalog=value.spaces[0].issue_catalog;
  assert.deepEqual(value.spaces[0].issues[0],{id:'DEMO-1',key:'DEMO-1',title:'Demo',state:'working',week:true,pinned:true,milestone_id:'m-demo'});
  assert.equal(catalog.week[0].week,false);assert.equal(catalog.week[0].pinned,false);assert.equal(catalog.week[0].milestone_id,null);
  assert.deepEqual(catalog.milestones,[{id:'m-demo',name:'Demo  milestone',due:'2026-11-20',progress:50},{id:'m-null',name:'',due:null,progress:0}]);
  assert.equal(catalog.updated_at,'2026-11-07T00:00:00Z');assert.deepEqual(catalog.results,[{id:'r-one',space:'one',status:'imported',keys:['DEMO-1'],message:'Imported'},{id:'r-two',space:'one',status:'rejected',keys:['DEMO-2'],message:'Not  available'}]);
  assert.equal(Object.hasOwn(catalog,'requests'),false);
  const projected=projectPanelFeed(value).feed;
  assert.deepEqual(projected,value);assert.notEqual(projected.spaces[0].issue_catalog.results[0],catalog.results[0]);assert.notEqual(projected.spaces[0].issue_catalog.results[0].keys,catalog.results[0].keys);
  assert.notEqual(projected.spaces[0].issue_catalog.milestones[0],catalog.milestones[0]);
  const old=normalize().spaces[0];assert.equal(Object.hasOwn(old.issues[0]??{},'week'),false);
});

test('candidate adornments sanitize malformed values and only error or missing report changes priority',()=>{
  const value=normalize({spaces:[space('one',{agents:[
    agent('error',{stage:5,status:'done',error:' Needs\n attention ',unread:999999,usage:{label:' Daily\n allowance ',limited:true,private:'omit'}}),
    agent('report',{stage:5,status:'done',report_missing:true}),agent('quota',{usage:{label:'Full',limited:true}}),
    agent('bad',{unread:-1,report_missing:'true',error:{},usage:[]} ),agent('old'),
  ]})]}).spaces[0].agents;
  assert.equal(value[0].error,'Needs  attention');assert.equal(value[0].unread,9999);
  assert.deepEqual(value[0].usage,{label:'Daily  allowance',limited:true});assert.equal(agentState(value[0]),'blocked');assert.equal(agentState(value[1]),'blocked');
  assert.equal(agentState(value[2]),'working');assert.equal(value[3].unread,0);assert.equal(value[3].report_missing,false);assert.equal(value[3].error,null);assert.equal(value[3].usage,null);
  for(const key of ['unread','report_missing','error','usage'])assert.equal(Object.hasOwn(value[4],key),false);
});

test('candidate collection limits and transient error/resume events retain finite timing',()=>{
  const raw=feed({spaces:[space('one',{issue_catalog:{week:[],milestone:[],all:[],
    milestones:Array.from({length:2050},(_,i)=>({id:`m-${i}`,name:'x'.repeat(200),due:'x'.repeat(100),progress:'x'.repeat(100)})),
    results:Array.from({length:130},(_,i)=>({id:`r-${i}`,space:'one',status:'rejected',keys:Array.from({length:51},(_,j)=>`${j}-`+'x'.repeat(100)),message:'x'.repeat(300)})),updated_at:42,
  }})]});
  const initial=cleanPanelFeed(raw),catalog=initial.spaces[0].issue_catalog;
  assert.equal(catalog.milestones.length,2048);assert.equal(catalog.results.length,128);assert.equal(catalog.milestones[0].name.length,100);assert.equal(catalog.milestones[0].due,null);assert.equal(catalog.milestones[0].progress,null);assert.equal(catalog.results[0].message.length,200);assert.equal(catalog.results[0].keys.length,50);assert.equal(catalog.results[0].keys[0].length,80);assert.equal(catalog.updated_at,null);
  raw.events=[{id:'resume',kind:'resume',at:stamp(NOW),from:'one-agent',to:null,label:'Resumed'},{id:'error',kind:'error',at:stamp(NOW+1),from:'one-agent',to:null,label:'Check required'}];
  const incoming=cleanPanelFeed(raw),state=panelEventStates(incoming,NOW+2,{previous:boot(initial),motion:false});
  assert.equal(incoming.events.length,2);assert.equal(state.tags.get('one-agent').label,'Check required');assert.equal(state.packets.length,0);
  const expired=panelEventStates(incoming,NOW+2+PANEL_TIMING.tagMs,{previous:state,motion:false});assert.equal(expired.tags.size,0);
});

test('candidate typed metadata updates preserve projection cache isolation without parsing',()=>{
  const raw=makePanelLoadFixture({now:NOW});raw.spaces[0].agents[0].usage={label:'Available',limited:false};
  raw.spaces[0].issue_catalog={week:[],milestone:[],all:[],results:[{id:'request-demo',space:raw.spaces[0].id,status:'rejected',keys:[],message:'Unavailable'}]};
  const initial=cleanPanelFeed(raw),first=projectPanelFeed(initial);
  raw.spaces[0].agents[0].unread=2;raw.spaces[0].issue_catalog.results[0].status='imported';
  const incoming=cleanPanelFeed(raw),parse=JSON.parse;JSON.parse=()=>{throw new Error('Typed candidate data parsed');};
  try{
    const changed=projectPanelFeed(incoming,first),same=projectPanelFeed(cleanPanelFeed(raw),changed);
    assert.equal(changed.stats.agentsReused,59);assert.equal(changed.stats.spacesReused,19);assert.equal(changed.stats.groupsComputed,1);assert.equal(same.stats.groupsComputed,0);
    assert.deepEqual(changed.feed,incoming);assert.notEqual(changed.spaces[0].agents[0].usage,incoming.spaces[0].agents[0].usage);
    assert.equal(first.spaces[0].issue_catalog.results[0].status,'rejected');
  }finally{JSON.parse=parse;}
});

test('memory proposal events retain general step and memory fields with detached projection copies',()=>{
  const value=normalize({events:[{id:'memory-step',kind:'memory',at:stamp(NOW),from:'one-agent',to:'one',step:3,memory:{state:'proposed',proposals:2},label:'Memory proposal'}]});
  assert.equal(value.events[0].step,3);assert.deepEqual(value.events[0].memory,{state:'proposed',proposals:2});
  const projected=projectPanelFeed(value).feed;
  assert.deepEqual(projected.events,value.events);assert.notEqual(projected.events[0].memory,value.events[0].memory);
});

test('confirmed milestone dates and numeric percentage progress reject invented values',()=>{
  const inputs=[
    {id:'valid',due:'2024-02-29',progress:50.5},{id:'century',due:'1900-02-29',progress:100},
    {id:'invalid-day',due:'2026-02-30',progress:-1},{id:'invalid-month',due:'2026-13-01',progress:101},
    {id:'string',due:'2026-1-01',progress:'3/6'},{id:'nonfinite',due:null,progress:Infinity},
    {id:'unknown',progress:null},{id:'absent'},
  ];
  const catalog=normalize({spaces:[space('one',{issue_catalog:{milestones:inputs}})]}).spaces[0].issue_catalog;
  assert.equal(catalog.milestones[0].due,'2024-02-29');assert.equal(catalog.milestones[0].progress,50.5);
  assert.equal(catalog.milestones[1].due,null);assert.equal(catalog.milestones[1].progress,100);
  for(const index of [2,3,4,5]){assert.equal(catalog.milestones[index].due,null);assert.equal(catalog.milestones[index].progress,null);}
  assert.equal(catalog.milestones[6].progress,null);assert.equal(Object.hasOwn(catalog.milestones[7],'progress'),false);assert.equal(Object.hasOwn(catalog.milestones[7],'due'),false);
});

test('confirmed catalog cache and result action metadata is detached and cache-isolated',()=>{
  const raw=makePanelLoadFixture({now:NOW}),target=raw.spaces[0];
  target.issue_catalog={cache:{state:'stale',at:stamp(NOW),scopes:{week:{state:'stale',at:stamp(NOW)},milestone:{state:'missing',at:null},all:{state:'ready',at:stamp(NOW)}}},
    results:[{id:'remove-demo',space:target.id,status:'imported',keys:['DEMO-1'],message:'Removed',action:'remove',code:'removed'}]};
  const input=cleanPanelFeed(raw),first=projectPanelFeed(input),catalog=first.spaces[0].issue_catalog;
  assert.equal(catalog.results[0].action,'remove');assert.equal(catalog.results[0].code,'removed');
  assert.notEqual(catalog.cache,input.spaces[0].issue_catalog.cache);assert.notEqual(catalog.cache.scopes.week,input.spaces[0].issue_catalog.cache.scopes.week);
  raw.spaces[0].issue_catalog.cache.scopes.week.state='ready';
  const incoming=cleanPanelFeed(raw),parse=JSON.parse;JSON.parse=()=>{throw new Error('Typed cache parsed');};
  try{
    const changed=projectPanelFeed(incoming,first);
    assert.equal(changed.stats.spacesChanged,1);assert.equal(changed.stats.groupsComputed,1);assert.equal(changed.stats.agentsReused,60);
    assert.equal(catalog.cache.scopes.week.state,'stale');assert.equal(changed.spaces[0].issue_catalog.cache.scopes.week.state,'ready');
    assert.deepEqual(changed.feed,incoming);
  }finally{JSON.parse=parse;}
  const malformed=normalize({spaces:[space('one',{issue_catalog:{cache:{state:'unknown'},results:[{id:'x',space:'one',status:'rejected',keys:[],action:'unsafe',code:'x'.repeat(100)}]}})]}).spaces[0].issue_catalog;
  assert.equal(malformed.cache,null);assert.equal(malformed.results[0].action,null);assert.equal(malformed.results[0].code.length,80);
  const partial=normalize({spaces:[space('one',{issue_catalog:{cache:{state:'empty',at:7,scopes:{week:{state:'unknown',at:null}}}}})]}).spaces[0].issue_catalog;
  assert.deepEqual(partial.cache,{state:'empty',at:null,scopes:{week:{state:'missing',at:null},milestone:{state:'missing',at:null},all:{state:'missing',at:null}}});
});

test('local collaboration links require explicit distinct space endpoints on the same known computer',()=>{
  const raw=feed({spaces:[space('one'),space('two',{name:'Partner workspace'}),space('remote',{computer:'worker'}),space('unknown',{computer:'missing'})],links:[
    {kind:'task',a:'one-agent',b:'two-agent'},
    {kind:'collaboration',a:'one',b:'two',private:'omit'},
    {kind:'collaboration',a:'two',b:'one'},
    {kind:'collaboration',a:'one',b:'one'},
    {kind:'collaboration',a:'one',b:'absent'},
    {kind:'collaboration',a:'one',b:'one-agent'},
    {kind:'collaboration',a:'one',b:'remote'},
    {kind:'collaboration',a:'one',b:'unknown'},
  ]});
  const value=cleanPanelFeed(raw);
  assert.deepEqual(value.links,[{kind:'task',a:'one-agent',b:'two-agent'},{a:'one',b:'two',kind:'collaboration'}]);
  assert.deepEqual(panelSpacePartners(value,'one'),[{id:'two',name:'Partner workspace',computer:'studio'}]);
  assert.deepEqual(panelSpacePartners(value,'two'),[{id:'one',name:'Space one',computer:'studio'}]);
  assert.deepEqual(panelSpacePartners(value,'absent'),[]);assert.deepEqual(panelSpacePartners(value,'unknown'),[]);
  assert.equal(raw.links.length,8,'raw links are not mutated');
});

test('partner labels follow explicit endpoints and renames without inferring collaboration from bundles or messages',()=>{
  const raw=feed({spaces:[space('one'),space('two',{name:'Same name'})],events:[{id:'message',kind:'message',at:stamp(NOW),from:'one-agent',to:'two-agent'}]});
  assert.deepEqual(panelSpacePartners(cleanPanelFeed(raw),'one'),[]);
  raw.links=[{a:'one',b:'two',kind:'collaboration'}];
  const first=projectPanelFeed(cleanPanelFeed(raw));raw.spaces[1].name='Updated partner';
  const changed=projectPanelFeed(cleanPanelFeed(raw),first);
  assert.equal(changed.spaces[0],first.spaces[0]);assert.equal(panelSpacePartners(changed.feed,'one')[0].name,'Updated partner');
  assert.equal(panelSpacePartners(first.feed,'one')[0].name,'Same name');assert.equal(changed.feed.links[0].kind,'collaboration');
  raw.links=[];assert.deepEqual(panelSpacePartners(cleanPanelFeed(raw),'one'),[]);
});

test('canonical local message fixture retains both card endpoints without changing collaboration evidence',()=>{
  const raw=makePanelFixture({share:'local',now:NOW}),baseline=cleanPanelFeed(raw),history=boot(baseline);
  const moved=localCollaborationMessage.apply(raw,NOW+10),incoming=cleanPanelFeed(moved);
  assert.equal(raw.events.length,0);assert.deepEqual(incoming.links,baseline.links);
  assert.equal(incoming.events[0].from,PANEL_IDS.space);assert.equal(incoming.events[0].to,PANEL_IDS.localSpace);
  const animation=panelEventStates(incoming,NOW+10,{previous:history});
  assert.equal(animation.packets[0].kind,'message');assert.equal(animation.packets[0].from,PANEL_IDS.space);assert.equal(animation.packets[0].to,PANEL_IDS.localSpace);
  assert.throws(()=>localCollaborationMessage.apply(makePanelFixture({now:NOW}),NOW+10),/Local collaboration/);
});

test('computer shares require two known distinct computers and never substitute for local collaboration',()=>{
  const value=normalize({spaces:[
    space('same',{share:{computer:'studio',kind:'space'}}),
    space('same-agent',{share:{computer:'studio',kind:'agent',agent_id:'same-agent-agent'}}),
    space('unknown-own',{computer:'unknown',share:{computer:'worker',kind:'space'}}),
    space('unknown-partner',{share:{computer:'unknown',kind:'space'}}),
    space('remote',{share:{computer:'worker',kind:'space'}}),
  ]});
  for(const item of value.spaces.slice(0,4))assert.equal(item.share,null);
  assert.deepEqual(value.spaces[4].share,{computer:'worker',kind:'space'});
  assert.deepEqual(value.links,[],'malformed shares do not invent local relationship links');
});


test('confirmed delivery units and computer endpoints survive detached projection; animation opt-out is explicit',()=>{
 const raw=feed();raw.computers[1].traffic={up:3,down:0,unit:'deliveries'};
 raw.events=[{id:'delivery',at:stamp(NOW),kind:'message',from:'studio',to:'worker',animate:false,label:'Delivered'}];
 const value=cleanPanelFeed(raw),projected=projectPanelFeed(value).feed;
 assert.equal(value.events[0].to,'worker');assert.equal(value.events[0].animate,false);
 assert.equal(value.computers[1].traffic.unit,'deliveries');
 assert.equal(projected.computers[1].traffic.unit,'deliveries');assert.equal(projected.events[0].animate,false);
 raw.computers[1].traffic.up=99;assert.equal(projected.computers[1].traffic.up,3);
 const previous=boot(normalize()),state=advance(value,previous,1);
 assert.equal(state.packets.length,0);assert.equal(state.connections.length,0);assert.equal(state.tags.get('studio').label,'Delivered');
});

test('unresolved messages are quiet; new messages stagger in two bounded native lanes without replay',()=>{
 const initial=normalize(),prior=boot(initial),from=initial.spaces[0].agents[0].id;
 const missing=normalize({events:[{id:'missing',at:stamp(NOW),kind:'message',from,to:null}]});
 const quiet=advance(missing,prior,1);assert.equal(quiet.nextAt,null);assert.equal(quiet.pending.length,0);
 const value=normalize({events:Array.from({length:12},(_,i)=>({id:'burst-'+i,at:stamp(NOW),kind:'message',from,to:'worker'}))});
 const queued=advance(value,prior,10),pending=queued.pending.map(([,event])=>event);
 assert.equal(pending.filter(event=>event.drawRoute).length,8);assert.equal(queued.packets.length,1);
 const moving=pending.filter(event=>event.drawRoute);
 for(let i=1;i<moving.length;i++)assert(moving[i].routeAt-moving[i-1].routeAt>=260);
 for(const lane of [0,1]){const own=moving.filter(event=>event.routeLane===lane);for(let i=1;i<own.length;i++)assert(own[i].routeAt-own[i-1].routeAt>=1000);}
 const done=advance(value,queued,20000);assert.equal(done.nextAt,null);assert.equal(done.pending.length,0);
 const reload=panelEventStates(value,NOW+30000);assert.equal(reload.packets.length,0);assert.equal(reload.nextAt,null);
 const changed={...value,events:value.events.map(event=>({...event,animate:false}))};
 const revoked=advance(changed,queued,20);assert.equal(revoked.packets.length,0);assert.equal(revoked.connections.length,0);
});


test('message travel lasts750ms and its pipe settles within1460ms',()=>{
 const initial=normalize(),previous=boot(initial),from=initial.spaces[0].agents[0].id;
 const value=normalize({events:[{id:'pipe',at:stamp(NOW),kind:'message',from,to:'worker'}]});
 let state=advance(value,previous,0);assert.equal(state.packets[0].phase,'start');assert.equal(state.packets[0].travelMs,750);
 state=advance(value,state,789);assert.equal(state.packets[0].phase,'travel');
 state=advance(value,state,790);assert.equal(state.packets[0].phase,'ping');
 state=advance(value,state,1000);assert.equal(state.packets[0].phase,'fade');
 state=advance(value,state,1460);assert.equal(state.packets.length,0);assert.equal(state.nextAt,null);
});
