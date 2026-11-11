// Read-only band content. weekSummary is the dialog's selection; bandModel picks issues one by one.
import { weekRows, compareIssues, windowOf, dayCells, addDays, daysBetween, md } from './model.js';
export function weekSummary(feed, options) {
  const { rows } = weekRows(feed, { ...options, open: {} });
  const items = rows.filter(r => r.kind === 'item').sort(compareIssues);
  return { items, total: items.length,
    today: items.filter(i => i.when === options.today).length,
    late: items.filter(i => i.when && i.when < options.today).length };
}

// The first `n` characters of a title, with "…" when cut.
export function clip(text, n = 14) {
  const chars = Array.from(String(text || '').trim());
  return chars.length > n ? `${chars.slice(0, n).join('').trimEnd()}…` : chars.join('');
}

// The band under the header, chosen issue by issue (not the dialog's parent groups), my open work:
// - a real deadline (`due`) this week or earlier: "◆ KEY 제목" in that day's cell. Late work
//   (before today, this week or earlier) sits first in Monday's cell, oldest first.
// - otherwise started or in review: one "진행 중" line, "● KEY 제목 → 12/3", "→ 11/14 목표" for a
//   milestone target only, "→ 날짜 없음" without either. A milestone target is never a deadline.
// tone: late | soon (today or tomorrow) | started | review | todo.
export function bandModel(feed, { today }) {
  const win = windowOf(feed, today, 7), tomorrow = addDays(today, 1);
  const days = dayCells(win, today).map(c => ({ ...c, items: [] })), ongoing = [];
  for (const p of feed?.projects ?? []) {
    const targets = new Map((p.milestones || []).map(m => [m.id, m.target]));
    for (const issue of p.issues) {
      if (issue.state === 'done') continue;
      const target = targets.get(issue.milestone) || '', item = { ...issue, when: issue.due || target };
      if (issue.due && issue.due <= win.end) {
        const late = issue.due < today;
        days[late ? 0 : Math.max(0, daysBetween(win.start, issue.due))].items.push({ key: issue.key, title: clip(issue.title), item, late,
          tone: late ? 'late' : issue.due === tomorrow || issue.due === today ? 'soon' : issue.state });
      } else if (issue.state === 'started' || issue.state === 'review') {
        ongoing.push({ key: issue.key, title: clip(issue.title, 16), item, tone: issue.state,
          date: issue.due ? md(issue.due) : target ? `${md(target)} 목표` : '날짜 없음' });
      }
    }
  }
  const byDay = (a, b) => Number(b.late) - Number(a.late) || (a.late && b.late ? a.item.due.localeCompare(b.item.due) : 0) || compareIssues(a.item, b.item);
  for (const day of days) day.items.sort(byDay);
  ongoing.sort((a, b) => compareIssues(a.item, b.item));
  const due = days.reduce((n, d) => n + d.items.length, 0);
  return { win, days, ongoing, due, total: due + ongoing.length, range: `${md(win.start)} – ${md(win.end)}` };
}

// Rough text widths: Hangul and other wide glyphs one em, the rest ~0.6 em.
export function textWidth(text, size = 12) {
  let w = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    w += c >= 0x1100 ? size : ch === ' ' ? size * 0.3 : /[A-Z0-9→◆●…]/.test(ch) ? size * 0.66 : size * 0.56;
  }
  return Math.ceil(w);
}
export const BAND = { height: 80, head: 22, due: 30, line: 26, label: 132, gap: 5, cellPad: 6, minChip: 124, more: 30, linePad: 10 };
export function chipWidth(chip, size = 11) {
  return 16 + 2 + textWidth('●', size) + [chip.key, chip.title, chip.date ? `→ ${chip.date}` : ''].filter(Boolean)
    .reduce((n, p) => n + BAND.gap + textWidth(p, size), 0);
}

// How many deadline chips a day cell of `width` px shows; each may shrink to `minChip` with its
// title cut. The rest fold into "+N". `width` null: not measured yet, show all; no room: only "+N".
export function fitCell(count, width) {
  if (width == null || count === 0) return { shown: count, more: 0 };
  if (!(width > BAND.cellPad * 2)) return { shown: 0, more: count };
  if (count === 1) return { shown: 1, more: 0 };   // a lone chip just shrinks
  const room = width - BAND.cellPad * 2, fit = n => n * BAND.minChip + Math.max(0, n - 1) * BAND.gap;
  if (fit(count) <= room) return { shown: count, more: 0 };
  let n = 0;
  while (n + 1 < count && fit(n + 1) + BAND.gap + BAND.more <= room) n++;
  return { shown: n, more: count - n };
}

// Which "진행 중" chips fit in `room` px; the rest fold into "+N". No wrapping, no scroll.
// `room` null: not measured yet, show all; no room at all: no chip, one "+N".
export function fitLine(chips, room, measure = chipWidth) {
  if (room == null || !chips.length) return { shown: chips, more: 0 };
  if (!(room > 0)) return { shown: [], more: chips.length };
  const widths = chips.map(c => measure(c)), all = widths.reduce((n, w, i) => n + (i ? BAND.gap : 0) + w, 0);
  if (all <= room) return { shown: chips, more: 0 };
  let used = BAND.more, n = 0;
  while (n < chips.length && used + BAND.gap + widths[n] <= room) used += BAND.gap + widths[n++];
  return { shown: chips.slice(0, n), more: chips.length - n };
}
