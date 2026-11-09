import {div,image} from 'gpui-kit';
import {paletteMode} from './collab-flow.js';

// Display states are supplied by a producer. This module does not decide
// whether a session may be kept, closed, or given an idle deadline.
// Keys follow the panel feed's `state` names; `asset` is the packaged file stem.
export const SESSION_STATES=Object.freeze({
  working:{label:'작업 중',shape:'spinner',animated:true,asset:'working'},
  idle:{label:'쉬는 중',shape:'ring',animated:false,asset:'idle'},
  needs_human:{label:'확인 필요',shape:'diamond',animated:true,asset:'needs_input'},
  unseen_result:{label:'결과 안 봄',shape:'check',animated:true,asset:'unseen_result'},
  cleanup_wait:{label:'정리 대기',shape:'moon',animated:true,asset:'cleanup_wait'},
  closing:{label:'닫는 중',shape:'tray',animated:true,asset:'closing'},
  closed:{label:'닫힘',shape:'box',animated:false,asset:'closed'},
});
const text=value=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,240):'';
export function sessionDisplay(value){
  if(!value||!Object.prototype.hasOwnProperty.call(SESSION_STATES,value.state))return null;
  return {state:value.state,reason:text(value.reason),...SESSION_STATES[value.state]};
}
export function sessionDescription(value){
  const state=sessionDisplay(value);if(!state)return '';
  return state.reason.startsWith(state.label)?state.reason:[state.label,state.reason].filter(Boolean).join(' · ');
}
export function sessionStatusAsset(value,t,{size=12,motion=true,visible=true,eventActive=false}={}){
  const state=sessionDisplay(value);if(!state)return null;
  const pixels=size===16?16:12;
  const animated=state.animated&&motion&&visible&&!eventActive;
  return {path:`mods/sixfold-desk/icons/status/${state.asset}-${pixels}-${paletteMode(t)}.${animated?'webp':'png'}`,size:pixels,animated};
}
export function sessionStatusGlyph(value,t,options={}){
  const asset=sessionStatusAsset(value,t,options);if(!asset)return null;
  const description=sessionDescription(value);
  // The native image decoder owns animation. Motion-off, hidden and transient
  // event states select an actual stationary PNG, without a script timer.
  return image(asset.path).id(`session-status-${options.id||'glyph'}`).size(asset.size).flex_none()
    .tooltip(description).accessibility_label(description);
}
export function sessionReasonLine(value,t,{id='reason',size=10}={}){
  const state=sessionDisplay(value);if(!state?.reason)return null;
  return div().id(`session-reason-${id}`).min_w(0).truncate().text_size(size).text_color(t.muted)
    .tooltip(state.reason).accessibility_label(state.reason).child(state.reason);
}
