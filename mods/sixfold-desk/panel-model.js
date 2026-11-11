import { projectTaskBranches } from './task-tree.js';

// Display data only. The producer owns task interpretation and lifecycle policy.
// Every event effect runs at this pace (2026-11-09: the person found 1x too fast to follow).
// 1 = the original timing: a message crossed in 1 s, a task event in 1.6 s.
export const PACE=1.5;
const paced=ms=>Math.round(ms*PACE);
export const PANEL_TIMING = Object.freeze({ tagMs: 60+paced(1640), startMs: 40, packetMs: 40+paced(1600), pingMs: paced(460), coolMs: paced(900) });
// A packet's corners: leave the row, run down the lane, enter the target row.
// Finite native targets; there is no JavaScript animation-frame timer.
export const PANEL_LEGS=Object.freeze([40,40+paced(260),40+paced(1360)]);
export const panelLeg=elapsed=>PANEL_LEGS.filter(at=>elapsed>=at).length;
// A message moves like every other event packet: same corners, same travel,
// ping and fade (2026-11-10: a faster, differently shaped send looked foreign).
export const MESSAGE_TIMING=Object.freeze({startMs:PANEL_TIMING.startMs,packetMs:PANEL_TIMING.packetMs,pingMs:PANEL_TIMING.pingMs,coolMs:PANEL_TIMING.coolMs});
const MAX = Object.freeze({ computers: 64, spaces: 128, agents: 256, issues: 128, links: 512, events: 256, bytes: 2 * 1024 * 1024 });
const STATUSES = new Set(['working', 'idle', 'blocked', 'done']);
const STATES = ['blocked', 'working', 'review', 'waiting', 'done'];
const KINDS = new Set(['dispatch', 'review_request', 'verdict', 'accept', 'message', 'spawn', 'close_step', 'memory', 'resume', 'error']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 160) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';
const id = value => typeof value === 'string' && value.length <= 160 && value.length > 0 && !/[\s\u0000-\u001f\u007f]/.test(value) ? value : '';
const integer = (value, max = 9999) => Number.isInteger(value) && value >= 0 ? Math.min(value, max) : 0;
const measurement = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, 1e12) : null;
const time = value => typeof value === 'string' ? (Number.isFinite(Date.parse(value)) ? Date.parse(value) : null) : Number.isFinite(value) && value >= 0 ? value : null;
const list = (value, limit) => Array.isArray(value) ? value.slice(0, limit) : [];
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const toolUrl=value=>typeof value==='string'&&value.length<=2048&&!/[\\\u0000-\u0020\u007f]/.test(value)&&/^https?:\/\/[^/@?#]+(?:[/?#].*)?$/i.test(value)?value:null;
const cleanMemory = value => object(value) && ['pending', 'saved', 'proposed'].includes(value.state)
  ? { state: value.state, proposals: integer(value.proposals) } : null;
const copyMemory = value => value ? { state: value.state, proposals: value.proposals } : null;
function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] ? value : null;
}
function cleanCatalogCache(value) {
  if (!object(value) || !['ready', 'stale', 'empty'].includes(value.state)) return null;
  const scopes = {};
  for (const name of ['week', 'milestone', 'all']) {
    const scope = value.scopes?.[name];
    scopes[name] = { state: ['ready', 'stale', 'missing'].includes(scope?.state) ? scope.state : 'missing', at: text(scope?.at, 80) || null };
  }
  return { state: value.state, at: text(value.at, 80) || null, scopes };
}
const copyCatalogCache = value => value ? { state: value.state, at: value.at, scopes: Object.fromEntries(['week', 'milestone', 'all'].map(name => [name, { state: value.scopes[name].state, at: value.scopes[name].at }])) } : null;
// Optional display extensions; absent properties keep the original v1 shape.
const issueExtras = issue => ({
  ...(owns(issue, 'week') ? { week: issue.week === true } : {}),
  ...(owns(issue, 'pinned') ? { pinned: issue.pinned === true } : {}),
  ...(owns(issue, 'milestone_id') ? { milestone_id: id(issue.milestone_id) || null } : {}),
});
// Optional producer row state (docs/panel-feed.md). Display only: the
// panel never derives a state, a keep reason or a close deadline by itself.
export const ROW_STATES = Object.freeze(['working', 'idle', 'needs_human', 'unseen_result', 'cleanup_wait', 'closing', 'closed']);
const MAX_CLEANUP_S = 7 * 24 * 3600;
function cleanCleanup(value) {
  if (!object(value)) return null;
  const since = time(value.idle_since), due = time(value.due_at), limit = value.limit_s;
  if (since === null || due === null || !Number.isInteger(limit) || limit <= 0 || limit > MAX_CLEANUP_S || due < since) return null;
  return { idle_since: since, limit_s: limit, due_at: due };
}
const agentExtras = agent => ({
  // An unknown state is dropped, not kept as null, so the row falls back to the
  // four-status mark exactly as an older feed does.
  ...(ROW_STATES.includes(agent.state) ? { state: agent.state } : {}),
  ...(owns(agent, 'keep_reason') ? { keep_reason: text(agent.keep_reason, 120) || null } : {}),
  ...(owns(agent, 'cleanup') ? { cleanup: cleanCleanup(agent.cleanup) } : {}),
  ...(owns(agent, 'unread') ? { unread: integer(agent.unread) } : {}),
  ...(owns(agent, 'report_missing') ? { report_missing: agent.report_missing === true } : {}),
  ...(owns(agent, 'error') ? { error: text(agent.error, 300) || null } : {}),
  ...(owns(agent, 'usage') ? { usage: object(agent.usage) ? { label: text(agent.usage.label, 100), limited: agent.usage.limited === true } : null } : {}),
});
const cleanIssues = (value, limit) => unique(list(value, limit).map(issue => object(issue) ? { ...issue, id: issue.key } : null), issue => object(issue) && id(issue.id) ? {
  id: issue.id, key: issue.id, title: text(issue.title, 200), state: STATES.includes(issue.state) ? issue.state : 'waiting',
  ...issueExtras(issue),
} : null);
const copyIssues = issues => issues.map(issue => ({ id: issue.id, key: issue.key, title: issue.title, state: issue.state, ...issueExtras(issue) }));
function cleanCatalog(value, spaceId) {
  if (!object(value)) return null;
  const request = value.import_request;
  return {
    week: cleanIssues(value.week, 2048), milestone: cleanIssues(value.milestone, 2048), all: cleanIssues(value.all, 2048),
    import_request: object(request) && request.path === 'panel-issue-requests' && request.space === spaceId
      ? { path: 'panel-issue-requests', space: spaceId } : null,
    ...(owns(value, 'milestones') ? { milestones: unique(list(value.milestones, 2048), item => object(item) && id(item.id) ? {
      id: item.id, name: text(item.name, 100),
      ...(owns(item, 'due') ? { due: dateOnly(item.due) } : {}),
      ...(owns(item, 'progress') ? { progress: typeof item.progress === 'number' && Number.isFinite(item.progress) && item.progress >= 0 && item.progress <= 100 ? item.progress : null } : {}),
    } : null) } : {}),
    ...(owns(value, 'cache') ? { cache: cleanCatalogCache(value.cache) } : {}),
    ...(owns(value, 'updated_at') ? { updated_at: text(value.updated_at, 80) || null } : {}),
    ...(owns(value, 'results') ? { results: unique(list(value.results, 128), item => object(item) && typeof item.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(item.id)
      && item.space === spaceId && ['imported', 'rejected'].includes(item.status) ? {
      id: item.id, space: spaceId, status: item.status, keys: [...new Set(list(item.keys, 50).map(key => text(key, 80)).filter(Boolean))], message: text(item.message, 200),
      ...(owns(item, 'action') ? { action: ['import', 'remove'].includes(item.action) ? item.action : null } : {}),
      ...(owns(item, 'code') ? { code: text(item.code, 80) } : {}),
    } : null) } : {}),
  };
}
function unique(values, clean) {
  const seen = new Set();
  return values.flatMap(value => {
    if (typeof value?.id === 'string' && seen.has(value.id)) return [];
    const item = clean(value);
    if (!item || !item.id || seen.has(item.id)) return [];
    seen.add(item.id);
    return [item];
  });
}
function navigation(value, target) {
  if (!object(value) || !id(value[target])) return null;
  const machine = value.machine;
  if (machine !== null && (typeof machine !== 'string' || !machine || machine.length > 160 || machine.trim() !== machine || /[\u0000-\u001f\u007f]/.test(machine))) return null;
  return { [target]: value[target], machine };
}
function cleanAgent(value, knownAgents) {
  if (!object(value) || !id(value.id) || knownAgents.has(value.id)) return null;
  knownAgents.add(value.id);
  const closing = object(value.closing) && Number.isInteger(value.closing.step) && value.closing.step >= 1 && value.closing.step <= 4
    ? { step: value.closing.step, blocked_reason: text(value.closing.blocked_reason, 300), ...(owns(value.closing, 'memory') ? { memory: cleanMemory(value.closing.memory) } : {}) } : null;
  return {
    id: value.id, family: ['claude', 'codex'].includes(value.family) ? value.family : 'unknown',
    title: text(value.title, 200), stage: Number.isInteger(value.stage) && value.stage >= 0 && value.stage <= 5 ? value.stage : 0,
    status: STATUSES.has(value.status) ? value.status : 'idle',
    issue: text(value.issue, 80) || null, closing, tooltip_addr: null, nav: navigation(value.nav, 'pane_id'),
    ...(owns(value, 'parent_id') ? { parent_id: id(value.parent_id) || null } : {}),
    ...(owns(value, 'subagent_kind') ? { subagent_kind: ['agent', 'task'].includes(value.subagent_kind) ? value.subagent_kind : null } : {}),
    ...agentExtras(value),
  };
}

// null signals a bad snapshot; callers can preserve their last valid read.
export function cleanPanelFeed(raw) {
  if (typeof raw === 'string') {
    if (raw.length > MAX.bytes) return null;
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!object(raw) || raw.v !== 1 || time(raw.at) === null || !Array.isArray(raw.spaces) || !Array.isArray(raw.computers)) return null;
  const computers = unique(list(raw.computers, MAX.computers), value => object(value) && id(value.id) ? {
    id: value.id, name: text(value.name, 80), linked: value.linked === true,
    bundle: text(value.bundle, 80), traffic: { up: measurement(value.traffic?.up), down: measurement(value.traffic?.down), ...(value.traffic?.unit==='deliveries'?{unit:'deliveries'}:{}) },
  } : null);
  const knownComputers = new Set(computers.map(item => item.id));
  const knownAgents = new Set();
  const spaces = unique(list(raw.spaces, MAX.spaces), value => {
    if (!object(value) || !id(value.id)) return null;
    const agents = unique(list(value.agents, MAX.agents), agent => cleanAgent(agent, knownAgents));
    const issues = cleanIssues(value.issues, MAX.issues);
    const work = object(value.work) && text(value.work.tool, 40) ? { tool: text(value.work.tool, 40).toLowerCase(), key: text(value.work.key, 80), open: integer(value.work.open),
      ...(owns(value.work,'url')?{url:toolUrl(value.work.url)}:{}) } : null;
    const share = object(value.share) && knownComputers.has(value.computer) && knownComputers.has(value.share.computer) && value.share.computer !== value.computer && ['space', 'agent'].includes(value.share.kind)
      && (value.share.kind !== 'agent' || agents.some(agent => agent.id === value.share.agent_id))
      ? { computer: value.share.computer, kind: value.share.kind, ...(value.share.kind === 'agent' ? { agent_id: value.share.agent_id } : {}) } : null;
    return {
      id: value.id, name: text(value.name, 100), bundle: text(value.bundle, 80),
      computer: knownComputers.has(value.computer) ? value.computer : null, nav: navigation(value.nav, 'space_id'),
      share, slack: object(value.slack) && text(value.slack.channel, 80) ? { channel: text(value.slack.channel, 80) } : null,
      work, issues, memory: { proposals: integer(value.memory?.proposals) }, agents,
      ...(owns(value, 'issue_catalog') ? { issue_catalog: cleanCatalog(value.issue_catalog, value.id) } : {}),
    };
  });
  for (const space of spaces) for (const agent of space.agents) if (owns(agent, 'parent_id') && (agent.parent_id === agent.id || !knownAgents.has(agent.parent_id))) agent.parent_id = null;
  const endpoints = new Set([...computers.map(item=>item.id), ...spaces.map(item => item.id), ...knownAgents]);
  const endpoint = value => id(value) && endpoints.has(value) ? value : null;
  const spaceById = new Map(spaces.map(space => [space.id, space])), collaborationPairs = new Set();
  const links = list(raw.links, MAX.links).flatMap(value => {
    if (!object(value) || value.a === value.b) return [];
    if (value.kind === 'task' && knownAgents.has(value.a) && knownAgents.has(value.b)) return [{ a: value.a, b: value.b, kind: 'task' }];
    if (value.kind !== 'collaboration') return [];
    const a = spaceById.get(value.a), b = spaceById.get(value.b);
    if (!a || !b || !a.computer || a.computer !== b.computer) return [];
    const pair = JSON.stringify([a.id, b.id].sort());
    if (collaborationPairs.has(pair)) return [];
    collaborationPairs.add(pair);
    return [{ a: a.id, b: b.id, kind: 'collaboration' }];
  });
  const events = unique(list(raw.events, MAX.events), value => object(value) && id(value.id) && KINDS.has(value.kind) && time(value.at) !== null ? {
    id: value.id, at: time(value.at), kind: value.kind, from: endpoint(value.from), to: endpoint(value.to),
    label: text(value.label, 100),
    ...(typeof value.animate==='boolean'?{animate:value.animate}:{}),
    ...(owns(value, 'allocation') ? { allocation: object(value.allocation) && ['existing', 'new'].includes(value.allocation.kind)
      ? { kind: value.allocation.kind, count: integer(value.allocation.count) } : null } : {}),
    ...(owns(value, 'step') ? { step: Number.isInteger(value.step) && value.step >= 1 && value.step <= 4 ? value.step : null } : {}),
    ...(owns(value, 'memory') ? { memory: cleanMemory(value.memory) } : {}),
  } : null);
  return { v: 1, at: time(raw.at), reduced_motion: typeof raw.reduced_motion === 'boolean' ? raw.reduced_motion : null, computers, spaces, links, events };
}

export function reconcilePanelFeed(raw, previous = null) {
  const incoming = raw === null || raw === undefined || raw === '' ? null : cleanPanelFeed(raw);
  const last = previous?.feed ?? (previous?.v === 1 ? previous : null);
  const feed = incoming ?? last;
  // `at` is the data's timestamp, not a producer heartbeat. An unchanged feed
  // remains valid indefinitely; only a read failure indicates unavailable data.
  const status = !incoming ? (raw === null || raw === undefined || raw === '' ? 'missing' : 'invalid') : 'ready';
  return { feed, status, stale: false, changed: Boolean(incoming && JSON.stringify(incoming) !== JSON.stringify(last)) };
}

// Only the producer's explicit native target may attach native metadata. Feed
// IDs are unrelated opaque keys, and display names are never navigation hints.
export function panelSpaces(feed, nativeSpaces = null, machine = undefined) {
  const key = (spaceId, machine) => JSON.stringify([spaceId, machine]);
  const native = new Map();
  for (const space of nativeSpaces ?? []) {
    const machine = space.machine ?? null;
    const prefix = machine === null ? null : `${machine}/`;
    const nativeId = prefix && typeof space.id === 'string' && space.id.startsWith(prefix) ? space.id.slice(prefix.length) : space.id;
    const identity = key(nativeId, machine);
    native.set(identity, native.has(identity) ? null : space);
  }
  return (feed?.spaces ?? []).filter(space => machine === undefined || space.computer === machine).map(space => ({ ...space, native: space.nav ? native.get(key(space.nav.space_id, space.nav.machine)) ?? null : null }));
}
// Explicit local collaboration endpoints only; names are display labels, never
// relationship evidence. A producer can end a relationship by removing its link.
export function panelSpacePartners(feed, spaceID) {
  const spaces = new Map((feed?.spaces ?? []).map(space => [space.id, space]));
  const source = spaces.get(spaceID), seen = new Set(), partners = [];
  if (!source?.computer) return partners;
  for (const link of feed?.links ?? []) {
    if (link.kind !== 'collaboration') continue;
    const targetID = link.a === spaceID ? link.b : link.b === spaceID ? link.a : null;
    const target = spaces.get(targetID);
    if (!target || target === source || target.computer !== source.computer || seen.has(target.id)) continue;
    seen.add(target.id);partners.push({ id: target.id, name: target.name, computer: target.computer });
  }
  return partners;
}
export function agentState(agent) {
  if (agent.closing?.blocked_reason || agent.status === 'blocked' || agent.report_missing === true || agent.error) return 'blocked';
  // 완료 = the feed's status 'done' alone. The harness sends it for a record row without a pane
  // whose task finished (stage 5) and for a pane its close scan will clean up. A finished task
  // whose pane is still kept arrives idle or working; its stage and keep_reason say why. `nav` is
  // not a pane test: a live pane whose session is not confirmed has nav null (review 2026-11-10).
  if (agent.status === 'done') return 'done';
  if (agent.stage === 3) return 'review';
  if (agent.stage === 4) return 'waiting';
  return agent.status === 'working' ? 'working' : 'waiting';
}
// The producer's seven-state value, or null when the feed predates it. A null
// row keeps the four-status mark; nothing here guesses the missing state.
export const agentRowState = agent => ROW_STATES.includes(agent?.state) ? agent.state : null;
const CLOSE_STEPS = ['보고 작성', '경험·결정 저장', '기억함 제안', '닫힘'];
const span = seconds => seconds >= 3600 && seconds % 3600 === 0 ? `${seconds / 3600}시간` : seconds >= 60 ? `${Math.round(seconds / 60)}분` : `${seconds}초`;
const cleanupTimer = agent => {
  const state = agentRowState(agent);
  return agent?.cleanup && (state === 'cleanup_wait' || state === 'unseen_result') ? agent.cleanup : null;
};
// True when the row carries a reason line. It does not depend on the clock, so
// row heights and layout stay fixed while the countdown changes.
export function agentHasReason(agent) {
  const state = agentRowState(agent);
  return Boolean(agent?.keep_reason || cleanupTimer(agent)
    || state === 'closing' && agent.closing && !agent.closing.blocked_reason
    || state === 'closed' && agent.closing?.memory?.state === 'saved');
}
// Reason text without the state label, and the next time the countdown text
// changes. Remaining minutes are counted on this clock from the producer's
// absolute `due_at`; the feed carries no pre-counted seconds.
export function agentReason(agent, now = Date.now()) {
  if (!agentHasReason(agent)) return { text: '', nextAt: null };
  const state = agentRowState(agent), timer = cleanupTimer(agent), parts = [];
  if (agent.keep_reason) parts.push(agent.keep_reason);
  else if (state === 'closing' && agent.closing) parts.push(CLOSE_STEPS[agent.closing.step - 1]);
  else if (state === 'closed') parts.push('기억함에 저장됨');
  let nextAt = null;
  if (timer) {
    const left = timer.due_at - now;
    if (left > 0) {
      const minutes = Math.ceil(left / 60000);
      if (!agent.keep_reason) parts.push(`${span(timer.limit_s)} 쉬면 닫힘`);
      parts[parts.length - 1] += ` (남은 ${minutes}분)`;
      nextAt = timer.due_at - (minutes - 1) * 60000;
    } else if (!parts.some(part => part.includes('다음 정리 때 닫힘'))) parts.push('다음 정리 때 닫힘');
  }
  return { text: parts.join(' · '), nextAt };
}
// The producer supplies recent-first arrays. Stable sorting keeps that order
// within each display state; opaque IDs and extra fields carry no date meaning.
const byState = (a, b) => STATES.indexOf(a.state) - STATES.indexOf(b.state) || a.index - b.index;
const sortedAgents = agents => agents.map((agent, index) => ({ agent, state: agentState(agent), index })).sort(byState).map(item => item.agent);
function treeAgents(agents, expandedParents) {
  const tree = projectTaskBranches(agents, { parentOf: agent => agent.parent_id, expandedParents });
  return { agents: tree.rows.map(row => row.entry), hidden: tree.hidden, folds: tree.folds,
    rowMeta: new Map(tree.rows.map(row => [row.entry.id, { depth: row.depth, parent: row.parent?.id ?? null, childCount: row.childCount }])) };
}
export function agentGroups(space, { includeClosedIds = new Set(), expandedIssueSpaces = new Set(), expandedParents = new Set() } = {}) {
  const issues = (space?.issues ?? []).map((issue, index) => ({ ...issue, index })).sort(byState);
  const assigned = new Set(issues.map(issue => issue.key));
  const input = space?.agents ?? [], parents = new Map(input.map(agent => [agent.id, agent]));
  const bucket = agent => space?.work && assigned.has(agent.issue) ? agent.issue : null;
  const agents = sortedAgents(input.filter(agent => {
    const parent = parents.get(agent.parent_id);
    // Only explicit children in this display bucket disappear on completion.
    // Other issue/space bindings remain independent roots. Filtering before
    // tree projection also removes completed branches from +N counts; active
    // descendants of an ended child remain visible as roots.
    if (parent && parent !== agent && bucket(parent) === bucket(agent) && agentState(agent) === 'done') return false;
    return agent.closing?.step !== 4 || agent.closing.blocked_reason || includeClosedIds.has(agent.id);
  }));
  if (!space?.work) return { grouped: false, groups: [], groupsHidden: 0, issueHidden: 0, issuesExpanded: false, groupsExpandable: false, ...treeAgents(agents, expandedParents) };
  const groupsExpandable = issues.length > 4, issuesExpanded = groupsExpandable && expandedIssueSpaces.has(space.id);
  // A live task must not disappear behind the generic issue fold.
  const activeIssues = new Set(agents.filter(agent => ['working','blocked'].includes(agent.status)).map(agent => agent.issue));
  const visibleIssues = groupsExpandable && !issuesExpanded
    ? issues.filter((issue,index) => index < 3 || activeIssues.has(issue.key)) : issues;
  const groups = visibleIssues.map(issue => ({ issue, ...treeAgents(agents.filter(agent => agent.issue === issue.key), expandedParents) }));
  const unassigned = agents.filter(agent => !assigned.has(agent.issue));
  if (unassigned.length) groups.push({ issue: null, ...treeAgents(unassigned, expandedParents) });
  const groupsHidden = issues.length - visibleIssues.length;
  return { grouped: true, groups, agents: groups.flatMap(group => group.agents), hidden: groups.reduce((sum, group) => sum + group.hidden, 0),
    groupsHidden, issueHidden: groupsHidden, issuesExpanded, groupsExpandable,
    rowMeta: new Map(groups.flatMap(group => [...group.rowMeta])), folds: groups.flatMap(group => group.folds) };
}

const sameReferences = (a, b) => a?.length === b.length && b.every((value, index) => value === a[index]);
const sameMapReferences = (a, entries) => a?.size === entries.length && entries.every(([key, value]) => a.get(key) === value);
const copyNavigation = (nav, target) => nav ? { [target]: nav[target], machine: nav.machine } : null;
function copyDisplayAgent(agent) {
  return {
    id: agent.id, family: agent.family, title: agent.title, stage: agent.stage, status: agent.status,
    issue: agent.issue, closing: agent.closing ? { step: agent.closing.step, blocked_reason: agent.closing.blocked_reason,
      ...(owns(agent.closing, 'memory') ? { memory: copyMemory(agent.closing.memory) } : {}) } : null,
    tooltip_addr: null, nav: copyNavigation(agent.nav, 'pane_id'),
    ...(owns(agent, 'parent_id') ? { parent_id: agent.parent_id } : {}),
    ...(owns(agent, 'subagent_kind') ? { subagent_kind: agent.subagent_kind } : {}),
    ...agentExtras(agent),
  };
}
function copyDisplaySpace(space, agents) {
  return {
    id: space.id, name: space.name, bundle: space.bundle, computer: space.computer, nav: copyNavigation(space.nav, 'space_id'),
    share: space.share ? { computer: space.share.computer, kind: space.share.kind, ...(space.share.kind === 'agent' ? { agent_id: space.share.agent_id } : {}) } : null,
    slack: space.slack ? { channel: space.slack.channel } : null,
    work: space.work ? { tool: space.work.tool, key: space.work.key, open: space.work.open,...(owns(space.work,'url')?{url:space.work.url}:{}) } : null,
    issues: copyIssues(space.issues),
    memory: { proposals: space.memory.proposals }, agents,
    ...(owns(space, 'issue_catalog') ? { issue_catalog: space.issue_catalog ? {
      week: copyIssues(space.issue_catalog.week), milestone: copyIssues(space.issue_catalog.milestone), all: copyIssues(space.issue_catalog.all),
      import_request: space.issue_catalog.import_request ? { ...space.issue_catalog.import_request } : null,
      ...(owns(space.issue_catalog, 'milestones') ? { milestones: space.issue_catalog.milestones.map(item => ({ id: item.id, name: item.name,
        ...(owns(item, 'due') ? { due: item.due } : {}), ...(owns(item, 'progress') ? { progress: item.progress } : {}),
      })) } : {}),
      ...(owns(space.issue_catalog, 'cache') ? { cache: copyCatalogCache(space.issue_catalog.cache) } : {}),
      ...(owns(space.issue_catalog, 'updated_at') ? { updated_at: space.issue_catalog.updated_at } : {}),
      ...(owns(space.issue_catalog, 'results') ? { results: space.issue_catalog.results.map(item => ({ id: item.id, space: item.space, status: item.status, keys: [...item.keys], message: item.message,
        ...(owns(item, 'action') ? { action: item.action } : {}), ...(owns(item, 'code') ? { code: item.code } : {}),
      })) } : {}),
    } : null } : {}),
  };
}
function copyDisplayMetadata(feed) {
  return {
    v: feed.v, at: feed.at, reduced_motion: feed.reduced_motion,
    computers: feed.computers.map(computer => ({ id: computer.id, name: computer.name, linked: computer.linked, bundle: computer.bundle, traffic: { ...computer.traffic } })),
    links: feed.links.map(link => ({ a: link.a, b: link.b, kind: link.kind })),
    events: feed.events.map(event => ({ id: event.id, at: event.at, kind: event.kind, from: event.from, to: event.to, label: event.label,
      ...(typeof event.animate==='boolean'?{animate:event.animate}:{}),
      ...(owns(event, 'allocation') ? { allocation: event.allocation ? { kind: event.allocation.kind, count: event.allocation.count } : null } : {}),
      ...(owns(event, 'step') ? { step: event.step } : {}),
      ...(owns(event, 'memory') ? { memory: copyMemory(event.memory) } : {}),
    })),
  };
}

// Project a sanitized immutable snapshot into reusable display entities. The
// signatures contain display content only; they never interpret an opaque ID.
// Per-space groups are recomputed only for changed content or a changed final
// closing-tag visibility, rather than on each redraw or animation boundary.
export function projectPanelFeed(feed, previous = null, { includeClosedIds = new Set(), expandedIssueSpaces = new Set(), expandedParents = new Set() } = {}) {
  if (!feed) return null;
  const old = previous?._cache;
  const retainedKey = closedIds => JSON.stringify([...includeClosedIds].filter(id => closedIds.has(id)).sort());
  const expansionKey = (spaceIds, agentIds) => JSON.stringify([[...expandedIssueSpaces].filter(id => spaceIds.has(id)).sort(), [...expandedParents].filter(id => agentIds.has(id)).sort()]);
  if (old?.input === feed && old.retained === retainedKey(old.closedIds) && old.expansion === expansionKey(old.spaceIds, old.agentIds)) {
    return { ...previous, stats: { agentsChanged: 0, agentsReused: previous.agents.size, spacesChanged: 0, spacesReused: previous.spaces.length, groupsComputed: 0, groupsReused: previous.groups.size, signaturesComputed: 0 } };
  }
  const agents = new Map(), spaces = new Map(), groupEntries = [], agentEntries = [];
  const closedIds = new Set();
  const stats = { agentsChanged: 0, agentsReused: 0, spacesChanged: 0, spacesReused: 0, groupsComputed: 0, groupsReused: 0, signaturesComputed: 0 };
  const projectedSpaces = feed.spaces.map(space => {
    const projectedAgents = space.agents.map(agent => {
      const signature = JSON.stringify(agent);
      stats.signaturesComputed++;
      const before = old?.agents.get(agent.id);
      const value = before?.signature === signature ? before.value : copyDisplayAgent(agent);
      stats[value === before?.value ? 'agentsReused' : 'agentsChanged']++;
      agents.set(agent.id, { signature, value });
      agentEntries.push([agent.id, value]);
      if (value.closing?.step === 4 && !value.closing.blocked_reason) closedIds.add(value.id);
      return value;
    });
    const signature = JSON.stringify(space);
    stats.signaturesComputed++;
    const before = old?.spaces.get(space.id);
    const value = before?.signature === signature ? before.value : copyDisplaySpace(space, projectedAgents);
    stats[value === before?.value ? 'spacesReused' : 'spacesChanged']++;
    const retained = projectedAgents.filter(agent => agent.closing?.step === 4 && includeClosedIds.has(agent.id)).map(agent => agent.id).sort();
    const visibility = JSON.stringify([retained, expandedIssueSpaces.has(space.id), projectedAgents.filter(agent => expandedParents.has(agent.id)).map(agent => agent.id).sort()]);
    const groups = before?.value === value && before.visibility === visibility ? before.groups : agentGroups(value, { includeClosedIds, expandedIssueSpaces, expandedParents });
    stats[groups === before?.groups ? 'groupsReused' : 'groupsComputed']++;
    spaces.set(space.id, { signature, value, visibility, groups });
    groupEntries.push([space.id, groups]);
    return value;
  });
  const stableSpaces = sameReferences(previous?.spaces, projectedSpaces) ? previous.spaces : projectedSpaces;
  const metadata = JSON.stringify({ ...feed, spaces: undefined });
  stats.signaturesComputed++;
  const stableFeed = old?.metadata === metadata
    ? stableSpaces === previous.spaces ? previous.feed : { ...previous.feed, spaces: stableSpaces }
    : { ...copyDisplayMetadata(feed), spaces: stableSpaces };
  return {
    feed: stableFeed, spaces: stableSpaces,
    agents: sameMapReferences(previous?.agents, agentEntries) ? previous.agents : new Map(agentEntries),
    groups: sameMapReferences(previous?.groups, groupEntries) ? previous.groups : new Map(groupEntries), stats,
    _cache: { agents, spaces, metadata, input: feed, closedIds, retained: retainedKey(closedIds), spaceIds: new Set(spaces.keys()), agentIds: new Set(agents.keys()), expansion: expansionKey(new Set(spaces.keys()), new Set(agents.keys())) },
  };
}

export function createPanelProjection() {
  let previous = null;
  return { project(feed, options) { previous = projectPanelFeed(feed, previous, options); return previous; }, reset() { previous = null; } };
}

export function panelEventLabel(event){
  // Mockup ㉑: «일 나누기 · N개» only when one task is split into several; one dispatch
  // keeps the producer's own words («일 맡김»).
  if(event.kind==='dispatch')return event.allocation?.count>1?`일 나누기 · ${event.allocation.count}개`:event.label||'일 맡김';
  if(event.kind==='spawn')return '새 에이전트';
  if(event.label)return event.label;
  if(event.allocation?.kind==='new')return '조정: 새로 열어 맡김';
  if(event.allocation?.kind==='existing')return event.allocation.count>1?`계획: 일 ${event.allocation.count}개로 나눔`:'조정: 일 맡김';
  return {dispatch:'조정: 일 맡김',spawn:'조정: 새로 열어 맡김',review_request:'검수 요청',verdict:'검수 완료',accept:'수락',resume:'다시 작업 중',error:'작업 오류',
    close_step:['','보고 작성','경험·결정 저장','기억함 제안','닫힘'][event.step]||'닫기 진행'}[event.kind]||'';
}

// Pass the returned state back as previous. The initial snapshot is a watermark,
// so reopening a sidebar never replays old sends or old stage changes.
export function panelEventStates(feed, now, { previous = null, motion = true } = {}) {
  const animate = motion && feed?.reduced_motion !== true;
  const incoming = feed?.events ?? [];
  const seen = new Set(previous?.seen ?? incoming.map(event => event.id));
  const pending = new Map(previous?.pending ?? []);
  const agentStages=new Map(),stageNames=['대기','배분 중','작업 중','검수 중','수락 대기','수락됨'];  // 완료 is the cleanup target only (agentState)
  let stageRevision=previous?.stageRevision||0;
  for(const agent of (feed?.spaces||[]).flatMap(space=>space.agents)){
    const signature=JSON.stringify([agent.stage,agent.closing?.step||0]);agentStages.set(agent.id,signature);
    if(previous?.agentStages?.has(agent.id)&&previous.agentStages.get(agent.id)!==signature){
      const label=agent.closing?['','보고 작성','경험·결정 저장','기억함 제안','닫힘'][agent.closing.step]:stageNames[agent.stage];
      const event={id:`stage-${++stageRevision}`,kind:'stage_change',from:agent.id,to:null,label,sourceAt:now,at:now,routeAt:now,drawRoute:false};
      pending.set(event.id,event);
    }
  }
  for (const event of incoming) {
    if (seen.has(event.id)) {
      // Corrections can revoke a route, but never replay an old ID.
      if(event.animate===false||!event.from||!event.to){const old=pending.get(event.id);if(old)pending.set(event.id,{...old,drawRoute:false});}
      continue;
    }
    seen.add(event.id);
    // Polling can observe a send well after its source timestamp. Start native
    // transitions on first observation so the packet's initial phase is drawn.
    const label=panelEventLabel(event);
    const route=event.animate!==false&&event.from&&event.to&&event.from!==event.to;
    if(!route&&!label)continue;
    let routeAt=now,routeLane=0,drawRoute=Boolean(route);
    if(event.kind==='message'&&route&&animate){
      const queued=[...pending.values()].filter(item=>item.kind==='message'&&item.drawRoute&&item.routeAt+MESSAGE_TIMING.packetMs>now);
      if(queued.length>=8)drawRoute=false;
      else {
        const last=queued.at(-1);routeAt=Math.max(now,last?last.routeAt+260:now);
        const free=[0,1].map(lane=>Math.max(now,...queued.filter(item=>item.routeLane===lane).map(item=>item.routeAt+1000)));
        routeLane=free[0]<=free[1]?0:1;routeAt=Math.max(routeAt,free[routeLane]);
      }
    }
    pending.set(event.id,{...event,label,sourceAt:event.at,at:now,routeAt,routeLane,drawRoute});
  }
  const active = [], tags = new Map(), spawning = new Set(), packets = [], connections = [];
  const endpointComputers=new Map(),agentIDs=new Set(),computerNames=new Map((feed?.computers||[]).map(c=>[c.id,c.name]));
  for(const computer of feed?.computers||[])endpointComputers.set(computer.id,computer.id);
  for(const space of feed?.spaces||[]){endpointComputers.set(space.id,space.computer);for(const agent of space.agents){agentIDs.add(agent.id);endpointComputers.set(agent.id,space.computer);}}
  let nextAt = null;
  const wake = at => { if (at > now && (nextAt === null || at < nextAt)) nextAt = at; };
  for (const [key, event] of pending) {
    const elapsed = now - event.at;
    const timing=event.kind==='message'?MESSAGE_TIMING:PANEL_TIMING;
    const routeAt=event.routeAt??event.at,routeElapsed=now-routeAt;
    const sourceComputer=endpointComputers.get(event.from),targetComputer=endpointComputers.get(event.to);
    const incoming=event.kind==='message'&&event.drawRoute!==false&&event.animate!==false&&agentIDs.has(event.to)
      &&sourceComputer&&targetComputer&&sourceComputer!==targetComputer?computerNames.get(sourceComputer):null;
    const incomingAt=routeAt+(animate?timing.packetMs:0);
    const end = event.kind==='stage_change'?event.at+PANEL_TIMING.tagMs
      :Math.max(event.label?event.at+PANEL_TIMING.tagMs:0,routeAt + timing.packetMs + timing.pingMs + timing.coolMs,incoming?incomingAt+PANEL_TIMING.tagMs:0);
    if (now >= end) { pending.delete(key); continue; }
    if (elapsed < 0) { wake(event.at); continue; }
    active.push({ ...event, elapsed });
    if (event.label && elapsed < PANEL_TIMING.tagMs) {
      const target = event.kind === 'spawn' ? event.to : event.from;
      const old = tags.get(target);
      if (target && (!old || old.sourceAt < event.sourceAt || (old.sourceAt === event.sourceAt && old.at <= event.at))) tags.set(target, { ...event, elapsed });
      wake(event.at + PANEL_TIMING.tagMs);
    }
    if(incoming){
      if(now>=incomingAt&&now<incomingAt+PANEL_TIMING.tagMs)tags.set(event.to,{...event,id:`incoming-${event.id}`,label:`← ${incoming}`,elapsed:now-incomingAt});
      wake(incomingAt);wake(incomingAt+PANEL_TIMING.tagMs);
    }
    if (event.animate!==false && (event.kind === 'spawn'||event.allocation?.kind==='new') && event.to && elapsed < PANEL_TIMING.tagMs) {
      spawning.add(event.to);
      if(animate)wake(event.at+PANEL_TIMING.startMs);
    }
    if (event.drawRoute!==false&&event.animate!==false&&event.from&&event.to&&['message', 'dispatch', 'spawn', 'memory'].includes(event.kind)) {
      if(routeElapsed<0){wake(routeAt);wake(end);continue;}
      connections.push({ ...event, at:routeAt,elapsed:routeElapsed, phase: 'static' });
      if (animate) {
        const phase = routeElapsed < timing.startMs ? 'start' : routeElapsed < timing.packetMs ? 'travel' : routeElapsed < timing.packetMs + timing.pingMs ? 'ping' : 'fade';
        packets.push({ ...event, observedAt:event.at,at:routeAt,elapsed:routeElapsed,phase, travelMs: timing.packetMs - timing.startMs, progress: Math.max(0, Math.min(1, (routeElapsed - timing.startMs) / (timing.packetMs - timing.startMs))) });
        wake(phase === 'start' ? routeAt + timing.startMs : phase === 'travel' ? routeAt + timing.packetMs : phase === 'ping' ? routeAt + timing.packetMs + timing.pingMs : end);
      }
    }
    wake(end);
  }
  return { seen: [...seen].slice(-4096), pending: [...pending], active, tags, spawning, packets, connections, nextAt, motion: animate,agentStages,stageRevision };
}
