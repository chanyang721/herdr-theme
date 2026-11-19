import { div, image } from 'gpui-kit';
import { h_flex, v_flex, Popover } from 'gpui-base';
import { shared, setShared } from 'herdr';
import { scopedAlerts, alertVersion, linearScoped, changeLines, linearCategory, popoverOpen, popoverRows, projectKey, alertKind, alertLine, kindTone, popoverChangeLines } from './alert-model.js';
import { feedNames, namesFor, alertTitle, readable } from './alert-slack.js';
import { fileChips, loadFileText, followFileText, localNames } from './alert-files.js';
import { spaceMentions, setSpaceMentions, arrivedFor } from './alert-mentions.js';
export { spaceMentions, setSpaceMentions };

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
export const hidePopover = () => setShared(STATE, {});
// Which attachment's text the open popover shows (`<alert id>|<file id>`, or none). It lives in the
// popover state, which the retained card's key already carries, so the card redraws with it.
const showFile = key => { const state = popoverState(); if (state?.space) setShared(STATE, {...state, file: key, at: Date.now()}); };
const viewFile = (key, file, cx) => {
  showFile(key); cx.notify();
  if (!key) return;
  const isOpen = () => popoverState()?.file === key, redraw = cx => { if (isOpen()) { showFile(key); cx.notify(); } };
  cx.spawn(async cx => {
    const got = await loadFileText(file.id);
    redraw(cx);
    if (got.state === 'pending' && isOpen()) followFileText(file.id, cx, isOpen, redraw);   // 본문 준비 중: ask the collector
  });
};
// The address fileChips chose (the direct download, or the Slack page when there is no team ID).
const downloadFile = (url, cx) => cx.open_url(url);
// A row's body on one line: a long message (a multi-line report, a code block) would otherwise draw every
// line and make the popover tall. The tooltip and 전체 보기 keep the whole text.
export const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim();
// A card's alert popover is open now: this run's own state, not expired (a value left from
// an earlier run or an hour ago does not count).
export const alertPopoverOpen = (now = Date.now()) => {
  const state = popoverState();
  return Boolean(state?.space) && ['slack', 'linear'].some(source => popoverOpen(state, state.space, source, BOOT, now));
};

const short = at => {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const line = (value, color, size = 12) => div().min_w(0).truncate().text_size(size).text_color(color).child(String(value ?? ''));

// A Slack row: "보낸 사람 → 받는 사람" and the time, the text with its tags spelled as names, and
// its attachments. `interactive` is off for the arrival peek (read-only, takes no focus).
// `arrived`: the mentions that just arrived for this space (the peek). Those the tracked feed does
// not list (unmapped mentions, DMs, thread replies routed to the fallback space) are shown too, and the
// arrived ones come first, so a peek always shows what opened it.
function slackRows(project, t, fresh = new Set(), interactive = true, arrived = []) {
  const read = shared('sixfold.alertRead') ?? {};
  const unread = item => read[item.id] !== alertVersion(item);
  const all = shared('sixfold.alertItems') ?? [], scoped = scopedAlerts(all, {project});
  const known = new Set(scoped.map(item => item.id));
  const extra = [...(arrived ?? []), ...spaceMentions(project)].filter(item => item && typeof item.id === 'string' && !known.has(item.id) && (known.add(item.id), true));
  const items = [...extra, ...scoped], feed = feedNames([...all, ...extra]), site = localNames();
  const open = interactive ? popoverState()?.file ?? null : null;
  const lit = popoverRows(items.filter(item => fresh.has(item.id)), 5, unread);
  const rows = [...lit, ...popoverRows(items.filter(item => !fresh.has(item.id)), 5 - lit.length, unread)];
  return {unread: items.filter(unread).length, rows: rows.map((item, i) => {
    const full = readable(item.text || item.title || '', namesFor(item, feed, site), item.mentions), text = oneLine(full);
    const files = fileChips(item, t, {id: `sf-alert-pop-slack-${i}`, open,
      onView: interactive ? viewFile : null, onDownload: interactive ? downloadFile : null});
    return v_flex().id(`sf-alert-pop-slack-${i}`).gap(2).p(8).rounded(6).bg(unread(item) ? t.selected : t.chrome)
      .when(fresh.has(item.id), e => e.border(1).border_color(t.ansi5 || t.accent))
      .child(h_flex().gap(6).items_center()
        .child(div().size(6).flex_none().rounded(3).bg(unread(item) ? t.accent : t.border))
        .child(line(alertTitle(item, feed, site), t.foreground, 12).font_bold().flex_1())
        .child(line(short(item.at), t.dim, 10).flex_none()))
      .child(line(text, t.muted, 12).tooltip(full.slice(0, 400)))
      .when(Boolean(files), e => e.child(files));
  })};
}

function linearRows(project, t) {
  const items = linearScoped(shared('sixfold.linearItems') ?? [], project);
  return {unread: items.filter(i => !i.read).length, rows: popoverRows(items, 5).map((item, i) =>
    v_flex().id(`sf-alert-pop-linear-${i}`).gap(2).p(8).rounded(6).bg(item.read ? t.chrome : t.selected)
      .child(h_flex().gap(6).items_center()
        .child(div().px(5).rounded(3).flex_none().text_size(10).font_bold()
          .bg(item.read ? t.surface : kindTone(alertKind(item).kind, t)).text_color(item.read ? t.muted : t.accent_foreground).child(alertKind(item).label))
        .child(line(item.issue || '', t.muted, 11).flex_none().font_bold())
        .child(line(item.issue_title || item.title || '', t.foreground, 12).flex_1())
        .child(line(short(item.changed_at || item.at), t.dim, 10).flex_none()))
      .children(popoverChangeLines(item).map((change, j) => line(change, t.ansi4 || t.accent, 11).id(`sf-alert-pop-change-${i}-${j}`)))
      .when(!changeLines(item).length && Boolean(alertLine(item)), e => e.child(line(alertLine(item), t.muted, 11))))};
}

// The surface of a card's alert popover: its title, the Slack/Linear tabs, the rows of `source` and
// 전체 보기. The popover and the new-alert peek both draw it, so a new Slack alert shows in the very
// popover its chip opens (as a new Linear alert shows the top of its card's issue search).
// `peek`: drawn by the arrival layer (no focus taken): a 새 알림 mark instead of the close button,
// and the title or a tab opens the card's popover itself.
function surface({id, project, source, t, slack, linear, onAll, onTab, onClose = null, onHead = null, peek = false}) {
  const current = source === 'linear' ? linear : slack;
  const tab = (name, label, data) => h_flex().id(`sf-alert-pop-tab-${id}-${name}`).h(28).px(10).gap(5).items_center().rounded(6)
    .bg(source === name ? t.selected : t.chrome).cursor_pointer()
    .on_click((_e, cx) => { cx.stop_propagation(); onTab(name); cx.notify(); })
    .child(image(`mods/sixfold-desk/icons/${name}.svg`).size(13))
    .child(line(label, source === name ? t.foreground : t.muted, 12))
    .child(line(data.unread ? `미확인 ${data.unread}` : '0', data.unread ? t.accent : t.dim, 10));
  const head = h_flex().id(`sf-alert-pop-head-${id}`).gap(8).items_center()
    .when(Boolean(onHead), e => e.cursor_pointer().tooltip('누르면 이 공간 알림 팝오버를 엽니다').on_click((_e, cx) => { cx.stop_propagation(); onHead(); cx.notify(); }))
    .child(line(`${project} 알림`, t.foreground, 13).font_bold().flex_1());
  if (peek) head.child(div().px(6).rounded(7).text_size(10).font_bold().bg(t.accent).text_color(t.accent_foreground || t.background).child('새 알림'));
  else head.child(div().id(`sf-alert-pop-close-${id}`).size(26).rounded(6).text_size(13).text_color(t.muted).flex().items_center().justify_center()
    .cursor_pointer().tooltip('닫기').on_click((_e, cx) => { cx.stop_propagation(); onClose?.(); cx.notify(); }).child('✕'));
  return v_flex().id(`sf-alert-pop-body-${id}`).w(400).max_h(560).gap(8).p(12)
    .rounded(10).border(1).border_color(peek ? t.accent : t.border).bg(t.popover || t.surface).text_color(t.foreground)
    .child(head)
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
        .on_click((_e, cx) => { cx.stop_propagation(); hidePopover(); onAll?.(source); cx.notify(); }).child('전체 보기')));
}

// The Slack mentions that arrived for a space in this run and are still unread: the popover lists
// them first and lit, so pressing the chip after a peek shows the alert that opened it.
const arrivedUnread = project => {
  const read = shared('sixfold.alertRead') ?? {};
  return arrivedFor(project).filter(item => read[item.id] !== alertVersion(item));
};

// `trigger` is the whole alerts row of the card, so the surface opens beside the card.
export function alertPopover({id, project, trigger, t, hasSlack, hasLinear, onAll}) {
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
  const arrived = hasSlack ? arrivedUnread(project) : [];
  const slack = hasSlack ? slackRows(project, t, new Set(arrived.map(item => item.id)), true, arrived) : null, linear = hasLinear ? linearRows(project, t) : null;
  return popover.content(surface({id, project, source, t, slack, linear, onAll,
    onTab: name => showPopover(project, name), onClose: hidePopover}).ml(14));
}

// A peek: the card's alert popover surface on its Slack tab, opened by new alerts beside the card (the
// arrival layer draws it in a Popup, which takes no focus); the ones just arrived are lit and listed
// first. Its rows are read-only; the title or a tab opens the card's popover itself (`onOpen`).
export function slackPeek(project, t, fresh = [], onAll = null, arrived = [], {hasLinear = false, onOpen = null} = {}) {
  const lit = new Set(fresh), known = new Set((arrived ?? []).map(item => item?.id));
  const slack = slackRows(project, t, lit, false, [...(arrived ?? []), ...arrivedFor(project).filter(item => lit.has(item.id) && !known.has(item.id))]);
  if (!slack.rows.length) return null;
  const linear = hasLinear ? linearRows(project, t) : null;
  const open = source => { if (onOpen) onOpen(source); else showPopover(project, source); };
  return surface({id: `peek-${projectKey(project)}`, project, source: 'slack', t, slack, linear, onAll,
    onTab: open, onHead: () => open('slack'), peek: true});
}
