// Read-only chip counts from the same selected work as the week dialog.
import { weekRows, compareIssues } from './model.js';
export function weekSummary(feed, options) {
  const { rows } = weekRows(feed, { ...options, open: {} });
  const items = rows.filter(r => r.kind === 'item').sort(compareIssues);
  return { items, total: items.length,
    today: items.filter(i => i.when === options.today).length,
    late: items.filter(i => i.when && i.when < options.today).length };
}
