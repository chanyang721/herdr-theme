export const projectKey = name => String(name ?? '').toLowerCase().replace(/[\s_-]/g, '');
// A message timestamp identifies receipt. Later task edits are not new messages.
export const alertVersion = item => item.id;
export function scopedAlerts(items, {project, read = {}, unread = false} = {}) {
  return (items ?? []).filter(i => (!project || projectKey(i.project) === projectKey(project))
    && (!unread || read[i.id] !== alertVersion(i)));
}
// Linear inbox items carry the Herdr space they belong to (machine-local mapping).
export const linearScoped = (items, space) => (items ?? []).filter(i => !space || projectKey(i.workspace) === projectKey(space));
export const linearUnread = (items, space) => linearScoped(items, space).filter(i => !i.read).length;
