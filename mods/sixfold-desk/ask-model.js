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
