export const WORDS = {
  ko: { blocked: '확인 필요', done: '완료', working: '작업 중', idle: '대기', input: '입력 대상', panes: '현재 작업', spaces: '작업 공간', attention: '확인 대기', empty: '확인을 기다리는 작업이 없습니다', noAgents: '에이전트 상태 보고 없음', shell: '터미널', bridge: 'TUI 연결', language: 'EN', next: '다음', zoom: '확대', settings: '설정', files: '파일', review: '변경', noFocus: '터미널을 선택하세요' },
  en: { blocked: 'Needs you', done: 'Done', working: 'Working', idle: 'Idle', input: 'INPUT TARGET', panes: 'CURRENT TAB', spaces: 'SPACES', attention: 'ATTENTION', empty: 'No tasks waiting for you', noAgents: 'No agent status reported', shell: 'Terminal', bridge: 'TUI link', language: '한국어', next: 'Next', zoom: 'Zoom', settings: 'Settings', files: 'Files', review: 'Changes', noFocus: 'Select a terminal' }
};
export function counts(list) {
  const result = { blocked: 0, done: 0, working: 0, idle: 0 };
  for (const item of list) if (item.status in result) result[item.status]++;
  return result;
}
export function attention(list) {
  // Stable source order within each status; no timers or focus-stealing sorting.
  return [...list.filter(a => a.status === 'blocked'), ...list.filter(a => a.status === 'done')];
}
export function title(p) {
  return p?.title?.trim() || p?.program?.name || p?.terminal || 'Terminal';
}
export function cycle(list, current, step = 1) {
  if (!list.length) return null;
  const at = list.findIndex(p => p.pane === current);
  return list[(at + step + list.length) % list.length];
}
