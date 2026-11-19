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
// The workspace that receives alerts whose own workspace is not shown. "Hub" unless the
// sidebar publishes the site's "fallback_space" (site.local.json).
let fallbackSpace = 'Hub';
export const setFallbackSpace = name => { if (typeof name === 'string' && name.trim()) fallbackSpace = name.trim(); };
export const currentFallbackSpace = () => fallbackSpace;
// An alert belongs to a space shown in the sidebar; one whose space is not
// there (renamed, closed, unmapped) belongs to the fallback space, so its arrival, badge,
// popover and inbox all agree. With no space list nothing is moved.
export const UNSORTED = '미분류';
// The fallback space when it is on screen; otherwise the first space shown, so an alert never
// lands on a space that does not exist (fallback_space unset and no space named Hub).
export function placeItems(items, names, fallback = fallbackSpace) {
  const shown = new Map((names ?? []).map(name => [projectKey(name), name]));
  if (!shown.size) return items ?? [];
  const home = shown.get(projectKey(fallback)) ?? names[0];
  return (items ?? []).map(item => {
    // Not placed yet (its issue is read on the next run): it stays 미분류, never the fallback.
    if (item?.workspace === UNSORTED) return item;
    const space = shown.get(projectKey(item?.workspace)) ?? home;
    return space === item?.workspace ? item : {...item, workspace: space, workspace_raw: item?.workspace ?? ''};
  });
}

// Issue fields the collector compares between runs; shown as "상태 Todo → Done".
// (The Linear inbox mod keeps the same table: mods cannot import each other.)
const CHANGE_LABEL = {issue_title: '제목', status: '상태', assignee: '담당', priority: '우선순위', due: '기한', project: '프로젝트'};
// A state-change notification's own before -> after, which the collector reads from Linear's issue
// history (`state_change`). It wins over the between-runs diff; without it nothing earlier is guessed.
export function stateChange(item) {
  const c = item?.state_change;
  return c && typeof c.to === 'string' && c.to ? {from: typeof c.from === 'string' ? c.from : '', to: c.to} : null;
}
const changeText = (label, from, to) => `${label} ${from || '없음'} → ${to || '없음'}`;
export const changeLines = item => {
  const own = stateChange(item);
  return [...(own ? [changeText('상태', own.from, own.to)] : []),
    ...(Array.isArray(item?.changes) ? item.changes : []).filter(c => c && CHANGE_LABEL[c.field] && !(own && c.field === 'status'))
      .map(c => changeText(CHANGE_LABEL[c.field], c.from, c.to))];
};
const LINEAR_CATEGORY = {assignments: '배정', mentions: '멘션', comments: '댓글', commentsAndReplies: '댓글', reviews: '리뷰', documentChanges: '문서', statusChanges: '상태 변경', reminders: '알림', reactions: '반응', subscriptions: '구독', triage: '분류'};
export const linearCategory = item => LINEAR_CATEGORY[item?.category] || '알림';

// What kind of alert, at a glance: Linear's notification type -> badge. The same table is in
// sixfold-linear-inbox/model.js (mods cannot import each other). An unknown type keeps its own
// name (never hidden); one with no type falls back to its category.
export const ALERT_KINDS = Object.freeze({
  new: '신규 이슈', comment: '댓글', reply: '답글', assign: '배정', status: '상태 변경',
  due: '마감', mention: '멘션', review: '확인 요청', reaction: '반응', other: '알림'});
const TYPE_KIND = {
  issueCreated: 'new', issueNewIssue: 'new', triageResponsibilityIssueAddedToTriage: 'review',
  issueNewComment: 'comment', issueComment: 'comment', issueCommentReply: 'reply', issueThreadReply: 'reply',   // issueComment: a space issue's comment read here (local)
  issueAssignedToYou: 'assign', issueUnassignedFromYou: 'assign',
  issueStatusChanged: 'status', issueStatusChangedAll: 'status', issueBlocking: 'status', issueUnblocked: 'status',
  issuePriorityUrgent: 'status', issueTitleChanged: 'status',
  issueDue: 'due', issueDueDateApproaching: 'due', issueReminder: 'due',
  issueMention: 'mention', issueCommentMention: 'mention', documentMention: 'mention', projectUpdateMentionPrompt: 'mention',
  issueReviewRequested: 'review', pullRequestReviewRequested: 'review', issueApprovalRequested: 'review', projectUpdatePrompt: 'review',
  issueCommentReaction: 'reaction', issueEmojiReaction: 'reaction', projectUpdateReaction: 'reaction'};
const CATEGORY_KIND = {assignments: 'assign', mentions: 'mention', comments: 'comment', commentsAndReplies: 'comment',
  reviews: 'review', statusChanges: 'status', reminders: 'due', reactions: 'reaction', triage: 'review'};
export function alertKind(item) {
  const type = String(item?.type || '');
  let kind = TYPE_KIND[type] || (/review|approval/i.test(type) ? 'review' : '') || (type ? '' : CATEGORY_KIND[item?.category] || 'other');
  // A comment that answers another one ("Kim replied: …") is a reply.
  if (kind === 'comment' && /^\S.{0,60}? replied:/.test(String(item?.subtitle || ''))) kind = 'reply';
  return kind ? {kind, label: ALERT_KINDS[kind]} : {kind: 'other', label: type};
}
// One color per kind, from the theme's own palette.
export const kindTone = (kind, t) => ({new: t.ansi2, comment: t.accent, reply: t.ansi6, assign: t.ansi3, status: t.ansi4, due: t.blocked,
  mention: t.ansi5, review: t.ansi1, reaction: t.dim}[kind] || t.muted) || t.accent;
// The second line says what changed, by kind: a comment its author and first line; a status
// change before -> after; a new issue who made it and its project; an assignment who assigned.
export function alertLine(item) {
  const first = value => String(value ?? '').split('\n')[0].slice(0, 200);
  const subtitle = first(item?.subtitle), {kind} = alertKind(item);
  const status = stateChange(item) || (Array.isArray(item?.changes) ? item.changes : []).find(c => c?.field === 'status');
  if (kind === 'status' && status) {
    // Who changed it, from Linear's own line ("Marked as completed by Kim").
    const by = /\bby (.{1,60})$/i.exec(subtitle)?.[1];
    return [changeText('상태', status.from, status.to), by].filter(Boolean).join(' · ');
  }
  if (kind === 'assign') { const by = /^Assigned by (.+)$/i.exec(subtitle)?.[1]; if (by) return `${by} 님이 배정`; }
  if (kind === 'new') return [subtitle.replace(/^Created by /i, '만든 사람 ') || '새 이슈', item?.project].filter(Boolean).join(' · ');
  if (kind === 'due') {
    const when = item?.due ? `기한 ${item.due}` : '';
    return [/overdue/i.test(subtitle) ? '기한 지남' : /soon|approach/i.test(subtitle) ? '기한 임박' : subtitle, when].filter(Boolean).join(' · ');
  }
  return subtitle || first(item?.comments?.[0]?.body) || changeLines(item)[0] || first(item?.title);
}
// The popover's change lines: for a status notification its state line also says who changed it.
export function popoverChangeLines(item) {
  const lines = changeLines(item), at = lines.findIndex(l => l.startsWith('상태 '));
  return alertKind(item).kind === 'status' && at >= 0 ? lines.map((l, j) => j === at ? alertLine(item) : l) : lines;
}

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
    id: i.id, category: alertKind(i).label, kind: alertKind(i).kind, at: i.changed_at || i.at || '',
    text: alertLine(i),
    url: typeof i.url === 'string' && LINEAR_URL.test(i.url) ? i.url : '', local: Boolean(i.local)}))};
}

// Opening an alert row (or '모두 읽음') confirms it: a Linear notification is marked read in Linear
// through the collector's guarded write; a comment read from a linked issue (no Linear notification)
// is marked on this computer only. One request per alert; the collector checks the id against its feed.
const NOTIFICATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMENT = /^comment:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const READ_LIMIT = 20;   // read requests one press may leave; the collector runs 5 a tick
const requestStamp = (now, random) => `${now.toString(36)}-${random().toString(36).slice(2, 10).padEnd(8, '0')}`;
export function readRequest(alert, origin, writes = [], {now = new Date(), random = Math.random} = {}) {
  if (!alert || alert.read || !['opened', 'all'].includes(origin)) return null;
  const base = {v: 1, id: requestStamp(now.getTime(), random), requested_at: now.toISOString(), origin};
  if (alert.local) return COMMENT.test(alert.id || '') ? {...base, action: 'mark_seen', item: alert.id} : null;
  if (!NOTIFICATION.test(alert.id || '') || !(writes ?? []).includes('mark_read')) return null;
  return {...base, action: 'mark_read', notification: alert.id, read: true};
}
// The unread alerts an opened issue row confirms: every unread alert of that issue in the space.
export const issueReadTargets = (items, space, key) => !key ? [] : linearScoped(items, space)
  .filter(i => !i.read && String(i.issue || '').toUpperCase() === String(key).toUpperCase()).slice(0, READ_LIMIT);
// '모두 읽음' in the issue search: the unread alerts of the issues the shared group shows.
export const groupReadTargets = (items, space, query = '') => alertedIssues(items, space, query)
  .flatMap(entry => issueReadTargets(items, space, entry.key)).slice(0, READ_LIMIT);
// Changes only when an issue's unread alerts change: part of the card key.
export const issueAlertSignature = (items, space) => linearScoped(items, space).filter(i => !i.read && i.issue)
  .map(i => JSON.stringify([i.issue, i.id, i.subtitle || '', i.changed_at || i.at || '', i.changes || [], i.state_change || null, i.comments?.[0]?.body || '', i.url || '', i.issue_title || '', i.title || ''])).sort().join(',');

// The issues of a space with unread Linear alerts, for the shared "알림 온 이슈"
// group of the issue search: every tab shows the same group, whether or not the
// tab's list has the issue. Newest first, filtered by the search, bounded.
export const ALERTED_ISSUES = 5;
export function alertedIssues(items, space, query = '', limit = ALERTED_ISSUES) {
  const needle = String(query ?? '').normalize('NFC').trim().toLocaleLowerCase();
  // The title comes from the issue's newest alert, so a renamed issue shows its new title.
  const keys = new Map(), newest = new Map();
  for (const item of linearScoped(items, space)) {
    const key = String(item.issue || '').toUpperCase(), at = String(item.changed_at || item.at || '');
    if (!key || item.read || (newest.has(key) && newest.get(key) >= at)) continue;
    newest.set(key, at); keys.set(key, item.issue_title || item.title || '');
  }
  return [...keys].filter(([key, title]) => !needle || `${key} ${title}`.normalize('NFC').toLocaleLowerCase().includes(needle))
    .map(([key, title]) => { const alerts = issueAlerts(items, space, key); return {key, title, at: alerts.lines[0]?.at || '', alerts}; })
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

// The Slack copy (the MCP mirror the collector reads) has stopped when its newest message is older
// than the collector's limit (6 h): the chip says so instead of a quiet 0.
export function slackCopyDelay(health, now = Date.now()) {
  const at = Date.parse(health?.mirror_latest_at ?? ''), limit = Number(health?.mirror_stale_hours) || 6;
  if (!Number.isFinite(at)) return null;
  const hours = (now - at) / 3_600_000;
  return hours > limit ? {hours: Math.floor(hours), at: health.mirror_latest_at} : null;
}

// GitHub (data/sixfold/github-alerts.json, written by a local `gh` collector; read only): review requests
// to me, my open pull requests and mentions. `unread` is GitHub's own state of the work, not a local mark:
// a review request while it is open, my pull request while it needs me (CI 실패·변경 요청·충돌), a mention
// until it is read on GitHub. The same table is in sixfold-github-inbox/model.js (mods cannot import each
// other); tests/github-alerts.test.mjs keeps the two equal.
// --- shared GitHub alert code
export const githubScoped = (items, space) => (items ?? []).filter(i => !space || projectKey(i.workspace) === projectKey(space));
export const GITHUB_KINDS = Object.freeze({review: '리뷰 요청', pr: '내 PR', mention: '멘션'});
export const githubKind = item => ({kind: GITHUB_KINDS[item?.kind] ? item.kind : 'other', label: GITHUB_KINDS[item?.kind] || '알림'});
const NEEDS = {ci: 'CI 실패', changes: '변경 요청', conflict: '충돌', review: '리뷰 기다림', mention: '나를 멘션'};
const CI_TEXT = {success: 'CI 통과', failure: 'CI 실패', pending: 'CI 진행 중'};
const REVIEW_TEXT = {approved: '승인됨', changes_requested: '변경 요청', review_required: '리뷰 대기'};
const MERGE_TEXT = {mergeable: '병합 가능', conflicting: '충돌'};
export const githubRef = item => `${String(item?.repo ?? '')}${Number.isInteger(item?.number) ? `#${item.number}` : ''}`;
// The second line: what needs me, else the pull request's state; a review request also says who asked.
export function githubLine(item) {
  const needs = (Array.isArray(item?.needs) ? item.needs : []).map(n => NEEDS[n]).filter(Boolean);
  if (item?.kind === 'review') return [`${item.author || '누군가'} 님이 리뷰 요청`, item.draft ? '초안' : ''].filter(Boolean).join(' · ');
  if (item?.kind === 'mention') return [item.reason === 'team_mention' ? '내 팀을 멘션' : '나를 멘션', item.subject === 'issue' ? '이슈' : item.subject === 'pull' ? 'PR' : ''].filter(Boolean).join(' · ');
  if (needs.length) return needs.join(' · ');
  return [CI_TEXT[item?.ci], REVIEW_TEXT[item?.review], MERGE_TEXT[item?.merge], item?.draft ? '초안' : ''].filter(Boolean).join(' · ') || '상태 확인 중';
}
export const githubTone = (item, t) => ({review: t.ansi1, mention: t.ansi5, pr: (item?.needs ?? []).length ? t.blocked : t.ansi2}[item?.kind] || t.muted) || t.accent;
export const githubLink = url => typeof url === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(pull|issues)\/\d{1,9}$/.test(url);
// --- end of the shared GitHub alert code
