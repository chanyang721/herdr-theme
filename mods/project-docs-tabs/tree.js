// Turns the resolver catalog into Finder locations for the 문서 tab: column-view entries
// (virtual POSIX paths) and list-view nodes. Pure: rebuilt on every frame, no host calls.

const fold = value => String(value ?? '').normalize('NFC').toLocaleLowerCase();
const OTHER = { id: 'other', label: '기타' };
const extOf = path => { const m = /\.([^./]+)$/.exec(path || ''); return m ? `.${m[1].toLowerCase()}` : ''; };
const safe = text => String(text).replace(/\//g, '∕');

// Does the search text appear in what the row shows or where the file lives?
export function matches(doc, query) {
  const q = fold(query).trim();
  if (!q) return true;
  const text = fold([doc.label, doc.name, doc.folder, doc.group, doc.kindLabel].filter(Boolean).join(' '));
  return q.split(/\s+/).every(word => text.includes(word));
}

// The short date shown in rows: 11-04, or 2025-11-04 in another year.
export function shortDate(iso, today = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
  return iso.slice(0, 4) === String(today.getFullYear()) ? iso.slice(5) : iso;
}

// A file entry; its path sorts so that column-view's newest-first order is the order we want.
function fileEntry(folder, doc, rank, kindLabel) {
  const ext = extOf(doc.path || doc.name);
  return { path: `${folder ? `${folder}/` : ''}${rank}_${doc.id}${ext}`, dir: false, id: doc.id, doc,
    name: `${doc.label}${ext}`, title: `${doc.recent && doc.state !== 'previous' ? '● ' : ''}${doc.label}`,
    date: doc.modified || doc.date, mtime: doc.mtime, size: doc.size, kindLabel, muted: doc.state === 'previous' || doc.state === 'archived',
    badge: doc.pinned ? '◆' : doc.versions?.length ? `${doc.versions.length + 1}판` : '' };
}

/**
 * Sidebar locations, each { key, label, count, entries, order }.
 * docs: kind folders holding the newest version of each document (pinned ones too, ◆).
 * localViews: producer-defined sections and groups. opened: opened files.
 * archived: 보관 documents by kind. options: kinds, localViews, kind (filter id or null).
 */
export function locations(documents, options = {}) {
  const { kinds = [], localViews = null, kind = null } = options;
  const order = [...kinds.filter(k => k.id !== OTHER.id), OTHER];
  const byId = new Map(documents.map(d => [d.id, d]));
  const result = [];
  const byKind = (docs, key, label) => {
    const entries = [];
    for (const k of order) {
      if (kind && k.id !== kind) continue;
      const members = docs.filter(d => (d.kind || OTHER.id) === k.id);
      if (!members.length) continue;
      entries.push({ path: safe(k.label), dir: true, name: k.label, badge: String(members.length) });
      // Newest write first: the rank is the modification time, not the date in the name.
      for (const d of members) entries.push(fileEntry(safe(k.label), d, String(d.mtime ?? 0).padStart(14, '0'), k.label));
    }
    const count = entries.filter(e => !e.dir).length;
    if (count) result.push({ key, label, count, entries, order: order.map(k => safe(k.label)) });
  };
  const catalog = documents.filter(d => !d.localView && !d.opened);
  byKind(catalog.filter(d => d.pinned || d.state === 'latest' || !d.state), 'docs', '공간 문서');
  if (localViews?.sections?.length && !kind) {
    const entries = [];
    for (const section of localViews.sections) {
      entries.push({ path: safe(section.label), dir: true, name: section.label });
      for (const group of section.groups) {
        const folder = group.label ? `${safe(section.label)}/${safe(group.label)}` : safe(section.label);
        if (group.label) entries.push({ path: folder, dir: true, name: group.label });
        const docs = group.ids.map(id => byId.get(id)).filter(d => d && d.state !== 'previous');
        // The producer's section metadata determines grouping and ordering.
        const fixed = true;
        docs.forEach((d, i) => entries.push(fileEntry(folder, d, fixed ? String(9999 - i).padStart(4, '0') : d.date || '0000', section.label)));
      }
    }
    result.push({ key: 'localViews', label: '로컬 보기', count: entries.filter(e => !e.dir).length, entries,
      order: localViews.sections.map(s => safe(s.label)), localViews: true });
  }
  const opened = documents.filter(d => d.opened);
  if (opened.length) result.push({ key: 'opened', label: '열람', count: opened.length,
    entries: opened.map((d, i) => fileEntry('', d, String(9999 - i).padStart(4, '0'), '')), order: [] });
  byKind(documents.filter(d => d.state === 'archived'), 'archived', '보관');
  return result;
}

// Where a document sits: { key, path } of the first location listing it (aliases count).
export function locate(locs, id) {
  for (const loc of locs) {
    const entry = loc.entries.find(e => !e.dir && (e.id === id || e.doc?.aliasOf === id));
    if (entry) return { key: loc.key, path: entry.path };
  }
  return null;
}

// List-view tree for one location; a file with versions holds them as children.
export function listTree(location, documents) {
  const byId = new Map(documents.map(d => [d.id, d]));
  const root = { id: '', name: location.label, folder: true, children: [] };
  const nodes = new Map([['', root]]);
  for (const entry of location.entries) {
    const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
    const ext = extOf(entry.name).slice(1).toUpperCase();
    const node = { id: entry.path, name: entry.dir ? entry.name : entry.title, fileName: entry.name, folder: entry.dir,
      date: entry.date, mtime: entry.mtime, size: entry.size, kind: entry.dir ? '폴더' : [entry.kindLabel, ext].filter(Boolean).join(' · '),
      badge: entry.dir ? '' : entry.badge, muted: entry.muted, docId: entry.id, children: entry.dir ? [] : undefined };
    if (!entry.dir) {
      const versions = (entry.doc?.versions || []).map(id => byId.get(id)).filter(Boolean);
      if (versions.length) node.children = versions.map(v => ({ id: `${entry.path}#${v.id}`, name: v.label, fileName: v.name,
        date: v.modified || v.date, mtime: v.mtime, size: v.size, kind: '이전 버전', muted: true, docId: v.id }));
    }
    nodes.set(entry.path, node);
    (nodes.get(parent) || root).children.push(node);
  }
  return root;
}

// Search results across every location as one flat list-view root.
export function searchTree(documents, query, kinds = [], kind = null) {
  const labels = new Map([...kinds, OTHER].map(k => [k.id, k.label]));
  const hits = documents.filter(d => !d.aliasOf && (!kind || d.kind === kind) && matches({ ...d, kindLabel: labels.get(d.kind) }, query));
  return { id: '', name: `검색: ${query}`, folder: true, children: hits.map(d => ({ id: `hit/${d.id}`, docId: d.id,
    name: `${d.pinned ? '◆ ' : ''}${d.label}${d.state === 'previous' ? ' (이전 버전)' : d.state === 'archived' ? ' (보관)' : ''}`,
    fileName: d.name, date: d.modified || d.date, mtime: d.mtime, size: d.size, muted: d.state === 'previous' || d.state === 'archived',
    kind: d.localView ? '로컬 보기' : labels.get(d.kind) || '문서' })) };
}

// Counts behind the kind filter; archived files and earlier versions are not counted.
export function kindCounts(documents, kinds = []) {
  const counts = new Map();
  for (const d of documents) {
    if (d.localView || d.opened || (d.state && d.state !== 'latest')) continue;
    const id = d.kind || OTHER.id;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...kinds.filter(k => k.id !== OTHER.id), OTHER].filter(k => counts.get(k.id)).map(k => ({ ...k, count: counts.get(k.id) }));
}

// Folder chain of an entry path: 'a/b/c.md' → ['a', 'a/b']; a folder path includes itself.
export function foldersOf(path, dir = false) {
  const parts = String(path || '').split('/').filter(Boolean);
  const count = dir ? parts.length : parts.length - 1;
  return parts.slice(0, Math.max(0, count)).map((_, i) => parts.slice(0, i + 1).join('/'));
}
