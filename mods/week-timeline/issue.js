import { div } from 'gpui-kit';
import { h_flex, v_flex, InputState, Input, TextareaState, Textarea } from 'gpui-base';
import { appHome, exec, readTextFile, writeTextFile, theme, props, run, closeOverlay } from 'herdr';
import { bridgeFrom, mix, md } from './model.js';
import { parseDetail, splitDescription, threads, addChange, removeChange, effective, describeChange, requestOf, parseApply, newId,
  breadcrumb, related, relationLabel, when, isKey } from './detail.js';

// C: the issue popup — a panel on the right over the panes, the rest dimmed. Shows the issue
// (요약·댓글·알림) and collects changes; nothing is written until [Linear 에 반영] is pressed,
// and then only by the separate apply command (bridge `apply`), for this one issue.
const DIR = 'data/sixfold/week-timeline-issues';
const BRIDGE = 'data/sixfold/week-timeline-bridge.json';
const FRESH_MS = 5 * 60 * 1000;
const READ_TIMEOUT = 6 * 60 * 1000;
const APPLY_TIMEOUT = 8 * 60 * 1000;
const WIDTH = 680;

const stop = el => el.on_mouse_down('left', (_e, cx) => cx.stop_propagation());
const path = (key, suffix = '') => `${appHome()}/${DIR}/${key}${suffix}.json`;
const today = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const plusDays = (iso, n) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

function button(id, label, t, onClick, { primary = false, danger = false, disabled = false } = {}) {
  const c = danger ? t.blocked : t.accent;
  return stop(div().id(id).flex_none().h(26).px(12).rounded(6).flex().items_center().text_size(12)
    .border(1).border_color(primary ? c : t.border).bg(primary ? c : t.chrome)
    .text_color(primary ? t.canvas : disabled ? t.dim : t.foreground).when(primary, el => el.font_semibold())
    .when(!disabled, el => el.cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }))
    .when(disabled, el => el.opacity(0.6)).child(label));
}
function chip(id, label, t, onClick, { open = false, dot = null, changed = false } = {}) {
  return stop(div().id(id).flex_none().h(24).px(9).rounded(6).flex().items_center().gap(6).text_size(12).cursor_pointer()
    .border(1).border_color(changed ? t.ansi3 || t.accent : open ? t.accent : t.border).bg(open ? t.selected : t.chrome)
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
    .when(Boolean(dot), el => el.child(div().size(8).rounded(4).bg(dot)))
    .child(label).child(div().text_size(9).text_color(t.muted).child('▾')));
}
const card = t => v_flex().gap(6).p(10).rounded(8).border(1).border_color(t.border).bg(t.surface || t.chrome);
const tag = (label, color, t) => div().flex_none().px(6).h(18).rounded(4).flex().items_center().text_size(10).font_semibold()
  .bg(mix(color, t.background, 0.75)).text_color(mix(color, t.foreground, 0.3)).child(label);

export function initIssue(v, p, cx) {
  v.key = isKey(p.issue) ? p.issue : '';
  v.row = p.row && typeof p.row === 'object' ? p.row : {};
  v.detail = null; v.pending = []; v.tab = ['comments', 'notices'].includes(p.tab) ? p.tab : 'summary'; v.menu = null; v.replyTo = '';
  v.reading = false; v.applying = false; v.result = null; v.message = ''; v.carried = false;
  v.dueInput = InputState.new({ placeholder: 'YYYY-MM-DD' });
  v.whoInput = InputState.new({ placeholder: '이름 또는 이메일' });
  v.replyInput = TextareaState.new({ placeholder: '댓글을 쓰고 [담기]를 누르면 반영 목록에 들어갑니다', rows: 3 });
  loadDetail(v, cx, true);
  loadCarried(v, cx);
  v.timers.push(cx.timer.every(3000, cx => { if (v.reading) loadDetail(v, cx, false); }));
}

function loadDetail(v, cx, maybeRead) {
  if (!v.key) return;
  cx.spawn(async cx => {
    const detail = parseDetail(await readTextFile(path(v.key)).catch(() => null), v.key);
    if (v.closed) return;
    if (detail && JSON.stringify(detail) !== JSON.stringify(v.detail)) { v.detail = detail; cx.notify(); }
    const age = detail?.readAt ? Date.now() - new Date(detail.readAt).getTime() : Infinity;
    if (maybeRead && (!detail?.issue || detail.stale || !(age < FRESH_MS))) readDetail(v, cx, false);
  });
}

// Changes a failed apply left behind come back as pending.
function loadCarried(v, cx) {
  cx.spawn(async cx => {
    let request = null;
    try { request = JSON.parse(await readTextFile(path(v.key, '.request')).catch(() => null) || 'null'); } catch { request = null; }
    if (v.closed || !request || request.key !== v.key || !Array.isArray(request.changes) || !request.changes.length) return;
    v.pending = request.changes.filter(c => c && typeof c.kind === 'string');
    v.carried = true; cx.notify();
  });
}

// Keeps a left-behind request file in step with the popup, so a cancelled or removed change does
// not come back on reopen. Only touches the file when one is there (a failed apply wrote it).
// Each save and each apply takes a new generation; a save whose read finishes after a newer one
// started is dropped, and the write itself only lands on the file it read (expected snapshot).
function persist(v, cx) {
  const key = v.key, pending = v.pending, gen = (v.gen = (v.gen || 0) + 1);
  cx.spawn(async () => {
    const target = path(key, '.request');
    const before = await readTextFile(target).catch(() => null);
    if (before == null || v.gen !== gen) return;
    await writeTextFile(target, JSON.stringify(requestOf(key, newId(), pending)), before).catch(() => {
      v.message = '남은 변경 파일을 갱신하지 못함 — 다시 열면 지난 변경이 보일 수 있음';
    });
  });
}

function removeAt(v, index, cx) {
  if (v.applying) return;
  v.pending = removeChange(v.pending, index); persist(v, cx); cx.notify();
}

function cancelAll(v, cx) {
  if (v.applying) return;
  v.pending = []; v.carried = false; v.message = ''; persist(v, cx); cx.notify();
}

function readDetail(v, cx, force) {
  if (v.reading) return;
  v.reading = true; v.message = ''; cx.notify();
  cx.spawn(async cx => {
    try {
      const bridge = bridgeFrom(await readTextFile(`${appHome()}/${BRIDGE}`).catch(() => null));
      if (!bridge) { v.message = '수집기 미설정 — 상세를 읽을 수 없음'; return; }
      const result = await exec(bridge.command, [...bridge.args, '--detail', v.key, ...(force ? ['--force'] : [])], { timeout: READ_TIMEOUT });
      if (result.code !== 0) v.message = `상세 읽기 종료 코드 ${result.code}`;
    } catch (error) {
      v.message = String(error?.message || error).slice(0, 100);
    } finally {
      v.reading = false;
      if (!v.closed) { loadDetail(v, cx, false); cx.notify(); }
    }
  });
}

function stage(v, change, cx) {
  if (!v.detail?.issue || v.applying) return;
  v.pending = addChange(v.pending, change, v.detail.issue); v.result = null; v.menu = null;
  if (v.carried) persist(v, cx);
  cx.notify();
}

function applyNow(v, cx) {
  if (v.applying || !v.pending.length) return;
  v.applying = true; v.message = ''; v.result = null; cx.notify();
  const gen = (v.gen = (v.gen || 0) + 1);   // older saves still in flight now drop out
  cx.spawn(async cx => {
    try {
      const bridge = bridgeFrom(await readTextFile(`${appHome()}/${BRIDGE}`).catch(() => null));
      if (!bridge?.apply) { v.message = '반영 도구 미설정(week-timeline-bridge.json 의 apply)'; return; }
      const target = path(v.key, '.request');
      const before = await readTextFile(target).catch(() => null);
      if (v.gen !== gen) { v.message = '반영 준비 중 변경이 바뀜 — 다시 눌러 주세요'; return; }
      const id = newId();
      await writeTextFile(target, JSON.stringify(requestOf(v.key, id, v.pending)), before);
      v.carried = true;   // the file is there now: later cancels and removals keep it in step
      const done = await exec(bridge.apply.command, [...bridge.apply.args, '--key', v.key, '--request', id], { timeout: APPLY_TIMEOUT });
      const result = parseApply(await readTextFile(path(v.key, '.apply')).catch(() => null), v.key);
      // Only the result that names this request counts; an older one (any time zone) is not this apply's.
      if (!result || result.request !== id) { v.message = `반영 결과 없음(종료 코드 ${done.code}) — 변경은 그대로 둠`; return; }
      v.result = result;
      if (result.mismatch) { v.message = result.error || '반영 요청이 바뀜 — 보내지 않음'; return; }
      v.pending = result.ok ? [] : result.kept;
      v.carried = !result.ok;
      if (!result.ok) v.message = result.error || '일부 변경이 Linear 에서 확인되지 않음';
    } catch (error) {
      v.message = `반영 실패: ${String(error?.message || error).slice(0, 100)} — 변경은 그대로 둠`;
    } finally {
      v.applying = false;
      if (!v.closed) { loadDetail(v, cx, false); cx.notify(); }
    }
  });
}

// Linear markdown → plain text: emphasis, code and link marks and inline tags (`<issue …>KEY</issue>`) dropped.
const plain = text => text.replace(/<issue[^>]*label="([^"]+)"[^>]*?(?:\/>|>.*?<\/issue>)/g, '$1').replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/<[^>]+>/g, '').trim();

// Markdown lines → short paragraphs: headings and bullets kept, emphasis/code/link marks dropped.
function paragraphs(lines) {
  const out = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim() || /^[-*_]{3,}$/.test(line.trim()) || /^\+\+\+/.test(line.trim())) continue;
    if (/^\|?[\s:|-]+\|?$/.test(line.trim()) && line.includes('-')) continue;   // a table's separator row
    if (/^\|.*\|$/.test(line.trim())) { out.push({ text: plain(line.trim().slice(1, -1).split('|').map(c => c.trim()).filter(Boolean).join(' · ')), heading: false, bullet: true }); continue; }
    const h = /^#{1,6}\s+(.*)$/.exec(line.trim()), b = /^\s*[-*+]\s+(.*)$/.exec(line), n = /^\s*\d+[.)]\s+/.test(line);
    const bold = /^\*\*[^*]+\*\*:?$/.test(line.trim());
    out.push({ text: plain(h ? h[1] : b ? b[1] : line), heading: Boolean(h) || bold, bullet: Boolean(b) || n });
  }
  return out.filter(p => p.text).slice(0, 120);
}

function closeIssue() { const id = props()?.overlay; if (id) closeOverlay(id); }

export function renderIssue(v) {
  const t = theme();
  const d = v.detail, i = d?.issue, row = v.row;
  const shown = i ? effective(i, v.pending) : null;
  const changed = kind => v.pending.some(c => c.kind === kind);
  const statusColor = name => {
    const s = d?.statuses.find(s => s.name === name);
    return s?.color || ({ completed: t.done, started: t.working, canceled: t.dim }[s?.type] ?? t.idle);
  };
  const crumbs = breadcrumb(d, row);
  // A failed re-read keeps the last copy: `attempted` is newer than `read_at` then.
  const failed = Boolean(d?.error) && (!d.readAt || d.attempted > d.readAt);
  const head = h_flex().flex_none().h(44).px(14).gap(6).items_center().border_b(1).border_color(t.border).text_size(12).text_color(t.muted)
    .child(h_flex().flex_1().min_w(0).gap(6).items_center().overflow_hidden()
      .children(crumbs.flatMap((c, n) => [n ? div().flex_none().text_color(t.dim).child('›') : null,
        div().min_w(0).truncate().when(n === crumbs.length - 1, el => el.flex_none().text_color(t.foreground).font_semibold()).child(c)].filter(Boolean))))
    .child(div().id('wi-fresh').flex_none().text_size(10).text_color(failed ? t.blocked : t.dim)
      .when(Boolean(d?.error), el => el.tooltip(d.error))
      .child(v.reading ? '읽는 중…' : failed ? `읽기 실패 ${when(d.attempted)}` : d?.readAt ? `읽음 ${when(d.readAt)}${d.error ? ' · 일부 못 읽음' : ''}` : ''))
    .child(button('wi-reread', '다시 읽기', t, cx => readDetail(v, cx, true), { disabled: v.reading }))
    .when(Boolean(i?.url || row.url), el => el.child(button('wi-web', 'Linear 웹 ↗', t, cx => {
      const url = i?.url || row.url;
      if (/^https:\/\/linear\.app\//.test(url)) cx.spawn(async () => { await exec('open', [url]); });
    })))
    .child(stop(div().id('wi-close').flex_none().size(26).rounded(6).flex().items_center().justify_center().text_size(14).cursor_pointer()
      .hover(el => el.bg(t.surface)).on_click((_e, cx) => { cx.stop_propagation(); closeIssue(); }).child('✕')));

  const title = v_flex().flex_none().px(16).pt(12).pb(8).gap(4)
    .child(div().text_size(17).font_semibold().text_color(t.foreground).child(i?.title || row.title || v.key))
    .when(Boolean(v.message), el => el.child(div().text_size(11).text_color(t.blocked).child(v.message)))
    .when(!i && !v.reading && Boolean(d?.error), el => el.child(div().text_size(11).text_color(t.blocked).child(d.error)));

  if (!i) {
    return frame(v, t, v_flex().size_full().child(head).child(title)
      .child(div().flex_1().flex().items_center().justify_center().text_size(12).text_color(t.muted)
        .child(v.reading ? 'Linear 에서 이 이슈를 읽는 중…' : '상세를 아직 읽지 못했습니다 — [다시 읽기]')));
  }

  const period = `${i.start ? `시작 ${md(i.start)}` : '시작 전'} · ${shown.due ? `마감 ${md(shown.due)}` : '마감 없음'}`;
  const chips = h_flex().flex_none().px(16).pb(8).gap(6).flex_wrap().items_center()
    .child(chip('wi-m-status', shown.status || '상태', t, cx => { v.menu = v.menu === 'status' ? null : 'status'; cx.notify(); },
      { open: v.menu === 'status', dot: statusColor(shown.status), changed: changed('status') }))
    .child(chip('wi-m-who', `담당 ${shown.assignee || '없음'}`, t, cx => { v.menu = v.menu === 'who' ? null : 'who'; cx.notify(); },
      { open: v.menu === 'who', changed: changed('assignee') }))
    .child(chip('wi-m-due', period, t, cx => { v.menu = v.menu === 'due' ? null : 'due'; cx.notify(); }, { open: v.menu === 'due', changed: changed('due') }))
    .child(chip('wi-m-label', shown.labels.length ? shown.labels.join(', ') : '라벨', t, cx => { v.menu = v.menu === 'label' ? null : 'label'; cx.notify(); },
      { open: v.menu === 'label', changed: changed('label') }))
    .when(Boolean(i.milestone), el => el.child(div().flex_none().text_size(11).text_color(t.muted).child(`◆ ${i.milestone}`)));

  const pick = (id, label, active, onClick, color) => stop(div().id(id).flex_none().h(24).px(10).rounded(12).flex().items_center().gap(6).text_size(12)
    .cursor_pointer().border(1).border_color(active ? t.accent : t.border).bg(active ? t.selected : t.chrome)
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
    .when(Boolean(color), el => el.child(div().size(8).rounded(4).bg(color))).child(label));
  let menu = null;
  if (v.menu === 'status') {
    menu = h_flex().gap(6).flex_wrap().children(d.statuses.map((s, n) => pick(`wi-s-${n}`, s.name, s.name === shown.status,
      cx => stage(v, { kind: 'status', to: s.name }, cx), s.color || statusColor(s.name))));
  } else if (v.menu === 'who') {
    menu = h_flex().gap(6).items_center()
      .child(pick('wi-w-me', '나', shown.assignee === '나', cx => stage(v, { kind: 'assignee', to: 'me' }, cx)))
      .child(pick('wi-w-none', '없음', !shown.assignee, cx => stage(v, { kind: 'assignee', to: null }, cx)))
      .child(div().w(200).child(Input.new(v.whoInput)))
      .child(button('wi-w-set', '담기', t, cx => { const who = v.whoInput.value().trim(); if (who) { stage(v, { kind: 'assignee', to: who.slice(0, 80) }, cx); v.whoInput.set_value(''); } }));
  } else if (v.menu === 'due') {
    const now = today(), friday = plusDays(now, (5 - new Date(`${now}T12:00:00`).getDay() + 7) % 7);
    menu = h_flex().gap(6).items_center().flex_wrap()
      .child(div().text_size(11).text_color(t.muted).child('마감'))
      .child(pick('wi-d-today', `오늘 ${md(now)}`, shown.due === now, cx => stage(v, { kind: 'due', to: now }, cx)))
      .child(pick('wi-d-fri', `금 ${md(friday)}`, shown.due === friday, cx => stage(v, { kind: 'due', to: friday }, cx)))
      .child(pick('wi-d-week', '+1주', false, cx => stage(v, { kind: 'due', to: plusDays(shown.due || now, 7) }, cx)))
      .child(pick('wi-d-none', '없음', !shown.due, cx => stage(v, { kind: 'due', to: null }, cx)))
      .child(div().w(130).child(Input.new(v.dueInput)))
      .child(button('wi-d-set', '담기', t, cx => {
        const value = v.dueInput.value().trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(value).getTime())) { stage(v, { kind: 'due', to: value }, cx); v.dueInput.set_value(''); }
        else { v.message = '날짜는 YYYY-MM-DD 로 적습니다'; cx.notify(); }
      }))
      .child(div().text_size(10).text_color(t.dim).child('시작일은 Linear 가 상태로 정합니다'));
  } else if (v.menu === 'label') {
    menu = h_flex().gap(6).flex_wrap().children(d.labels.map((l, n) => pick(`wi-l-${n}`, l.name, shown.labels.includes(l.name),
      cx => stage(v, { kind: 'label', name: l.name }, cx), l.color || null)));
  }

  const tabs = h_flex().flex_none().px(16).gap(18).border_b(1).border_color(t.border).text_size(12)
    .children([['summary', '요약'], ['comments', `댓글 ${d.comments.length}`], ['notices', `알림 ${d.notices.length + d.slack.length}`]].map(([id, label]) =>
      stop(div().id(`wi-t-${id}`).h(32).flex().items_center().cursor_pointer().border_b(2).border_color(v.tab === id ? t.accent : t.background)
        .text_color(v.tab === id ? t.foreground : t.muted).when(v.tab === id, el => el.font_semibold())
        .on_click((_e, cx) => { cx.stop_propagation(); v.tab = id; cx.notify(); }).child(label))));

  const foot = footer(v, t);
  const body = v.tab === 'comments' ? comments(v, t, d) : v.tab === 'notices' ? notices(t, d) : summary(v, t, d, shown);
  return frame(v, t, v_flex().size_full()
    .child(head).child(title).child(chips)
    .when(Boolean(menu), el => el.child(div().flex_none().mx(16).mb(8).p(8).rounded(8).border(1).border_color(t.border).bg(t.canvas).child(menu)))
    .child(tabs)
    .child(div().id('wi-body').flex_1().min_h(0).overflow_y_scroll().child(v_flex().p(16).gap(14).children(body)))
    .when(Boolean(foot), el => el.child(foot)));
}

function frame(v, t, panel) {
  return h_flex().id('wi-root').size_full()
    .child(div().id('wi-dim').flex_1().h_full().bg(t.canvas).opacity(0.55).on_click(() => closeIssue()))
    .child(stop(v_flex().flex_none().w(WIDTH).h_full().py(32).pr(32)
      .child(div().size_full().rounded(10).border(1).border_color(t.border).bg(t.background).shadow_lg().overflow_hidden().text_color(t.foreground).child(panel))));
}

function summary(v, t, d, shown) {
  const i = d.issue, lines = splitDescription(i.description);
  const prose = lines.filter(l => l.kind === 'text');
  const checks = lines.filter(l => l.kind === 'check');
  const out = [];
  const paras = paragraphs(prose.map(l => l.text));
  out.push(v_flex().gap(6).child(div().text_size(11).font_semibold().text_color(t.muted).child('설명'))
    .when(!paras.length, el => el.child(div().text_size(12).text_color(t.dim).child('설명 없음')))
    .children(paras.map(p => p.heading
      ? div().pt(4).text_size(12).font_semibold().text_color(t.foreground).child(p.text)
      : div().text_size(12).whitespace_normal().text_color(t.foreground).when(p.bullet, el => el.pl(12)).child(p.bullet ? `• ${p.text}` : p.text))));
  if (checks.length) {
    const doneCount = checks.filter(c => shown.checks[c.line] ?? c.done).length;
    out.push(v_flex().gap(2)
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(`할 일 ${doneCount}/${checks.length}`))
      .children(checks.map((c, n) => {
        const done = shown.checks[c.line] ?? c.done, moved = c.line in shown.checks;
        return stop(h_flex().id(`wi-c-${n}`).min_h(26).px(6).gap(8).items_center().rounded(6).cursor_pointer().hover(el => el.bg(t.surface))
          .on_click((_e, cx) => { cx.stop_propagation(); stage(v, { kind: 'check', line: c.line, done: !done }, cx); })
          .child(div().flex_none().size(14).rounded(3).border(1).border_color(done ? t.done : t.muted).bg(done ? t.done : t.background)
            .flex().items_center().justify_center().text_size(10).text_color(t.canvas).child(done ? '✓' : ''))
          .child(div().flex_1().min_w(0).text_size(12).whitespace_normal().text_color(done ? t.muted : t.foreground).child(plain(c.text)))
          .when(moved, el => el.child(tag('바뀜', t.ansi3 || t.accent, t))));
      })));
  }
  const rel = related(i);
  if (rel.length) {
    out.push(v_flex().gap(6).child(div().text_size(11).font_semibold().text_color(t.muted).child('관련 이슈'))
      .child(h_flex().gap(6).flex_wrap().children(rel.map((r, n) => stop(h_flex().id(`wi-r-${n}`).h(24).px(8).gap(6).items_center().rounded(6)
        .border(1).border_color(/block/i.test(r.type) ? t.blocked : t.border).bg(t.chrome).cursor_pointer().text_size(11)
        .tooltip(`${r.key} ${r.title}\n${r.status} · 눌러서 이 이슈 보기`)
        .on_click((_e, cx) => { cx.stop_propagation(); switchTo(v, r.key, cx); })
        .child(div().text_color(t.muted).child(relationLabel(r.type))).child(div().font_semibold().child(r.key))
        .child(div().max_w(180).truncate().child(r.title)).child(div().text_color(t.muted).child(r.status)))))));
  }
  const box = card(t).child(div().text_size(11).font_semibold().text_color(t.muted).child('Herdr 작업 연결'));
  if (!d.herdr.length) box.child(div().text_size(12).text_color(t.dim).child(`하네스 기록에 ${i.key} 가 들어간 작업이 없습니다`));
  d.herdr.forEach((h, n) => box.child(v_flex().gap(3).pt(n ? 6 : 0).when(n > 0, el => el.border_t(1).border_color(t.border))
    .child(h_flex().gap(6).items_center()
      .child(tag(h.kind === 'final' ? '완료 보고' : h.kind === 'progress' ? '진행 보고' : '작업', h.kind === 'final' ? t.done : t.working, t))
      .child(div().flex_1().min_w(0).truncate().text_size(12).child(h.title || h.task))
      .child(div().flex_none().text_size(10).text_color(t.dim).child(when(h.at))))
    .when(Boolean(h.done), el => el.child(div().text_size(11).text_color(t.muted).whitespace_normal().child(h.done)))
    .when(Boolean(h.remaining), el => el.child(div().text_size(11).text_color(t.ansi3 || t.muted).child(`남은 것: ${h.remaining}`)))
    .when(Boolean(h.terminal), el => el.child(h_flex().child(button(`wi-go-${n}`, '관련 작업 칸으로 이동', t, () => {
      run('agent.focus', { terminal: h.terminal });
      closeIssue();
    }))))));
  out.push(box);
  return out;
}

function switchTo(v, key, cx) {
  if (!isKey(key) || key === v.key) return;
  if (v.pending.length) { v.message = '반영하지 않은 변경이 있어 다른 이슈로 넘어가지 않습니다'; cx.notify(); return; }
  v.key = key; v.row = { key }; v.detail = null; v.tab = 'summary'; v.menu = null; v.result = null; v.message = ''; v.replyTo = '';
  loadDetail(v, cx, true); loadCarried(v, cx); cx.notify();
}

function comments(v, t, d) {
  const out = [];
  const list = threads(d.comments);
  if (!list.length) out.push(div().text_size(12).text_color(t.dim).child('댓글 없음'));
  const one = (c, reply) => v_flex().gap(4).when(reply, el => el.ml(22).pl(10).border_l(2).border_color(t.border))
    .child(h_flex().gap(6).items_center()
      .child(div().flex_none().size(18).rounded(9).bg(mix(t.accent, t.background, 0.6)).flex().items_center().justify_center().text_size(10).font_semibold()
        .child((c.author || '?').slice(0, 1)))
      .child(div().text_size(12).font_semibold().child(c.author || '알 수 없음'))
      .child(div().text_size(10).text_color(t.dim).child(when(c.at))))
    .children(paragraphs(c.body.split('\n')).map(p => div().pl(24).text_size(12).whitespace_normal().when(p.heading, el => el.font_semibold()).child(p.bullet ? `• ${p.text}` : p.text)));
  list.forEach((c, n) => out.push(card(t).child(one(c, false)).children(c.replies.map(r => one(r, true)))
    .child(h_flex().pl(24).child(stop(div().id(`wi-re-${n}`).text_size(11).text_color(v.replyTo === c.id ? t.accent : t.muted).cursor_pointer()
      .on_click((_e, cx) => { cx.stop_propagation(); v.replyTo = v.replyTo === c.id ? '' : c.id; cx.notify(); })
      .child(v.replyTo === c.id ? '이 스레드에 답글 다는 중 · 취소' : '답글'))))));
  const target = d.comments.find(c => c.id === v.replyTo);
  out.push(v_flex().gap(6)
    .child(div().text_size(11).text_color(t.muted).child(target ? `${target.author} 의 스레드에 답글` : '새 댓글'))
    .child(div().rounded(6).border(1).border_color(t.border).child(Textarea.new(v.replyInput)))
    .child(h_flex().justify_end().child(button('wi-reply', target ? '답글 담기' : '댓글 담기', t, cx => {
      const body = v.replyInput.value().trim();
      if (!body) return;
      stage(v, { kind: 'reply', parent: v.replyTo, body: body.slice(0, 8000) }, cx);
      v.replyInput.set_value(''); v.replyTo = '';
    }))));
  return out;
}

function notices(t, d) {
  const out = [];
  if (!d.notices.length && !d.slack.length) out.push(div().text_size(12).text_color(t.dim).child('이 이슈의 알림 없음'));
  d.notices.forEach(n => out.push(card(t).child(h_flex().gap(6).items_center().child(tag('Linear', t.accent, t))
    .child(div().flex_1().text_size(11).text_color(t.muted).child(n.type)).child(div().text_size(10).text_color(t.dim).child(`${when(n.at)}${n.read ? ' · 읽음' : ''}`)))
    .child(div().text_size(12).whitespace_normal().child(n.text))));
  d.slack.forEach(s => out.push(card(t).child(h_flex().gap(6).items_center().child(tag('Slack', t.ansi5 || t.accent, t))
    .child(div().flex_1().text_size(11).text_color(t.muted).child(s.channel)).child(div().text_size(10).text_color(t.dim).child(when(s.at) || s.at)))
    .child(div().text_size(12).whitespace_normal().child(s.text))));
  if (!d.slackReady) out.push(div().text_size(11).text_color(t.dim).child('Slack 언급: Slack 읽기 연결을 찾지 못해 미확인'));
  return out;
}

function footer(v, t) {
  if (v.pending.length) {
    return v_flex().flex_none().border_t(1).border_color(t.border).bg(t.chrome).px(14).py(10).gap(6)
      .child(v_flex().gap(2).max_h(96).overflow_hidden().children(v.pending.map((c, n) => h_flex().gap(6).items_center().text_size(11)
        .child(div().flex_none().text_color(t.ansi3 || t.accent).child('●')).child(div().flex_1().min_w(0).truncate().child(describeChange(c)))
        .child(stop(div().id(`wi-x-${n}`).flex_none().px(4).text_color(t.muted).cursor_pointer()
          .on_click((_e, cx) => { cx.stop_propagation(); removeAt(v, n, cx); }).child('×'))))))
      .child(h_flex().gap(8).items_center()
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(12).font_semibold().child(`Linear 에 반영할 변경 ${v.pending.length}건${v.carried ? ' (지난번에 남은 것)' : ''}`))
          .child(div().text_size(10).text_color(t.muted).child('Linear MCP · 누를 때만 반영 · 자동 반영 없음')))
        .child(button('wi-cancel', '취소', t, cx => cancelAll(v, cx), { disabled: v.applying }))
        .child(button('wi-apply', v.applying ? '반영 중…' : 'Linear 에 반영', t, cx => applyNow(v, cx), { primary: true, disabled: v.applying })));
  }
  if (v.result?.ok) {
    return h_flex().flex_none().h(36).px(14).gap(8).items_center().border_t(1).border_color(t.border).bg(mix(t.done, t.background, 0.82)).text_size(12)
      .child(div().text_color(t.done).child('✓')).child(div().flex_1().child(`Linear 에 ${v.result.applied}건 반영 · 다시 읽어 확인함 ${when(v.result.at)}`));
  }
  return null;
}
