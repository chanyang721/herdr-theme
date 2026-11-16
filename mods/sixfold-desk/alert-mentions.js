import { projectKey } from './alert-model.js';

// Mentions routed to a space (slack-mentions.json: unmapped channels, DMs and thread replies go to Share).
// They give that space its Slack badge and rows even when the tracked feed (project-alerts.json) has none.
// Module state grouped by space, set by alerts.js on each load: not a shared value, which is persisted
// and copied on every read — the badge reads this several times per card, and copying the whole list
// each time pushed the sidebar past its render budget ("could not be re-rendered … interrupted").
let mentionsBySpace = new Map();
export function setSpaceMentions(items) {
  const next = new Map();
  for (const item of items ?? []) {
    if (!item || typeof item.id !== 'string') continue;
    const key = projectKey(item.project);
    if (!next.has(key)) next.set(key, []);
    next.get(key).push(item);
  }
  mentionsBySpace = next;
}
export const spaceMentions = project => mentionsBySpace.get(projectKey(project)) ?? [];
