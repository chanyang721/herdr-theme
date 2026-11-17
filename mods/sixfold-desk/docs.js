import {appHome,spaces,panes,exec,window} from 'herdr';
import {subscribeJsonFile} from './panel-io.js';

export function currentDocs(index){const space=spaces().find(s=>s.active);return index?.spaces?.[space?.id]||index?.spaces?.[space?.name]||null;}
// The collector spawns a process that walks every pinned folder: at most every two minutes,
// and at once (after SHOWN_MIN_MS) when a document tab comes into view. CHECK_MS only reads
// the host's in-memory model.
const COLLECT_MS=120000,SHOWN_MIN_MS=10000,CHECK_MS=5000;
const native = () => `${appHome()}/scripts/sixfold/herdr-theme${(typeof window==='function' && window()?.platform==='windows') || /^(?:[A-Za-z]:[\\/]|\\\\)/.test(appHome())?'.exe':''}`;
const COLLECTORS='__sixfoldDocsCollectorsV1';
// The shown space shows a tab holding a project-docs-tabs pane.
export function docsTabShown(){
  if(typeof panes!=='function')return false;
  const space=spaces().find(s=>s.active),tab=space?.tabs?.find(t=>t.active);
  return Boolean(tab)&&panes().some(p=>p.tab===tab.id&&p.mod==='project-docs-tabs');
}
function collectDocs(view,min=COLLECT_MS){
  if(view.sidebarVisible===false)return;
  const collectors=globalThis[COLLECTORS]??(globalThis[COLLECTORS]=new Map());
  const key=appHome(),state=collectors.get(key)??{at:null,pending:false};
  collectors.set(key,state);
  const now=Date.now();
  if(state.pending||(state.at!==null&&now-state.at<min))return;
  state.at=now;state.pending=true;
  // Collection discovers new/moved documents; file subscriptions only deliver
  // its output. Sidebar copies share one actual collection per app home.
  Promise.resolve().then(()=>exec(native(),['collect_docs'])).catch(()=>{}).finally(()=>{state.pending=false;});
}
function validDocs(data){
  return data&&typeof data==='object'&&!Array.isArray(data)&&data.version===1
    &&data.spaces&&typeof data.spaces==='object'&&!Array.isArray(data.spaces)
    &&Object.values(data.spaces).every(item=>item&&typeof item==='object'&&!Array.isArray(item)
      &&Array.isArray(item.files)&&typeof item.folder==='string'
      &&item.files.every(file=>file&&typeof file==='object'&&typeof file.path==='string'&&typeof file.name==='string'&&Number.isFinite(file.mtime)));
}
export function watchDocs(view,cx){
  view.stopDocs?.();
  let disposed=false,previousHash=null,previousValue=null,loaded=false;
  const unsubscribe=subscribeJsonFile(cx,`${appHome()}/data/sixfold/project-docs-index.json`,snapshot=>{
    if(disposed||snapshot.status!=='ready'||!validDocs(snapshot.value))return;
    const hash=typeof snapshot.hash==='string'?snapshot.hash:null;
    if(loaded&&((hash!==null&&hash===previousHash)||(hash===null&&snapshot.value===previousValue)))return;
    loaded=true;previousHash=hash;previousValue=snapshot.value;
    view.projectDocs=snapshot.value;view.docsIndexAt=Date.now();
    if(view.sidebarVisible!==false)cx.notify();
  });
  let shown=docsTabShown();
  collectDocs(view);
  const timer=cx.timer.every(CHECK_MS,()=>{
    if(disposed)return;
    const now=docsTabShown(),opened=now&&!shown;shown=now;
    collectDocs(view,opened?SHOWN_MIN_MS:COLLECT_MS);
  });
  const stop=()=>{if(disposed)return;disposed=true;unsubscribe();timer?.cancel?.();};
  view.stopDocs=stop;(view.fileSubscriptions??=[]).push(stop);
  return stop;
}
