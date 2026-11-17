// A pet represents an observed agent address, never an inferred background job.
export const STATES = {
  working: {pose:'walk', label:'작업 중', token:'working'},
  idle: {pose:'sleep', label:'대기', token:'idle'},
  done: {pose:'sit', label:'완료 · 미확인', token:'done'},
  blocked: {pose:'raise', label:'확인 필요', token:'blocked'},
};
export function petSessions(agents, space) {
  const seen = new Set();
  return agents.filter(a => a.space === space && typeof a.address === 'string' && !seen.has(a.address) && seen.add(a.address))
    .map(a => ({...a, ...(STATES[a.status] || {pose:'sit',label:'상태 미확인',token:'muted'})}));
}
export function petOptions(shared) {
  // Same rule as sixfold-desk/motion.js (mods cannot import each other): motion is opt-in.
  return {enabled:shared('sixfold.pets') !== false, motion:shared('sixfold.motion') === true && shared('sixfold.pets.motion') !== false};
}
// A working pet walks only for BRIEF_MS after its status changes, then stands: a forever
// loop makes GPUI redraw the whole window every frame. Same rule as sixfold-desk/motion.js.
// `memory` is the view's {born, seen}; pets first seen in its first second start still.
export const BRIEF_MS=8000;
export function petWalks(memory, sessions, now=Date.now()) {
  memory.born ??= now; memory.seen ??= new Map();
  const walking = new Set(); let wake = null;
  for (const a of sessions) {
    let entry = memory.seen.get(a.address);
    if (!entry) memory.seen.set(a.address, entry = {status:a.status, until:now - memory.born < 1000 ? 0 : now + BRIEF_MS});
    else if (entry.status !== a.status) { entry.status = a.status; entry.until = now + BRIEF_MS; }
    if (a.status === 'working' && now < entry.until) { walking.add(a.address); if (wake === null || entry.until < wake) wake = entry.until; }
  }
  for (const key of memory.seen.keys()) if (!sessions.some(a => a.address === key)) memory.seen.delete(key);
  return {walking, wake};
}
export const petTooltip = a => `${a.space_name || ''} · ${a.title || a.program?.name || '세션'} · ${a.address} · ${a.label}`;
