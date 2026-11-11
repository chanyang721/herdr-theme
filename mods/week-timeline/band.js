// Presentation only: the feed, issue selection and producer contract stay in model.js.
import { weekRows, compareIssues } from './model.js';

export const BAND = { collapsed: 28, toolbar: 28, head: 22, row: 24, maxRows: 5, max: 171 };
export const EXPANDED_KEY = 'sixfold.week-timeline.expanded';

export function bandHeight(expanded, rows = 5) {
  return expanded ? BAND.toolbar + BAND.head + BAND.row * Math.min(BAND.maxRows, Math.max(1, rows)) + 1 : BAND.collapsed;
}

export function bandSummary(feed, options) {
  // Tree folds affect the table only; counts always describe the selected projects.
  const { rows } = weekRows(feed, { ...options, open: {} });
  const projects = rows.filter(r => r.kind === 'project');
  const items = rows.filter(r => r.kind === 'item');
  const done = projects.reduce((n, p) => n + p.done, 0);
  const kinds = {};
  for (const i of items) kinds[i.look] = (kinds[i.look] || 0) + 1;
  if (done) kinds.done = done;
  return { projects, items: [...items].sort(compareIssues), total: items.length + done, kinds,
    today: items.filter(i => i.due === options.today).length,
    blocked: items.filter(i => i.blocked).length,
    started: items.filter(i => i.state === 'started' || i.state === 'review').length };
}
