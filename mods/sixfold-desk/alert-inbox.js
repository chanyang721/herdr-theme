import { div, image } from 'gpui-kit';
import { h_flex } from 'gpui-base';
import { shared, openOverlay } from 'herdr';
import { createHash } from 'crypto';
import { scopedAlerts, linearScoped, githubScoped, slackCopyDelay, projectKey, workspaceAlertCounts, workspaceAlertTimeline, folded, linkFeedSlack } from './alert-model.js';
import { alertPopover, showPopover, popoverState, spaceMentions } from './alert-popover.js';
import { mentionsEpoch, spaceNeeds } from './alert-mentions.js';
import { arrivals } from './arrival-store.js';
import { flyingIds } from './arrival-model.js';

// An alert still flying in from its popup is counted once it lands.
const landedOnly = (items, scope) => { const flying = flyingIds(arrivals(), Date.now(), scope.motion !== false); return flying.size ? items.filter(i => !flying.has(i.id)) : items; };
// shared() copies the whole value on every read (the tracked feed is hundreds of KB), and every
// card asks several times per render. The feed is read and grouped by space once per load
// instead: alerts.js sets it together with the mentions, whose epoch is the version key.
let slackIndex = { epoch: undefined, bySpace: new Map(), ids: new Set(), hidden: new Set() };
const trackedIndex = () => {
  const epoch = mentionsEpoch();
  if (slackIndex.epoch === epoch) return slackIndex;
  const bySpace = new Map(), ids = new Set(), hidden = new Set();
  for (const item of shared('sixfold.alertItems') ?? []) {
    ids.add(item.id);
    if (folded(item)) { hidden.add(item.id); continue; }   // still dedupes its mention copy, never counted or listed
    const key = projectKey(item.project);
    if (!bySpace.has(key)) bySpace.set(key, []);
    bySpace.get(key).push(item);
  }
  return slackIndex = { epoch, bySpace, ids, hidden };
};
// The space's tracked Slack alerts plus the mentions routed to it that the tracked feed does not list.
const slackItems = project => { const { bySpace, ids } = trackedIndex();
  return [...(bySpace.get(projectKey(project)) ?? []), ...spaceMentions(project).filter(i => !ids.has(i.id))]; };
const slackUnread = scope => landedOnly(scopedAlerts(slackItems(scope.project),{...scope,read:shared('sixfold.alertRead') ?? {},unread:true}),scope).length;
const linearUnreadNow = scope => landedOnly(linearScoped(shared('sixfold.linearItems') ?? [],scope.project).filter(i=>!i.read),scope).length;
// GitHub counts the work it lists as unread (a review request, my pull request that needs me, an unread mention).
const githubUnreadNow = scope => landedOnly(githubScoped(shared('sixfold.githubItems') ?? [],scope.project).filter(i=>i.unread),scope).length;
// What the card's alerts row shows; part of the retained card's signature so the row redraws when it changes.
export function alertSignature(name, motion = true) {
  if(!hasWorkspaceAlerts(name))return '';
  const scope={project:name,motion},open=popoverState();
  // The copy-delay mark (hours shown and the copy's last message) redraws the row when it starts, moves or ends.
  const delay=hasSlackAlerts(name)?slackCopyDelay(shared('sixfold.slackHealth')):null;
  return [hasSlackAlerts(name),hasLinearAlerts(name),hasGithubAlerts(name),spaceNeeds(name).map(i=>i.id).join(','),slackUnread(scope),linearUnreadNow(scope),hasGithubAlerts(name)?githubUnreadNow(scope):0,
    open?.space===name?`${open.source}:${open.boot}:${open.at}`:'',
    delay?`${delay.hours}:${delay.at}`:''].join('|');
}

// A space with a tracked feed opens its channel messages; one without (the fallback space, which only receives
// mentions) opens its mentions, so 전체 보기 is never an empty list.
export function openInbox(scope = {}) {
  const newMessages = !scope.project || named(shared('sixfold.alertProjects'), scope.project);
  return openOverlay({mod:'sixfold-slack-inbox',kind:'dialog',width:760,height:620,props:{...scope,newMessages}});
}
export function openLinearInbox(scope = {}) {
  return openOverlay({mod:'sixfold-linear-inbox',kind:'dialog',width:860,height:680,props:{...scope}});
}
export function openGithubInbox(scope = {}) {
  return openOverlay({mod:'sixfold-github-inbox',kind:'dialog',width:820,height:660,props:{...scope}});
}
const openFor = (source, scope) => source === 'linear' ? openLinearInbox(scope) : source === 'github' ? openGithubInbox(scope) : openInbox(scope);
const named = (list,name) => (list ?? []).some(p=>String(p).toLowerCase()===name?.toLowerCase());
export const hasSlackAlerts = name => named(shared('sixfold.alertProjects'),name) || spaceMentions(name).length > 0;
export const hasLinearAlerts = name => named(shared('sixfold.linearSpaces'),name);
export const hasGithubAlerts = name => named(shared('sixfold.githubSpaces'),name);
// The sidebar reserves the alerts row from this (row height), so it covers both sources.
export const hasNeeds = name => spaceNeeds(name).length > 0;
export const hasWorkspaceAlerts = name => hasSlackAlerts(name) || hasLinearAlerts(name) || hasGithubAlerts(name) || hasNeeds(name);
// The whole row is the popover trigger, so the surface opens beside the card.
// A badge press picks which source the popover shows first.
export function workspaceAlertsRow(space,t,{motion=true}={}) {
  if(!hasWorkspaceAlerts(space.name))return div();
  const scope={project:space.name,motion};
  const row=h_flex().id(`sf-channel-alerts-${space.id}`).h(26).w_full().px(10).gap(6).items_center().cursor_pointer()
    .child(alertBadge(`space-${space.id}`,t,{...scope,popover:true}))
    .child(linearBadge(`space-${space.id}`,t,{...scope,popover:true}))   // same chips as the merged meta line, no separate label
    .child(githubBadge(`space-${space.id}`,t,{...scope,popover:true}))
    .child(needsBadge(`space-${space.id}`,t,{...scope,popover:true}));
  // Presses stop here so the card underneath is not selected or dragged.
  const stop=(_e,cx)=>cx.stop_propagation();
  return div().id(`sf-channel-alerts-wrap-${space.id}`).h(26).flex_none().on_mouse_down('left',stop).on_mouse_up('left',stop)
    .child(alertPopover({id:space.id,project:space.name,trigger:row,t,hasSlack:hasSlackAlerts(space.name),hasLinear:hasLinearAlerts(space.name),
      hasGithub:hasGithubAlerts(space.name),hasNeeds:hasNeeds(space.name),onAll:source=>openFor(source,{project:space.name})}));
}
// A task card carries its alerts on its meta line when that line can show both
// sources (a Linear chip, or no Linear alerts) and the space has no GitHub chip (the
// meta line has no room for a third); otherwise the alerts row stays.
// Exactly one of the two is drawn, so one alerts popover belongs to a card.
export const alertsOnMetaLine = (task, name) => Boolean(task && (task.slack || task.work) && (task.work?.tool === 'linear' || !hasLinearAlerts(name)) && !hasGithubAlerts(name) && !hasNeeds(name));
// A task card shows Slack and Linear on its one meta line: the Slack part opens the
// Slack alerts, the Linear chip (key · issues · unread) opens the issue search.
export function cardAlertCounts(name, motion = true) {
  const scope = {project: name, motion};
  const delay = hasSlackAlerts(name) ? slackCopyDelay(shared('sixfold.slackHealth')) : null;
  return {hasSlack: hasSlackAlerts(name), slack: hasSlackAlerts(name) ? slackUnread(scope) : 0, linear: hasLinearAlerts(name) ? linearUnreadNow(scope) : 0,
    delay: delay ? delay.hours : 0, delayAt: delay?.at || ''};
}
// Use the space's optional alerts DTO when present. Older installations can
// still read their existing feeds with the same fallback-space placement.
const sha256 = value => createHash('sha256').update(value).digest('hex');
// Only the list ties feed rows to their Slack messages (link and read key); counts never need them.
const notificationInput = (name, options, link = false) => {
  if(Array.isArray(options.alerts?.items))return {space:name,...options,...(link?{alerts:{...options.alerts,
    items:linkFeedSlack(options.alerts.items,[...(shared('sixfold.alertItems')??[]),...spaceMentions(name)],sha256)}}:{})};
  return {space:name,slack:[...slackItems(name),...spaceMentions(name).filter(i=>!trackedIndex().hidden.has(i.id))],
    linear:shared('sixfold.linearItems')??[],github:shared('sixfold.githubItems')??[],read:shared('sixfold.alertRead')??{},...options};
};
export function workspaceUnreadCounts(name,options={}) {
  const input=notificationInput(name,options);
  if(Array.isArray(input.alerts?.items))return workspaceAlertCounts(input);
  // Delay native badge counts until the arrival lands, as the source badges do.
  // The notification list still shows every item, including an open arrival.
  return workspaceAlertCounts({...input,slack:landedOnly(input.slack??[],options),
    linear:landedOnly(input.linear??[],options),github:landedOnly(input.github??[],options)});
}
export const workspaceNotifications = (name,options={}) => workspaceAlertTimeline(notificationInput(name,options,true));
// The card head supplies an opener for its own issue popover, selecting alerts.
// Keep this separate from source badges, whose legacy inboxes are still usable.
export function workspaceUnreadBadge(space,t,{onOpen,alerts=space.alerts,connections,motion=true}={}){
  const count=workspaceUnreadCounts(space.name,{alerts,connections,motion}).total;
  if(!count)return div();
  const stop=(_event,cx)=>cx.stop_propagation();
  return div().id(`sf-unread-${space.id}`).flex_none().px(5).py(1).rounded(7).text_size(10)
    .text_color(t.accent).tooltip(`안 읽은 알림 ${count}건`)
    .on_mouse_down('left',stop).on_mouse_up('left',stop)
    .when(Boolean(onOpen),e=>e.cursor_pointer().on_click((_event,cx)=>{cx.stop_propagation();onOpen(space,'alerts',cx);}))
    .child(String(count));
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
    .flex().items_center().gap(2).child(image('mods/sixfold-desk/icons/slack.svg').size(13))
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
// Requests that need the person (a waiting pane, a mention to sort) placed on this space.
export function needsBadge(id,t,scope={}) {
  const items=spaceNeeds(scope.project);
  if(!items.length)return div();
  return div().id(`sf-needs-${id}`).flex_none().px(5).py(2).rounded(4).text_size(10).font_bold()
    .bg(t.blocked||t.accent).text_color(t.background)
    .tooltip(`확인 필요 ${items.length}건\n${items.slice(0,6).map(i=>String(i.title||i.summary||'').split('\n')[0]).join('\n')}`)
    .when(!scope.popover,e=>e.on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_mouse_up('left',(_e,cx)=>cx.stop_propagation()))
    .on_click(badgePress(scope,'needs',()=>{}))
    .child(`! ${items.length}`);
}
export function githubBadge(id,t,scope={}) {
  if(!hasGithubAlerts(scope.project))return div();
  const unread=githubUnreadNow(scope);
  return div().id(`sf-github-${id}`).flex_none().px(5).py(2).rounded(4).text_size(10)
    .bg(unread?t.accent:t.surface).text_color(unread?t.accent_foreground:t.muted)
    .tooltip(`GitHub 손볼 일 ${unread}건 · 리뷰 요청·내 PR(CI 실패·변경 요청·충돌)·멘션`)
    .when(!scope.popover,e=>e.on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_mouse_up('left',(_e,cx)=>cx.stop_propagation()))
    .on_click(badgePress(scope,'github',openGithubInbox))
    .flex().items_center().gap(3).child(image('mods/sixfold-desk/icons/github.svg').size(13))
    .when(unread>0,e=>e.child(div().child(String(unread))));
}
