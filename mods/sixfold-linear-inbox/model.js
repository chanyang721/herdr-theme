// Pure helpers for the Linear inbox window (tested in tests/linear-inbox.test.mjs).
const CATEGORY = {assignments:'배정', mentions:'멘션', comments:'댓글', commentsAndReplies:'댓글', reviews:'리뷰', documentChanges:'문서', statusChanges:'상태 변경', reminders:'알림', reactions:'반응', subscriptions:'구독', triage:'분류'};
export const categoryLabel = item => alertKind(item).label || CATEGORY[item?.category] || '알림';

// What kind of alert, at a glance: Linear's notification type -> badge. The same table is in
// sixfold-desk/alert-model.js (mods cannot import each other). An unknown type keeps its own
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

export const spaceKey = name => String(name ?? '').toLowerCase().replace(/[\s_-]/g, '');
export const linearLink = url => typeof url === 'string' && /^https:\/\/linear\.app\/[A-Za-z0-9_-]+\/(issue|project)\//.test(url);

// Same rule as sixfold-desk/alert-model.js placeItems (mods cannot import each other):
// an alert whose space is not shown belongs to Share.
export const UNSORTED = '미분류';
export function placeItems(items, names, fallback = 'Share') {
  const shown = new Map((names ?? []).map(name => [spaceKey(name), name]));
  if (!shown.size) return items ?? [];
  const home = shown.get(spaceKey(fallback)) ?? fallback;
  return (items ?? []).map(item => {
    // Not placed yet (its issue is read on the next run): it stays 미분류, never Share.
    if (item?.workspace === UNSORTED) return item;
    const space = shown.get(spaceKey(item?.workspace)) ?? home;
    return space === item?.workspace ? item : {...item, workspace: space, workspace_raw: item?.workspace ?? ''};
  });
}
export function visibleItems(items, {space = null, unreadOnly = false} = {}) {
  return (items ?? []).filter(i => (!space || spaceKey(i.workspace) === spaceKey(space)) && (!unreadOnly || !i.read));
}
export function spacesOf(items) {
  return [...new Set((items ?? []).map(i => i.workspace).filter(Boolean))].sort();
}
// The "수집:" line of the inbox. Shows where the data comes from (source 'linear-api' = direct GraphQL)
// and, on failure, only a fixed label for the error kind — never the raw error text or any key.
const HEALTH_STATE = {collecting: '조회 중', partial: '일부 확인', ok: '확인됨', error: '조회 실패'};
export const COLLECT_ERROR = Object.freeze({
  key_missing: 'API 키 없음', unauthorized: 'API 키 확인 필요', rate_limited: 'API 호출 한도 · 잠시 뒤 재시도', network: '네트워크 오류',
});
export function collectLine(health) {
  const h = health && typeof health === 'object' ? health : {};
  const state = HEALTH_STATE[h.state] || '상태 확인 전';
  const kind = h.state === 'error' ? COLLECT_ERROR[h.error_kind] : '';
  // No API key yet: the collector keeps reading through MCP and says so.
  const source = h.source === 'linear-api' ? 'Linear API 직접 · ' : h.fallback === 'key_missing' ? 'API 키 없음 · MCP로 수집 · ' : '';
  return `수집: ${source}${state}${kind ? ` · ${kind}` : ''} · 마지막 성공 ${h.last_success || '아직 없음'} · 60초마다 조회 · 읽음은 Linear 기준`;
}
export function issueLine(item) {
  return [item.status, item.assignee && `담당 ${item.assignee}`, item.priority && `우선순위 ${item.priority}`, item.due && `기한 ${item.due}`]
    .filter(Boolean).join(' · ');
}
// Before→after of issue fields that changed between collector runs.
// (Same table as sixfold-desk/alert-model.js: mods cannot import each other.)
const CHANGE_LABEL = {issue_title: '제목', status: '상태', assignee: '담당', priority: '우선순위', due: '기한', project: '프로젝트'};
export const changeLines = item => (Array.isArray(item?.changes) ? item.changes : [])
  .filter(c => c && CHANGE_LABEL[c.field])
  .map(c => `${CHANGE_LABEL[c.field]} ${c.from || '없음'} → ${c.to || '없음'}`);
export function requestId(now = Date.now(), random = Math.random) {
  return `${now.toString(36)}-${random().toString(36).slice(2, 10).padEnd(8, '0')}`;
}

// One request = one Linear write, run by the local collector only because a person pressed it.
export function buildRequest(action, item, extra = {}, {now = new Date(), id = requestId(now.getTime())} = {}) {
  // Who asked: a pressed button (default), an opened row ('opened') or '모두 읽음' ('all'); the collector
  // retries a failed automatic read mark, a failed press is shown to the person instead.
  const origin = ['opened', 'all'].includes(extra.origin) ? {origin: extra.origin} : {};
  const base = {v: 1, id, action, requested_at: now.toISOString(), ...(action === 'mark_read' || action === 'mark_seen' ? origin : {})};
  if (action === 'mark_read') return {...base, notification: item.id, read: true};
  if (action === 'mark_seen') {
    if (!item?.local || !/^comment:[0-9a-f-]{36}$/.test(item.id || '')) throw new Error('이 컴퓨터에서 확인할 수 있는 댓글이 아닙니다');
    return {...base, item: item.id};
  }
  if (!/^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/.test(item?.issue || '')) throw new Error('이 알림에는 이슈가 없습니다');
  if (action === 'set_state') {
    const state = String(extra.state ?? '');
    if (!state || state.length > 60 || state.includes('\n')) throw new Error('상태 이름이 올바르지 않습니다');
    return {...base, issue: item.issue, state};
  }
  if (action === 'comment') {
    const body = String(extra.body ?? '');
    if (!body.trim() || body.length > 4000) throw new Error('댓글 내용을 입력하세요 (4000자 이하)');
    return {...base, issue: item.issue, body};
  }
  throw new Error('지원하지 않는 작업');
}
export const resultLabel = result => !result ? '처리 대기 중…' : result.ok ? '반영했습니다' : `실패: ${result.error || '이유 미확인'}`;

// '모두 읽음' in the window: the unread alerts shown, at most READ_ALL (the collector runs 5 a tick).
export const READ_ALL = 20;
export const readAllTargets = (items, space, writes = []) => visibleItems(items, {space, unreadOnly: true})
  .filter(i => i.local || (writes ?? []).includes('mark_read')).slice(0, READ_ALL);
