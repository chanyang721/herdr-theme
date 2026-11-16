import { projectKey } from './alert-model.js';
import { arrivalTarget } from './arrival-model.js';

// Mentions routed to a space (slack-mentions.json: unmapped channels, DMs and thread replies go to Share).
// They give that space its Slack badge and rows even when the tracked feed (project-alerts.json) has none.
// Module state grouped by space, set by alerts.js on each load: not a shared value, which is persisted
// and copied on every read — the badge reads this several times per card, and copying the whole list
// each time pushed the sidebar past its render budget ("could not be re-rendered … interrupted").
// A mention whose space is not on the sidebar ('미연결', a closed space) is grouped under Share, the
// card its arrival lands on (arrivalTarget), so it stays in Share's badge and popover after the peek.
// With no sidebar names (not loaded yet) each mention keeps its own space.
let mentionsBySpace = new Map();
export function setSpaceMentions(items, names = []) {
  const next = new Map(), onScreen = (names ?? []).length > 0;
  for (const item of items ?? []) {
    if (!item || typeof item.id !== 'string') continue;
    const space = onScreen ? arrivalTarget(item.project, names) : item.project, key = projectKey(space);
    if (!next.has(key)) next.set(key, []);
    // A moved mention carries Share as its project (as placeItems does for Linear), so the badge's
    // per-space filter (scopedAlerts) counts it; the collector's value stays in project_raw.
    next.get(key).push(key === projectKey(item.project) ? item : {...item, project: space, project_raw: item.project ?? ''});
  }
  mentionsBySpace = next;
}
export const spaceMentions = project => mentionsBySpace.get(projectKey(project)) ?? [];
