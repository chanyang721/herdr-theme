// Builds the 문서 tab's left tree from the resolver catalog. Pure: no host calls, so the
// sections can be tested and rebuilt on every frame.

const fold = value => String(value ?? '').normalize('NFC').toLocaleLowerCase();
export const HARNESS_LABEL = '하네스';
const OTHER = { id: 'other', label: '기타' };

// Does the search text appear in what the row shows or where the file lives?
export function matches(doc, query) {
  const q = fold(query).trim();
  if (!q) return true;
  const text = fold([doc.label, doc.name, doc.folder, doc.group, doc.kindLabel].filter(Boolean).join(' '));
  return q.split(/\s+/).every(word => text.includes(word));
}

// The short date shown at the end of a row: 11-04, or 2025-11-04 in another year.
export function shortDate(iso, today = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
  return iso.slice(0, 4) === String(today.getFullYear()) ? iso.slice(5) : iso;
}

/**
 * Sections in display order. Each has a stable key (for the open/closed memory), a label,
 * the number of documents it holds and rows. A row is { doc, depth, versions, expanded }
 * or { heading } for a sub-group such as a history month.
 *
 * options: kinds [{id,label}], harness {sections}, query, kind (filter id or null),
 * archive (show 보관), open (key → bool chosen by the person), families (Set of expanded
 * family heads), selected (id).
 */
export function treeSections(documents, options = {}) {
  const { kinds = [], harness = null, query = '', kind = null, archive = false, open = {}, families = new Set(), selected = null } = options;
  const byId = new Map(documents.map(d => [d.id, d]));
  const labels = new Map([...kinds, OTHER].map(k => [k.id, k.label]));
  const withKind = d => ({ ...d, kindLabel: labels.get(d.kind) || '' });
  const searching = Boolean(fold(query).trim());
  const sections = [];
  const isOpen = (key, fallback) => searching || (key in open ? open[key] : fallback);
  // A head shows when it or one of its earlier versions matches; matching versions unfold it.
  const versionsOf = d => (d.versions || []).map(id => byId.get(id)).filter(v => v && v.state !== 'archived');
  const headRows = heads => {
    const rows = [];
    for (const head of heads) {
      const versions = versionsOf(head);
      const hitVersions = versions.filter(v => matches(withKind(v), query));
      const hit = matches(withKind(head), query);
      if (!hit && !hitVersions.length) continue;
      const expanded = families.has(head.id) || versions.some(v => v.id === selected) || (searching && hitVersions.length > 0 && !hit);
      rows.push({ doc: head, depth: 0, versions: versions.length, expanded });
      if (expanded) for (const v of (searching && !hit ? hitVersions : versions)) rows.push({ doc: v, depth: 1, versions: 0, expanded: false });
    }
    return rows;
  };
  const push = (key, label, rows, fallback, extra = {}) => {
    const count = rows.filter(r => r.doc && r.depth === 0).length;
    if (!count) return;
    const expanded = isOpen(key, fallback);
    sections.push({ key, label, count, expanded, recent: rows.some(r => r.doc?.recent), rows: expanded ? rows : [], ...extra });
  };

  const kindOk = d => !kind || d.kind === kind;
  const catalog = documents.filter(d => !d.harness);
  push('pinned', '고정', headRows(catalog.filter(d => d.pinned && kindOk(d))), true);
  push('opened', '열람', headRows(catalog.filter(d => d.opened)), true);
  if (harness?.sections?.length && !kind) {
    for (const section of harness.sections) {
      const rows = [];
      for (const group of section.groups) {
        // Versioned harness documents list their newest link; older ones fold under it.
        const docs = headRows(group.ids.map(id => byId.get(id)).filter(d => d && d.state !== 'previous'));
        if (!docs.length) continue;
        if (group.label) rows.push({ heading: group.label });
        for (const r of docs) rows.push({ ...r, depth: r.depth + (group.label ? 1 : 0) });
      }
      const count = rows.filter(r => r.doc && r.doc.state !== 'previous').length;
      if (!count) continue;
      const key = `harness:${section.id}`, expanded = isOpen(key, section.id === 'status');
      sections.push({ key, label: `${HARNESS_LABEL} · ${section.label}`, count, expanded, harness: true,
        recent: false, rows: expanded ? rows : [] });
    }
  }
  const heads = catalog.filter(d => !d.pinned && !d.opened && (d.state === 'latest' || !d.state) && kindOk(d));
  for (const k of [...kinds.filter(k => k.id !== OTHER.id), OTHER]) {
    const members = heads.filter(d => (d.kind || OTHER.id) === k.id);
    push(`kind:${k.id}`, k.label, headRows(members), members.some(d => d.recent));
  }
  if (archive) {
    const archived = catalog.filter(d => d.state === 'archived' && kindOk(d) && matches(withKind(d), query));
    push('archived', '보관', archived.map(doc => ({ doc, depth: 0, versions: 0, expanded: false })), true);
  }
  return sections;
}

// Counts behind the kind filter chips; the archive count is separate.
export function kindCounts(documents, kinds = []) {
  const counts = new Map();
  for (const d of documents) {
    if (d.harness || d.opened || (d.state && d.state !== 'latest')) continue;
    const id = d.kind || OTHER.id;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...kinds.filter(k => k.id !== OTHER.id), OTHER].filter(k => counts.get(k.id)).map(k => ({ ...k, count: counts.get(k.id) }));
}
