import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPanelFeed, reconcilePanelFeed, panelSpaces, agentGroups, agentState, panelEventStates, projectPanelFeed, createPanelProjection, PANEL_TIMING } from '../mods/sixfold-desk/panel-model.js';
import { makePanelFixture, makePanelMatrix, makePanelLoadFixture, PANEL_IDS, eventSequence, makePanelScenario } from './panel-fixtures.mjs';

const NOW = 1780000000000;
const stamp = at => new Date(at).toISOString();
const agent = (id, extra = {}) => ({ id, family: 'codex', title: `Task ${id}`, stage: 2, status: 'working', ...extra });
const space = (id, extra = {}) => ({ id, name: `Space ${id}`, computer: 'studio', bundle: 'violet', share: null, slack: null, work: null, issues: [], memory: { proposals: 0 }, agents: [agent(`${id}-agent`)], ...extra });
const feed = extra => ({ v: 1, at: stamp(NOW), computers: [{ id: 'studio', name: 'Studio', local: true }, { id: 'worker', name: 'Worker', linked: true }], spaces: [space('one')], links: [], events: [], ...extra });
const normalize = extra => cleanPanelFeed(feed(extra));
const boot = value => panelEventStates(value, NOW);
const advance = (value, previous, delta, motion = true) => panelEventStates(value, NOW + delta, { previous, motion });

test('all 18 space combinations retain independent sharing, tool and Slack facts', () => {
  const combinations = makePanelMatrix(NOW);
  assert.equal(combinations.length, 18);
  assert.equal(new Set(combinations.map(item => item.name)).size, 18);
  for (const { options, feed } of combinations) {
    const actual = cleanPanelFeed(feed).spaces[0];
    assert.equal(actual.share?.kind ?? 'none', options.share);
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
  assert.deepEqual(group.agents.map(a => a.id), ['blocked', 'newer', 'older']);
  assert.equal(group.hidden, 3);
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
  assert.deepEqual(result.groups.map(group => group.issue?.state ?? null), ['blocked', 'working', 'review', 'waiting', 'done', null]);
  assert.deepEqual(result.groups.at(-1).agents.map(a => a.id), ['unassigned']);
});

test('four rows stay visible; more than four become three plus remainder for each issue', () => {
  for (const size of [3, 4, 5, 9]) {
    const item = normalize({ spaces: [space('one', { work: { tool: 'linear', key: 'ENG' }, issues: [{ key: 'ENG-1', title: 'Example', state: 'working' }], agents: Array.from({ length: size }, (_, n) => agent(`agent-${n}`, { issue: 'ENG-1' })) })] }).spaces[0];
    const group = agentGroups(item).groups[0];
    assert.equal(group.agents.length, size > 4 ? 3 : size);
    assert.equal(group.hidden, size > 4 ? size - 3 : 0);
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
  assert.deepEqual(agentGroups(sorting).groups.map(group => group.issue?.state ?? null), ['blocked', 'working', 'review', 'waiting', 'done', null]);
  const noIssue = cleanPanelFeed(makePanelScenario('no-issue', { now: NOW })).spaces[0];
  assert.equal(agentGroups(noIssue).groups.at(-1).issue, null);
  assert.equal(agentGroups(noIssue).groups.at(-1).agents.length, 3);
  const overflow = cleanPanelFeed(makePanelScenario('overflow', { now: NOW })).spaces[0];
  assert.equal(agentGroups(overflow).agents.length, 3);
  assert.equal(agentGroups(overflow).hidden, 4);
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
