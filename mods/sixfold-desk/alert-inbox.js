import { div, image } from 'gpui-kit';
import { h_flex } from 'gpui-base';
import { shared, openOverlay } from 'herdr';
import { scopedAlerts } from './alert-model.js';

export function openInbox(scope = {}) {
  return openOverlay({mod:'sixfold-slack-inbox',kind:'dialog',width:760,height:620,props:{...scope,newMessages:true}});
}
export const hasWorkspaceAlerts = name => (shared('sixfold.alertProjects') ?? []).some(p=>p.toLowerCase()===name?.toLowerCase());
export function workspaceAlertsRow(space,t) {
  if(!hasWorkspaceAlerts(space.name))return div();
  return h_flex().id(`sf-channel-alerts-${space.id}`).h(26).flex_none().px(10).gap(6).items_center()
    .child(alertBadge(`space-${space.id}`,t,{project:space.name}))
    .child(div().text_size(10).text_color(t.muted).child('채널 알림'));
}
export function alertBadge(id,t,scope={}) {
  if(!hasWorkspaceAlerts(scope.project))return div();
  const unread=scopedAlerts(shared('sixfold.alertItems') ?? [],{...scope,read:shared('sixfold.alertRead') ?? {},unread:true}).length;
  return div().id(`sf-slack-${id}`).flex_none().px(5).py(2).rounded(4).text_size(10)
    .bg(unread?t.accent:t.surface).text_color(unread?t.accent_foreground:t.muted)
    .tooltip(`팝업에서 미확인 ${unread}건 · Slack 앱 읽음 상태와 별도`)
    .on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_mouse_up('left',(_e,cx)=>cx.stop_propagation())
    .on_click((_e,cx)=>{cx.stop_propagation();openInbox(scope);})
    .flex().items_center().gap(3).child(image('mods/sixfold-desk/icons/slack.svg').size(13))
    .when(unread>0,e=>e.child(div().child(String(unread))));
}
