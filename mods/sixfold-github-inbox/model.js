// Pure helpers for the GitHub inbox window (tested in tests/github-alerts.test.mjs).
// The block between the "shared GitHub alert code" marks is the same as in sixfold-desk/alert-model.js
// (mods cannot import each other); the test fails when the two copies differ.
export const projectKey = name => String(name ?? '').toLowerCase().replace(/[\s_-]/g, '');
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

// The spaces the window offers, in the collector's order, and how much work each has.
export const spacesOf = (spaces, items) => [...new Set([...(spaces ?? []), ...(items ?? []).map(i => i.workspace).filter(Boolean)])];
export const workCount = (items, space) => githubScoped(items, space).filter(i => i.unread).length;
// Sections of the window: review requests, mentions, my pull requests (work first in each, newest first).
export const SECTIONS = Object.freeze([['review', '나에게 온 리뷰 요청'], ['mention', '나를 멘션한 알림'], ['pr', '내 PR']]);
export function sections(items, {space = null, workOnly = false} = {}) {
  const scoped = githubScoped(items, space).filter(i => !workOnly || i.unread);
  const order = (a, b) => (Number(Boolean(b.unread)) - Number(Boolean(a.unread))) || String(b.at ?? '').localeCompare(String(a.at ?? ''));
  return SECTIONS.map(([kind, title]) => ({kind, title, items: scoped.filter(i => i.kind === kind).sort(order)}));
}
const KIND_TEXT = {auth: 'gh 로그인 필요', missing: 'gh 없음', rate: '요청 한도', network: '연결 실패', other: '조회 실패'};
// One line about the collector: when it last read GitHub, and what failed (by kind only; gh text is never kept).
export function collectLine(health = {}) {
  const at = typeof health.last_success === 'string' ? health.last_success.slice(5, 16).replace('T', ' ') : '';
  const failed = Object.entries(health.errors && typeof health.errors === 'object' ? health.errors : {})
    .map(([part, kind]) => `${part === 'pulls' ? 'PR' : part === 'mentions' ? '멘션' : part} ${KIND_TEXT[kind] || '조회 실패'}`);
  if (health.state === 'error') return `GitHub 조회 실패 (${KIND_TEXT[health.error_kind] || '조회 실패'}) · 이전 목록 표시${at ? ` · 마지막 성공 ${at}` : ''}`;
  if (!at) return 'GitHub 수집 기록 없음 · 아직 받은 GitHub 데이터가 없습니다';
  return [`마지막 수집 ${at}`, ...failed].join(' · ');
}
