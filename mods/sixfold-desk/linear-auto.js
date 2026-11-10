import { appHome, readTextFile, writeTextFile } from 'herdr';
import { approvalRequest, localRequest } from './linear-auto-model.js';

// The IO of the '자동 작업' group: read the collector's ledger, drop one request file per press,
// and follow the collector's results. A pressed part stays busy (drawn '처리 중') until its result
// arrives or it expires; a failure shows one error line. The ledger carries what was applied.
const data = () => `${appHome()}/data/sixfold`;
const BUSY_MS = 3 * 60 * 1000, ERROR_MS = 60 * 1000;
const busy = new Map();   // `${alert8}:${part}` -> {request, at}
let lastError = null;
export const busyKeys = (now = Date.now()) => {
  for (const [key, b] of busy) if (now - b.at > BUSY_MS) busy.delete(key);
  return new Set(busy.keys());
};
export const autoError = (now = Date.now()) => lastError && now - lastError.at < ERROR_MS ? lastError.text : '';

export async function readLedger({read = readTextFile, path = `${data()}/linear-auto.json`} = {}) {
  const text = await read(path).catch(() => null);
  if (!text) return null;
  try { const value = JSON.parse(text); return value && typeof value === 'object' ? value : null; } catch { return null; }
}

// The comment as it stands now: the person's edited draft when there is one, else the proposal.
async function commentBody(r, read) {
  const draft = r?.proposal?.draft ? await read(r.proposal.draft).catch(() => null) : null;
  return draft && draft.trim() ? draft.trim() : r?.proposal?.comment || '';
}

// [댓글 올리기] / [상태 바꾸기] / [모두 반영]: one linear-actions request per part.
export async function approve(r, parts, writes, {read = readTextFile, write = writeTextFile, now = new Date(),
                                                 folder = `${data()}/linear-actions`} = {}) {
  const sent = [];
  for (const part of parts) {
    const key = `${r.key}:${part}`;
    if (busyKeys(now.getTime()).has(key)) continue;
    const body = part === 'comment' ? await commentBody(r, read) : null;
    const request = approvalRequest(r, part, writes, {now, body, serial: `${now.getTime().toString(36)}${sent.length}`});
    if (!request) { lastError = {text: `${part === 'comment' ? '댓글' : '상태 변경'}을 보낼 수 없습니다(쓰기 꺼짐 또는 내용 없음)`, at: now.getTime()}; continue; }
    await write(`${folder}/${request.id}.json`, JSON.stringify(request), null);
    busy.set(key, {request: request.id, at: now.getTime()});
    sent.push(request.id);
  }
  if (sent.length) lastError = null;
  return sent;
}

// [버리기] / [작업 시작]: the collector's own ledger only; nothing goes to Linear.
export async function local(r, action, {write = writeTextFile, now = new Date(), folder = `${data()}/linear-auto-actions`} = {}) {
  const request = localRequest(r, action, {now});
  if (!request) return null;
  await write(`${folder}/${request.id}.json`, JSON.stringify(request), null);
  if (action === 'start') busy.set(`${r.key}:start`, {request: request.id, at: now.getTime()});
  return request.id;
}

// Follows pressed parts: true when something changed (redraw).
export async function checkApprovals({read = readTextFile, folder = `${data()}/linear-actions/results`, now = Date.now()} = {}) {
  let changed = false;
  for (const [key, b] of [...busy]) {
    if (key.endsWith(':start')) continue;   // a start shows up in the ledger itself
    const text = await read(`${folder}/${b.request}.json`).catch(() => null);
    if (!text) continue;
    let result = null; try { result = JSON.parse(text); } catch { continue; }
    busy.delete(key); changed = true;
    if (result?.ok !== true) lastError = {text: `반영 실패: ${String(result?.error || '이유 미확인').slice(0, 120)}`, at: now};
  }
  return changed;
}
// A start is done when the ledger no longer shows the alert waiting for a person.
export function settleStarts(view) {
  const waiting = new Set((view?.decide ?? []).map(r => `${r.key}:start`));
  for (const key of [...busy.keys()]) if (key.endsWith(':start') && !waiting.has(key)) busy.delete(key);
}
export const AUTO_POLL_MS = 2000;
