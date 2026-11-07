// Finder list view and path bar for the 문서 tab. The column view and file icons come from
// column-view.js (the shared public column widget), so both
// draw files the same way. Pure description: safe inside render(); theme tokens only.
//
// A node is { id, name, fileName?, folder?, date?, size?, kind?, badge?, muted?, children? }.
// A file node may have children too (earlier versions), which the list view unfolds.
import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { icon as entryIcon } from './column-view.js';

const KINDS = { md: 'Markdown', markdown: 'Markdown', html: 'HTML', htm: 'HTML', pdf: 'PDF', docx: 'Word', doc: 'Word', xlsx: 'Excel', xls: 'Excel', txt: '텍스트' };
export const extOf = node => ((node.fileName || node.name || '').split('.').slice(1).pop() || '').toLowerCase();
export const icon = node => entryIcon({ dir: Boolean(node.folder), name: node.fileName || node.name });
export const kindOf = node => node.kind || (node.folder ? '폴더' : KINDS[extOf(node)] ? `${KINDS[extOf(node)]} 문서` : '문서');

export function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1000, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const fold = value => String(value ?? '').normalize('NFC').toLocaleLowerCase();

// Folders stay on top, as Finder does by default; then the chosen column, then the name.
export function sortNodes(nodes, sort = null) {
  if (!sort) return nodes.slice();
  const { key = 'name', dir = 1 } = sort;
  // 수정일 orders by the modification time when both rows have one, else by the shown date.
  if (key === 'date') return nodes.slice().sort((a, b) => (Boolean(b.folder) - Boolean(a.folder)) ||
    (Number.isFinite(a.mtime) && Number.isFinite(b.mtime) ? (a.mtime - b.mtime) * dir
      : (a.date || '') < (b.date || '') ? -dir : (a.date || '') > (b.date || '') ? dir : 0) ||
    (fold(a.name) < fold(b.name) ? -1 : fold(a.name) > fold(b.name) ? 1 : 0));
  const value = node => key === 'size' ? node.size ?? -1 : key === 'kind' ? fold(kindOf(node)) : fold(node.name);
  return nodes.slice().sort((a, b) => (Boolean(b.folder) - Boolean(a.folder)) ||
    (value(a) < value(b) ? -dir : value(a) > value(b) ? dir : 0) || (fold(a.name) < fold(b.name) ? -1 : fold(a.name) > fold(b.name) ? 1 : 0));
}

// Nodes from the root down to the one with this id (root excluded), or null.
export function findPath(root, id) {
  if (!root || id == null) return null;
  for (const child of root.children || []) {
    if (child.id === id) return [child];
    const below = findPath(child, id);
    if (below) return [child, ...below];
  }
  return null;
}

// Visible list rows: { node, depth, open, openable } in display order.
export function flatten(root, expanded = new Set(), sort = null, depth = 0) {
  const rows = [];
  for (const node of sortNodes(root?.children || [], sort)) {
    const openable = Boolean(node.children?.length), open = openable && expanded.has(node.id);
    rows.push({ node, depth, open, openable });
    if (open) rows.push(...flatten(node, expanded, node.folder ? sort : null, depth + 1));
  }
  return rows;
}

const key = id => String(id);

function rowBase(t, id, current, inPath, onClick) {
  return h_flex().id(id).flex_none().min_w(0).h(24).pr(6).gap(6).items_center().rounded(4).cursor_pointer()
    .border_l(2).border_color(current ? t.accent : inPath ? t.border : t.canvas)
    .bg(current ? t.selected : inPath ? t.chrome : t.canvas).hover(s => s.bg(current ? t.selected : t.hover))
    .on_click(onClick);
}

const COLUMNS = [['name', '이름'], ['date', '수정일'], ['kind', '종류'], ['size', '크기']];

/**
 * Finder list view: sortable header, disclosure triangles, one row per visible node.
 * options: { id, expanded: Set, sort: {key, dir}, selected | isSelected(node), theme, onOpen(node, depth, cx),
 *            onToggle(id, cx), onSort(key, cx), dateWidth, kindWidth, sizeWidth }
 */
export function listView(root, options) {
  const { id = 'finder-list', expanded = new Set(), sort = { key: 'date', dir: -1 }, selected = null, isSelected = null, theme: t, onOpen, onToggle, onSort,
    dateWidth = 92, kindWidth = 96, sizeWidth = 64 } = options;
  const widths = { date: dateWidth, kind: kindWidth, size: sizeWidth };
  const header = h_flex().flex_none().h(24).px(6).gap(6).items_center().border_b(1).border_color(t.border)
    .children(COLUMNS.map(([name, label]) => {
      const cell = div().id(`${id}-sort-${name}`).cursor_pointer().truncate().text_size(11)
        .text_color(sort.key === name ? t.foreground : t.muted).when(sort.key === name, el => el.font_semibold())
        .on_click((_e, cx) => onSort(name, cx)).child(`${label}${sort.key === name ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}`);
      return name === 'name' ? cell.flex_1().min_w(0).pl(18) : cell.w(widths[name]).flex_none();
    }));
  const rows = flatten(root, expanded, sort).map(({ node, depth, open, openable }) => {
    const current = isSelected ? isSelected(node) : node.id === selected;
    return rowBase(t, `${id}-row-${key(node.id)}`, current, false, (_e, cx) => onOpen(node, depth, cx)).pl(6 + depth * 16)
      .tooltip(node.tooltip || node.name)
      .child(div().id(`${id}-toggle-${key(node.id)}`).w(12).flex_none().text_size(10).text_color(t.muted)
        .when(openable, el => el.cursor_pointer().on_click((_e, cx) => onToggle(node.id, cx)))
        .child(openable ? (open ? '▾' : '▸') : ''))
      .child(div().flex_none().text_size(13).child(icon(node)))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(node.muted ? t.muted : t.foreground)
        .when(current, el => el.font_semibold()).child(node.name))
      .when(Boolean(node.badge), el => el.child(div().flex_none().text_size(10).text_color(t.accent).child(node.badge)))
      .child(div().w(dateWidth).flex_none().truncate().text_size(11).text_color(t.muted).child(node.date || '—'))
      .child(div().w(kindWidth).flex_none().truncate().text_size(11).text_color(t.muted).child(kindOf(node)))
      .child(div().w(sizeWidth).flex_none().truncate().text_size(11).text_color(t.muted).child(node.folder ? '—' : formatSize(node.size)));
  });
  return v_flex().id(id).size_full().min_h(0).min_w(0)
    .child(header)
    .child(v_flex().id(`${id}-rows`).flex_1().min_h(0).overflow_y_scrollbar().p(4).gap(1)
      .when(!rows.length, el => el.child(div().px(8).py(6).text_size(12).text_color(t.muted).child('비어 있음')))
      .children(rows));
}

/**
 * Path bar: root › folder › file. onJump(depth, cx) with -1 for the root.
 * nodes is the findPath result (or the open folder chain).
 */
export function breadcrumb(root, nodes, options) {
  const { id = 'finder-path', theme: t, onJump } = options;
  const parts = [root, ...(nodes || [])];
  return h_flex().id(id).flex_none().min_w(0).h(24).px(8).gap(4).items_center().overflow_hidden()
    .children(parts.flatMap((node, index) => {
      const last = index === parts.length - 1;
      const crumb = div().id(`${id}-${index}`).flex_none().max_w(220).truncate().px(4).rounded(4).cursor_pointer()
        .hover(s => s.bg(t.hover)).text_size(11).text_color(last ? t.foreground : t.muted).when(last, el => el.font_semibold())
        .on_click((_e, cx) => onJump(index - 1, cx)).child(`${icon(node)} ${node.name}`);
      return index ? [div().flex_none().text_size(11).text_color(t.muted).child('›'), crumb] : [crumb];
    }));
}
