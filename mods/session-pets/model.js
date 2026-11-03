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
  return {enabled:shared('sixfold.pets') !== false, motion:shared('sixfold.motion') !== false && shared('sixfold.pets.motion') !== false};
}
export const petTooltip = a => `${a.space_name || ''} · ${a.title || a.program?.name || '세션'} · ${a.address} · ${a.label}`;
