import { div, image } from 'gpui-kit';
import { h_flex } from 'gpui-base';
import { shared, openOverlay } from 'herdr';
import { scopedAlerts, linearScoped, slackCopyDelay } from './alert-model.js';
import { alertPopover, showPopover, popoverState } from './alert-popover.js';
import { arrivals } from './arrival-store.js';
import { flyingIds } from './arrival-model.js';

// An alert still flying in from its popup is counted once it lands.
const landedOnly = (items, scope) => { const flying = flyingIds(arrivals(), Date.now(), scope.motion !== false); return flying.size ? items.filter(i => !flying.has(i.id)) : items; };
const slackUnread = scope => landedOnly(scopedAlerts(shared('sixfold.alertItems') ?? [],{...scope,read:shared('sixfold.alertRead') ?? {},unread:true}),scope).length;
const linearUnreadNow = scope => landedOnly(linearScoped(shared('sixfold.linearItems') ?? [],scope.project).filter(i=>!i.read),scope).length;
// What the card's alerts row shows; part of the retained card's signature so the row redraws when it changes.
export function alertSignature(name, motion = true) {
  if(!hasWorkspaceAlerts(name))return '';
  const scope={project:name,motion},open=popoverState();
  return [hasSlackAlerts(name),hasLinearAlerts(name),slackUnread(scope),linearUnreadNow(scope),open?.space===name?`${open.source}:${open.boot}:${open.at}`:''].join('|');
}

export function openInbox(scope = {}) {
  return openOverlay({mod:'sixfold-slack-inbox',kind:'dialog',width:760,height:620,props:{...scope,newMessages:true}});
}
export function openLinearInbox(scope = {}) {
  return openOverlay({mod:'sixfold-linear-inbox',kind:'dialog',width:860,height:680,props:{...scope}});
}
const named = (list,name) => (list ?? []).some(p=>String(p).toLowerCase()===name?.toLowerCase());
export const hasSlackAlerts = name => named(shared('sixfold.alertProjects'),name);
export const hasLinearAlerts = name => named(shared('sixfold.linearSpaces'),name);
// The sidebar reserves the alerts row from this (row height), so it covers both sources.
export const hasWorkspaceAlerts = name => hasSlackAlerts(name) || hasLinearAlerts(name);
// The whole row is the popover trigger, so the surface opens beside the card.
// A badge press picks which source the popover shows first.
export function workspaceAlertsRow(space,t,{motion=true}={}) {
  if(!hasWorkspaceAlerts(space.name))return div();
  const scope={project:space.name,motion};
  const row=h_flex().id(`sf-channel-alerts-${space.id}`).h(26).w_full().px(10).gap(6).items_center().cursor_pointer()
    .child(alertBadge(`space-${space.id}`,t,{...scope,popover:true}))
    .child(linearBadge(`space-${space.id}`,t,{...scope,popover:true}));   // same chips as the merged meta line, no separate label
  // Presses stop here so the card underneath is not selected or dragged.
  const stop=(_e,cx)=>cx.stop_propagation();
  return div().id(`sf-channel-alerts-wrap-${space.id}`).h(26).flex_none().on_mouse_down('left',stop).on_mouse_up('left',stop)
    .child(alertPopover({id:space.id,project:space.name,trigger:row,t,hasSlack:hasSlackAlerts(space.name),hasLinear:hasLinearAlerts(space.name),
      onAll:source=>source==='linear'?openLinearInbox({project:space.name}):openInbox({project:space.name})}));
}
// A task card carries its alerts on its meta line when that line can show both
// sources (a Linear chip, or no Linear alerts); otherwise the alerts row stays.
// Exactly one of the two is drawn, so one alerts popover belongs to a card.
export const alertsOnMetaLine = (task, name) => Boolean(task && (task.slack || task.work) && (task.work?.tool === 'linear' || !hasLinearAlerts(name)));
// A task card shows Slack and Linear on its one meta line: the Slack part opens the
// Slack alerts, the Linear chip (key · issues · unread) opens the issue search.
export function cardAlertCounts(name, motion = true) {
  const scope = {project: name, motion};
  const delay = hasSlackAlerts(name) ? slackCopyDelay(shared('sixfold.slackHealth')) : null;
  return {hasSlack: hasSlackAlerts(name), slack: hasSlackAlerts(name) ? slackUnread(scope) : 0, linear: hasLinearAlerts(name) ? linearUnreadNow(scope) : 0,
    delay: delay ? delay.hours : 0, delayAt: delay?.at || ''};
}
export function slackAlertsChip(space, trigger, t) {
  if (!alertsOnMetaLine(space, space.name)) return trigger;   // the alerts row has the popover for this card
  const stop = (_e, cx) => cx.stop_propagation();
  return div().id(`sf-slack-chip-wrap-${space.id}`).flex_1().min_w(0).on_mouse_down('left', stop).on_mouse_up('left', stop)
    .child(alertPopover({id: `meta-${space.id}`, project: space.name, trigger, t, hasSlack: true, hasLinear: false,
      onAll: () => openInbox({project: space.name})}));
}
// Inside the card row a badge only chooses the popover source; elsewhere it opens the inbox.
const badgePress=(scope,source,open)=>(_e,cx)=>{
  if(scope.popover){showPopover(scope.project,source);return;}
  cx.stop_propagation();open(scope);
};
export function alertBadge(id,t,scope={}) {
  if(!hasSlackAlerts(scope.project))return div();
  const unread=slackUnread(scope);
  return div().id(`sf-slack-${id}`).flex_none().px(5).py(2).rounded(4).text_size(10)
    .bg(unread?t.accent:t.surface).text_color(unread?t.accent_foreground:t.muted)
    .tooltip(`팝업에서 미확인 ${unread}건 · Slack 앱 읽음 상태와 별도`)
    .when(!scope.popover,e=>e.on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_mouse_up('left',(_e,cx)=>cx.stop_propagation()))
    .on_click(badgePress(scope,'slack',openInbox))
    .flex().items_center().gap(3).child(image('mods/sixfold-desk/icons/slack.svg').size(13))
    .when(unread>0,e=>e.child(div().child(String(unread))))
    .when(Boolean(slackCopyDelay(shared('sixfold.slackHealth'))),e=>e.child(div().text_size(9).text_color(t.blocked||t.muted).child('사본 지연')));
}
export function linearBadge(id,t,scope={}) {
  if(!hasLinearAlerts(scope.project))return div();
  const unread=linearUnreadNow(scope);
  return div().id(`sf-linear-${id}`).flex_none().px(5).py(2).rounded(4).text_size(10)
    .bg(unread?t.accent:t.surface).text_color(unread?t.accent_foreground:t.muted)
    .tooltip(`Linear 미확인 알림 ${unread}건`)
    .when(!scope.popover,e=>e.on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_mouse_up('left',(_e,cx)=>cx.stop_propagation()))
    .on_click(badgePress(scope,'linear',openLinearInbox))
    .flex().items_center().gap(3).child(image('mods/sixfold-desk/icons/linear.svg').size(13))
    .when(unread>0,e=>e.child(div().child(String(unread))));
}
