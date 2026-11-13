import { div } from 'gpui-kit';
import { Popup } from 'gpui-base';
import { settings, appHome, readTextFile, writeTextFile } from 'herdr';
import { alertPopoverOpen, slackPeek } from './alert-popover.js';
import { hasWorkspaceAlerts, hasSlackAlerts, hasLinearAlerts, openInbox, openLinearInbox, alertSignature } from './alert-inbox.js';
import { watchLinear } from './linear-feed.js';
import { arrivals, setArrivalHost, clearArrivalHost, setPeekCheck, holdArrivals } from './arrival-store.js';
import { nextPhaseAt, arrivalOpen, peekMode } from './arrival-model.js';
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
  // A new alert opens its space's popover (a peek) on any card that is on screen (merged meta line or
  // a separate alerts row), with motion on, and while no issue search or alert popover is open; then
  // the chip only counts it (arrival-model.js peekMode).
  const decide = (space, source) => peekMode({host: host(), motion: view.arrivalMotion, card: view.arrivalCards?.get(projectKey(space)),
    issuesOpen: Boolean(view.panelRetained?.anyIssuesOpen?.()), popoverOpen: alertPopoverOpen(), source});
  // The last few decisions, kept in a small local file so "why did it not open" can be answered.
  let last = undefined;
  const note = entry => {
    const path = `${appHome()}/data/sixfold/arrival-peek-log.json`;
    cx.spawn(async () => {
      try {
        if (last === undefined) last = await readTextFile(path).catch(() => null);
        const list = (() => { try { return JSON.parse(last || '[]'); } catch { return []; } })();
        const next = JSON.stringify([...(Array.isArray(list) ? list : []), entry].slice(-20));
        await writeTextFile(path, next, last); last = next;
      } catch { last = undefined; }
    });
  };
  const check = (space, source) => {
    const [mode, why] = decide(space, source);
    note({at: new Date().toISOString(), space, source, mode: mode || 'popup', why});
    return mode;
  };
  setPeekCheck(check);
  const stop = () => { clearArrivalHost(host); setPeekCheck(null); view.arrivalWake?.cancel?.(); view.arrivalWake = null; stopLinear(); };
  view.stopArrivals = stop;
  return stop;
}

export const alertCardSignature = (name, motion) => alertSignature(name, motion);

// `cards` = [{s, top, extra}] in the workspace list's coordinates. One finite
// wake per phase edge; none while nothing is arriving.
export function alertArrivalLayer(view, cx, {cards, motion, t, right}) {
  const now = Date.now(), list = arrivals(now);
  const at = new Map(cards.map(card => [projectKey(card.s.name), card]));
  // What the peek check reads when the next alert arrives (bounded by the cards on screen).
  view.arrivalMotion = motion;
  // Every card on screen; Linear needs its chip (the merged line's tool chip, or a Linear badge in the alerts row).
  view.arrivalCards = new Map(cards.map(card => [projectKey(card.s.name),
    {merged: Boolean(card.merged), linear: card.merged ? card.width > 80 : hasLinearAlerts(card.s.name)}]));
  const anchors = (space, source) => {
    const hit = at.get(projectKey(space));
    if (!hit) return null;
    // Merged card: Slack lands on the left of the meta line, Linear on its tool chip at the right end.
    if (hit.merged) return {top: hit.top, left: 11, right, badgeY: hit.top + 38 + hit.extra + 10, edge: 11 + Math.max(0, hit.width - 6),
      badgeX: source === 'linear' && hit.width > 80 ? 11 + hit.width - 40 : 26};
    // Alerts row card: the badge in its alerts row; the peek opens at the card's right edge, as on a merged card.
    const alerts = hasWorkspaceAlerts(hit.s.name);
    return {top: hit.top, left: 11, right, badgeY: alerts ? hit.top + 38 + hit.extra + 13 : hit.top + 18,
      badgeX: alerts && source === 'linear' && hasSlackAlerts(hit.s.name) ? 72 : 33,
      ...(hit.width > 0 ? {edge: 11 + Math.max(0, hit.width - 6)} : {})};
  };
  const next = nextPhaseAt(list, now, motion);
  if (next !== null && !(view.arrivalWake && view.arrivalWakeAt <= next)) {
    view.arrivalWake?.cancel?.();
    view.arrivalWakeAt = next;
    view.arrivalWake = cx.timer.after(Math.max(16, next - now), () => {
      view.arrivalWake = null; view.arrivalWakeAt = null;
      view.panelRetained?.alertsChanged?.();   // a landed alert is counted on the card's meta line
      view.invalidateSidebar ? view.invalidateSidebar() : cx.notify();
    });
  }
  const redraw = () => { view.panelRetained?.alertsChanged?.(); view.invalidateSidebar ? view.invalidateSidebar() : cx.notify(); };
  // The peek surface: a Popup pinned to the card's right edge, beside where the issue search opens.
  // Resting the pointer on it holds it open; leaving restarts its time.
  const peek = ({space, source, arrivals: shown, anchor}) => {
    const fresh = shown.map(a => a.id);
    const body = source === 'linear' ? view.panelRetained?.peekIssues?.(space, fresh, t)
      : slackPeek(space, t, fresh, () => openInbox({project: space}));
    if (!body) return null;
    const key = `${projectKey(space)}-${source}`;
    return div().id(`sf-peek-${key}`).absolute().left(anchor.edge ?? anchor.badgeX).top(anchor.badgeY).size(2)
      .child(Popup.new(`sf-peek-pop-${key}`, div().size(2)).anchor('left_center')
        .content(div().id(`sf-peek-body-${key}`).ml(right + 8)
          .on_hover((hovered, _cx) => { if (holdArrivals(space, source, hovered)) redraw(); })
          .child(body)));
  };
  return arrivalLayer({list, now, motion, anchors, t, u: 1 / (Number(settings()?.zoom) || 1), peek,
    onOpen: a => { const open = arrivalOpen(a); open.source === 'linear' ? openLinearInbox({project: open.project}) : openInbox({project: open.project}); }});
}
