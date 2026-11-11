// C: one issue's detail for the popup, and the changes waiting to be written to Linear.
// Pure functions (tests import them); the producer writes week-timeline-issues/<KEY>.json.

const KEY = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/;
const CHECK = /^(\s*[-*] \[)( |x|X)(\] )(.+)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, n = 400) => (typeof v === 'string' ? v.slice(0, n) : '');
const list = v => (Array.isArray(v) ? v : []);

export const isKey = key => typeof key === 'string' && KEY.test(key);

export function parseDetail(text, key) {
  let v;
  try { v = typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
  if (!v || v.v !== 1 || v.key !== key) return null;
  const i = v.issue && v.issue.key === key ? v.issue : null;
  return {
    key, error: str(v.error, 200), readAt: str(v.read_at, 40), attempted: str(v.attempted, 40), stale: Boolean(v.stale),
    issue: i && {
      key, title: str(i.title, 200), description: str(i.description, 12000), status: str(i.status, 40), statusType: str(i.status_type, 20),
      assignee: str(i.assignee, 80), labels: list(i.labels).filter(l => typeof l === 'string'), due: DATE.test(i.due) ? i.due : '',
      start: DATE.test(i.start) ? i.start : '', milestone: str(i.milestone, 120), parent: isKey(i.parent) ? i.parent : '',
      project: str(i.project, 120), team: str(i.team, 60), url: /^https:\/\/linear\.app\//.test(i.url || '') ? i.url : '',
      relations: list(i.relations).filter(r => r && isKey(r.key)).map(r => ({ type: str(r.type, 30), key: r.key, title: str(r.title, 120), status: str(r.status, 40) })),
    },
    statuses: list(v.statuses).filter(s => s && str(s.name)).map(s => ({ name: s.name, type: str(s.type, 20), color: str(s.color, 7) })),
    labels: list(v.labels).filter(l => l && str(l.name)).map(l => ({ name: l.name, color: str(l.color, 7) })),
    comments: list(v.comments).filter(c => c && str(c.id) && typeof c.body === 'string')
      .map(c => ({ id: c.id, parent: str(c.parent, 40), author: str(c.author, 80), at: str(c.at, 40), body: str(c.body, 4000) })),
    notices: list(v.notices).filter(n => n && str(n.text)).map(n => ({ type: str(n.type, 40), text: str(n.text, 240), at: str(n.at, 40), read: Boolean(n.read) })),
    slack: list(v.slack).filter(s => s && str(s.text)).map(s => ({ channel: str(s.channel, 80), at: str(s.at, 40), text: str(s.text, 200) })),
    slackReady: Boolean(v.slack_ready),
    herdr: list(v.herdr).filter(h => h && str(h.task)).map(h => ({
      task: h.task, title: str(h.title, 120), kind: str(h.kind, 20), done: str(h.done, 160), remaining: str(h.remaining, 120),
      at: str(h.at, 40), terminal: /^t[0-9a-z]{1,8}$/.test(h.terminal || '') ? h.terminal : '' })),
  };
}

// The description, split into prose lines and to-do lines (`- [ ] …`), in order.
export function splitDescription(description) {
  return str(description, 12000).split('\n').map(line => {
    const m = CHECK.exec(line);
    return m ? { kind: 'check', line, text: m[4], done: m[2] !== ' ' } : { kind: 'text', line, text: line };
  });
}

// Root comments with their replies, oldest first.
export function threads(comments) {
  const roots = comments.filter(c => !c.parent || !comments.some(p => p.id === c.parent));
  return roots.map(r => ({ ...r, replies: comments.filter(c => c.parent === r.id) }));
}

// --- pending changes --------------------------------------------------------------------------

// One change in, the new pending list out. Same field: the later value wins; going back to what
// Linear has drops the change; a label toggled twice cancels out; replies add up.
export function addChange(pending, change, issue) {
  const rest = pending.filter(c => c.kind !== change.kind || c.kind === 'reply' || c.kind === 'label' || (c.kind === 'check' && c.line !== change.line));
  if (change.kind === 'reply') return [...pending, { ...change, rid: change.rid || newId() }];
  if (change.kind === 'status') return change.to === issue.status ? rest : [...rest, change];
  if (change.kind === 'assignee') return [...rest, change];
  if (change.kind === 'due') return (change.to || '') === issue.due ? rest : [...rest, change];
  if (change.kind === 'check') {
    const original = splitDescription(issue.description).find(l => l.kind === 'check' && l.line === change.line);
    return !original || original.done === change.done ? rest : [...rest, change];
  }
  if (change.kind === 'label') {
    const have = new Set(issue.labels), want = new Set(effective(issue, pending).labels);
    if (want.has(change.name)) want.delete(change.name); else want.add(change.name);
    const add = [...want].filter(l => !have.has(l)), remove = [...have].filter(l => !want.has(l));
    const others = pending.filter(c => c.kind !== 'label');
    return add.length || remove.length ? [...others, { kind: 'label', add, remove }] : others;
  }
  return pending;
}

export const removeChange = (pending, index) => pending.filter((_c, i) => i !== index);

// What the popup shows: Linear's values with the pending changes on top.
export function effective(issue, pending) {
  const out = { status: issue.status, assignee: issue.assignee, due: issue.due, labels: [...issue.labels], checks: {} };
  for (const c of pending) {
    if (c.kind === 'status') out.status = c.to;
    if (c.kind === 'assignee') out.assignee = c.to === 'me' ? '나' : c.to ?? '';
    if (c.kind === 'due') out.due = c.to || '';
    if (c.kind === 'label') out.labels = [...issue.labels.filter(l => !c.remove.includes(l)), ...c.add];
    if (c.kind === 'check') out.checks[c.line] = c.done;
  }
  return out;
}

export function describeChange(c) {
  if (c.kind === 'status') return `상태 → ${c.to}`;
  if (c.kind === 'assignee') return `담당 → ${c.to === 'me' ? '나' : c.to ?? '없음'}`;
  if (c.kind === 'due') return `마감 → ${c.to || '없음'}`;
  if (c.kind === 'label') return `라벨 ${[...c.add.map(l => `+${l}`), ...c.remove.map(l => `−${l}`)].join(' ')}`;
  if (c.kind === 'check') return `할 일 ${c.done ? '완료' : '해제'}: ${c.line.replace(CHECK, '$4').slice(0, 40)}`;
  if (c.kind === 'reply') return `${c.parent ? '답글' : '댓글'}: ${c.body.replace(/\s+/g, ' ').slice(0, 40)}`;
  return '';
}

// Ids for a request and for each reply (the apply script never sends a reply key twice).
export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// The request the apply script reads; `id` ties the result to it.
export function requestOf(key, id, pending) {
  return { key, id, changes: pending.map(c => c.kind === 'label' ? { kind: 'label', add: c.add, remove: c.remove } : c) };
}

export function parseApply(text, key) {
  let v;
  try { v = typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
  if (!v || v.key !== key || typeof v.at !== 'string') return null;
  return { at: v.at, request: str(v.request, 80), ok: v.ok === true, error: str(v.error, 200), applied: Number(v.applied) || 0,
    kept: list(v.kept).filter(c => c && typeof c.kind === 'string') };
}

// project › milestone › parent › key
export function breadcrumb(detail, row) {
  const i = detail?.issue;
  return [i?.project || row?.project || '', i?.milestone || row?.milestone || '', i?.parent || row?.parent || '', i?.key || row?.key || '']
    .filter(Boolean);
}

// Related issues worth a look: blockers first, then the rest.
export function related(issue) {
  const rank = t => (/block/i.test(t) ? 0 : 1);
  return [...(issue?.relations ?? [])].sort((a, b) => rank(a.type) - rank(b.type));
}

export function relationLabel(type) {
  return /blocked/i.test(type) ? '이 이슈를 막음' : /block/i.test(type) ? '이 이슈가 막음' : /duplicate/i.test(type) ? '중복' : '관련';
}

export function when(stamp) {
  const d = new Date(stamp);
  if (Number.isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
