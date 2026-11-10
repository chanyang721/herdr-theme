import { settings } from 'herdr';
import { hasWorkspaceAlerts, hasSlackAlerts, openInbox, openLinearInbox, alertSignature } from './alert-inbox.js';
import { watchLinear } from './linear-feed.js';
import { arrivals, setArrivalHost, clearArrivalHost } from './arrival-store.js';
import { nextPhaseAt, arrivalOpen } from './arrival-model.js';
import { arrivalLayer } from './arrival-view.js';
import { projectKey } from './alert-model.js';

// The sidebar's side of new-alert arrivals, in one place: the Linear feed
// subscription, the host flag (alerts fold into cards only while this sidebar
// is shown, otherwise their window opens) and the layer drawn over the cards.
export function startAlertArrivals(view, cx) {
  view.stopArrivals?.();
  const stopLinear = watchLinear(view, cx);
  const host = () => view.sidebarVisible !== false;
  setArrivalHost(host);
  const stop = () => { clearArrivalHost(host); view.arrivalWake?.cancel?.(); view.arrivalWake = null; stopLinear(); };
  view.stopArrivals = stop;
  return stop;
}

export const alertCardSignature = (name, motion) => alertSignature(name, motion);

// `cards` = [{s, top, extra}] in the workspace list's coordinates. One finite
// wake per phase edge; none while nothing is arriving.
export function alertArrivalLayer(view, cx, {cards, motion, t, right}) {
  const now = Date.now(), list = arrivals();
  const at = new Map(cards.map(card => [projectKey(card.s.name), card]));
  const anchors = (space, source) => {
    const hit = at.get(projectKey(space));
    if (!hit) return null;
    const alerts = hasWorkspaceAlerts(hit.s.name);
    return {top: hit.top, left: 11, right, badgeY: alerts ? hit.top + 38 + hit.extra + 13 : hit.top + 18,
      badgeX: alerts && source === 'linear' && hasSlackAlerts(hit.s.name) ? 72 : 33};
  };
  const next = nextPhaseAt(list, now, motion);
  if (next !== null && !(view.arrivalWake && view.arrivalWakeAt <= next)) {
    view.arrivalWake?.cancel?.();
    view.arrivalWakeAt = next;
    view.arrivalWake = cx.timer.after(Math.max(16, next - now), () => {
      view.arrivalWake = null; view.arrivalWakeAt = null;
      view.invalidateSidebar ? view.invalidateSidebar() : cx.notify();
    });
  }
  return arrivalLayer({list, now, motion, anchors, t, u: 1 / (Number(settings()?.zoom) || 1),
    onOpen: a => { const open = arrivalOpen(a); open.source === 'linear' ? openLinearInbox({project: open.project}) : openInbox({project: open.project}); }});
}
