import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { run, readTextFile, writeTextFile, appHome } from 'herdr';

const SHOWN = new Set(['needs-you']);  // Only what a person must decide; the rest stays in the project.
const MARKS = { 'needs-you': '!', info: '✓', processing: '●' };

// Tracked Slack, GitHub and pane requests, ordered by the watcher: needs-you first.
export function visibleAlerts(items, limit = 6) {
  return (items ?? []).filter(item => SHOWN.has(item.status)).slice(0, limit);
}

export function watchAlerts(view, cx) {
  let loading = false;
  let previous;
  const refresh = cx => {
    if (loading) return;
    loading = true;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${appHome()}/data/sixfold/alerts.json`);
        if (text === previous) return;
        const items = text ? JSON.parse(text).items ?? [] : [];
        view.alerts = items;
        previous = text;
        cx.notify();
      } catch { /* Missing folders and partial writes are retried on the next tick. */ }
      finally { loading = false; }
    });
  };
  refresh(cx);
  cx.timer.every(2000, refresh);
}

async function dismiss(id) {
  const path = `${appHome()}/data/sixfold/alerts-dismissed.json`;
  const old = await readTextFile(path);
  const ids = old ? JSON.parse(old) : [];
  await writeTextFile(path, JSON.stringify([...ids, id]), old);
}

export function alertSection(view, t) {
  const alerts = visibleAlerts(view.alerts);
  const waiting = alerts.filter(item => item.status === 'needs-you').length;
  return v_flex().id('sf-alerts').flex_none().px(10).py(9).gap(4).bg(t.surface).border_t(1).border_color(t.border)
    .child(h_flex().gap(5).items_center()
      .child(div().flex_1().text_size(10).font_bold().text_color(t.muted).child('공통 알림'))
      .child(div().text_size(10).text_color(t.accent).child(`확인 ${waiting}건`)))
    .children(alerts.map(item => h_flex().id(`sf-alert-${item.id}`).gap(5).items_center().px(6).py(4).rounded(4).bg(t.chrome)
      .tooltip(item.summary || item.text || item.title)
      .on_click(() => { if (item.terminal) run('agent.focus', { terminal: item.terminal }); })
      .child(div().text_size(10).text_color(t.accent).child(MARKS[item.status]))
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.foreground)
        .child(`${item.project} · ${item.summary || item.title}`))
      .child(div().id(`sf-alert-close-${item.id}`).px(3).text_size(11).text_color(t.muted)
        .on_mouse_down('left', (_event, cx) => cx.stop_propagation())
        .on_mouse_up('left', (_event, cx) => cx.stop_propagation())
        .on_click((_event, cx) => {
          cx.stop_propagation();
          view.alerts = view.alerts.filter(other => other.id !== item.id);
          cx.spawn(async () => { await dismiss(item.id); });
          cx.notify();
        }).child('×'))));
}
