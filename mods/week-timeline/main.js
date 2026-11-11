import { View, div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { appHome, exec, readTextFile, theme, props, settings, openOverlay, closeOverlay } from 'herdr';
import { initIssue, renderIssue } from './issue.js';
import { KIND, parseFeed, bridgeFrom, weekRows, dayCells, projectRows, freshness, isoDay, daysBetween, md, mix } from './model.js';
import { bandModel, fitCell, fitLine, textWidth, BAND } from './summary.js';

// A: a band under the header: seven day cells with that day's deadline chips and one "진행 중" line.
//    Its summary or a +N opens the week in a dismissible dialog over the panes; a chip opens the issue (C).
// B: "프로젝트 전체 타임라인" opens a window over the panes: milestones and my issues by week.
// C: clicking an issue opens its popup (issue.js) on the right over the panes.
// The feed is written by a user-owned producer (week-timeline-bridge.json); nothing here reads Linear.
const FEED = 'data/sixfold/week-timeline.json';
const BRIDGE = 'data/sixfold/week-timeline-bridge.json';
const READ_MS = 15 * 1000;
const PRODUCE_MS = 2 * 60 * 1000;      // a sync: one notifications look; the producer reads in full itself every 2 h
const PRODUCE_TIMEOUT = 9 * 60 * 1000;
const FRESH_S = 90;
const FULL_KEY = 'week-timeline-full';
const ISSUE_KEY = 'week-timeline-issue';
const WEEK_KEY = 'week-timeline-week';

const stop = el => el.on_mouse_down('left', (_e, cx) => cx.stop_propagation());
const pct = n => `${Math.max(0, Math.min(100, n)).toFixed(3)}%`;
const caret = (open, t) => div().w(14).flex_none().text_size(9).text_color(t.muted).child(open ? '▼' : '▶');

function lozenge(kind, t) {
  const c = t[KIND[kind].token] || t.muted;
  return div().flex_none().text_size(10).font_semibold().px(6).rounded(3).bg(mix(c, t.background, 0.72)).text_color(mix(c, t.foreground, 0.35)).child(KIND[kind].name);
}
function meter(done, total, t, w = 40) {
  const share = total ? done / total : 0;
  return h_flex().flex_none().items_center().gap(5).text_size(10).text_color(t.muted)
    .child(div().w(w).h(4).rounded(2).bg(t.raised || t.border).overflow_hidden().child(div().h_full().w(pct(share * 100)).bg(t.done)))
    .child(`${done}/${total}`);
}
function legend(t, kinds) {
  return h_flex().flex_none().items_center().gap(10).text_size(11).text_color(t.muted).children(kinds.map(k =>
    h_flex().items_center().gap(4).child(k === 'milestone' ? div().text_size(10).text_color(t.ansi3 || t.accent).child('◆') : div().size(8).rounded(2).bg(t[KIND[k].token] || t.muted))
      .child(k === 'milestone' ? '마일스톤' : k === 'hot' ? '오늘 마감' : KIND[k].name)));
}
function pill(id, label, active, t, onClick) {
  return stop(div().id(id).flex_none().h(20).px(9).rounded(10).border(1).border_color(active ? t.accent : t.border)
    .bg(active ? t.selected : t.chrome).text_size(11).text_color(active ? t.foreground : t.muted).flex().items_center().cursor_pointer()
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(label));
}
function status(feed, t) {
  const f = freshness(feed);
  return div().flex_none().text_size(10).text_color(f.failed ? t.blocked : t.dim)
    .tooltip(f.failed ? `${f.detail}${f.since ? `\n${f.since}을 보여 주는 중` : ''}` : 'Linear 읽기 전용 · 담당 = 나 · 알림이 오면 그 이슈만 다시 읽음 · 2시간마다 전체 대조').child(f.text);
}

export default class WeekTimeline extends View {
  init(_props, cx) {
    const p = props() || {};
    this.timers = []; this.closed = false;
    if (p.issue) { this.mode = 'issue'; initIssue(this, p, cx); return; }
    this.mode = p.full ? 'full' : p.week ? 'week' : 'band';
    this.full = Boolean(p.full);
    this.project = typeof p.project === 'string' ? p.project : null;
    this.feed = null; this.filter = 'all'; this.days = 7; this.open = {}; this.undated = false;
    this.busy = false; this.note = '';
    this.load(cx);
    this.timers.push(cx.timer.every(READ_MS, cx => this.load(cx)));
    this.timers.push(cx.timer.every(60000, cx => cx.notify()));   // today's line and late marks follow the clock
    if (this.mode === 'band') {
      this.timers.push(cx.timer.after(5000, cx => this.produce(cx, FRESH_S)));
      this.timers.push(cx.timer.every(PRODUCE_MS, cx => this.produce(cx, FRESH_S)));
    }
  }
  close() { this.closed = true; for (const timer of this.timers) timer?.cancel?.(); this.timers = []; }

  load(cx) {
    if (this.closed) return;
    cx.spawn(async cx => {
      const feed = parseFeed(await readTextFile(`${appHome()}/${FEED}`).catch(() => null));
      if (this.closed) return;
      if (feed && JSON.stringify(feed) !== JSON.stringify(this.feed)) { this.feed = feed; cx.notify(); }
      else if (!feed && !this.loaded) { this.loaded = true; cx.notify(); }
    });
  }
  // Runs the configured producer; it does nothing itself while its last attempt is younger than `fresh` s.
  produce(cx, fresh) {
    if (this.closed || this.busy) return;
    this.busy = true;
    cx.spawn(async cx => {
      try {
        const bridge = bridgeFrom(await readTextFile(`${appHome()}/${BRIDGE}`).catch(() => null));
        if (!bridge) { this.note = '수집기 미설정'; return; }
        const result = await exec(bridge.command, [...bridge.args, '--if-older', String(fresh)], { timeout: PRODUCE_TIMEOUT });
        this.note = result.code === 0 ? '' : `수집기 종료 코드 ${result.code}`;
      } catch (error) {
        this.note = String(error?.message || error).slice(0, 80);
      } finally {
        this.busy = false;
        if (!this.closed) { this.load(cx); cx.notify(); }
      }
    });
  }
  openWeek() {
    openOverlay({ mod: 'week-timeline', kind: 'dialog', key: WEEK_KEY, width: 1, height: 1, frame: 'none', props: { week: true } });
  }
  closeWeek() { const id = props()?.overlay; if (id) closeOverlay(id); }
  openFull() {
    if (this.mode === 'week') this.closeWeek();
    openOverlay({ mod: 'week-timeline', kind: 'window', key: FULL_KEY, width: 0.86, height: 0.8,
      props: { full: true, project: this.filter === 'all' ? null : this.filter } });
  }
  // The issue popup: one dialog the size of the window; issue.js draws the panel on the right and
  // leaves the rest see-through (dimmed by the dialog), closing on a click there, ✕ or Esc.
  openIssue(r) {
    const project = (this.feed?.projects ?? []).find(p => p.issues.some(i => i.key === r.key));
    const milestone = project?.milestones.find(m => m.id === r.milestone)?.name || '';
    openOverlay({ mod: 'week-timeline', kind: 'dialog', key: ISSUE_KEY, width: 1, height: 1, frame: 'none',
      props: { issue: r.key, row: { key: r.key, title: r.title || '', url: r.url || '', project: project?.name || '', milestone, parent: r.parent || '' } } });
  }
  toggle(id, fallback, cx) { this.open = { ...this.open, [id]: !(this.open[id] ?? fallback) }; cx.notify(); }

  render() { return this.mode === 'issue' ? renderIssue(this) : this.full ? this.renderFull() : this.mode === 'week' ? this.renderWeek() : this.renderBand(); }

  // --- A ------------------------------------------------------------------------------------------
  // Under the header, ~80px: the week label, seven day cells with that day's deadline chips, and one
  // "진행 중" line. No tree, table or bars here; those stay in the dialog (+N) and B.
  renderBand() {
    const t = theme(), today = isoDay(), f = freshness(this.feed);
    const hex = v => v && /^#[0-9a-f]{6}/i.test(v) ? v : null, ground = hex(t.canvas) || t.background;
    const rule = mix(t.border, t.background, 0.45), weekend = ground, todayBg = mix(t.blocked, t.background, 0.9);
    const root = h_flex().id('wt-band').size_full().bg(mix(t.chrome, ground, 0.45)).border_b(1).border_color(t.border)
      .text_size(12).font_normal().text_color(t.foreground).whitespace_nowrap().overflow_hidden()
      .on_size_change((size, cx) => { const w = size.width / (settings()?.zoom || 1); if (Math.abs((this.width || 0) - w) > 1) { this.width = w; cx.notify(); } });
    if (!this.feed) return root.items_center().px(12).child(div().min_w(0).truncate().text_color(t.dim || t.muted)
      .child(this.note || (this.loaded ? '이번 주 타임라인: 아직 수집된 내용이 없습니다' : '이번 주 타임라인 읽는 중…')));
    const m = bandModel(this.feed, { today });
    const tone = c => ({ late: t.ansi1 || t.blocked, soon: t.blocked, review: t.ansi5 || t.accent }[c.tone] || t.working);
    const tip = r => `${r.key} ${r.title}\n${r.status}${r.when ? ` · ${r.due ? '마감' : '마일스톤 목표'} ${r.when}` : ''}\n눌러서 이슈 보기`;
    const issue = (c, el) => stop(el.id(`wt-chip-${c.key}`).cursor_pointer().tooltip(tip(c.item))
      .on_click((_e, cx) => { cx.stop_propagation(); this.openIssue(c.item); }));
    const more = (id, n, keys, h) => stop(div().id(id).flex_none().h(h).px(7).rounded(h / 2).border(1).border_color(t.border).bg(t.chrome)
      .flex().items_center().text_size(11).text_color(t.muted).cursor_pointer().tooltip(`${keys.join(' · ')}\n눌러서 이번 주 전체`)
      .on_click((_e, cx) => { cx.stop_propagation(); this.openWeek(); }).child(`+${n}`));
    const dueChip = c => {
      const color = tone(c), hot = c.tone === 'late' || c.tone === 'soon';
      return issue(c, h_flex().min_w(0).h(20).px(8).gap(BAND.gap).items_center().rounded(10).border(1)
        .border_color(hot ? mix(color, t.background, 0.55) : t.border).bg(hot ? mix(color, t.background, 0.86) : t.chrome)
        .hover(el => el.border_color(color))
        .child(div().flex_none().text_size(11).text_color(color).child('◆'))
        .child(div().flex_none().text_color(t.muted).child(c.key))
        .child(div().min_w(0).truncate().child(c.title)));
    };
    const lineChip = c => issue(c, h_flex().flex_none().h(18).px(8).gap(BAND.gap).items_center().rounded(9).border(1).border_color(t.border)
      .bg(t.chrome).text_size(11).hover(el => el.border_color(tone(c)))
      .child(div().flex_none().text_color(tone(c)).child('●'))
      .child(div().flex_none().text_color(t.muted).child(c.key))
      .child(div().flex_none().child(c.title))
      .when(Boolean(c.due), el => el.child(div().flex_none().text_color(t.muted).child(`→ ${c.due}`))));
    const right = Math.max(0, (this.width || 0) - BAND.label), cell = right / 7;
    const label = stop(v_flex().id('wt-summary').w(BAND.label).flex_none().h_full().px(12).py(7).gap(3).border_r(1).border_color(rule).cursor_pointer()
      .tooltip(`${f.text} · 눌러서 이번 주 타임라인`).on_click((_e, cx) => { cx.stop_propagation(); this.openWeek(); })
      .child(div().font_semibold().child('이번 주'))
      .child(div().text_size(11).text_color(t.muted).child(m.range))
      .child(div().text_size(11).text_color(t.muted).child(`마감 ${m.due} · 진행 ${m.ongoing.length}`)));
    const cellBox = (c, i, h) => div().flex_1().min_w(0).h(h).when(i < 6, el => el.border_r(1).border_color(rule))
      .when(c.today || c.weekend, el => el.bg(c.today ? todayBg : weekend));
    const head = h_flex().id('wt-days').h(BAND.head).flex_none().children(m.days.map((c, i) => cellBox(c, i, BAND.head).px(10).flex().items_center()
      .text_size(11).when(c.today, el => el.font_semibold()).text_color(c.today ? t.blocked : c.weekend ? (t.dim || t.muted) : t.muted).child(c.label)));
    const dues = h_flex().id('wt-due').h(BAND.due).flex_none().children(m.days.map((c, i) => {
      const fit = fitCell(c.items.length, cell);
      return cellBox(c, i, BAND.due).id(`wt-day-${i}`).px(BAND.cellPad).flex().items_center().gap(BAND.gap).overflow_hidden()
        .children(c.items.slice(0, fit.shown).map(dueChip))
        .when(fit.more > 0, el => el.child(more(`wt-more-${i}`, fit.more, c.items.slice(fit.shown).map(x => x.key), 20)));
    }));
    const tail = f.failed || this.note ? (this.note || f.text) : '';
    const room = right - BAND.linePad * 2 - textWidth('진행 중', 11) - BAND.gap * 3 - textWidth('프로젝트 전체 ↗', 11) - (tail ? textWidth(tail, 11) + BAND.gap : 0);
    const line = fitLine(m.ongoing, room);
    const ongoing = h_flex().id('wt-ongoing').h(BAND.line).flex_none().px(BAND.linePad).gap(BAND.gap).items_center().border_t(1).border_color(rule).overflow_hidden()
      .child(div().flex_none().text_size(11).text_color(t.muted).child('진행 중'))
      .when(!m.total, el => el.child(div().flex_none().text_size(11).text_color(t.muted).child('· 이번 주 할 일 없음')))
      .when(m.total > 0 && !m.ongoing.length, el => el.child(div().flex_none().text_size(11).text_color(t.dim || t.muted).child('없음')))
      .children(line.shown.map(lineChip))
      .when(line.more > 0, el => el.child(more('wt-more-ongoing', line.more, m.ongoing.slice(line.shown.length).map(x => x.key), 18)))
      .child(div().flex_1())
      .when(Boolean(tail), el => el.child(div().id('wt-band-status').flex_none().text_size(11).text_color(t.dim || t.muted)
        .tooltip(f.failed ? `${f.detail}${f.since ? `\n${f.since}을 보여 주는 중` : ''}` : tail).child(tail)))
      .child(stop(div().id('wt-band-full').flex_none().text_size(11).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { cx.stop_propagation(); this.openFull(); }).child('프로젝트 전체 ↗')));
    return root.child(label).child(v_flex().flex_1().min_w(0).h_full().child(head).child(dues).child(ongoing));
  }
  renderWeek() {
    const t = theme();
    return v_flex().id('wt-backdrop').size_full().p(24).items_center().justify_center()
      .on_click((_e, cx) => { cx.stop_propagation(); this.closeWeek(); })
      .child(stop(v_flex().id('wt-dialog').w_full().max_w(1600).h('65%').min_h(180).max_h(420)
        .rounded(8).border(1).border_color(t.border).bg(t.background).overflow_hidden()
        .on_click((_e, cx) => cx.stop_propagation()).child(this.renderWeekTable())));
  }
  renderWeekTable() {
    const t = theme(), today = isoDay(), LABEL = 380, ROW = 24;
    const { win, rows } = weekRows(this.feed, { today, days: this.days, filter: this.filter, open: this.open });
    const cells = dayCells(win, today), D = win.days, todayAt = daysBetween(win.start, today);
    const now = new Date(), hour = now.getHours() + now.getMinutes() / 60;
    const projects = this.feed?.projects ?? [];
    const rule = mix(t.border, t.background, 0.55), weekend = mix(t.canvas, t.background, 0.5);
    const bar = h_flex().flex_none().h(28).items_center().gap(10).px(12).bg(t.chrome).border_b(1).border_color(t.border).text_size(12)
      .child(div().flex_none().text_color(t.foreground).child('타임라인'))
      .child(div().flex_none().text_color(t.muted).child(D === 7 ? `이번 주 ${md(win.start)}(월) – ${md(win.end)}(일)` : `2주 ${md(win.start)} – ${md(win.end)}`))
      .child(div().flex_none().w(1).h(14).bg(t.border))
      .child(pill('wt-f-all', '전체', this.filter === 'all', t, cx => { this.filter = 'all'; cx.notify(); }))
      .children(projects.map(p => pill(`wt-f-${p.key}`, p.key, this.filter === p.key, t, cx => { this.filter = p.key; cx.notify(); })))
      .child(div().flex_1())
      .child(legend(t, ['todo', 'started', 'review', 'hot']))
      .child(h_flex().flex_none().rounded(6).border(1).border_color(t.border).overflow_hidden()
        .children([[7, '1주'], [14, '2주']].map(([n, label]) => stop(div().id(`wt-z-${n}`).h(20).px(10).flex().items_center().text_size(11).cursor_pointer()
          .bg(D === n ? t.selected : t.chrome).text_color(D === n ? t.foreground : t.muted)
          .on_click((_e, cx) => { cx.stop_propagation(); this.days = n; cx.notify(); }).child(label)))))
      .child(status(this.feed, t))
      .child(stop(div().id('wt-open-full').flex_none().text_size(11).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { cx.stop_propagation(); this.openFull(); }).child('프로젝트 전체 타임라인 ↗')))
      .child(stop(div().id('wt-close').flex_none().px(5).text_size(13).text_color(t.muted).cursor_pointer().tooltip('닫기 · Esc')
        .on_click((_e, cx) => { cx.stop_propagation(); this.closeWeek(); }).child('✕')));
    const head = h_flex().flex_none().h(22).border_b(1).border_color(t.border).text_size(11).text_color(t.muted)
      .child(div().w(LABEL).flex_none().h_full().px(12).flex().items_center().border_r(1).border_color(t.border)
        .child(`이슈 · ${rows.length}행 · 스크롤 ↕`))
      .child(h_flex().flex_1().h_full().children(cells.map((c, i) => div().flex_1().h_full().pl(6).flex().items_center().when(i > 0, el => el.border_l(1).border_color(rule))
        .bg(c.weekend ? weekend : t.background).text_color(t.muted)
        .child(c.label))));
    const lane = () => div().flex_1().h_full().relative();
    const body = rows.map((r, n) => {
      const label = h_flex().w(LABEL).flex_none().h_full().items_center().gap(6).pl(12 + r.depth * 18).pr(12).border_r(1).border_color(t.border).overflow_hidden();
      const row = h_flex().id(`wt-r-${n}`).h(ROW).flex_none().text_size(12).font_normal().border_b(1).border_color(rule);
      if (r.kind === 'project') {
        return stop(row.bg(t.chrome).cursor_pointer().on_click((_e, cx) => this.toggle(r.key, true, cx))
          .child(label.child(caret(r.open, t)).child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(r.title || r.key))
            .when(r.total > 0, el => el.child(meter(r.done, r.total, t))))
          .child(lane().when(r.empty, el => el.child(div().absolute().top(0).bottom(0).left(10).flex().items_center().text_size(11).text_color(t.muted)
            .child(r.read ? '이번 주 배정 이슈 없음' : '읽지 못함')))));
      }
      if (r.kind === 'epic') {
        const c = t[r.color] || t.accent;
        return stop(row.cursor_pointer().hover(el => el.bg(t.surface))
          .tooltip(`${r.key} ${r.title || ''}\n눌러서 이슈 보기 · ▶ 접기·펴기`)
          .on_click((_e, cx) => { cx.stop_propagation(); this.openIssue(r); })
          .child(label.child(stop(div().id(`wt-c-${n}`).cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); this.toggle(r.id, true, cx); }).child(caret(r.open, t))))
            .child(div().size(12).flex_none().rounded(3).bg(c))
            .child(div().flex_none().text_size(11).text_color(t.muted).child(r.key))
            .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(r.title || '상위 이슈'))
            .child(meter(r.done, r.total, t)))
          .child(lane()));
      }
      const c = t[KIND[r.look].token] || t.muted, mark = r.marker;
      const marks = lane();
      if (mark?.edge === 'future') marks.child(div().absolute().top(0).bottom(0).right(12).flex().items_center().text_size(10).text_color(c).child(mark.label));
      else if (mark) marks.child(h_flex().id(`wt-mark-${r.key}`).absolute().top(0).bottom(0).left(pct(mark.at / D * 100)).w(pct(100 / D)).px(6).gap(4).items_center()
        .child(div().text_size(11).text_color(c).child('◆'))
        .when(r.state === 'started', el => el.child(div().size(4).rounded(2).bg(t.working)))
        .when(Boolean(mark.label), el => el.child(div().text_size(10).text_color(c).child(mark.label))));
      return stop(row.cursor_pointer().hover(el => el.bg(t.surface))
        .tooltip(`${r.key} ${r.title}\n${r.status}${r.due ? ` · 마감 ${r.due}` : r.when ? ` · 마일스톤 목표 ${r.when}` : ''}\n눌러서 이슈 보기`)
        .on_click((_e, cx) => { cx.stop_propagation(); this.openIssue(r); })
        .child(label.child(div().flex_none().text_size(11).text_color(t.muted).child(r.key))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(r.title))
          .child(lozenge(r.look, t)))
        .child(marks));
    });
    const grid = h_flex().absolute().inset_0()
      .child(div().w(LABEL).flex_none())
      .child(div().flex_1().h_full().relative()
        .children(cells.map((c, i) => div().absolute().top(0).bottom(0).left(pct(i / D * 100)).w(pct(100 / D)).when(i > 0, el => el.border_l(1).border_color(rule))
          .when(c.weekend, el => el.bg(weekend))))
        .when(todayAt >= 0 && todayAt < D, el => el.child(div().absolute().top(0).bottom(0).left(pct((todayAt + hour / 24) / D * 100)).w(2).ml(-1).bg(t.blocked).opacity(0.7))));
    const empty = !this.feed ? (this.note || (this.loaded ? '아직 수집된 내용이 없습니다' : '…')) : '';
    const content = empty
      ? div().flex_1().flex().items_center().justify_center().text_size(12).text_color(t.muted).child(empty)
      : div().id('wt-body').flex_1().min_h(0).overflow_y_scrollbar()
        .child(div().relative().h(rows.length * ROW).child(grid).child(v_flex().absolute().inset_0().children(body)));
    return v_flex().id('wt-week').size_full().bg(t.background).text_color(t.foreground).border_b(1).border_color(t.border)
      .child(bar).child(head).child(content);
  }

  // --- B ------------------------------------------------------------------------------------------
  renderFull() {
    const t = theme(), today = isoDay(), LABEL = 440, ROW = 28;
    const projects = this.feed?.projects ?? [];
    const project = projects.find(p => p.key === this.project) || projects[0] || null;
    const { range, rows } = projectRows(project, { today, open: this.open, undated: this.undated });
    const S = range.span, at = d => d / S * 100, todayAt = daysBetween(range.start, today);
    const close = () => { const id = props()?.overlay; if (id) closeOverlay(id); };
    const head = h_flex().flex_none().h(36).items_center().gap(10).px(12).bg(t.chrome).border_b(1).border_color(t.border).text_size(12)
      .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child('프로젝트 타임라인'))
      .child(div().flex_none().text_color(t.muted).child(`마일스톤별 · Linear 담당 이슈 · ${md(range.start)} – ${md(range.end)}`))
      .child(div().flex_none().w(1).h(14).bg(t.border))
      .children(projects.map(p => pill(`wt-p-${p.key}`, p.workspace || p.key, project?.key === p.key, t, cx => { this.project = p.key; cx.notify(); })))
      .child(pill('wt-undated', '날짜 없는 이슈 보기', this.undated, t, cx => { this.undated = !this.undated; cx.notify(); }))
      .child(div().flex_1())
      .child(legend(t, ['todo', 'started', 'review', 'done', 'milestone']))
      .child(status(this.feed, t))
      .child(stop(div().id('wt-fold').flex_none().text_size(11).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { cx.stop_propagation(); close(); }).child('이번 주로 접기')));
    const scale = h_flex().flex_none().border_b(1).border_color(t.border).text_size(11).text_color(t.muted)
      .child(div().w(LABEL).flex_none().px(12).pb(4).flex().items_end().border_r(1).border_color(t.border).child('마일스톤 · 이슈'))
      .child(v_flex().flex_1()
        .child(h_flex().h(20).children(range.months.map(m => div().h_full().w(pct(m.days / S * 100)).pl(6).flex().items_center()
          .border_l(1).border_color(t.border).text_color(t.foreground).font_semibold().overflow_hidden().child(m.days >= 7 ? m.label : ''))))
        .child(h_flex().h(18).border_t(1).border_color(t.surface || t.border).children(range.weeks.map(w => div().h_full().flex_1().pl(4).flex().items_center()
          .border_l(1).border_color(t.surface || t.border).text_size(10).bg(w.now ? t.surface : t.background).text_color(w.now ? t.blocked : t.muted).child(w.label)))));
    const lane = () => div().flex_1().h_full().relative();
    const tag = (left, text, color) => div().absolute().top(0).bottom(0).left(pct(left)).pl(10).flex().items_center().text_size(10).text_color(color).whitespace_nowrap().child(text);
    const diamond = (left, color) => div().absolute().top(6).left(pct(left)).ml(-6).text_size(12).text_color(color).child('◆');
    const body = rows.map((r, n) => {
      const label = h_flex().w(LABEL).flex_none().h_full().items_center().gap(6).pl(r.kind === 'project' ? 8 : r.kind === 'milestone' ? 24 : 50).pr(10)
        .border_r(1).border_color(t.border).overflow_hidden();
      const row = h_flex().id(`wt-b-${n}`).h(ROW).flex_none().border_b(1).border_color(t.surface || t.border);
      if (r.kind === 'project') {
        if (r.empty) return row.bg(t.chrome).child(label.child(div().font_semibold().text_color(t.foreground).child(r.title)))
          .child(lane().child(div().absolute().top(0).bottom(0).left(10).flex().items_center().text_size(11).text_color(t.muted)
            .child(`Linear 에 ${r.title} 마일스톤·담당 이슈가 아직 없습니다`)));
        const end = r.to == null ? S : r.to + 1;
        return row.bg(t.chrome).child(label.child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(r.title)))
          .child(lane().child(div().absolute().top(10).h(8).left(pct(at(r.from))).w(pct(at(end - r.from))).rounded(4).bg(mix(t.accent, t.background, 0.8)).border(1).border_color(t.accent))
            .child(tag(at(end), r.label, t.muted)));
      }
      if (r.kind === 'milestone') {
        const c = r.done ? t.done : (t.ansi3 || t.accent);
        const line = lane();
        if (r.to != null) {
          const from = Math.max(0, r.from ?? 0), width = Math.max(0.5, at(r.to + 1 - from));
          line.child(div().absolute().top(10).h(8).left(pct(at(from))).w(pct(width)).rounded(4).bg(t.raised || t.surface).border(1).border_color(t.border).overflow_hidden()
            .child(div().h_full().w(pct(r.progress ?? 0)).bg(t.done)))
            .child(diamond(at(r.to + 0.5), c)).child(tag(at(r.to + 0.5), r.label, c));
        }
        return stop(row.cursor_pointer().hover(el => el.bg(t.surface)).on_click((_e, cx) => { if (r.has) this.toggle(r.id, r.open, cx); })
          .child(label.child(r.has ? caret(r.open, t) : div().w(14).flex_none()).child(div().flex_none().text_size(10).text_color(c).child('◆'))
            .child(div().flex_1().min_w(0).truncate().text_color(r.done ? t.muted : t.foreground).child(r.title))
            .when(r.progress != null, el => el.child(h_flex().flex_none().items_center().gap(5).text_size(10).text_color(t.muted)
              .child(div().w(44).h(4).rounded(2).bg(t.raised || t.border).overflow_hidden().child(div().h_full().w(pct(r.progress)).bg(t.done)))
              .child(`${Math.round(r.progress)}%`))))
          .child(line));
      }
      if (r.kind === 'undated') {
        return row.child(label.child(div().text_size(11).text_color(t.muted).child(r.shown ? `날짜 없는 이슈 ${r.count}건` : `날짜 없는 이슈 ${r.count}건 숨김`)))
          .child(lane().when(r.shown, el => el.child(div().absolute().top(0).bottom(0).left(10).right(10).flex().items_center().text_size(10).text_color(t.muted)
            .overflow_hidden().whitespace_nowrap().child(r.items.map(i => i.key).join(' · ')))));
      }
      const c = t[KIND[r.look].token] || t.muted;
      const line = lane();
      if (r.bar) line.child(div().absolute().top(8).h(12).left(pct(at(Math.max(0, r.bar.from)))).w(pct(Math.max(0.4, at(r.bar.to - Math.max(0, r.bar.from) + 1)))).rounded(4).bg(c))
        .child(tag(at(r.bar.to + 1), r.label, t.muted));
      else line.child(diamond(at(r.diamond + 0.5), c)).child(tag(at(r.diamond + 0.5), r.label, t.muted));
      return stop(row.cursor_pointer().hover(el => el.bg(t.surface))
        .tooltip(`${r.key} ${r.title}\n${r.status}${r.start ? ` · 시작 ${r.start}` : ''}${r.due ? ` · 마감 ${r.due}` : ''}\n눌러서 이슈 보기`)
        .on_click((_e, cx) => { cx.stop_propagation(); this.openIssue(r); })
        .child(label.child(div().flex_none().text_size(11).text_color(t.muted).child(r.key))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(r.title)).child(lozenge(r.look, t)))
        .child(line));
    });
    const grid = h_flex().absolute().inset_0().child(div().w(LABEL).flex_none())
      .child(div().flex_1().h_full().relative()
        .children(range.weeks.map((_w, i) => div().absolute().top(0).bottom(0).left(pct(i * 7 / S * 100)).w(1).bg(t.surface || t.border)))
        .when(todayAt >= 0 && todayAt < S, el => el.child(div().absolute().top(0).bottom(0).left(pct(at(todayAt + 0.5))).w(2).ml(-1).bg(t.blocked).opacity(0.75))));
    const content = !this.feed
      ? div().flex_1().flex().items_center().justify_center().text_color(t.muted).child('아직 수집된 내용이 없습니다')
      : div().id('wt-full-body').flex_1().min_h(0).overflow_y_scroll()
        .child(div().relative().h(rows.length * ROW).child(grid).child(v_flex().absolute().inset_0().children(body)));
    return v_flex().id('wt-full').size_full().bg(t.background).text_color(t.foreground).text_size(12)
      .child(head).child(scale).child(content);
  }
}
