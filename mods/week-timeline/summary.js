// Read-only band content from the same selected work as the week dialog.
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

// The band under the header: seven day cells, each with that day's "◆ KEY 제목" deadline chips
// (late work, even from before this week, sits in Monday's cell first), and one "진행 중" line for
// started or in-review work whose date falls after this week (or has none): "● KEY 제목 → 12/3".
// tone: late | soon (today or tomorrow) | started | review | todo.
export function bandModel(feed, { today }) {
  const win = windowOf(feed, today, 7), tomorrow = addDays(today, 1);
  const { items } = weekSummary(feed, { today });
  const days = dayCells(win, today).map(c => ({ ...c, items: [] })), ongoing = [];
  for (const item of items) {
    const d = item.when, live = item.state === 'started' || item.state === 'review';
    if (d && d <= win.end) {
      const late = d < today;
      days[Math.max(0, daysBetween(win.start, d))].items.push({ key: item.key, title: clip(item.title), item, late,
        tone: late ? 'late' : d === today || d === tomorrow ? 'soon' : item.state });
    } else if (live) {
      ongoing.push({ key: item.key, title: clip(item.title, 16), item, tone: item.state, due: d ? md(d) : '' });
    }
  }
  // Late work first in its cell, then the shared processing order.
  for (const day of days) day.items.sort((a, b) => Number(b.late) - Number(a.late));
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
  return 16 + 2 + textWidth('●', size) + [chip.key, chip.title, chip.due ? `→ ${chip.due}` : ''].filter(Boolean)
    .reduce((n, p) => n + BAND.gap + textWidth(p, size), 0);
}

// How many deadline chips a day cell of `width` px shows; each may shrink to `minChip` with its
// title cut. The rest fold into "+N".
export function fitCell(count, width) {
  if (!(width > 0) || count <= 1) return { shown: count, more: 0 };   // a lone chip just shrinks
  const room = width - BAND.cellPad * 2, fit = n => n * BAND.minChip + Math.max(0, n - 1) * BAND.gap;
  if (fit(count) <= room) return { shown: count, more: 0 };
  let n = 0;
  while (n + 1 < count && fit(n + 1) + BAND.gap + BAND.more <= room) n++;
  return { shown: n, more: count - n };
}

// Which "진행 중" chips fit in `room` px; the rest fold into "+N". No wrapping, no scroll.
export function fitLine(chips, room, measure = chipWidth) {
  if (!(room > 0)) return { shown: chips, more: 0 };
  const widths = chips.map(c => measure(c)), all = widths.reduce((n, w, i) => n + (i ? BAND.gap : 0) + w, 0);
  if (all <= room) return { shown: chips, more: 0 };
  let used = BAND.more, n = 0;
  while (n < chips.length && used + BAND.gap + widths[n] <= room) used += BAND.gap + widths[n++];
  return { shown: chips.slice(0, n), more: chips.length - n };
}
