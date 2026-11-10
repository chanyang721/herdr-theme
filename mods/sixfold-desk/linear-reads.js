import { appHome, readTextFile, writeTextFile } from 'herdr';
import { readRequest, READ_LIMIT } from './alert-model.js';

// Read marks asked from this sidebar (a row opened, [읽음], [모두 읽음]). Pending ones are drawn
// dimmed; once the collector reports Linear's success they are shown read right away (before the
// next collection); a failure puts the alert back to unread with one error line. Bounded, expiring.
const READ_PENDING_MS = 5 * 60 * 1000, READ_DONE_MS = 10 * 60 * 1000, READ_ERROR_MS = 60 * 1000, READ_LIMIT_KEPT = 100;
const reads = new Map();            // alert id -> {request, at, state: 'pending'|'done'}
let readError = null, confirmedHook = null;
export const onReadConfirmed = hook => { confirmedHook = hook; };
export const readState = id => reads.get(id)?.state || '';
export const readPendingIds = () => new Set([...reads].filter(([, r]) => r.state === 'pending').map(([id]) => id));
export const lastReadError = (now = Date.now()) => readError && now - readError.at < READ_ERROR_MS ? readError.text : '';
const prune = now => {
  for (const [id, r] of reads) {
    if (now - r.at <= (r.state === 'pending' ? READ_PENDING_MS : READ_DONE_MS)) continue;
    reads.delete(id);
    // No answer in time: back to unread with a line saying so, never silently.
    if (r.state === 'pending') readError = {text: '읽음 처리 응답이 없어 되돌렸습니다. 다시 눌러 주세요', at: now};
  }
  while (reads.size > READ_LIMIT_KEPT) reads.delete(reads.keys().next().value);
};
// Confirmed reads are shown read until the feed itself says so (then the entry is dropped).
export function withLocalReads(items) {
  return (items ?? []).map(item => {
    const r = reads.get(item?.id);
    if (r && item.read) { reads.delete(item.id); return item; }
    return r?.state === 'done' ? {...item, read: true} : item;
  });
}
// One request file per alert, like a pressed button; the collector runs each once through its guard.
export async function requestReads(alerts, origin, writes, {now = new Date(), write = writeTextFile, folder = `${appHome()}/data/sixfold/linear-actions`} = {}) {
  prune(now.getTime());
  let left = 0;
  for (const alert of [...new Map((alerts ?? []).filter(a => a && !reads.has(a.id)).map(a => [a.id, a])).values()].slice(0, READ_LIMIT)) {
    const request = readRequest(alert, origin, writes, {now});
    if (!request) continue;
    await write(`${folder}/${request.id}.json`, JSON.stringify(request), null);
    reads.set(alert.id, {request: request.id, at: now.getTime(), state: 'pending'}); left++;
  }
  if (left) readError = null;
  prune(now.getTime());
  return left;
}
// Reads the collector's results for pending marks. Returns true when something changed.
export async function checkReads({read = readTextFile, folder = `${appHome()}/data/sixfold/linear-actions/results`, now = Date.now()} = {}) {
  let changed = false, confirmed = false;
  for (const [id, r] of [...reads].filter(([, r]) => r.state === 'pending')) {
    const text = await read(`${folder}/${r.request}.json`).catch(() => null);
    if (!text) continue;
    let result = null; try { result = JSON.parse(text); } catch { continue; }
    changed = true;
    if (result?.ok === true) { reads.set(id, {...r, state: 'done', at: now}); confirmed = true; }
    else { reads.delete(id); readError = {text: `읽음 처리 실패: ${String(result?.error || '이유 미확인').slice(0, 120)}`, at: now}; }
  }
  prune(now);
  if (confirmed) confirmedHook?.();
  return changed;
}
export const READ_POLL_MS = 2000;
