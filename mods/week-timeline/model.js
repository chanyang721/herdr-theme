// Linear timeline, read from a local feed (data/sixfold/week-timeline.json) that a user-owned
// producer writes. Pure functions only: the view and the tests share them.
//   A (always shown): this week — project > top issue > work items, by day.
//   B (on demand):    the whole project — project > milestone > my issues, by week.
export const DAYS = ['월', '화', '수', '목', '금', '토', '일'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/;
const LINK = /^https:\/\/linear\.app\/[A-Za-z0-9_-]+\/issue\/[A-Z][A-Z0-9]{0,9}-\d{1,7}$/;
const STATES = ['todo', 'started', 'review', 'done'];
const DAY = 86400000;
const str = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const date = value => DATE.test(value ?? '') ? value : '';

export function parseFeed(text) {
  let value;
  try { value = typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
  if (!value || value.v !== 2 || !Array.isArray(value.projects)) return null;
  const projects = value.projects.slice(0, 8).filter(p => p && typeof p.key === 'string' && p.key.trim()).map(p => ({
    key: str(p.key, 12), name: str(p.name, 120), workspace: str(p.workspace, 60), read: p.read !== false,
    milestones: (Array.isArray(p.milestones) ? p.milestones : []).slice(0, 40)
      .filter(m => m && typeof m.id === 'string' && m.id && typeof m.name === 'string' && m.name.trim())
      .map(m => ({ id: m.id.slice(0, 80), name: m.name.slice(0, 120), target: date(m.target),
        progress: typeof m.progress === 'number' && m.progress >= 0 && m.progress <= 100 ? m.progress : null })),
    issues: (Array.isArray(p.issues) ? p.issues : []).slice(0, 800).filter(i => i && KEY.test(i.key) && STATES.includes(i.state)).map(i => ({
      key: i.key, title: str(i.title, 160), status: str(i.status, 40), state: i.state, blocked: i.blocked === true,
      due: date(i.due), start: date(i.start), done_at: date(i.done_at),
      parent: KEY.test(i.parent ?? '') && i.parent !== i.key ? i.parent : '', milestone: str(i.milestone, 80),
      url: LINK.test(i.url ?? '') ? i.url : '',
    })),
  }));
  return { updated: str(value.updated, 40), attempted: str(value.attempted, 40), error: str(value.error, 200),
    week: { start: date(value.week?.start), end: date(value.week?.end) }, projects };
}

// --- dates (YYYY-MM-DD strings; whole days, no time zones) ----------------------------------
export function isoDay(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const utc = day => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));
export const addDays = (day, n) => new Date(utc(day) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / DAY);
export const monday = day => addDays(day, -((new Date(utc(day)).getUTCDay() + 6) % 7));
export const md = day => `${+day.slice(5, 7)}/${+day.slice(8, 10)}`;

// --- look --------------------------------------------------------------------------------------
// Theme tokens per kind of bar; `hot` is due today or late.
export const KIND = {
  todo: { token: 'idle', name: '할 일' }, started: { token: 'working', name: '진행 중' },
  review: { token: 'ansi5', name: '검토 중' }, done: { token: 'done', name: '완료' },
  hot: { token: 'blocked', name: '오늘 마감' }, late: { token: 'blocked', name: '기한 지남' },
  blocked: { token: 'blocked', name: '막힘' },
};
export const EPIC_TOKENS = ['accent', 'ansi3', 'ansi5', 'ansi2', 'ansi4', 'ansi1', 'ansi6'];

// What a work item shows: its lozenge kind (late/today/blocked win over the state).
export function kindOf(item, today) {
  if (item.state === 'done') return 'done';
  if (item.due && item.due < today) return 'late';
  if (item.due && item.due === today) return 'hot';
  if (item.blocked) return 'blocked';
  return item.state;
}

// Hex mix for lozenge backgrounds: `amount` of `b` into `a`.
export function mix(a, b, amount) {
  const parse = hex => { const m = /^#([0-9a-f]{6})/i.exec(hex || ''); return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : null; };
  const x = parse(a), y = parse(b);
  if (!x || !y) return a || b;
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * amount).toString(16).padStart(2, '0')).join('');
}

// --- A: this week -------------------------------------------------------------------------------
export function windowOf(feed, today, days = 7) {
  const start = feed?.week?.start || monday(today);
  return { start, days, end: addDays(start, days - 1), dates: Array.from({ length: days }, (_, i) => addDays(start, i)) };
}

// The top ancestor of `key`: itself without a parent, else the highest one known
// (a parent outside my issues is named by its key only). A parent cycle stops where it closes.
export function rootOf(key, byKey) {
  let at = key;
  const seen = new Set([key]);
  for (;;) {
    const up = byKey.get(at)?.parent;
    if (!up || seen.has(up)) return at;
    if (!byKey.has(up)) return up;
    seen.add(up);
    at = up;
  }
}

// Where an item's bar sits in the window, in day columns:
// { from, to, label } — label: "→ 11/25" past the window, "기한 없음" without a due day.
export function weekBar(item, win, today) {
  const at = day => daysBetween(win.start, day), last = win.days - 1;
  if (item.state === 'done') {
    const d = at(item.done_at || today);
    return { from: Math.max(0, Math.min(last, at(item.start || item.done_at || today))), to: Math.max(0, Math.min(last, d)), label: '' };
  }
  const due = item.due ? at(item.due) : null;
  const started = item.state === 'started' || item.state === 'review';
  let from = started ? (item.start ? at(item.start) : at(today)) : (due ?? at(today));
  let to = due ?? (started ? last : from);
  let label = due == null ? (started ? '기한 없음' : '') : '';
  if (due != null && due > last) { to = last; label = `→ ${md(item.due)}`; }
  if (due != null && due < 0) { from = 0; to = 0; label = `${md(item.due)} 지남`; }
  from = Math.max(0, Math.min(last, Math.min(from, to)));
  to = Math.max(from, Math.min(last, to));
  return { from, to, label };
}

// Rows for A. Work for the window: open items in progress or due by its last day (late ones too),
// grouped under their top issue. A top issue shows only as a group (thin bar + progress); a
// loose item with a due day stays visible under its project. Done this week counts toward progress.
export function weekRows(feed, { today = isoDay(), days = 7, filter = 'all', open = {} } = {}) {
  const win = windowOf(feed, today, days), rows = [];
  for (const p of feed?.projects ?? []) {
    if (filter !== 'all' && filter !== p.key) continue;
    const byKey = new Map(p.issues.map(i => [i.key, i]));
    const live = i => i.state !== 'done' && (i.state === 'started' || i.state === 'review' || (i.due && i.due <= win.end));
    const doneHere = i => i.state === 'done' && i.done_at >= win.start && i.done_at <= win.end;
    const groups = new Map(), loose = [];
    for (const i of p.issues) {
      if (!live(i) && !doneHere(i)) continue;
      const root = rootOf(i.key, byKey);
      if (root === i.key) { if (live(i)) loose.push(i); continue; }
      if (!groups.has(root)) groups.set(root, { key: root, items: [], done: 0 });
      const g = groups.get(root);
      if (live(i)) g.items.push(i); else g.done++;
    }
    for (const g of groups.values()) if (!g.items.length) groups.delete(g.key);
    // A loose top issue with open work beneath it is the group, not an item of its own.
    const shown = loose.filter(i => !groups.has(i.key) && i.due);
    const order = list => [...list].sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.key.localeCompare(b.key, 'en', { numeric: true }));
    const total = [...groups.values()].reduce((n, g) => n + g.items.length + g.done, 0) + shown.length;
    const done = [...groups.values()].reduce((n, g) => n + g.done, 0);
    const pOpen = open[p.key] !== false;
    rows.push({ kind: 'project', key: p.key, title: p.name || p.workspace, depth: 0, open: pOpen, done, total, empty: !groups.size && !shown.length, read: p.read });
    if (!pOpen) continue;
    const list = [...groups.values()].sort((a, b) => (order(a.items)[0].due || '9999').localeCompare(order(b.items)[0].due || '9999') || a.key.localeCompare(b.key, 'en', { numeric: true }));
    list.forEach((g, n) => {
      const epic = byKey.get(g.key), gOpen = open[`${p.key}/${g.key}`] !== false;
      const from = Math.min(...g.items.map(i => weekBar(i, win, today).from));
      rows.push({ kind: 'epic', key: g.key, title: epic?.title || '', depth: 1, open: gOpen, color: EPIC_TOKENS[n % EPIC_TOKENS.length],
        done: g.done, total: g.items.length + g.done, from, to: win.days - 1, url: epic?.url || '', id: `${p.key}/${g.key}` });
      if (gOpen) for (const i of order(g.items)) rows.push({ kind: 'item', depth: 2, ...i, look: kindOf(i, today), bar: weekBar(i, win, today) });
    });
    for (const i of order(shown)) rows.push({ kind: 'item', depth: 1, ...i, look: kindOf(i, today), bar: weekBar(i, win, today) });
  }
  return { win, rows };
}

// Day header cells for A.
export function dayCells(win, today) {
  return win.dates.map((day, i) => {
    const wd = (new Date(utc(day)).getUTCDay() + 6) % 7;
    const label = win.days <= 7 ? `${DAYS[wd]} ${md(day)}` : `${DAYS[wd]} ${+day.slice(8, 10)}`;
    return { day, label: day === today ? `${label} 오늘` : label, today: day === today, weekend: wd > 4 };
  });
}

// --- B: the whole project by milestone -------------------------------------------------------------
// Range: from three weeks before this Monday to the Sunday after the last target or due day.
export function projectRange(project, today) {
  const start = addDays(monday(today), -21);
  const days = [...(project?.milestones ?? []).map(m => m.target), ...(project?.issues ?? []).map(i => i.due), addDays(today, 28)].filter(Boolean);
  let end = addDays(monday(days.reduce((a, b) => (a > b ? a : b))), 6);
  if (daysBetween(start, end) > 52 * 7) end = addDays(start, 52 * 7 - 1);
  const span = daysBetween(start, end) + 1, weeks = [], months = [];
  for (let d = start; d <= end; d = addDays(d, 7)) weeks.push({ day: d, label: md(d), now: d <= today && today < addDays(d, 7) });
  for (let d = start; d <= end;) {
    const next = addDays(`${d.slice(0, 7)}-01`, 40).slice(0, 7) + '-01';
    const stop = next > end ? addDays(end, 1) : next;
    months.push({ label: `${+d.slice(5, 7)}월`, days: daysBetween(d, stop) });
    d = stop;
  }
  return { start, end, span, weeks, months };
}

// Rows for B. `open`: { [milestoneId]: bool } (default: the first two milestones not yet done).
export function projectRows(project, { today = isoDay(), open = {}, undated = false } = {}) {
  const range = projectRange(project, today), rows = [];
  if (!project) return { range, rows };
  const at = day => daysBetween(range.start, day);
  const ms = project.milestones, byMs = new Map(ms.map(m => [m.id, []])), none = [];
  for (const i of project.issues) (byMs.has(i.milestone) ? byMs.get(i.milestone) : none).push(i);
  const current = ms.filter(m => m.progress !== 100).slice(0, 2).map(m => m.id);
  const isOpen = id => open[id] ?? current.includes(id);
  const targets = ms.map(m => m.target).filter(Boolean).sort();
  if (!ms.length && !project.issues.length) {
    rows.push({ kind: 'project', key: project.key, title: project.name || project.workspace, empty: true });
    return { range, rows };
  }
  rows.push({ kind: 'project', key: project.key, title: project.name || project.workspace, empty: false,
    from: 0, to: targets.length ? at(targets[targets.length - 1]) : null,
    label: targets.length ? `${md(targets[0])} – ${md(targets[targets.length - 1])}` : '' });
  const issueRows = (list, depth) => {
    const dated = list.filter(i => i.start || i.due || i.done_at)
      .sort((a, b) => (a.due || a.done_at || '9999').localeCompare(b.due || b.done_at || '9999') || a.key.localeCompare(b.key, 'en', { numeric: true }));
    for (const i of dated) {
      const look = kindOf(i, today);
      const end = i.state === 'done' ? i.done_at || i.due : i.due || today;
      if (i.start) rows.push({ kind: 'item', depth, ...i, look, bar: { from: at(i.start), to: at(end) },
        label: i.due ? `${md(i.start)} – ${md(i.due)}` : `${md(i.start)} – 기한 없음` });
      else rows.push({ kind: 'item', depth, ...i, look, diamond: at(i.due || i.done_at), label: md(i.due || i.done_at) });
    }
    const left = list.length - dated.length;
    if (left) rows.push({ kind: 'undated', depth, count: left, shown: undated, items: undated ? list.filter(i => !(i.start || i.due || i.done_at)) : [] });
  };
  let prev = null;
  for (const m of ms) {
    const done = m.progress === 100, items = byMs.get(m.id) ?? [];
    const from = prev ? at(prev) + 1 : 0, to = m.target ? at(m.target) : null;
    rows.push({ kind: 'milestone', id: m.id, title: m.name, done, progress: m.progress, open: isOpen(m.id), has: items.length > 0,
      from, to, label: m.target ? md(m.target) : '목표일 없음' });
    if (m.target) prev = m.target;
    if (isOpen(m.id)) issueRows(items, 2);
  }
  if (none.length) {
    rows.push({ kind: 'milestone', id: '', title: '마일스톤 없음', done: false, progress: null, open: isOpen(''), has: true, from: null, to: null, label: '' });
    if (isOpen('')) issueRows(none, 2);
  }
  return { range, rows };
}

// --- status line ------------------------------------------------------------------------------------
const hhmm = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
// "확인 09:41" or, after a failed refresh, "갱신 실패 09:51" (the last good data stays shown).
export function freshness(feed) {
  if (!feed) return { text: '아직 읽지 않음', failed: false };
  const updated = Date.parse(feed.updated), attempted = Date.parse(feed.attempted);
  if (feed.error) return { text: `갱신 실패 ${Number.isFinite(attempted) ? hhmm(attempted) : ''}`.trim(), failed: true, detail: feed.error,
    since: Number.isFinite(updated) ? `마지막 값 ${hhmm(updated)}` : '' };
  return { text: Number.isFinite(updated) ? `확인 ${hhmm(updated)}` : '확인 전', failed: false };
}

// The user-owned producer: data/sixfold/week-timeline-bridge.json
// { "command": "/usr/bin/python3", "args": ["/path/week_timeline.py"] }. Absolute command only.
export function bridgeFrom(text) {
  let value;
  try { value = typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
  if (!value || typeof value.command !== 'string' || !value.command.startsWith('/')) return null;
  const args = v => (Array.isArray(v) ? v.filter(a => typeof a === 'string').slice(0, 8) : []);
  const apply = value.apply && typeof value.apply.command === 'string' && value.apply.command.startsWith('/')
    ? { command: value.apply.command, args: args(value.apply.args) } : null;
  return { command: value.command, args: args(value.args), apply };
}

// Whether the two chip rows should sit on one line: the timeline block is weight-sized, so its
// height tells the window's. Hysteresis keeps it from flipping at the edge.
export function wantCompact(height, compact, { max = 202, low = 150, high = 190 } = {}) {
  if (!(height > 0)) return compact;
  if (height >= max - 1) return false;
  return compact ? height < high : height < low;
}
