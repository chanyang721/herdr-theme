import {div,svg} from 'gpui-kit';

const label=value=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,80):'';
function humanName(value){
  const name=label(value);
  // The caller supplies a display name, never a machine address or path.
  return /[\\/@:]|\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(name)?'':name;
}

/** Informational row adornments from an already normalized detail object. */
export function rowDetailParts(detail,t,{compact=true,motion=false}={}){
  const value=detail&&typeof detail==='object'?detail:{};
  const error=label(value.errorLabel),remote=humanName(value.remoteName);
  const quota=value.quota&&typeof value.quota==='object'?value.quota:null;
  const quotaLabel=label(quota?.label),limited=quota?.limited===true;
  const unread=Number.isFinite(value.unread)?Math.max(0,Math.floor(value.unread)):0;
  const blocked=t.blocked||t.muted;
  const tooltip=[error,limited?(quotaLabel||'Usage limit reached'):'',remote?`Remote: ${remote}`:'',unread?`${Math.min(unread,99)}${unread>99?'+':''} unread`:'' ].filter(Boolean).join(' · ');
  const remoteBadge=remote?div().absolute().right(-3).bottom(-2).size(9).flex_none().rounded(2)
    .bg(t.background).tooltip(`Remote: ${remote}`)
    .child(svg('mods/sixfold-desk/icons/device-computer.svg').size(8).text_color(t.muted)):null;
  const unreadBadge=unread?div().w(compact?18:20).h(13).flex_none().rounded(4)
    .text_size(8).text_color(t.accent||t.foreground).bg(t.selected||t.surface)
    .items_center().justify_center().tooltip(`${unread>99?'99+':unread} unread`)
    .child(unread>99?'99+':String(unread)):null;
  // Both states reuse the caller's status slot. No animation is needed, even
  // when motion is enabled; motion-off therefore has no scheduled work.
  void motion;
  return {remoteBadge,unreadBadge,statusMark:error?'!':limited?'◷':null,
    statusColor:error||limited?blocked:null,tooltip};
}
