import { div } from 'gpui-kit';
import { v_flex } from 'gpui-base';
import { appHome, readTextFile, run } from 'herdr';

export function parseReports(text) {
  let data;
  try { data = JSON.parse(text || 'null'); } catch { return []; }
  if (data?.schema !== 1 || !Array.isArray(data.reports)) return [];
  const seen = new Set();
  return data.reports.filter(row => {
    if (!row || typeof row.id !== 'string' || !row.id || seen.has(row.id)
      || typeof row.title !== 'string' || !row.title || typeof row.summary !== 'string') return false;
    seen.add(row.id); return true;
  }).slice(0, 20).map(row => ({id: row.id, title: row.title, summary: row.summary,
    state: typeof row.state === 'string' ? row.state : '',
    terminal: typeof row.terminal === 'string' ? row.terminal : null}));
}
export function watchReports(view, cx) {
  view.sessionReports = [];
  let loading = false, previous = '';
  const refresh = cx => {
    if (loading) return;
    loading = true;
    cx.spawn(async cx => {
      try {
        const reports = parseReports(await readTextFile(`${appHome()}/data/sixfold/session-reports.json`).catch(() => null));
        const signature = JSON.stringify(reports);
        if (signature !== previous) { view.sessionReports = reports; previous = signature; cx.notify(); }
      } finally { loading = false; }
    });
  };
  refresh(cx); cx.timer.every(5000, refresh);
}
export function reportsSection(view, t) {
  return v_flex().id('sf-session-reports').flex_none().px(10).py(8).gap(4).border_t(1).border_color(t.border)
    .children((view.sessionReports ?? []).slice(0, 4).map((row, index) =>
      v_flex().id(`sf-report-${index}`).gap(2).tooltip(`${row.title}\n${row.summary}`)
        .when(Boolean(row.terminal), e => e.cursor_pointer().on_click(() => run('agent.focus', {terminal: row.terminal})))
        .child(div().text_size(10).text_color(t.muted).child(row.title))
        .child(div().text_size(10).text_color(t.dim).truncate().child(row.summary))));
}
