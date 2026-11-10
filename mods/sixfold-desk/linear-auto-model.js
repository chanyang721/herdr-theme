// Linear auto work, as the collector's ledger (linear-auto.json, written by the collector's linear_auto.py)
// shows it: per space, the finished work waiting for a person's approval ('반영 대기'), the alerts a
// person decides ('결정 필요'), and the work running now ('자동 작업'). Pure: no IO, no clock.
//
// Approval buttons never write Linear here. They build the same linear-actions request a pressed
// button always drops (comment / set_state); the collector runs it once through linear_guard.py
// (one call, exact arguments). The request id auto-<alert8>-<c|s>-<n> lets the collector put the
// result back on the ledger entry.

export const AUTO_LIMIT = 8;
const PENDING = ['proposed'];
const DECIDE = ['decide'];
const RUNNING = ['planned', 'queued', 'dispatched', 'working', 'final', 'plan_failed'];
export const STATE_LABEL = Object.freeze({
  planned: '계획만(dry-run)', queued: '대기열', dispatched: '보냄', working: '작업 중', final: '검수 대기',
  plan_failed: '계획 실패', proposed: '반영 대기', applied: '반영됨', discarded: '버림', decide: '결정 필요',
});
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const ISSUE = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/;

export const alert8 = id => String(id ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
const entries = ledger => Array.isArray(ledger?.entries) ? ledger.entries.filter(e => e && typeof e.id === 'string') : [];
const inSpace = (entry, space) => !space || entry.workspace === space;
const newest = (a, b) => String(b.at || '').localeCompare(String(a.at || ''));

function row(entry) {
  const proposal = entry.proposal && typeof entry.proposal === 'object' ? entry.proposal : null;
  const applied = entry.applied && typeof entry.applied === 'object' ? entry.applied : {};
  return {
    id: entry.id, key: alert8(entry.id), issue: String(entry.issue || ''), title: String(entry.title || ''),
    url: String(entry.url || ''), at: entry.at || '', state: entry.state, label: STATE_LABEL[entry.state] || entry.state,
    reason: String(entry.reason || ''), note: String(entry.note || ''), taskId: String(entry.task_id || ''),
    proposal: proposal && {
      comment: String(proposal.comment || ''), state: String(proposal.state || ''), from: String(proposal.from_status || ''),
      publish: String(proposal.publish || ''), checks: Array.isArray(proposal.checks) ? proposal.checks.map(String) : [],
      draft: String(proposal.draft || ''),
    },
    applied: {comment: applied.comment || null, state: applied.state || null},
  };
}

// What the issue search shows above '알림 온 이슈' for one space.
export function autoView(ledger, space) {
  const list = entries(ledger).filter(e => inSpace(e, space)).sort(newest);
  const pick = states => list.filter(e => states.includes(e.state));
  const pending = pick(PENDING), decide = pick(DECIDE), running = pick(RUNNING);
  const sw = ledger?.switch && typeof ledger.switch === 'object' ? ledger.switch : {};
  return {
    pending: pending.slice(0, AUTO_LIMIT).map(row), decide: decide.slice(0, AUTO_LIMIT).map(row),
    running: running.slice(0, AUTO_LIMIT).map(row),
    more: {pending: Math.max(0, pending.length - AUTO_LIMIT), decide: Math.max(0, decide.length - AUTO_LIMIT),
           running: Math.max(0, running.length - AUTO_LIMIT)},
    enabled: sw.enabled === true, mode: sw.mode === 'live' ? 'live' : 'dry-run',
    spaceOn: Boolean(space && sw.spaces && sw.spaces[space] === true),
  };
}

// A part still needs its button: not applied yet (a failed one can be pressed again).
export const partOpen = (r, part) => Boolean(r?.proposal) && (part === 'comment' || Boolean(r.proposal.state))
  && r.applied?.[part]?.ok !== true;

// The linear-actions request one approval button drops. `body` is the comment as it stands when
// pressed (the person's edited draft, or the proposal). Null when this computer cannot send it.
export function approvalRequest(r, part, writes = [], {now = new Date(), body = null, serial = now.getTime().toString(36)} = {}) {
  if (!r?.proposal || !ISSUE.test(r.issue) || !partOpen(r, part)) return null;
  const action = part === 'comment' ? 'comment' : 'set_state';
  if (!(writes ?? []).includes(action)) return null;
  const id = `auto-${r.key}-${part === 'comment' ? 'c' : 's'}-${serial}`.slice(0, 64);
  if (!REQUEST_ID.test(id)) return null;
  const base = {v: 1, id, action, issue: r.issue, requested_at: now.toISOString(), origin: 'button'};
  if (action === 'set_state') return r.proposal.state ? {...base, state: r.proposal.state} : null;
  const text = String(body ?? r.proposal.comment).trim();
  return text && text.length <= 4000 ? {...base, body: text} : null;
}

// Local only (the collector's ledger, never Linear): drop a proposal, or start a 'decide' alert.
export function localRequest(r, action, {now = new Date(), serial = now.getTime().toString(36)} = {}) {
  if (!r || !['discard', 'start'].includes(action)) return null;
  if (action === 'discard' && r.state !== 'proposed') return null;
  if (action === 'start' && !['decide', 'planned', 'queued'].includes(r.state)) return null;
  const id = `${action}-${r.key}-${serial}`.slice(0, 64);
  return REQUEST_ID.test(id) ? {v: 1, id, action, alert: r.id, requested_at: now.toISOString()} : null;
}

// Changes only when what the group draws changes: part of the popover key.
export const autoSignature = (ledger, space) => entries(ledger).filter(e => inSpace(e, space))
  .map(e => `${e.id}:${e.state}:${e.applied?.comment?.ok ?? ''}:${e.applied?.state?.ok ?? ''}`).join('|');
