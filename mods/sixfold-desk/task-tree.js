// Display-only tree projection. Call separately for each caller-owned bucket;
// this helper never assigns issue, space, role or lifecycle meaning to IDs.
// childCount counts all descendants, so a collapsed row can show its full +N.
// maxNodes truncates the input; maxDepth promotes overdeep nodes to roots.
// Omitted expandedIDs uses defaultExpanded; an explicit Set selects expansion.
export function projectTaskTree(entries, {
  idOf = entry => entry?.id,
  parentOf = () => null,
  compare = null,
  expandedIDs = null,
  defaultExpanded = false,
  maxDepth = 32,
  maxNodes = 4096,
} = {}) {
  const bound = (value, fallback, ceiling) => Number.isInteger(value) && value >= 0 ? Math.min(value, ceiling) : fallback;
  const depthLimit = bound(maxDepth, 32, 128), nodeLimit = bound(maxNodes, 4096, 16384);
  const nodes = (Array.isArray(entries) ? entries : []).slice(0, nodeLimit).map((entry, index) => ({ entry, index, id: idOf(entry), parent: null, children: [], depth: 0, count: 0 }));
  const identities = new Map();
  const validId = value => typeof value === 'string' && value.length > 0;
  for (const node of nodes) if (validId(node.id)) identities.set(node.id, identities.has(node.id) ? null : node);
  for (const node of nodes) {
    // Duplicate identities remain visible but cannot safely own or join a tree.
    if (!validId(node.id) || identities.get(node.id) !== node) continue;
    const parentId = parentOf(node.entry), parent = validId(parentId) ? identities.get(parentId) : null;
    if (parent && parent !== node) node.parent = parent;
  }
  const complete = new Set();
  for (const start of nodes) {
    const path = [], positions = new Map();
    let node = start;
    while (node && !complete.has(node)) {
      if (positions.has(node)) {
        const cycle = path.slice(positions.get(node));
        cycle.reduce((first, item) => item.index < first.index ? item : first).parent = null;
        break;
      }
      positions.set(node, path.length);path.push(node);node = node.parent;
    }
    for (const item of path) complete.add(item);
  }
  const roots = [];
  for (const node of nodes) if (node.parent) node.parent.children.push(node);else roots.push(node);
  // Promote at depth boundaries instead of dropping or clipping descendants.
  const queue = [...roots];
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index];
    for (const child of node.children) {
      if (node.depth >= depthLimit) { child.parent = null;child.depth = 0; }
      else child.depth = node.depth + 1;
      queue.push(child);
    }
  }
  for (const node of nodes) node.children = [];
  roots.length = 0;
  for (const node of nodes) if (node.parent) node.parent.children.push(node);else roots.push(node);
  const order = (a, b) => {
    const priority = compare ? compare(a.entry, b.entry) : 0;
    return Number.isFinite(priority) && priority !== 0 ? priority : a.index - b.index;
  };
  roots.sort(order);
  for (const node of nodes) node.children.sort(order);
  // Reverse breadth-first order is child-before-parent even after promotion.
  for (let index = queue.length - 1; index >= 0; index--) {
    const node = queue[index];
    if (node.parent) node.parent.count += node.count + 1;
  }
  const rows = [], pending = roots.slice().reverse();
  while (pending.length) {
    const node = pending.pop();
    const expanded = node.children.length > 0 && (expandedIDs === null ? defaultExpanded === true : expandedIDs.has(node.id));
    rows.push({ entry: node.entry, depth: node.depth, parent: node.parent?.entry ?? null, childCount: node.count, expanded });
    if (expanded) for (let index = node.children.length - 1; index >= 0; index--) pending.push(node.children[index]);
  }
  return rows;
}

// Keep roots visible and fold direct child branches beyond the first three.
// A branch includes its visible descendants; its fold follows their final row.
export function projectTaskBranches(entries, { expandedParents = new Set(), ...options } = {}) {
  const all = projectTaskTree(entries, { ...options, expandedIDs: null, defaultExpanded: true });
  const children = new Map(all.map(row => [row.entry, []])), roots = [];
  for (const row of all) if (row.parent) children.get(row.parent).push(row);else roots.push(row);
  const rows = [], folds = [], pending = roots.slice().reverse().map(row => ({ row }));
  let hidden = 0;
  const idOf = options.idOf ?? (entry => entry?.id);
  while (pending.length) {
    const item = pending.pop();
    if (item.fold) { folds.push({ ...item.fold, after: idOf(rows.at(-1).entry) });continue; }
    const row = item.row, branches = children.get(row.entry), parentId = idOf(row.entry);
    const expandable = branches.length > 3, expanded = expandable && expandedParents.has(parentId);
    const visible = expandable && !expanded ? branches.slice(0, 3) : branches;
    rows.push({ ...row, childCount: branches.length, expanded: !expandable || expanded });
    if (expandable) {
      const omitted = branches.length - visible.length;hidden += omitted;
      pending.push({ fold: { parent: parentId, hidden: omitted, count: branches.length, expanded } });
    }
    for (let index = visible.length - 1; index >= 0; index--) pending.push({ row: visible[index] });
  }
  return { rows, folds, hidden };
}
