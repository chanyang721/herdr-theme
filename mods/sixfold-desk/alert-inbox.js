import { div, image } from 'gpui-kit';
import { h_flex } from 'gpui-base';
import { shared, openOverlay } from 'herdr';
import { scopedAlerts, linearUnread } from './alert-model.js';

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
export function workspaceAlertsRow(space,t) {
  if(!hasWorkspaceAlerts(space.name))return div();
  return h_flex().id(`sf-channel-alerts-${space.id}`).h(26).flex_none().px(10).gap(6).items_center()
    .child(alertBadge(`space-${space.id}`,t,{project:space.name}))
    .child(linearBadge(`space-${space.id}`,t,{project:space.name}))
    .child(div().text_size(10).text_color(t.muted).child('알림'));
}
export function alertBadge(id,t,scope={}) {
  if(!hasSlackAlerts(scope.project))return div();
  const unread=scopedAlerts(shared('sixfold.alertItems') ?? [],{...scope,read:shared('sixfold.alertRead') ?? {},unread:true}).length;
  return div().id(`sf-slack-${id}`).flex_none().px(5).py(2).rounded(4).text_size(10)
    .bg(unread?t.accent:t.surface).text_color(unread?t.accent_foreground:t.muted)
    .tooltip(`팝업에서 미확인 ${unread}건 · Slack 앱 읽음 상태와 별도`)
    .on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_mouse_up('left',(_e,cx)=>cx.stop_propagation())
    .on_click((_e,cx)=>{cx.stop_propagation();openInbox(scope);})
    .flex().items_center().gap(3).child(image('mods/sixfold-desk/icons/slack.svg').size(13))
    .when(unread>0,e=>e.child(div().child(String(unread))));
}
export function linearBadge(id,t,scope={}) {
  if(!hasLinearAlerts(scope.project))return div();
  const unread=linearUnread(shared('sixfold.linearItems') ?? [],scope.project);
  return div().id(`sf-linear-${id}`).flex_none().px(5).py(2).rounded(4).text_size(10)
    .bg(unread?t.accent:t.surface).text_color(unread?t.accent_foreground:t.muted)
    .tooltip(`Linear 미확인 알림 ${unread}건`)
    .on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_mouse_up('left',(_e,cx)=>cx.stop_propagation())
    .on_click((_e,cx)=>{cx.stop_propagation();openLinearInbox(scope);})
    .flex().items_center().gap(3).child(image('mods/sixfold-desk/icons/linear.svg').size(13))
    .when(unread>0,e=>e.child(div().child(String(unread))));
}
