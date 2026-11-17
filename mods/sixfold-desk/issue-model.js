// Display data for the issue search's Linear side: each issue's real Linear status, the project's
// milestones in Linear's own order, and an issue's detail. Inputs are the collector's read caches
// (linear-cache.js) and the feed; nothing is guessed — a status not read yet is '상태 미확인'.

const TYPE_ORDER = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'];
export const UNKNOWN_STATUS = '상태 미확인';
// Linear-like icons: backlog dashed, todo empty, in progress half, in review mostly full, blocked
// stop, done check, canceled/duplicate cross.
export function statusLook(status) {
  const name = String(status?.name || ''), type = String(status?.type || ''), lower = name.toLowerCase();
  if (!name) return {kind: 'unknown', icon: '·', label: UNKNOWN_STATUS};
  if (/block/.test(lower) || name.includes('막힘')) return {kind: 'blocked', icon: '⊘', label: name};
  if (/review/.test(lower) || name.includes('검토') || name.includes('리뷰')) return {kind: 'review', icon: '◕', label: name};
  if (/duplicate/.test(lower)) return {kind: 'canceled', icon: '⊗', label: name};
  const kind = TYPE_ORDER.includes(type) ? type : /done|complete/.test(lower) ? 'completed' : /cancel/.test(lower) ? 'canceled'
    : /progress/.test(lower) ? 'started' : /backlog/.test(lower) ? 'backlog' : /todo/.test(lower) ? 'unstarted' : 'unstarted';
  return {kind, icon: {triage: '◇', backlog: '◌', unstarted: '○', started: '◐', completed: '✔', canceled: '✕'}[kind], label: name};
}
const HEX = /^#[0-9a-f]{6}$/i;
export function statusTone(status, t) {
  if (HEX.test(status?.color || '')) return status.color;
  const look = statusLook(status);
  return {unknown: t.dim, triage: t.muted, backlog: t.dim, unknownType: t.dim, unstarted: t.muted, started: t.ansi3 || t.accent,
    review: t.ansi2 || t.accent, blocked: t.blocked, completed: t.ansi4 || t.accent, canceled: t.dim}[look.kind] ?? t.muted;
}
// Done and canceled are folded by default.
export const folded = status => ['completed', 'canceled'].includes(statusLook(status).kind);

// Issue key -> {name, type, color} from the project cache (the team's status list gives type and color).
export function statusIndex(project) {
  const teams = project?.statuses && typeof project.statuses === 'object' ? project.statuses : {};
  const byName = new Map();
  for (const list of Object.values(teams)) for (const s of Array.isArray(list) ? list : []) if (s?.name && !byName.has(s.name)) byName.set(s.name, s);
  const index = new Map();
  for (const issue of Array.isArray(project?.issues) ? project.issues : []) {
    if (!issue?.key || !issue.status) continue;
    const team = (teams[issue.team] || []).find(s => s?.name === issue.status) || byName.get(issue.status);
    index.set(issue.key, {name: issue.status, type: issue.status_type || team?.type || '', color: team?.color || ''});
  }
  return index;
}
// The statuses an issue can move to: its team's list, else every status the project cache knows.
export function teamStatuses(project, team) {
  const teams = project?.statuses && typeof project.statuses === 'object' ? project.statuses : {};
  const list = Array.isArray(teams[team]) ? teams[team] : Object.values(teams).flat();
  const seen = new Set();
  return list.filter(s => s?.name && !seen.has(s.name) && seen.add(s.name))
    .sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)).slice(0, 20);
}

// Filter chips over the shown rows: 전체, then each status present (Linear type order), with counts.
export function statusFilters(rows, statusOf) {
  const counts = new Map();
  for (const row of rows) {
    const status = statusOf(row.key);
    const name = status?.name || UNKNOWN_STATUS;
    const entry = counts.get(name) || {name, status, count: 0};
    entry.count++; counts.set(name, entry);
  }
  const rank = entry => entry.name === UNKNOWN_STATUS ? 99 : TYPE_ORDER.indexOf(statusLook(entry.status).kind === 'review' || statusLook(entry.status).kind === 'blocked' ? 'started' : statusLook(entry.status).kind);
  return [{name: '전체', count: rows.length}, ...[...counts.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))];
}
// Rows the list shows for a filter: '전체' hides done/canceled unless `showFolded`.
export function filterRows(rows, statusOf, filter = '전체', showFolded = false) {
  if (filter && filter !== '전체') return rows.filter(row => (statusOf(row.key)?.name || UNKNOWN_STATUS) === filter);
  return showFolded ? rows : rows.filter(row => !folded(statusOf(row.key)));
}
export const foldedCount = (rows, statusOf) => rows.filter(row => folded(statusOf(row.key))).length;

// Milestones: Linear's own list and order when the project cache has it, else the catalog's.
// Issue count and progress are Linear's; computed ones are marked (counted) and shown '계산값'.
export function milestoneList(project, catalog, unreadKeys = new Set()) {
  const fromLinear = Array.isArray(project?.milestones) && project.milestones.length;
  // Titles come from the sidebar's lists when the project read left them out (compact rows).
  const titles = new Map([...(catalog?.week || []), ...(catalog?.milestone || []), ...(catalog?.all || [])].filter(i => i?.key).map(i => [i.key, i.title]));
  const issues = (fromLinear ? (project.issues || []) : [...(catalog?.milestone || []), ...(catalog?.all || [])])
    .map(issue => issue?.title || !titles.has(issue?.key) ? issue : {...issue, title: titles.get(issue.key)});
  const byMilestone = new Map();
  for (const issue of issues) {
    if (!issue?.milestone_id || !issue.key) continue;
    const list = byMilestone.get(issue.milestone_id) || new Map();
    list.set(issue.key, issue); byMilestone.set(issue.milestone_id, list);
  }
  const source = fromLinear ? project.milestones : (catalog?.milestones || []);
  return source.filter(m => m?.id && m.name).map(m => {
    const list = [...(byMilestone.get(m.id)?.values() || [])];
    const progress = typeof m.progress === 'number' ? Math.max(0, Math.min(100, m.progress)) : null;
    // Linear's milestones keep an unknown count unknown (null → '—'); the catalog fallback counts its rows.
    const count = Number.isInteger(m.issues) ? m.issues : fromLinear ? null : list.length;
    const status = m.status || (progress === null ? 'planned' : progress >= 100 ? 'done' : progress > 0 ? 'started' : 'planned');
    return {id: m.id, name: m.name, target: m.target || m.due || '', progress, issues: count,
      counted: fromLinear ? m.counted === true : true, status, items: list,
      unread: list.filter(issue => unreadKeys.has(issue.key)).length};
  });
}

const clip = (value, limit) => { const s = String(value ?? '').trim(); return s.length > limit ? `${s.slice(0, limit - 1)}…` : s; };
// The detail of one issue: the read issue (or what the lists know), comments, bound agent work and
// the unread alerts that say what changed.
export function detailData(key, {issueCache = null, row = null, status = null, agents = [], alerts = []} = {}) {
  const issue = issueCache?.issue && issueCache.issue.key === key ? issueCache.issue : null;
  const shownStatus = issue?.status ? {name: issue.status, type: issue.status_type || status?.type || '', color: status?.color || ''} : status;
  return {
    key, title: issue?.title || row?.title || key, url: issue?.url || '',
    status: shownStatus || null,
    fields: [['담당', issue?.assignee], ['마감', issue?.due], ['마일스톤', issue?.milestone], ['우선순위', issue?.priority],
      ['라벨', (issue?.labels || []).slice(0, 8).join(', ')]].filter(([, value]) => value),
    team: issue?.team || '',
    description: clip(issue?.description, 420),
    comments: (Array.isArray(issueCache?.comments) ? issueCache.comments : []).slice(0, 5)
      .map(c => ({author: clip(c?.author, 40), at: c?.at || '', body: clip(c?.body, 260)})),
    agents: (agents || []).filter(a => a?.issue === key).slice(0, 6).map(a => ({id: a.id, title: clip(a.title, 80), status: a.status || ''})),
    alerts: (alerts || []).slice(0, 6),
    loaded: Boolean(issue), state: issueCache?.state || '', error: issueCache?.state === 'error' ? clip(issueCache.error, 120) : '',
    at: issueCache?.at || '',
  };
}

// --- Parent/child tree of an issue list -----------------------------------------------------------
// What the lists know of each issue: its row (title, for a parent shown outside the list) and its
// parent key. Only rows that name a parent give one (week-timeline.json does; a feed catalog only when
// its producer sends `parent`); without any, every list stays flat as before.
const ISSUE_KEY = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/;
export const TREE_MAX_DEPTH = 3;
export function issueLedger(...lists) {
  const rows = new Map(), parents = new Map();
  for (const list of lists) for (const issue of Array.isArray(list) ? list : []) {
    if (!issue?.key) continue;
    const seen = rows.get(issue.key);
    if (!seen || (!seen.title && issue.title)) rows.set(issue.key, issue);
    if (!parents.has(issue.key) && ISSUE_KEY.test(issue.parent || '') && issue.parent !== issue.key) parents.set(issue.key, issue.parent);
  }
  return {rows, parents};
}
// The shown rows as a tree: [{issue, depth, ghost, known}]. A row's parent that the list does not show
// (another tab, filtered out, another milestone) is a dimmed header (`ghost`), with the ledger's row
// when known (`known`), else its key only. Groups keep the rows' order: a group sits where its first
// shown member was, and inside it the rows keep their order. A parent loop is cut where it closes;
// depth stops growing at TREE_MAX_DEPTH. Headers are display only: counts stay the rows' own.
export function issueTree(rows, ledger = null) {
  const list = (Array.isArray(rows) ? rows : []).filter(row => row?.key);
  const parents = ledger?.parents;
  if (!parents?.size) return list.map(issue => ({issue, depth: 0, ghost: false, known: true}));
  const order = new Map(), nodes = new Map();
  for (const issue of list) if (!nodes.has(issue.key)) { order.set(issue.key, order.size); nodes.set(issue.key, {issue, ghost: false, known: true}); }
  for (const issue of list) {
    let at = issue.key; const seen = new Set([at]);
    for (let step = 0; step < 32; step++) {
      const up = parents.get(at);
      if (!up || seen.has(up)) break;
      seen.add(up);
      if (!nodes.has(up)) {
        const known = ledger.rows?.get(up);
        nodes.set(up, {issue: known || {key: up, title: ''}, ghost: true, known: Boolean(known)});
      }
      at = up;
    }
  }
  // Keep a parent link only when it does not close a loop through the links kept so far.
  const link = new Map();
  for (const key of nodes.keys()) {
    const up = parents.get(key);
    if (!up || !nodes.has(up)) continue;
    let at = up, loop = false;
    for (let step = 0; at && step <= nodes.size; step++) { if (at === key) { loop = true; break; } at = link.get(at); }
    if (!loop) link.set(key, up);
  }
  const kids = new Map(), roots = [];
  for (const key of nodes.keys()) {
    const up = link.get(key);
    if (up) { if (!kids.has(up)) kids.set(up, []); kids.get(up).push(key); } else roots.push(key);
  }
  const rank = new Map();
  const rankOf = key => {
    if (rank.has(key)) return rank.get(key);
    rank.set(key, Infinity);
    let best = order.has(key) ? order.get(key) : Infinity;
    for (const kid of kids.get(key) || []) best = Math.min(best, rankOf(kid));
    rank.set(key, best);
    return best;
  };
  const byRank = (a, b) => { const x = rankOf(a), y = rankOf(b); return x === y ? 0 : x < y ? -1 : 1; };
  const out = [];
  const visit = (key, depth) => {
    if (rankOf(key) === Infinity) return;
    const node = nodes.get(key);
    out.push({issue: node.issue, depth: Math.min(depth, TREE_MAX_DEPTH), ghost: node.ghost, known: node.known});
    for (const kid of (kids.get(key) || []).slice().sort(byRank)) visit(kid, depth + 1);
  };
  for (const key of roots.sort(byRank)) visit(key, 0);
  return out;
}
