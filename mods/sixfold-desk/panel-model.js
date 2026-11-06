// Display data only. The producer owns task interpretation and lifecycle policy.
export const PANEL_FEED_FILE = 'data/sixfold/harness-local/views/panel-feed.json';
export const PANEL_TIMING = Object.freeze({ tagMs: 1700, startMs: 40, packetMs: 1640, pingMs: 460, coolMs: 900 });
const MAX = Object.freeze({ computers: 64, spaces: 128, agents: 256, issues: 128, links: 512, events: 256, bytes: 2 * 1024 * 1024 });
const STATUSES = new Set(['working', 'idle', 'blocked', 'done']);
const STATES = ['blocked', 'working', 'review', 'waiting', 'done'];
const KINDS = new Set(['dispatch', 'review_request', 'verdict', 'accept', 'message', 'spawn', 'close_step', 'memory']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 160) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';
const id = value => typeof value === 'string' && value.length <= 160 && value.length > 0 && !/[\s\u0000-\u001f\u007f]/.test(value) ? value : '';
const integer = (value, max = 9999) => Number.isInteger(value) && value >= 0 ? Math.min(value, max) : 0;
const measurement = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, 1e12) : null;
const time = value => typeof value === 'string' ? (Number.isFinite(Date.parse(value)) ? Date.parse(value) : null) : Number.isFinite(value) && value >= 0 ? value : null;
const list = (value, limit) => Array.isArray(value) ? value.slice(0, limit) : [];
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
    ? { step: value.closing.step, blocked_reason: text(value.closing.blocked_reason, 300) } : null;
  return {
    id: value.id, family: ['claude', 'codex'].includes(value.family) ? value.family : 'unknown',
    title: text(value.title, 200), stage: Number.isInteger(value.stage) && value.stage >= 0 && value.stage <= 5 ? value.stage : 0,
    status: STATUSES.has(value.status) ? value.status : 'idle',
    issue: text(value.issue, 80) || null, closing, tooltip_addr: null, nav: navigation(value.nav, 'pane_id'),
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
    bundle: text(value.bundle, 80), traffic: { up: measurement(value.traffic?.up), down: measurement(value.traffic?.down) },
  } : null);
  const knownComputers = new Set(computers.map(item => item.id));
  const knownAgents = new Set();
  const spaces = unique(list(raw.spaces, MAX.spaces), value => {
    if (!object(value) || !id(value.id)) return null;
    const agents = unique(list(value.agents, MAX.agents), agent => cleanAgent(agent, knownAgents));
    const issues = unique(list(value.issues, MAX.issues).map(issue => object(issue) ? { ...issue, id: issue.key } : null), issue => object(issue) && id(issue.id) ? {
      id: issue.id, key: issue.id, title: text(issue.title, 200), state: STATES.includes(issue.state) ? issue.state : 'waiting',
    } : null);
    const work = object(value.work) && text(value.work.tool, 40) ? { tool: text(value.work.tool, 40).toLowerCase(), key: text(value.work.key, 80), open: integer(value.work.open) } : null;
    const share = object(value.share) && knownComputers.has(value.share.computer) && ['space', 'agent'].includes(value.share.kind)
      && (value.share.kind !== 'agent' || agents.some(agent => agent.id === value.share.agent_id))
      ? { computer: value.share.computer, kind: value.share.kind, ...(value.share.kind === 'agent' ? { agent_id: value.share.agent_id } : {}) } : null;
    return {
      id: value.id, name: text(value.name, 100), bundle: text(value.bundle, 80),
      computer: knownComputers.has(value.computer) ? value.computer : null, nav: navigation(value.nav, 'space_id'),
      share, slack: object(value.slack) && text(value.slack.channel, 80) ? { channel: text(value.slack.channel, 80) } : null,
      work, issues, memory: { proposals: integer(value.memory?.proposals) }, agents,
    };
  });
  const endpoints = new Set([...spaces.map(item => item.id), ...knownAgents]);
  const endpoint = value => id(value) && endpoints.has(value) ? value : null;
  const links = list(raw.links, MAX.links).flatMap(value => object(value) && value.kind === 'task' && knownAgents.has(value.a) && knownAgents.has(value.b) && value.a !== value.b
    ? [{ a: value.a, b: value.b, kind: 'task' }] : []);
  const events = unique(list(raw.events, MAX.events), value => object(value) && id(value.id) && KINDS.has(value.kind) && time(value.at) !== null ? {
    id: value.id, at: time(value.at), kind: value.kind, from: endpoint(value.from), to: endpoint(value.to),
    label: text(value.label, 100),
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
export function agentState(agent) {
  if (agent.closing?.blocked_reason || agent.status === 'blocked') return 'blocked';
  if (agent.status === 'done' || agent.stage === 5) return 'done';
  if (agent.stage === 3) return 'review';
  if (agent.stage === 4) return 'waiting';
  return agent.status === 'working' ? 'working' : 'waiting';
}
// The producer supplies recent-first arrays. Stable sorting keeps that order
// within each display state; opaque IDs and extra fields carry no date meaning.
const byState = (a, b) => STATES.indexOf(a.state) - STATES.indexOf(b.state) || a.index - b.index;
const sortedAgents = agents => agents.map((agent, index) => ({ agent, state: agentState(agent), index })).sort(byState).map(item => item.agent);
const limited = agents => ({ agents: agents.length > 4 ? agents.slice(0, 3) : agents, hidden: agents.length > 4 ? agents.length - 3 : 0 });

export function agentGroups(space, { includeClosedIds = new Set() } = {}) {
  const agents = sortedAgents((space?.agents ?? []).filter(agent => agent.closing?.step !== 4 || agent.closing.blocked_reason || includeClosedIds.has(agent.id)));
  if (!space?.work) return { grouped: false, groups: [], ...limited(agents) };
  const issues = (space.issues ?? []).map((issue, index) => ({ ...issue, index })).sort(byState);
  const assigned = new Set(issues.map(issue => issue.key));
  const groups = issues.map(issue => ({ issue, ...limited(agents.filter(agent => agent.issue === issue.key)) }));
  const unassigned = agents.filter(agent => !assigned.has(agent.issue));
  if (unassigned.length) groups.push({ issue: null, ...limited(unassigned) });
  return { grouped: true, groups, agents, hidden: groups.reduce((sum, group) => sum + group.hidden, 0) };
}

const sameReferences = (a, b) => a?.length === b.length && b.every((value, index) => value === a[index]);
const sameMapReferences = (a, entries) => a?.size === entries.length && entries.every(([key, value]) => a.get(key) === value);
const copyNavigation = (nav, target) => nav ? { [target]: nav[target], machine: nav.machine } : null;
function copyDisplayAgent(agent) {
  return {
    id: agent.id, family: agent.family, title: agent.title, stage: agent.stage, status: agent.status,
    issue: agent.issue, closing: agent.closing ? { step: agent.closing.step, blocked_reason: agent.closing.blocked_reason } : null,
    tooltip_addr: null, nav: copyNavigation(agent.nav, 'pane_id'),
  };
}
function copyDisplaySpace(space, agents) {
  return {
    id: space.id, name: space.name, bundle: space.bundle, computer: space.computer, nav: copyNavigation(space.nav, 'space_id'),
    share: space.share ? { computer: space.share.computer, kind: space.share.kind, ...(space.share.kind === 'agent' ? { agent_id: space.share.agent_id } : {}) } : null,
    slack: space.slack ? { channel: space.slack.channel } : null,
    work: space.work ? { tool: space.work.tool, key: space.work.key, open: space.work.open } : null,
    issues: space.issues.map(issue => ({ id: issue.id, key: issue.key, title: issue.title, state: issue.state })),
    memory: { proposals: space.memory.proposals }, agents,
  };
}
function copyDisplayMetadata(feed) {
  return {
    v: feed.v, at: feed.at, reduced_motion: feed.reduced_motion,
    computers: feed.computers.map(computer => ({ id: computer.id, name: computer.name, linked: computer.linked, bundle: computer.bundle, traffic: { up: computer.traffic.up, down: computer.traffic.down } })),
    links: feed.links.map(link => ({ a: link.a, b: link.b, kind: link.kind })),
    events: feed.events.map(event => ({ id: event.id, at: event.at, kind: event.kind, from: event.from, to: event.to, label: event.label })),
  };
}

// Project a sanitized immutable snapshot into reusable display entities. The
// signatures contain display content only; they never interpret an opaque ID.
// Per-space groups are recomputed only for changed content or a changed final
// closing-tag visibility, rather than on each redraw or animation boundary.
export function projectPanelFeed(feed, previous = null, { includeClosedIds = new Set() } = {}) {
  if (!feed) return null;
  const old = previous?._cache;
  const retainedKey = closedIds => JSON.stringify([...includeClosedIds].filter(id => closedIds.has(id)).sort());
  if (old?.input === feed && old.retained === retainedKey(old.closedIds)) {
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
    const visibility = JSON.stringify(retained);
    const groups = before?.value === value && before.visibility === visibility ? before.groups : agentGroups(value, { includeClosedIds });
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
    _cache: { agents, spaces, metadata, input: feed, closedIds, retained: retainedKey(closedIds) },
  };
}

export function createPanelProjection() {
  let previous = null;
  return { project(feed, options) { previous = projectPanelFeed(feed, previous, options); return previous; }, reset() { previous = null; } };
}

// Pass the returned state back as previous. The initial snapshot is a watermark,
// so reopening a sidebar never replays old sends or old stage changes.
export function panelEventStates(feed, now, { previous = null, motion = true } = {}) {
  const animate = motion && feed?.reduced_motion !== true;
  const incoming = feed?.events ?? [];
  const seen = new Set(previous?.seen ?? incoming.map(event => event.id));
  const pending = new Map(previous?.pending ?? []);
  for (const event of incoming) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    // Polling can observe a send well after its source timestamp. Start native
    // transitions on first observation so the packet's initial phase is drawn.
    pending.set(event.id, { ...event, sourceAt: event.at, at: now });
  }
  const active = [], tags = new Map(), spawning = new Set(), packets = [], connections = [];
  let nextAt = null;
  const wake = at => { if (at > now && (nextAt === null || at < nextAt)) nextAt = at; };
  for (const [key, event] of pending) {
    const elapsed = now - event.at;
    const end = event.at + PANEL_TIMING.packetMs + PANEL_TIMING.pingMs + PANEL_TIMING.coolMs;
    if (now >= end) { pending.delete(key); continue; }
    if (elapsed < 0) { wake(event.at); continue; }
    active.push({ ...event, elapsed });
    if (event.label && elapsed < PANEL_TIMING.tagMs) {
      const target = event.kind === 'spawn' ? event.to : event.from;
      const old = tags.get(target);
      if (target && (!old || old.sourceAt < event.sourceAt || (old.sourceAt === event.sourceAt && old.at <= event.at))) tags.set(target, { ...event, elapsed });
      wake(event.at + PANEL_TIMING.tagMs);
    }
    if (event.kind === 'spawn' && event.to && elapsed < PANEL_TIMING.tagMs) spawning.add(event.to);
    if (['message', 'dispatch', 'spawn', 'memory'].includes(event.kind)) {
      connections.push({ ...event, elapsed, phase: 'static' });
      if (animate) {
        const phase = elapsed < PANEL_TIMING.startMs ? 'start' : elapsed < PANEL_TIMING.packetMs ? 'travel' : elapsed < PANEL_TIMING.packetMs + PANEL_TIMING.pingMs ? 'ping' : 'fade';
        packets.push({ ...event, elapsed, phase, travelMs: PANEL_TIMING.packetMs - PANEL_TIMING.startMs, progress: Math.max(0, Math.min(1, (elapsed - PANEL_TIMING.startMs) / (PANEL_TIMING.packetMs - PANEL_TIMING.startMs))) });
        wake(phase === 'start' ? event.at + PANEL_TIMING.startMs : phase === 'travel' ? event.at + PANEL_TIMING.packetMs : phase === 'ping' ? event.at + PANEL_TIMING.packetMs + PANEL_TIMING.pingMs : end);
      }
    }
    wake(end);
  }
  return { seen: [...seen].slice(-4096), pending: [...pending], active, tags, spawning, packets, connections, nextAt, motion: animate };
}
