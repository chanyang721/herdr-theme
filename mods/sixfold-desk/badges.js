import {div} from 'gpui-kit';
import {h_flex} from 'gpui-base';
import {appHome,openOverlay,run,shared} from 'herdr';
import {subscribeJsonFile} from './panel-io.js';

// Workspace badges: a generic slot beside each workspace name in the sidebar. Any mod can
// publish them in shared state, and any tool can write them to a file; the theme only draws
// them and runs what a badge asks for when clicked.
//
//   shared 'sixfold.workspace.badges'  or  data/sixfold/workspace-badges.json
//   { "<machine>|<space id>": [ { "id", "text", "tone", "tooltip", "command" | "open" } ] }
//
// <machine> is the remote machine's name, empty for this computer; <space id> carries no
// machine prefix. `command` is {name, args} for run(); `open` is an overlay of a mod
// ({mod, props, kind, key, width, height}). Tones: blocked, working, done, accent, dim.
export const BADGES_KEY='sixfold.workspace.badges';
export const BADGES_FILE='data/sixfold/workspace-badges.json';
const TONES=['blocked','working','done','accent','dim'];
const NAME=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function badgeKey(machine,spaceId){
  return `${machine??''}|${String(spaceId||'').split('/').pop()}`;
}

// Keeps well-formed badges only, at most four per workspace; text stays short.
export function cleanBadges(value){
  const out={};
  if(!value||typeof value!=='object'||Array.isArray(value))return out;
  for(const [key,list] of Object.entries(value)){
    if(typeof key!=='string'||!key.includes('|')||!Array.isArray(list))continue;
    const badges=list.filter(b=>b&&typeof b.id==='string'&&typeof b.text==='string'&&b.text.trim()).slice(0,4).map(b=>({
      id:b.id.slice(0,64),text:b.text.trim().slice(0,12),tone:TONES.includes(b.tone)?b.tone:'dim',
      tooltip:typeof b.tooltip==='string'?b.tooltip.slice(0,300):'',
      command:b.command&&typeof b.command.name==='string'&&NAME.test(b.command.name.split('.')[0])?{name:b.command.name,args:b.command.args&&typeof b.command.args==='object'?b.command.args:undefined}:null,
      open:b.open&&typeof b.open.mod==='string'&&NAME.test(b.open.mod)?b.open:null,
    }));
    if(badges.length)out[key]=badges;
  }
  return out;
}

// Shared state wins per workspace over the file, so a running mod can update live.
export function badgesFor(key,fromFile,fromShared){
  return cleanBadges(fromShared)[key]||fromFile?.[key]||[];
}

export function watchBadges(view,cx){
  view.stopBadges?.();view.fileBadges??={};
  let disposed=false,previousHash=null,previousValue=null,loaded=false;
  const unsubscribe=subscribeJsonFile(cx,`${appHome()}/${BADGES_FILE}`,snapshot=>{
    if(disposed||snapshot.status!=='ready')return;
    const hash=typeof snapshot.hash==='string'?snapshot.hash:null;
    if(loaded&&((hash!==null&&hash===previousHash)||(hash===null&&snapshot.value===previousValue)))return;
    loaded=true;previousHash=hash;previousValue=snapshot.value;
    view.fileBadges=cleanBadges(snapshot.value);
    if(view.sidebarVisible!==false)cx.notify();
    view.panelRetained?.alertsChanged?.();   // a task card's meta line carries the badges
  });
  const stop=()=>{if(disposed)return;disposed=true;unsubscribe();};
  view.stopBadges=stop;(view.fileSubscriptions??=[]).push(stop);
  return stop;
}

function activate(badge){
  if(badge.open){
    const {mod,props,kind,key,width,height}=badge.open;
    openOverlay({mod,props:props&&typeof props==='object'?props:{},kind:['window','dialog','popup'].includes(kind)?kind:'window',
      ...(typeof key==='string'?{key}:{}),...(Number.isFinite(width)?{width}:{}),...(Number.isFinite(height)?{height}:{})});
  }else if(badge.command)run(badge.command.name,badge.command.args);
}

// The harness memory badge's bare '! N' means items waiting for a check; say so.
export const badgeLabel=b=>b.id==='harness-memory'&&/^!\s*\d+$/.test(b.text)?b.text.replace(/^!\s*/,'확인 대기 '):b.text;
export function workspaceBadges(view,s,t){
  const list=badgesFor(badgeKey(s.machine??null,s.id),view.fileBadges,shared(BADGES_KEY));
  if(!list.length)return div();
  const color=tone=>({blocked:t.blocked,working:t.working,done:t.done||t.ansi2,accent:t.accent})[tone];
  return h_flex().flex_none().gap(3).children(list.map(b=>{
    const filled=b.tone!=='dim';
    return h_flex().id(`sf-badge-${s.id}-${b.id}`).flex_none().h(16).px(5).items_center().rounded(8).text_size(10).font_bold()
      .when(filled,e=>e.bg(color(b.tone)).text_color(t.background)).when(!filled,e=>e.text_color(t.dim))
      .when(Boolean(b.tooltip),e=>e.tooltip(b.tooltip).accessibility_label(b.tooltip))
      .when(Boolean(b.open||b.command),e=>e.cursor_pointer()
        .on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_mouse_up('left',(_e,cx)=>cx.stop_propagation())
        .on_click((_e,cx)=>{cx.stop_propagation();activate(b);}))
      .child(badgeLabel(b));
  }));
}
