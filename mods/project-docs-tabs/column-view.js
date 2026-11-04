export const COLUMN_VIEW_VERSION = 1;
// Finder-style column view shared by herdr mods (harness-memory's 기억 panel, project-docs-tabs).
// Source of truth: herdr-harness mods/harness-memory/column-view.js. Other mods copy this file
// byte for byte and check COLUMN_VIEW_VERSION; change it here and bump the version.
//
// entries: [{ path: 'a/b.md', dir: false, name?, date?, muted?, badge? }] relative POSIX paths under
// one root; extra fields pass through to label(entry) and the row (a virtual folder is just a path).
// selected: the selected path ('' = nothing). Clicking a folder opens its column to the right;
// clicking a file shows `preview` in the last column. Colors come from theme() tokens only, so
// light and dark themes both work.
import { div } from 'gpui-kit';
import { v_flex, h_flex, Button } from 'gpui-base';

export function parentOf(path) {
  const i = String(path || '').lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function sorter(parent, { order = [], newestFirst = null } = {}) {
  const rank = p => { const i = order.indexOf(p); return i < 0 ? order.length : i; };
  return (a, b) => {
    if (!parent && order.length) {
      const r = rank(a.path) - rank(b.path);
      if (r) return r;
    }
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    if (newestFirst && newestFirst.test(parent)) return b.path.localeCompare(a.path);
    return a.path.localeCompare(b.path);
  };
}

const ICONS = { md: '📝', markdown: '📝', txt: '📝', html: '🌐', htm: '🌐', pdf: '📕', docx: '📘', doc: '📘',
  xlsx: '📗', xls: '📗', csv: '📗' };

// One icon per kind, so every mod using the column view draws files the same way.
export function icon(entry) {
  if (entry?.dir) return '📁';
  const name = String(entry?.name || entry?.path || '');
  const dot = name.lastIndexOf('.');
  return ICONS[dot < 0 ? '' : name.slice(dot + 1).toLowerCase()] || '📄';
}

// The columns to draw: the root, then one per selected folder along the selected path.
export function columnsFor(entries, selected, options = {}) {
  const children = new Map();
  for (const e of entries || []) {
    const parent = parentOf(e.path);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(e);
  }
  const chain = [''];
  const parts = String(selected || '').split('/').filter(Boolean);
  const dirs = new Set((entries || []).filter(e => e.dir).map(e => e.path));
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join('/');
    if (dirs.has(p)) chain.push(p); else break;
  }
  const onPath = new Set(parts.map((_, i) => parts.slice(0, i + 1).join('/')));
  return chain.map(parent => ({
    parent,
    items: [...(children.get(parent) || [])].sort(sorter(parent, options))
      .map(e => ({ ...e, name: e.name || e.path.split('/').pop(), selected: onPath.has(e.path) })),
  }));
}

// How many trailing columns fit beside the preview in `width` px.
export function visibleColumns(count, { width = 0, columnWidth = 180, previewMin = 260, hasPreview = false } = {}) {
  if (!width) return count;
  const room = width - (hasPreview ? previewMin : 0);
  return Math.max(1, Math.min(count, Math.floor(room / columnWidth)));
}

export function columnView({ id, entries, selected, t, onSelect, preview = null, columnWidth = 180, previewMin = 260,
  width = 0, order = [], newestFirst = null, label = null }) {
  const columns = columnsFor(entries, selected, { order, newestFirst });
  const shown = visibleColumns(columns.length, { width, columnWidth, previewMin, hasPreview: Boolean(preview) });
  const hidden = columns.length - shown;
  const row = h_flex().size_full().min_h(0).items_start();
  if (hidden > 0) {
    const back = columns[hidden - 1].parent;
    row.child(Button.new(`${id}-back`).flex_none().w(18).h_full().cursor_pointer().bg(t.chrome).hover(s => s.bg(t.raised))
      .border_r(1).border_color(t.border).text_color(t.dim).text_size(12).accessibility_label('앞 열 보기')
      .child(div().pt(8).pl(4).child('‹')).on_click((_e, cx) => onSelect(back, true, cx)));
  }
  columns.slice(hidden).forEach((col, i) => {
    const list = v_flex().flex_none().w(columnWidth).h_full().min_h(0).overflow_y_scrollbar().py(4).px(4).gap(1)
      .bg(t.chrome).border_r(1).border_color(t.border);
    if (!col.items.length) list.child(div().px(8).py(6).text_size(11.5).text_color(t.dim).child('비어 있음'));
    for (const item of col.items) {
      const text = label ? label(item) : item.name;
      // selected: theme.selected plus an accent bar on the left (same as the docs tab's list view)
      list.child(Button.new(`${id}-c${hidden + i}-${item.path}`).w_full().pl(item.selected ? 6 : 8).pr(8).py(4).rounded(4).cursor_pointer()
        .bg(item.selected ? t.selected : t.chrome).hover(s => s.bg(item.selected ? t.selected : t.raised))
        .when(item.selected, e => e.border_l(2).border_color(t.accent))
        .text_size(12).text_color(item.muted ? t.dim : item.selected ? t.foreground : item.dir ? t.muted : t.foreground)
        .accessibility_label(item.path)
        .child(h_flex().w_full().items_center().gap(5)
          .child(div().flex_none().text_size(11).child(icon(item)))
          .child(div().flex_1().min_w(0).overflow_hidden().child(text))
          .when(item.badge != null && item.badge !== '', e => e.child(div().flex_none().px(5).rounded(7).bg(t.raised)
            .text_size(10).text_color(t.muted).child(String(item.badge))))
          .when(item.dir, e => e.child(div().flex_none().text_color(t.dim).child('›'))))
        .on_click((_e, cx) => onSelect(item.path, item.dir, cx)));
    }
    row.child(list);
  });
  if (preview) row.child(v_flex().flex_1().min_w(previewMin).h_full().min_h(0).overflow_y_scrollbar().px(14).py(10).gap(8).child(preview));
  return row;
}
