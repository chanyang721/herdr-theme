import { div, image } from 'gpui-kit';
import { shared, openOverlay } from 'herdr';
import { scopedAlerts } from './alert-model.js';

export function openInbox(scope = {}) {
  return openOverlay({mod:'sixfold-slack-inbox',kind:'dialog',width:760,height:620,props:{...scope,newMessages:true}});
}
export function alertBadge(id,t,scope={}) {
  if(!(shared('sixfold.alertProjects') ?? []).some(name=>name.toLowerCase()===scope.project?.toLowerCase()))return div();
  const unread=scopedAlerts(shared('sixfold.alertItems') ?? [],{...scope,read:shared('sixfold.alertRead') ?? {},unread:true}).length;
  return div().id(`sf-slack-${id}`).flex_none().px(5).py(2).rounded(4).text_size(10)
    .bg(unread?t.accent:t.surface).text_color(unread?t.accent_foreground:t.muted)
    .tooltip(`새 메시지 ${unread}건 · 클릭하여 원문 확인`)
    .on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_mouse_up('left',(_e,cx)=>cx.stop_propagation())
    .on_click((_e,cx)=>{cx.stop_propagation();openInbox(scope);})
    .flex().items_center().gap(3).child(image('mods/sixfold-desk/icons/slack.svg').size(13))
    .when(unread>0,e=>e.child(div().child(String(unread))));
}
