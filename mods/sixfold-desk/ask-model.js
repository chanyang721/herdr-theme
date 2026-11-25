// Generic local cards and configured command prefixes. No producer-specific policy.
export const KIND_WORDS = {
  ko: { permission: '권한', question: '질문', plan: '계획', title: '확인 대기 카드', failed: '응답 실패' },
  en: { permission: 'Permission', question: 'Question', plan: 'Plan', title: 'Cards waiting', failed: 'Action failed' },
};
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const key = value => typeof value === 'string' && KEY.test(value);
const REQUEST = /^[a-z0-9][a-z0-9-]{0,95}$/;
const text = value => typeof value === 'string' && value.length > 0 && !/[\0\r\n]/.test(value);
// Question and option text may span lines (a question often carries its reasons
// on separate lines); only a NUL makes it unusable.
const prose = value => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
const absolute = value => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value);

export function bridgeFrom(source) {
  let data;
  try { data = typeof source === 'string' ? JSON.parse(source || 'null') : source; } catch { return null; }
  if (!text(data?.python) || !text(data?.script) || !absolute(data.script)) return null;
  if (data.args !== undefined && (!Array.isArray(data.args) || data.args.some(a => typeof a !== 'string' || a.includes('\0')))) return null;
  return { python: data.python, script: data.script, args: [...(data.args ?? [])] };
}
export function questionsOf(card) {
  return (Array.isArray(card?.questions) ? card.questions : []).filter(q => q && key(q.id) && prose(q.title)).map(q => ({
    id: q.id, title: q.title, multi: q.multi === true,
    options: (Array.isArray(q.options) ? q.options : []).filter(o => o && key(o.id) && prose(o.label)).map(o => ({id: o.id, label: o.label})),
  }));
}
export function actionsOf(card) {
  return (Array.isArray(card?.actions) ? card.actions : []).filter(a => a && key(a.id) && text(a.label)).map(a => ({
    id: a.id, label: a.label, requiresAnswers: a.requiresAnswers === true,
    autoSubmit: a.autoSubmit === true, primary: a.primary === true,
  }));
}
// `answerable: false` is display only: the request waits in its own pane (the card can no
// longer answer it) and stays until that pane's prompt ends. A missing field (an older
// producer) reads as true. Cards are kept oldest first; ties keep the producer's order.
const stamp = value => text(value) && value.length <= 40 ? value : null;
export const byAge = (a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
export function parseAsks(source) {
  let data;
  try { data = typeof source === 'string' ? JSON.parse(source || 'null') : source; } catch { return null; }
  if (data?.schema !== 1 || !Array.isArray(data.cards)) return null;
  const seen = new Set();
  return { cards: data.cards.filter(card => {
    if (!card || !key(card.id) || !text(card.revision) || card.revision.length > 128
      || !text(card.title) || !['permission', 'question', 'plan'].includes(card.kind) || seen.has(card.id)) return false;
    seen.add(card.id); return true;
  }).map(card => {
    const answerable = card.answerable !== false;
    return {id: card.id, revision: card.revision, kind: card.kind, title: card.title,
      detail: typeof card.detail === 'string' ? card.detail : '', terminal: text(card.terminal) ? card.terminal : null,
      answerable, createdAt: stamp(card.createdAt),
      questions: questionsOf(card), actions: answerable ? actionsOf(card) : []};
  }).sort(byAge) };
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
  ko: {open: '열기', close: '닫기', inPane: '대기 시간이 지나 이 카드로는 답할 수 없습니다. 그 페인의 Claude 창에서 직접 답하세요. 답하면 이 카드는 사라지고 다음 요청이 열립니다.', goPane: '페인으로 이동', paneOnly: '페인에서 답하기', queue: (i, n) => `${i}/${n} · 오래된 순`, closeHint: '닫아도 거절·답변되지 않습니다. 머리줄 버튼이나 왼쪽 목록에서 다시 열 수 있습니다.',
    none: '이 페인에 남은 확인 요청이 없습니다.', loading: '불러오는 중…', loadFailed: '카드를 읽지 못했습니다.', refreshFailed: '최신 내용을 읽지 못했습니다 — 아래는 마지막으로 읽은 내용입니다.', retry: '다시 읽기', sending: '전송 중…', sent: '응답을 접수했습니다.',
    expired: '처리되었거나 만료된 요청', unconfirmed: '응답 접수를 확인하지 못함 — 에이전트 페인에서 결과를 확인하세요', revised: '요청 내용이 바뀌어 선택을 초기화했습니다.', unassigned: '소속 미확인',
    errors: {failed: '전송 실패 — 다시 시도하세요', changed: '연결 설정이 바뀌었습니다 — 다시 열어 주세요', stale: '요청이 바뀌었거나 만료되었습니다 — 최신 내용을 확인하세요', incomplete: '모든 질문에 답한 뒤 보내세요'},
    count: n => `${n}건`, more: n => `${n}개 페인 · 목록을 스크롤해 모두 보기`},
  en: {open: 'Open', close: 'Close', inPane: 'This card waited too long and can no longer answer. Answer it in that pane\'s own Claude prompt; the card then goes and the next request opens.', goPane: 'Go to pane', paneOnly: 'Answer in pane', queue: (i, n) => `${i}/${n} · oldest first`, closeHint: 'Closing does not deny or answer. Reopen it from the pane header or the sidebar.',
    none: 'No requests left for this pane.', loading: 'Loading…', loadFailed: 'Could not read the cards.', refreshFailed: 'Could not read the latest — showing the last read.', retry: 'Retry', sending: 'Sending…', sent: 'Response accepted.',
    expired: 'Handled or expired', unconfirmed: 'Response not confirmed — check the agent pane', revised: 'The request changed; choices were reset.', unassigned: 'Unassigned',
    errors: {failed: 'Send failed — try again', changed: 'Connection changed — reopen the card', stale: 'The request changed or expired — check the latest', incomplete: 'Answer every question before sending'},
    count: n => `${n}`, more: n => `${n} panes · scroll the list for all`},
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
// One queue over several panes (a space tab): every card of those panes, oldest first.
export function queueFor(cards, terminals) {
  const wanted = new Set((Array.isArray(terminals) ? terminals : []).map(t => (typeof t === 'string' ? t : '')));
  return (cards ?? []).filter(card => wanted.has(termKey(card))).sort(byAge);
}
// The card to show after a re-read: the one on screen while it is still there, else the oldest.
export function pageAfter(previous, page, next) {
  const id = (previous ?? [])[page]?.id, at = id === undefined ? -1 : (next ?? []).findIndex(card => card.id === id);
  return at >= 0 ? at : 0;
}

// Display requests use opaque feed IDs, not native navigation targets. Only an
// explicit owner attaches a request to a space; names and focus are not hints.
export function spaceAsks(requests, space) {
  if (!key(space) || !Array.isArray(requests)) return [];
  const counts = new Map();
  for (const item of requests) if (key(item?.id)) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  return requests.filter(item => item && key(item.id) && counts.get(item.id) === 1
    && Object.hasOwn(item, 'space') && item.space === space).map(item => ({
    id: item.id, space, agent: key(item.agent) ? item.agent : null,
    kind: ['permission', 'question', 'plan'].includes(item.kind) ? item.kind : null,
    title: text(item.title) ? item.title.slice(0, 500) : '',
    answerable: item.answerable !== false, createdAt: stamp(item.created_at),
  })).sort(byAge);
}
export const SPACE_ASK_WIDTH = 45;
export const SPACE_ASK_GAP = 1;
// Bounds and the returned position share the parent's coordinate system. The
// caller reserves the right gutter and updates bounds on layout/scroll changes.
export function spaceAskLayout(bounds) {
  if (!bounds || !['x', 'y', 'w', 'h'].every(k => Number.isFinite(bounds[k])) || bounds.w <= 0 || bounds.h <= 0) return null;
  const left = bounds.x + bounds.w + SPACE_ASK_GAP;
  return Number.isFinite(left) ? {left, top: bounds.y, width: SPACE_ASK_WIDTH, height: bounds.h} : null;
}
function digest(value) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
// Where a summary came from: the cards file read as valid ('ready', possibly
// empty), confirmed absent ('missing': no bridge or no cards file, so nothing
// waits), or not readable ('unreadable': a failed, oversized or half-written
// read). Only a 'ready' summary carries counts. An unreadable one names the
// panes that had requests on the last good read, so their headers can say the
// state is unconfirmed instead of keeping an old count.
const SUMMARY_STATES = ['ready', 'missing', 'unreadable'];
export function askSummary(cards, status = 'ready', previous = null) {
  if (!SUMMARY_STATES.includes(status)) status = 'unreadable';
  if (status === 'missing') return {status, v: '', panes: {}};
  if (status === 'unreadable') {
    const known = summaryState(previous) === 'ready' ? Object.keys(previous.panes ?? {})
      : summaryState(previous) === 'unreadable' && Array.isArray(previous.unverified) ? previous.unverified : [];
    const unverified = [...new Set(known.filter(t => typeof t === 'string'))].sort();
    return {status, v: `!${digest(JSON.stringify(unverified))}`, panes: {}, unverified};
  }
  const panes = {};
  for (const group of groupAsks(cards)) panes[group.terminal ?? ''] = {n: group.cards.length, kind: group.cards[0].kind};
  // The owning terminal is part of the version: a card moved to another pane
  // must leave the old pane's popup.
  // So is answerable: a card that now waits in its pane must lose its buttons in the popup.
  const live = (cards ?? []).map(card => JSON.stringify([card.id, card.revision, card.terminal ?? null, card.answerable !== false])).join('|');
  return {status, v: live ? digest(live) : '', panes};
}
// A summary without a known status (an older theme's, or garbage) is not a
// reading of the cards file and is never drawn.
export const summaryState = summary => summary && typeof summary === 'object' && SUMMARY_STATES.includes(summary.status) ? summary.status : null;
export function summaryFor(summary, terminal) {
  if (summaryState(summary) !== 'ready') return null;
  const pane = summary.panes && typeof summary.panes === 'object'
    && Object.hasOwn(summary.panes, terminal ?? '') ? summary.panes[terminal ?? ''] : null;
  return pane && Number.isInteger(pane.n) && pane.n > 0 && ['permission', 'question', 'plan'].includes(pane.kind) ? pane : null;
}
// True when the cards file could not be read and this pane had requests on
// the last good read: its header says "unconfirmed", never the old count.
export const unverifiedFor = (summary, terminal) => summaryState(summary) === 'unreadable'
  && Array.isArray(summary.unverified) && summary.unverified.includes(terminal ?? '');
// The summary of the bridge and cards files as read right now (typed
// snapshots {status: 'ready'|'missing'|'invalid', value}). A missing bridge or
// cards file means nothing waits; any other failed read is 'unreadable'.
export function summaryFromSnapshots(bridgeSnap, cardsSnap, previous = null) {
  const value = snap => snap?.status === 'ready' && Object.hasOwn(snap, 'value') ? snap.value : undefined;
  if (bridgeSnap?.status === 'missing') return askSummary(null, 'missing');
  const bridge = value(bridgeSnap) === undefined ? null : bridgeFrom(value(bridgeSnap));
  if (!bridge) return askSummary(null, 'unreadable', previous);
  if (cardsSnap?.status === 'missing') return askSummary(null, 'missing');
  const parsed = value(cardsSnap) === undefined ? null : parseAsks(value(cardsSnap));
  return parsed ? askSummary(parsed.cards) : askSummary(null, 'unreadable', previous);
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

// A card from a pane outside the focused space is easy to miss in the sidebar
// list, so its pane's popup opens by itself once. `opened` holds the
// `id:revision` keys already shown this way; closing a popup never reopens
// it, and a revised card counts as new. One pane per call: the rest stay in
// the list and open on later calls. Cards whose space is unknown count as
// elsewhere, cards in the focused space never pop up.
export const askKey = card => `${card.id}:${card.revision}`;
export function autoPopupTarget(cards, opened, spaceOf, focusedSpace) {
  const shown = new Set(opened ?? []);
  for (const group of groupAsks(cards)) {
    if (!group.terminal) continue;
    const space = spaceOf(group.terminal) ?? null;
    if (space !== null && space === (focusedSpace ?? null)) continue;
    const fresh = group.cards.filter(card => !shown.has(askKey(card)));
    if (fresh.length) return {terminal: group.terminal, cards: group.cards, keys: group.cards.map(askKey)};
  }
  return null;
}
// Keep only keys of cards still alive, so the record never grows without bound.
export const prunedOpened = (opened, cards) => {
  const live = new Set((cards ?? []).map(askKey));
  return [...new Set(opened ?? [])].filter(key => live.has(key));
};
