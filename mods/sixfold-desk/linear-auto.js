import { appHome, readTextFile, writeTextFile } from 'herdr';
import { approvalRequest, localRequest, requestId } from './linear-auto-model.js';

// The IO of the '자동 작업' group: read the collector's ledger, drop one request file per press,
// and follow the collector's results. A pressed part is claimed before anything is awaited, so a
// second press (or a second click while the draft is read) sends nothing. Its id names one part of
// one proposal (auto-<alert8>-<c|s>-<proposal>): the collector also runs it at most once. A success
// stays done here until the ledger itself shows it applied; a failure frees the part with one error line.
const data = () => `${appHome()}/data/sixfold`;
const BUSY_MS = 3 * 60 * 1000, ERROR_MS = 60 * 1000, DONE_LIMIT = 100;
const busy = new Map();   // `${alert8}:${part}` -> {request, at}
const done = new Map();   // request id -> at: succeeded, not yet in the ledger
let lastError = null;
export const busyKeys = (now = Date.now()) => {
  for (const [key, b] of busy) if (now - b.at > BUSY_MS) busy.delete(key);
  return new Set(busy.keys());
};
export const doneIds = () => new Set(done.keys());
export const autoError = (now = Date.now()) => lastError && now - lastError.at < ERROR_MS ? lastError.text : '';
const fail = (text, now) => { lastError = {text, at: now}; };

export async function readLedger({read = readTextFile, path = `${data()}/linear-auto.json`} = {}) {
  const text = await read(path).catch(() => null);
  if (!text) return null;
  try { const value = JSON.parse(text); return value && typeof value === 'object' ? value : null; } catch { return null; }
}

// [댓글 올리기] / [상태 바꾸기] / [모두 반영]: one linear-actions request per part.
export async function approve(r, parts, writes, {read = readTextFile, write = writeTextFile, now = new Date(),
                                                 folder = `${data()}/linear-actions`} = {}) {
  const at = now.getTime(), mine = [];
  // Claim first, synchronously: nothing below may run twice for one part.
  for (const part of parts) {
    const key = `${r?.key}:${part}`, id = requestId(r, part);
    if (!id || busyKeys(at).has(key) || done.has(id)) continue;
    busy.set(key, {request: id, at});
    mine.push({part, key, id});
  }
  const sent = [];
  for (const {part, key, id} of mine) {
    let body = null;
    if (part === 'comment' && r.proposal?.draft) {
      // An edited draft is what the person approved: when it cannot be read, nothing is sent.
      const text = await read(r.proposal.draft).catch(() => null);
      if (!text || !text.trim()) { busy.delete(key); fail('댓글 초안을 읽지 못해 보내지 않았습니다 · [수정]으로 초안을 확인하세요', at); continue; }
      body = text.trim();
    }
    const request = approvalRequest(r, part, writes, {now, body});
    if (!request) { busy.delete(key); fail(`${part === 'comment' ? '댓글' : '상태 변경'}을 보낼 수 없습니다(쓰기 꺼짐 또는 내용 없음)`, at); continue; }
    try { await write(`${folder}/${request.id}.json`, JSON.stringify(request), null); }
    catch { busy.delete(key); fail('요청을 남기지 못했습니다', at); continue; }
    sent.push(request.id);
  }
  if (sent.length && sent.length === mine.length) lastError = null;
  return sent;
}

// [버리기] / [작업 시작]: the collector's own ledger only; nothing goes to Linear.
export async function local(r, action, {write = writeTextFile, now = new Date(), folder = `${data()}/linear-auto-actions`} = {}) {
  const key = `${r?.key}:${action}`;
  if (busyKeys(now.getTime()).has(key)) return null;
  const request = localRequest(r, action, {now});
  if (!request) return null;
  busy.set(key, {request: request.id, at: now.getTime()});
  try { await write(`${folder}/${request.id}.json`, JSON.stringify(request), null); }
  catch { busy.delete(key); fail('요청을 남기지 못했습니다', now.getTime()); return null; }
  return request.id;
}

// Follows pressed parts: true when something changed (redraw).
export async function checkApprovals({read = readTextFile, folder = `${data()}/linear-actions/results`, now = Date.now()} = {}) {
  let changed = false;
  for (const [key, b] of [...busy]) {
    if (key.endsWith(':start') || key.endsWith(':discard')) continue;   // these show up in the ledger itself
    const text = await read(`${folder}/${b.request}.json`).catch(() => null);
    if (!text) continue;
    let result = null; try { result = JSON.parse(text); } catch { continue; }
    if (result?.id !== b.request) continue;
    busy.delete(key); changed = true;
    if (result.ok === true) { done.set(b.request, now); while (done.size > DONE_LIMIT) done.delete(done.keys().next().value); }
    else fail(`반영 실패: ${String(result?.error || '이유 미확인').slice(0, 120)}`, now);
  }
  return changed;
}
// The ledger caught up: what it shows applied (or no longer waiting) needs no local mark.
export function settleLedger(view) {
  const rows = [...(view?.pending ?? []), ...(view?.decide ?? [])];
  const waiting = new Set((view?.decide ?? []).filter(r => r.state === 'decide').map(r => `${r.key}:start`));
  const proposed = new Set((view?.pending ?? []).map(r => `${r.key}:discard`));
  for (const key of [...busy.keys()]) {
    if ((key.endsWith(':start') && !waiting.has(key)) || (key.endsWith(':discard') && !proposed.has(key))) busy.delete(key);
  }
  for (const id of [...done.keys()]) {
    const r = rows.find(row => id.startsWith(`auto-${row.key}-`));
    const part = id.split('-')[2] === 'c' ? 'comment' : 'state';
    if (!r || r.applied?.[part]?.ok === true) done.delete(id);
  }
}
export const AUTO_POLL_MS = 2000;
