// Generic local cards and configured command prefixes. No producer-specific policy.
export const KIND_WORDS = {
  ko: { permission: '권한', question: '질문', plan: '계획', title: '확인 대기 카드', failed: '응답 실패' },
  en: { permission: 'Permission', question: 'Question', plan: 'Plan', title: 'Cards waiting', failed: 'Action failed' },
};
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const key = value => typeof value === 'string' && KEY.test(value);
const REQUEST = /^[a-z0-9][a-z0-9-]{0,95}$/;
const text = value => typeof value === 'string' && value.length > 0 && !/[\0\r\n]/.test(value);
const absolute = value => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value);

export function bridgeFrom(source) {
  let data;
  try { data = typeof source === 'string' ? JSON.parse(source || 'null') : source; } catch { return null; }
  if (!text(data?.python) || !text(data?.script) || !absolute(data.script)) return null;
  if (data.args !== undefined && (!Array.isArray(data.args) || data.args.some(a => typeof a !== 'string' || a.includes('\0')))) return null;
  return { python: data.python, script: data.script, args: [...(data.args ?? [])] };
}
export function questionsOf(card) {
  return (Array.isArray(card?.questions) ? card.questions : []).filter(q => q && key(q.id) && text(q.title)).map(q => ({
    id: q.id, title: q.title, multi: q.multi === true,
    options: (Array.isArray(q.options) ? q.options : []).filter(o => o && key(o.id) && text(o.label)).map(o => ({id: o.id, label: o.label})),
  }));
}
export function actionsOf(card) {
  return (Array.isArray(card?.actions) ? card.actions : []).filter(a => a && key(a.id) && text(a.label)).map(a => ({
    id: a.id, label: a.label, requiresAnswers: a.requiresAnswers === true,
    autoSubmit: a.autoSubmit === true, primary: a.primary === true,
  }));
}
export function parseAsks(source) {
  let data;
  try { data = typeof source === 'string' ? JSON.parse(source || 'null') : source; } catch { return null; }
  if (data?.schema !== 1 || !Array.isArray(data.cards)) return null;
  const seen = new Set();
  return { cards: data.cards.filter(card => {
    if (!card || !key(card.id) || !text(card.revision) || card.revision.length > 128
      || !text(card.title) || !['permission', 'question', 'plan'].includes(card.kind) || seen.has(card.id)) return false;
    seen.add(card.id); return true;
  }).map(card => ({id: card.id, revision: card.revision, kind: card.kind, title: card.title,
    detail: typeof card.detail === 'string' ? card.detail : '', terminal: text(card.terminal) ? card.terminal : null,
    questions: questionsOf(card), actions: actionsOf(card)})) };
}
export const askFor = (cards, terminal) => (cards ?? []).find(card => card.terminal && card.terminal === terminal) ?? null;
export const detailOf = card => typeof card?.detail === 'string' ? card.detail : '';
export const selectionOf = (selected, id) => Object.hasOwn(selected ?? {}, id) && Array.isArray(selected[id]) ? selected[id] : [];
export function choose(selected, question, option) {
  if (!question.options.some(o => o.id === option)) return {...(selected ?? {})};
  const now = {...(selected ?? {})};
  if (!question.multi) { now[question.id] = [option]; return now; }
  const set = new Set(selectionOf(now, question.id));
  if (set.has(option)) set.delete(option); else set.add(option);
  now[question.id] = question.options.filter(o => set.has(o.id)).map(o => o.id);
  if (!now[question.id].length) delete now[question.id];
  return now;
}
export function complete(card, selected) {
  const questions = questionsOf(card);
  return questions.length > 0 && questions.every(q => {
    const choices = selectionOf(selected, q.id);
    return Array.isArray(choices) && choices.length > 0 && (q.multi || choices.length === 1)
      && choices.every(id => q.options.some(o => o.id === id));
  });
}
export function actionRequest(card, actionId, selected, requestId, createdAt) {
  if (typeof requestId !== 'string' || !REQUEST.test(requestId) || !key(card?.id) || !text(card?.revision)) throw Error('Invalid local action');
  const action = actionsOf(card).find(a => a.id === actionId);
  if (!action || (action.requiresAnswers && !complete(card, selected))) throw Error('Complete the card before sending');
  const answers = {};
  for (const q of questionsOf(card)) {
    const choices = selectionOf(selected, q.id);
    if (!Array.isArray(choices) || (!q.multi && choices.length > 1)
      || choices.some(id => !q.options.some(o => o.id === id))) throw Error('Invalid option');
    if (choices.length) answers[q.id] = q.options.filter(o => choices.includes(o.id)).map(o => o.id);
  }
  return {schema: 1, id: requestId, cardId: card.id, revision: card.revision, action: actionId, answers, createdAt};
}
export function requestPath(home, id) {
  if (typeof id !== 'string' || !REQUEST.test(id)) throw Error('Invalid request id');
  return `${home.replace(/[\\/]+$/, '')}/data/sixfold/bridge-actions/${id}.json`;
}
export function acceptedReceipt(stdout, id) {
  try {
    const receipt = JSON.parse(String(stdout ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1) || 'null');
    return receipt?.schema === 1 && receipt.id === id && ['accepted', 'duplicate'].includes(receipt.status);
  } catch { return false; }
}
export function touchesCards(paths, directory) {
  const normalized = path => String(path).replace(/\\/g, '/').replace(/\/+$/, '');
  return (paths ?? []).some(path => normalized(path) === normalized(directory)
    || ['cards.json', 'bridge.json'].includes(normalized(path).split('/').at(-1)));
}

// Pane-scoped presentation. The sidebar watcher publishes only a summary
// (terminal -> count/kind and a version); pane headers and the popup read it,
// and the popup re-reads the neutral cards file itself when the version moves.
export const SUMMARY_KEY = 'sixfold.asks.summary';
export const ASK_WORDS = {
  ko: {open: '열기', close: '닫기', closeHint: '닫아도 거절·답변되지 않습니다. 머리줄 버튼이나 왼쪽 목록에서 다시 열 수 있습니다.',
    none: '이 페인에 남은 확인 요청이 없습니다.', loading: '불러오는 중…', loadFailed: '카드를 읽지 못했습니다.', retry: '다시 읽기', sending: '전송 중…', sent: '응답을 접수했습니다.',
    expired: '처리되었거나 만료된 요청', revised: '요청 내용이 바뀌어 선택을 초기화했습니다.', unassigned: '소속 미확인',
    errors: {failed: '전송 실패 — 다시 시도하세요', changed: '연결 설정이 바뀌었습니다 — 다시 열어 주세요', stale: '요청이 바뀌었거나 만료되었습니다 — 최신 내용을 확인하세요', incomplete: '모든 질문에 답한 뒤 보내세요'},
    count: n => `${n}건`, more: n => `+${n}개 페인 더 보기`, fold: '접기'},
  en: {open: 'Open', close: 'Close', closeHint: 'Closing does not deny or answer. Reopen it from the pane header or the sidebar.',
    none: 'No requests left for this pane.', loading: 'Loading…', loadFailed: 'Could not read the cards.', retry: 'Retry', sending: 'Sending…', sent: 'Response accepted.',
    expired: 'Handled or expired', revised: 'The request changed; choices were reset.', unassigned: 'Unassigned',
    errors: {failed: 'Send failed — try again', changed: 'Connection changed — reopen the card', stale: 'The request changed or expired — check the latest', incomplete: 'Answer every question before sending'},
    count: n => `${n}`, more: n => `+${n} more panes`, fold: 'Show less'},
};
export const errorText = (lang, code) => {
  const words = (ASK_WORDS[lang] ?? ASK_WORDS.en).errors;
  return words[code] ?? words.failed;
};
const termKey = card => card?.terminal ?? '';
export function groupAsks(cards) {
  const groups = new Map();
  for (const card of cards ?? []) {
    const key = termKey(card);
    if (!groups.has(key)) groups.set(key, {terminal: card.terminal ?? null, cards: []});
    groups.get(key).cards.push(card);
  }
  return [...groups.values()];
}
export const cardsFor = (cards, terminal) => (cards ?? []).filter(card => termKey(card) === (terminal ?? ''));
function digest(value) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
// null cards (no bridge) publish an empty summary: the feature stays hidden.
export function askSummary(cards) {
  const panes = {};
  for (const group of groupAsks(cards)) panes[group.terminal ?? ''] = {n: group.cards.length, kind: group.cards[0].kind};
  const live = (cards ?? []).map(card => `${card.id}:${card.revision}`).join('|');
  return {v: live ? digest(live) : '', panes};
}
export function summaryFor(summary, terminal) {
  const pane = summary && typeof summary === 'object' && summary.panes && typeof summary.panes === 'object'
    && Object.hasOwn(summary.panes, terminal ?? '') ? summary.panes[terminal ?? ''] : null;
  return pane && Number.isInteger(pane.n) && pane.n > 0 && ['permission', 'question', 'plan'].includes(pane.kind) ? pane : null;
}
export const clampPage = (page, length) => length > 0 ? Math.min(Math.max(0, Number.isInteger(page) ? page : 0), length - 1) : 0;
// Reconciles the popup's displayed cards with a fresh read: choices for a
// card whose revision moved are dropped, and cards that vanished without our
// own accepted send are reported as handled elsewhere or expired.
export function reconcile(previous, next, choices, sent) {
  const before = new Map((previous ?? []).map(card => [card.id, card.revision]));
  const after = new Map((next ?? []).map(card => [card.id, card.revision]));
  const kept = Object.create(null);
  let revised = false;
  for (const [id, value] of Object.entries(choices ?? {})) {
    if (!after.has(id)) continue;
    if (before.has(id) && before.get(id) !== after.get(id)) { revised = true; continue; }
    kept[id] = value;
  }
  const expired = [...before.keys()].filter(id => !after.has(id) && !(sent ?? new Set()).has(id)).length;
  return {choices: kept, revised, expired};
}
// Popup height in px for one card: enough for its text and options, bounded
// so the popup never covers the whole window (the body scrolls beyond it).
export function popupHeight(card) {
  if (!card) return 420; // opened from a pane header: content unknown, the body scrolls
  const lines = text => Math.max(1, Math.ceil(String(text ?? '').length / 70)) + (String(text ?? '').match(/\n/g)?.length ?? 0);
  let h = 150 + lines(card.title) * 18 + (card.detail ? Math.min(lines(card.detail), 14) * 16 + 18 : 0);
  for (const q of questionsOf(card)) h += 26 + lines(q.title) * 16 + q.options.reduce((sum, o) => sum + 10 + lines(o.label) * 17, 0);
  return Math.max(220, Math.min(640, Math.round(h)));
}
