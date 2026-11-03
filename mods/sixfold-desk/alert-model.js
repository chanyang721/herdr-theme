export const projectKey = name => String(name ?? '').toLowerCase().replace(/[\s_-]/g, '');
// A message timestamp identifies receipt. Later task edits are not new messages.
export const alertVersion = item => item.id;
export function scopedAlerts(items, {project, read = {}, unread = false} = {}) {
  return (items ?? []).filter(i => (!project || projectKey(i.project) === projectKey(project))
    && (!unread || read[i.id] !== alertVersion(i)));
}
