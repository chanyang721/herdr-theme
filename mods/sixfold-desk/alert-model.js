export const projectKey = name => String(name ?? '').toLowerCase().replace(/[\s_-]/g, '');
// A message timestamp identifies receipt. Later task edits are not new messages.
export const alertVersion = item => item.id;
export function scopedAlerts(items, {project, read = {}, unread = false} = {}) {
  return (items ?? []).filter(i => (!project || projectKey(i.project) === projectKey(project))
    && (!unread || read[i.id] !== alertVersion(i)));
}
// Linear inbox items carry the Herdr space they belong to (machine-local mapping).
export const linearScoped = (items, space) => (items ?? []).filter(i => !space || projectKey(i.workspace) === projectKey(space));
export const linearUnread = (items, space) => linearScoped(items, space).filter(i => !i.read).length;
// An alert belongs to a space shown in the sidebar; one whose space is not
// there (renamed, closed, unmapped) belongs to Share, so its arrival, badge,
// popover and inbox all agree. With no space list nothing is moved.
export function placeItems(items, names, fallback = 'Share') {
  const shown = new Map((names ?? []).map(name => [projectKey(name), name]));
  if (!shown.size) return items ?? [];
  const home = shown.get(projectKey(fallback)) ?? fallback;
  return (items ?? []).map(item => {
    const space = shown.get(projectKey(item?.workspace)) ?? home;
    return space === item?.workspace ? item : {...item, workspace: space, workspace_raw: item?.workspace ?? ''};
  });
}

// Issue fields the collector compares between runs; shown as "상태 Todo → Done".
// (The Linear inbox mod keeps the same table: mods cannot import each other.)
const CHANGE_LABEL = {issue_title: '제목', status: '상태', assignee: '담당', priority: '우선순위', due: '기한', project: '프로젝트'};
export const changeLines = item => (Array.isArray(item?.changes) ? item.changes : [])
  .filter(c => c && CHANGE_LABEL[c.field])
  .map(c => `${CHANGE_LABEL[c.field]} ${c.from || '없음'} → ${c.to || '없음'}`);
const LINEAR_CATEGORY = {assignments: '배정', mentions: '멘션', comments: '댓글', commentsAndReplies: '댓글', reviews: '리뷰', documentChanges: '문서', statusChanges: '상태 변경', reminders: '알림', reactions: '반응', subscriptions: '구독', triage: '분류'};
export const linearCategory = item => LINEAR_CATEGORY[item?.category] || '알림';

// The space card popover: which card and source is open, set by a badge press
// or by a new alert. Shared values persist across app restarts, so a state only
// counts in the run that wrote it (`boot`) and for POPOVER_TTL.
export const POPOVER_TTL = 30 * 60 * 1000;
export function popoverOpen(state, space, source, boot, now = Date.now()) {
  return Boolean(state && typeof boot === 'string' && state.boot === boot
    && projectKey(state.space) === projectKey(space) && state.source === source
    && Number.isFinite(state.at) && now - state.at < POPOVER_TTL);
}
// Newest first, unread before read, at most `limit` rows for the small popover.
export function popoverRows(items, limit = 5, isUnread = i => !i.read) {
  return [...(items ?? [])].sort((a, b) => (isUnread(b) - isUnread(a)) || String(b.at ?? '').localeCompare(String(a.at ?? ''))).slice(0, limit);
}

// Unread Linear alerts of one issue for its row in the issue search: how many,
// the newest `limit` as one line each ("Kim commented: …" + time + comment
// link), and how many more. Same items and read state as the alert popover.
export const ISSUE_ALERT_LINES = 2;
const LINEAR_URL = /^https:\/\/linear\.app\/[A-Za-z0-9_-]+\/(issue|project)\//;
export function issueAlerts(items, space, key, limit = ISSUE_ALERT_LINES) {
  if (!key) return null;
  const unread = linearScoped(items, space).filter(i => !i.read && String(i.issue || '').toUpperCase() === String(key).toUpperCase())
    .sort((a, b) => String(b.changed_at || b.at || '').localeCompare(String(a.changed_at || a.at || '')));
  if (!unread.length) return null;
  return {unread: unread.length, more: Math.max(0, unread.length - limit), lines: unread.slice(0, limit).map(i => ({
    id: i.id, category: linearCategory(i), at: i.changed_at || i.at || '',
    text: String(i.subtitle || i.comments?.[0]?.body || changeLines(i)[0] || i.title || '').split('\n')[0].slice(0, 200),
    url: typeof i.url === 'string' && LINEAR_URL.test(i.url) ? i.url : ''}))};
}
// Changes only when an issue's unread alerts change: part of the card key.
export const issueAlertSignature = (items, space) => linearScoped(items, space).filter(i => !i.read && i.issue)
  .map(i => `${i.issue}:${i.id}`).sort().join(',');
