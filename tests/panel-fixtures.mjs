// Neutral, deterministic display fixtures shared by model tests and UI captures.
// They contain no commands, original addresses, account names or local paths.
const opaque = (prefix, number) => `${prefix}-${number.toString(16).padStart(16, '0')}`;
export const PANEL_IDS = Object.freeze({
  studio: opaque('c', 1), worker: opaque('c', 2), space: opaque('s', 1), remoteSpace: opaque('s', 2), localSpace: opaque('s', 3),
  planner: opaque('a', 1), implementer: opaque('a', 2), reviewer: opaque('a', 3), spawned: opaque('a', 4),
  bundle: opaque('b', 1), remoteBundle: opaque('b', 2),
});
const copy = value => JSON.parse(JSON.stringify(value));
const iso = value => new Date(value ?? Date.now()).toISOString();
const baseAgent = (number, title, extra = {}) => ({ id: opaque('a', number), family: number % 2 ? 'claude' : 'codex', title, stage: 0, status: 'idle', issue: null, closing: null, tooltip_addr: null, nav: null, ...extra });
const blankSpace = (id, name, computer, bundle) => ({ id, name, computer, bundle, nav: null, share: null, slack: null, work: null, issues: [], memory: { proposals: 0 }, agents: [] });

export function makePanelFixture({ share = 'none', tool = null, slack = false, now = Date.now(), agents, reduced_motion = null, nav = null } = {}) {
  if (!['none', 'local', 'space', 'agent'].includes(share)) throw new TypeError('Unknown sharing fixture');
  if (![null, 'linear', 'jira'].includes(tool)) throw new TypeError('Unknown tool fixture');
  const space = blankSpace(PANEL_IDS.space, 'Demo workspace', PANEL_IDS.studio, PANEL_IDS.bundle);
  space.nav = nav ? { space_id: nav.space_id, machine: nav.machine } : null;
  space.agents = [baseAgent(1, 'Plan workspace search', { stage: 1, status: 'working' }), baseAgent(2, 'Build workspace search'), baseAgent(3, 'Check keyboard behavior')];
  if (typeof agents === 'number') space.agents = Array.from({ length: Math.max(0, Math.min(32, Math.floor(agents))) }, (_, index) => space.agents[index] ?? baseAgent(index + 1, `Demo task ${index + 1}`, { stage: 2, status: 'working' }));
  else if (Array.isArray(agents)) space.agents = agents.slice(0, 32).map((agent, index) => baseAgent(index + 1, agent.title ?? `Demo task ${index + 1}`, { family: agent.family ?? (index % 2 ? 'codex' : 'claude'), stage: agent.stage ?? 2, status: agent.status ?? 'working', issue: agent.issue ?? null, closing: agent.closing ? copy(agent.closing) : null, nav: agent.nav ? { pane_id: agent.nav.pane_id, machine: agent.nav.machine } : null }));
  if (share === 'space' || share === 'agent') space.share = { computer: PANEL_IDS.worker, kind: share, ...(share === 'agent' ? { agent_id: space.agents[1]?.id ?? space.agents[0]?.id } : {}) };
  if (slack) space.slack = { channel: 'demo-room' };
  if (tool) {
    space.work = { tool, key: 'DEMO', open: 2 };
    space.issues = [{ key: 'DEMO-12', title: 'Workspace search', state: 'working' }, { key: 'DEMO-18', title: 'Keyboard navigation', state: 'review' }];
    for (const agent of space.agents) if (agent.id !== PANEL_IDS.planner) agent.issue ??= 'DEMO-12';
  }
  const spaces = [space], links = space.agents.some(agent => agent.id === PANEL_IDS.implementer) && space.agents.some(agent => agent.id === PANEL_IDS.reviewer) ? [{ a: PANEL_IDS.implementer, b: PANEL_IDS.reviewer, kind: 'task' }] : [];
  if (share === 'local') {
    const partner = blankSpace(PANEL_IDS.localSpace, 'Reference workspace', PANEL_IDS.studio, PANEL_IDS.bundle);
    partner.agents = [baseAgent(40, 'Check workspace responses', { stage: 3, status: 'working', issue: tool ? 'DEMO-12' : null })];
    partner.work = space.work ? { ...space.work } : null;partner.issues = copy(space.issues);partner.slack = space.slack ? { ...space.slack } : null;
    spaces.push(partner);links.push({ a: space.id, b: partner.id, kind: 'collaboration' });
  }
  return {
    v: 1, at: iso(now), reduced_motion: typeof reduced_motion === 'boolean' ? reduced_motion : null,
    computers: [{ id: PANEL_IDS.studio, name: 'Studio', linked: true, bundle: PANEL_IDS.bundle, traffic: { up: 0, down: 0 } }, { id: PANEL_IDS.worker, name: 'Worker', linked: share === 'space' || share === 'agent', bundle: PANEL_IDS.bundle, traffic: { up: null, down: null } }],
    spaces, links, events: [],
  };
}

export const panelCombinations = Object.freeze(['none', 'local', 'space', 'agent'].flatMap(share => [null, 'linear', 'jira'].flatMap(tool => [false, true].map(slack => Object.freeze({ name: `${share}-${tool ?? 'none'}-${slack ? 'slack' : 'no-slack'}`, share, tool, slack })))));
export const PANEL_COMBINATIONS = panelCombinations;
export function makePanelMatrix(now = Date.now()) {
  const at = typeof now === 'object' ? now.now : now;
  return panelCombinations.map(options => ({ name: options.name, options, feed: makePanelFixture({ ...options, now: at }) }));
}

export function makePanelLoadFixture({ spaces = 20, agentsPerSpace = 3, now = Date.now(), reduced_motion = null, status = 'working', changedRow = null, marker = null } = {}) {
  if (!Number.isInteger(spaces) || spaces < 1 || spaces > 128 || !Number.isInteger(agentsPerSpace) || agentsPerSpace < 1 || agentsPerSpace > 256) throw new TypeError('Invalid load fixture dimensions');
  if (!['working', 'idle', 'blocked', 'done'].includes(status)) throw new TypeError('Unknown load fixture status');
  const feed = makePanelFixture({ now, reduced_motion });
  feed.spaces = Array.from({ length: spaces }, (_, spaceIndex) => {
    const space = blankSpace(opaque('s', spaceIndex + 1), `Load workspace ${String(spaceIndex).padStart(2, '0')}`, PANEL_IDS.studio, PANEL_IDS.bundle);
    space.agents = Array.from({ length: agentsPerSpace }, (_, agentIndex) => {
      const index = spaceIndex * agentsPerSpace + agentIndex;
      return baseAgent(index + 1, `Load ${String(index).padStart(4, '0')}`, { stage: status === 'idle' ? 0 : status === 'done' ? 5 : 2, status });
    });
    return space;
  });
  feed.links = [];
  const target = changedRow ?? (marker === null ? null : 0);
  if (target !== null) {
    if (!Number.isInteger(target) || target < 0 || target >= spaces * agentsPerSpace) throw new TypeError('Invalid changed fixture row');
    feed.spaces[Math.floor(target / agentsPerSpace)].agents[target % agentsPerSpace].title = marker ?? `Load ${String(target).padStart(4, '0')} changed`;
  }
  return feed;
}

const allAgents = feed => feed.spaces.flatMap(space => space.agents);
const findAgent = (feed, id) => allAgents(feed).find(agent => agent.id === id);
function append(feed, now, kind, from, to, label) {
  const next = feed.events.reduce((max, event) => Math.max(max, Number.parseInt(event.id.slice(2), 16) || 0), 0) + 1;
  feed.at = iso(now);
  feed.events.push({ id: opaque('e', next), at: iso(now), kind, from: from ?? null, to: to ?? null, label });
  if (feed.events.length > 100) feed.events.splice(0, feed.events.length - 100);
  return feed;
}
function mutation(name, change, event) {
  return Object.freeze({ name, apply(input, now = Date.now()) { const feed = copy(input); change(feed); return append(feed, now, ...event); } });
}
export const localCollaborationMessage = mutation('message-local', feed => {
  if (!feed.links.some(link => link.kind === 'collaboration' && link.a === PANEL_IDS.space && link.b === PANEL_IDS.localSpace)) throw new TypeError('Local collaboration fixture required');
}, ['message', PANEL_IDS.space, PANEL_IDS.localSpace, 'Workspace message']);
const closing = (step, label) => mutation(`close-${step}`, feed => {
  const agent = findAgent(feed, PANEL_IDS.implementer);
  if (agent) { agent.stage = 5; agent.status = 'done'; agent.closing = { step, blocked_reason: null }; }
}, ['close_step', PANEL_IDS.implementer, PANEL_IDS.space, label]);

function addRemote(feed, computer) {
  let remote = feed.spaces.find(space => space.id === PANEL_IDS.remoteSpace);
  if (!remote) { remote = blankSpace(PANEL_IDS.remoteSpace, 'Reference workspace', computer, PANEL_IDS.bundle); feed.spaces.push(remote); }
  remote.computer = computer;
  const primary = feed.spaces.find(space => space.id === PANEL_IDS.space);
  const reviewer = primary?.agents.find(agent => agent.id === PANEL_IDS.reviewer);
  if (reviewer) { primary.agents = primary.agents.filter(agent => agent.id !== reviewer.id); remote.agents.push(reviewer); }
  if (computer === PANEL_IDS.worker) {
    primary.share = { computer: PANEL_IDS.worker, kind: 'agent', agent_id: PANEL_IDS.implementer };
    remote.share = { computer: PANEL_IDS.studio, kind: 'agent', agent_id: PANEL_IDS.reviewer };
    feed.computers.find(item => item.id === PANEL_IDS.worker).linked = true;
  }
}

export const eventSequence = Object.freeze([
  mutation('assign-existing', feed => {
    const agent = findAgent(feed, PANEL_IDS.implementer); if (agent) { agent.stage = 2; agent.status = 'working'; }
  }, ['assign', PANEL_IDS.planner, PANEL_IDS.implementer, '계획: 일 2개로 나눔']),
  mutation('spawn', feed => {
    const space = feed.spaces.find(space => space.id === PANEL_IDS.space);
    if (!findAgent(feed, PANEL_IDS.spawned)) space.agents.push(baseAgent(4, 'Build search filters', { stage: 2, status: 'working', issue: space.work ? 'DEMO-18' : null }));
  }, ['spawn', PANEL_IDS.planner, PANEL_IDS.spawned, '새 작업']),
  mutation('review_request', feed => {
    for (const id of [PANEL_IDS.implementer, PANEL_IDS.reviewer]) { const agent = findAgent(feed, id); if (agent) { agent.stage = 3; agent.status = 'working'; } }
  }, ['review_request', PANEL_IDS.implementer, PANEL_IDS.reviewer, '검수 요청']),
  mutation('verdict', feed => {
    const implementer = findAgent(feed, PANEL_IDS.implementer); if (implementer) { implementer.stage = 4; implementer.status = 'idle'; }
    const reviewer = findAgent(feed, PANEL_IDS.reviewer); if (reviewer) { reviewer.stage = 5; reviewer.status = 'done'; }
  }, ['verdict', PANEL_IDS.reviewer, PANEL_IDS.implementer, '검수: 통과']),
  mutation('accept', feed => {
    const agent = findAgent(feed, PANEL_IDS.implementer); if (agent) { agent.stage = 5; agent.status = 'done'; agent.closing = { step: 1, blocked_reason: null }; }
  }, ['accept', PANEL_IDS.planner, PANEL_IDS.implementer, '수락']),
  closing(1, '보고 작성'), closing(2, '경험·결정 저장'), closing(3, '기억함 제안'),
  mutation('memory', feed => {
    const space = feed.spaces.find(space => space.id === PANEL_IDS.space); space.memory.proposals += 1;
    const agent = findAgent(feed, PANEL_IDS.implementer); if (agent) agent.closing = { step: 3, blocked_reason: null };
  }, ['memory', PANEL_IDS.implementer, PANEL_IDS.space, '기억 제안 1']),
  mutation('blocked-close', feed => {
    const agent = findAgent(feed, PANEL_IDS.implementer); if (agent) { agent.status = 'blocked'; agent.closing = { step: 3, blocked_reason: '저장 확인이 필요합니다' }; }
  }, ['close_step', PANEL_IDS.implementer, PANEL_IDS.space, '정리 확인 필요']),
  closing(4, '닫힘'),
  mutation('message', () => {}, ['message', PANEL_IDS.planner, PANEL_IDS.reviewer, '메시지']),
  mutation('message-space', feed => addRemote(feed, PANEL_IDS.studio), ['message', PANEL_IDS.planner, PANEL_IDS.reviewer, '공간 간 메시지']),
  mutation('message-computer', feed => addRemote(feed, PANEL_IDS.worker), ['message', PANEL_IDS.planner, PANEL_IDS.reviewer, '컴퓨터 간 메시지']),
]);

export function applyPanelEvent(feed, name, now = Date.now()) {
  const event = eventSequence.find(event => event.name === name);
  if (!event) throw new TypeError('Unknown panel event fixture');
  return event.apply(feed, now);
}

export function makePanelScenario(name, options = {}) {
  const feed = makePanelFixture({ ...options, tool: options.tool ?? (name === 'sorting' || name === 'no-issue' ? 'linear' : null) });
  const space = feed.spaces[0];
  if (name === 'sorting') {
    space.issues = ['done', 'waiting', 'review', 'working', 'blocked'].map((state, index) => ({ key: `DEMO-${index + 1}`, title: ['Polish search', 'Document shortcuts', 'Check navigation', 'Build search', 'Confirm storage'][index], state }));
    space.work.open = 5;
    space.agents = space.issues.map((issue, index) => baseAgent(index + 1, issue.title, { issue: issue.key, stage: issue.state === 'review' ? 3 : issue.state === 'waiting' ? 0 : issue.state === 'done' ? 5 : 2, status: issue.state === 'blocked' ? 'blocked' : issue.state === 'done' ? 'done' : issue.state === 'waiting' ? 'idle' : 'working' }));
    space.agents.push(baseAgent(6, 'Unassigned example', { stage: 0 }));
  } else if (name === 'no-issue') {
    for (const agent of space.agents) agent.issue = null;
  } else if (name === 'overflow') {
    space.agents = Array.from({ length: 7 }, (_, index) => baseAgent(index + 1, `Search task ${index + 1}`, { stage: 2, status: 'working', issue: space.work ? 'DEMO-12' : null }));
  } else if (name === 'cross-space') addRemote(feed, PANEL_IDS.studio);
  else if (name === 'cross-computer') addRemote(feed, PANEL_IDS.worker);
  else throw new TypeError('Unknown panel scenario fixture');
  return feed;
}

export function makePanelCompleteFixture({now=Date.now(),reduced_motion=null}={}){
  const feed=makePanelFixture({share:'space',tool:'linear',slack:true,now,reduced_motion});
  const space=feed.spaces[0];
  const issues=Array.from({length:6},(_,index)=>({key:`DEMO-${index+1}`,title:['Build search','Check shortcuts','Polish feedback','Publish guide','Review colors','Follow up'][index],
    state:index===3?'done':index===1?'blocked':index===0?'working':'waiting',milestone_id:index<3?'release':'next'}));
  space.issues=issues.slice(0,4).map((issue,index)=>({...issue,week:index<2,pinned:index>=2}));
  space.work.open=4;space.memory.proposals=2;
  space.issue_catalog={week:issues.slice(0,2),milestone:issues.slice(),all:issues.slice(),
    milestones:[{id:'release',name:'Search release',due:'2026-11-13',progress:0},{id:'next',name:'Next update',progress:33.3}],
    cache:{state:'ready',at:'2026-11-07T00:00:00Z',scopes:Object.fromEntries(['week','milestone','all'].map(scope=>[scope,{state:'ready',at:'2026-11-07T00:00:00Z'}]))},
    import_request:{path:'panel-issue-requests',space:space.id},results:[]};
  space.agents=[baseAgent(1,'Build search',{issue:'DEMO-1',stage:2,status:'working'}),
    ...Array.from({length:6},(_,index)=>baseAgent(index+2,`Check search case ${index+1}`,{issue:'DEMO-1',parent_id:opaque('a',1),subagent_kind:index%2?'task':'agent',stage:2,status:index===5?'done':'working'})),
    baseAgent(8,'Confirm storage',{issue:'DEMO-2',stage:2,status:'blocked',error:'Connection unavailable',unread:3}),
    baseAgent(9,'Write check report',{issue:'DEMO-2',stage:3,status:'idle',report_missing:true}),
    baseAgent(10,'Polish feedback',{issue:'DEMO-3',stage:2,status:'idle',usage:{label:'Daily limit reached',limited:true}}),
    baseAgent(11,'Publish guide',{issue:'DEMO-4',stage:5,status:'done'}),
    baseAgent(12,'Save check notes',{stage:5,status:'done',closing:{step:2,blocked_reason:null,memory:{state:'saved',proposals:2}}})];
  const remote=blankSpace(PANEL_IDS.remoteSpace,'Reference workspace',PANEL_IDS.worker,PANEL_IDS.bundle);
  remote.nav={space_id:'demo-reference',machine:'Worker'};
  remote.agents=[baseAgent(20,'Check shared behavior',{stage:3,status:'working',unread:1})];
  feed.spaces.push(remote);feed.links=[];
  return feed;
}

// A measured field case (one project space, 9 issue rows, 16 agent rows, 3 working), with synthetic keys
// and titles. `ledger: false` strips every field the producer feed added for it (Linear status, finish time,
// own issue, role, held issues), which is what an older producer sends.
export function makeLedgerFieldFeed({ now = Date.now(), ledger = true } = {}) {
  const feed = makePanelFixture({ tool: 'linear', now });
  const space = feed.spaces[0];
  space.work = { tool: 'linear', key: 'DEMO', open: 9 };
  const day = new Date(now), pad = n => String(n).padStart(2, '0');
  const today = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
  const status = (name, type, extra = {}) => ledger ? { status: name, ...(type ? { status_type: type } : {}), ...extra } : {};
  space.issues = [
    { key: 'DEMO-417', title: 'Finished import', state: 'working', ...status('Done', 'completed', { done_at: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12).toISOString() }) },
    { key: 'DEMO-502', title: 'Dropped export', state: 'waiting', ...status('Canceled', 'canceled') },
    { key: 'DEMO-573', title: 'Repeated report', state: 'waiting', ...status('Duplicate') },
    { key: 'DEMO-490', title: 'Restock flow', state: 'working', ...status('In Progress', 'started') },
    { key: 'DEMO-412', title: 'Order screen', state: 'working', ...status('In Progress', 'started') },
    { key: 'DEMO-393', title: 'Payment retry', state: 'working', ...status('In Review', 'started') },
    { key: 'DEMO-610', title: 'Later idea', state: 'waiting', ...status('Backlog', 'backlog') },
    { key: 'DEMO-611', title: 'Next search', state: 'waiting', ...status('Todo', 'unstarted') },
    { key: 'DEMO-612', title: 'Unknown status', state: 'waiting' },
  ];
  space.issue_catalog = { source: 'linear-ledger', week: [], milestone: [], all: [
    { key: 'DEMO-411', title: 'Merge approval', state: 'waiting', ...status('In Progress', 'started') },
    { key: 'DEMO-503', title: 'Stock sync', state: 'waiting', ...status('In Review', 'started') },
    { key: 'DEMO-504', title: 'Stock sync follow-up', state: 'waiting', ...status('Done', 'completed') },
  ], import_request: null };
  const id = n => opaque('a', 100 + n);
  const row = (n, title, extra, fields = {}) => baseAgent(100 + n, title, { stage: 2, status: 'idle', ...extra, ...(ledger ? fields : {}) });
  space.agents = [
    row(1, 'Empty shell', { issue: 'DEMO-502', keep_reason: 'work left' }, { role: null, own_issue: 'DEMO-502', issues: ['DEMO-502'] }),
    row(2, 'Empty shell', { issue: 'DEMO-573', keep_reason: 'input unchecked' }, { role: null, own_issue: 'DEMO-573', issues: ['DEMO-573'] }),
    row(3, 'Restock flow', { issue: 'DEMO-490', status: 'working' }, { role: 'integrate', own_issue: 'DEMO-490', issues: ['DEMO-490', 'DEMO-503', 'DEMO-504', 'DEMO-393'] }),
    row(4, 'Restock flow', { issue: 'DEMO-490' }, { role: 'review', own_issue: 'DEMO-490', issues: ['DEMO-490'] }),
    row(5, 'DEMO-503+504 merge', { issue: 'DEMO-490', parent_id: id(3), subagent_kind: 'task' }, { own_issue: 'DEMO-503' }),
    row(6, 'Prepare release command', { issue: 'DEMO-490', parent_id: id(3), subagent_kind: 'task' }, { own_issue: null }),
    row(7, 'Runbook rebase and merge', { issue: 'DEMO-490', parent_id: id(3), subagent_kind: 'task' }, { own_issue: null }),
    row(8, 'DEMO-393 rebase', { issue: 'DEMO-490', parent_id: id(3), subagent_kind: 'task' }, { own_issue: 'DEMO-393' }),
    row(9, 'DEMO-490~492 restock merge', { issue: 'DEMO-490', parent_id: id(3), subagent_kind: 'task' }, { own_issue: 'DEMO-490' }),
    row(10, 'Order screen', { issue: 'DEMO-412' }, { role: 'implement', own_issue: 'DEMO-412', issues: ['DEMO-412'] }),
    row(11, 'Payment retry', { issue: 'DEMO-393' }, { role: 'implement', own_issue: 'DEMO-393', issues: ['DEMO-393'] }),
    row(12, 'Stock sync', { issue: 'DEMO-490' }, { role: 'implement', own_issue: 'DEMO-503', issues: ['DEMO-503'] }),
    row(13, 'Stock sync', { issue: 'DEMO-490' }, { role: 'review', own_issue: 'DEMO-503', issues: ['DEMO-503', 'DEMO-411'] }),
    row(14, 'Next search', { issue: 'DEMO-611', status: 'working' }, { role: 'implement', own_issue: 'DEMO-611', issues: ['DEMO-611'] }),
    row(15, 'Later idea', { issue: 'DEMO-610' }, { role: 'implement', own_issue: 'DEMO-610', issues: ['DEMO-610'] }),
    row(16, '기록을 읽지 못한 작업', { issue: 'DEMO-612', status: 'working' }, { role: null, own_issue: 'DEMO-612', issues: ['DEMO-612'] }),
  ];
  feed.links = [];
  return { feed, ids: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i + 1, id(i + 1)])), today };
}
