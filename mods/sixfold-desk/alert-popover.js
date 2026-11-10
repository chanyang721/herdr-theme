import { div, image } from 'gpui-kit';
import { h_flex, v_flex, Popover } from 'gpui-base';
import { shared, setShared } from 'herdr';
import { scopedAlerts, alertVersion, linearScoped, changeLines, linearCategory, popoverOpen, popoverRows, projectKey } from './alert-model.js';

// A small surface beside a space card: the newest Slack and Linear alerts of that
// space, opened by its alert badges or by a new alert. The full inboxes stay one
// press away ("전체 보기"). Only display state lives here — nothing is written to
// Slack or Linear, and opening it does not mark anything read.
const STATE = 'sixfold.alertPopover';
// One id per load of this mod: a value left over from an earlier run never opens.
const BOOT = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
export const popoverState = () => shared(STATE) ?? null;
export function showPopover(space, source, {auto = false} = {}) {
  setShared(STATE, {space, source, auto, boot: BOOT, at: Date.now()});
}
// Cards that drew a popover host recently. A new alert opens the popover only on
// such a card; otherwise the caller falls back to its window. Bounded by spaces.
const hosts = new Map();
export const markHost = space => hosts.set(projectKey(space), Date.now());
export const hasHost = (space, now = Date.now()) => now - (hosts.get(projectKey(space)) ?? -Infinity) < 10_000;
export const hidePopover = () => setShared(STATE, {});

const short = at => {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const line = (value, color, size = 12) => div().min_w(0).truncate().text_size(size).text_color(color).child(String(value ?? ''));

function slackRows(project, t) {
  const read = shared('sixfold.alertRead') ?? {};
  const unread = item => read[item.id] !== alertVersion(item);
  const items = scopedAlerts(shared('sixfold.alertItems') ?? [], {project});
  return {unread: items.filter(unread).length, rows: popoverRows(items, 5, unread).map((item, i) =>
    v_flex().id(`sf-alert-pop-slack-${i}`).gap(2).p(8).rounded(6).bg(unread(item) ? t.selected : t.chrome)
      .child(h_flex().gap(6).items_center()
        .child(div().size(6).flex_none().rounded(3).bg(unread(item) ? t.accent : t.border))
        .child(line(item.author || 'Slack', t.foreground, 12).font_bold().flex_1())
        .child(line(short(item.at), t.dim, 10).flex_none()))
      .child(line(item.text || item.title || '', t.muted, 12).tooltip(String(item.text || item.title || '').slice(0, 400))))};
}

function linearRows(project, t) {
  const items = linearScoped(shared('sixfold.linearItems') ?? [], project);
  return {unread: items.filter(i => !i.read).length, rows: popoverRows(items, 5).map((item, i) =>
    v_flex().id(`sf-alert-pop-linear-${i}`).gap(2).p(8).rounded(6).bg(item.read ? t.chrome : t.selected)
      .child(h_flex().gap(6).items_center()
        .child(div().px(5).rounded(3).flex_none().text_size(10).font_bold()
          .bg(item.read ? t.surface : t.accent).text_color(item.read ? t.muted : t.accent_foreground).child(linearCategory(item)))
        .child(line(item.issue || '', t.muted, 11).flex_none().font_bold())
        .child(line(item.issue_title || item.title || '', t.foreground, 12).flex_1())
        .child(line(short(item.changed_at || item.at), t.dim, 10).flex_none()))
      .children(changeLines(item).map((change, j) => line(change, t.ansi4 || t.accent, 11).id(`sf-alert-pop-change-${i}-${j}`)))
      .when(!changeLines(item).length && Boolean(item.subtitle), e => e.child(line(item.subtitle, t.muted, 11))))};
}

// `trigger` is the whole alerts row of the card, so the surface opens beside the card.
export function alertPopover({id, project, trigger, t, hasSlack, hasLinear, onAll}) {
  markHost(project);
  const state = popoverState();
  const source = popoverOpen(state, project, 'linear', BOOT) ? 'linear' : popoverOpen(state, project, 'slack', BOOT) ? 'slack' : null;
  const fallback = hasLinear && !hasSlack ? 'linear' : 'slack';
  const popover = Popover.new(`sf-alert-pop-${id}`).anchor('left_center').open(Boolean(source))
    .on_open_change((value, cx) => {
      // A badge press just chose its source; keep it rather than the fallback.
      const fresh = state && state.boot === BOOT && projectKey(state.space) === projectKey(project) && Date.now() - state.at < 2000;
      value ? showPopover(project, fresh && state.source ? state.source : fallback) : hidePopover();
      cx.notify();
    }).trigger(trigger);
  if (!source) return popover;
  const slack = hasSlack ? slackRows(project, t) : null, linear = hasLinear ? linearRows(project, t) : null;
  const current = source === 'linear' ? linear : slack;
  const tab = (name, label, data) => h_flex().id(`sf-alert-pop-tab-${id}-${name}`).h(28).px(10).gap(5).items_center().rounded(6)
    .bg(source === name ? t.selected : t.chrome).cursor_pointer()
    .on_click((_e, cx) => { cx.stop_propagation(); showPopover(project, name); cx.notify(); })
    .child(image(`mods/sixfold-desk/icons/${name}.svg`).size(13))
    .child(line(label, source === name ? t.foreground : t.muted, 12))
    .child(line(data.unread ? `미확인 ${data.unread}` : '0', data.unread ? t.accent : t.dim, 10));
  return popover.content(v_flex().id(`sf-alert-pop-body-${id}`).w(400).ml(14).max_h(560).gap(8).p(12)
    .rounded(10).border(1).border_color(t.border).bg(t.popover || t.surface).text_color(t.foreground)
    .child(h_flex().gap(8).items_center()
      .child(line(`${project} 알림`, t.foreground, 13).font_bold().flex_1())
      .child(div().id(`sf-alert-pop-close-${id}`).size(26).rounded(6).text_size(13).text_color(t.muted).flex().items_center().justify_center()
        .cursor_pointer().tooltip('닫기').on_click((_e, cx) => { cx.stop_propagation(); hidePopover(); cx.notify(); }).child('✕')))
    .child(h_flex().gap(4)
      .when(Boolean(slack), e => e.child(tab('slack', 'Slack', slack)))
      .when(Boolean(linear), e => e.child(tab('linear', 'Linear', linear))))
    .child(v_flex().id(`sf-alert-pop-list-${id}`).max_h(420).overflow_y_scroll().gap(4)
      .when(!current || !current.rows.length, e => e.child(line('표시할 알림이 없습니다.', t.muted, 12).p(8)))
      .children(current ? current.rows : []))
    .child(h_flex().gap(6).items_center()
      .child(line(source === 'slack' ? 'Slack 앱 읽음 상태와 별도' : '읽음은 Linear 기준', t.dim, 10).flex_1())
      .child(div().id(`sf-alert-pop-all-${id}`).px(10).py(5).rounded(5).text_size(12).font_semibold()
        .bg(t.surface).text_color(t.accent).hover(s => s.bg(t.hover)).cursor_pointer()
        .on_click((_e, cx) => { cx.stop_propagation(); hidePopover(); onAll(source); cx.notify(); }).child('전체 보기'))));
}
