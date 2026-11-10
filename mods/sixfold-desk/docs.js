import {appHome,spaces,exec,window} from 'herdr';
import {subscribeJsonFile} from './panel-io.js';

export function currentDocs(index){const space=spaces().find(s=>s.active);return index?.spaces?.[space?.id]||index?.spaces?.[space?.name]||null;}
const COLLECT_MS=30000;
const native = () => `${appHome()}/scripts/sixfold/herdr-theme${(typeof window==='function' && window()?.platform==='windows') || /^(?:[A-Za-z]:[\\/]|\\\\)/.test(appHome())?'.exe':''}`;
const COLLECTORS='__sixfoldDocsCollectorsV1';
function collectDocs(view){
  if(view.sidebarVisible===false)return;
  const collectors=globalThis[COLLECTORS]??(globalThis[COLLECTORS]=new Map());
  const key=appHome(),state=collectors.get(key)??{at:null,pending:false};
  collectors.set(key,state);
  const now=Date.now();
  if(state.pending||(state.at!==null&&now-state.at<COLLECT_MS))return;
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
  collectDocs(view);
  const timer=cx.timer.every(COLLECT_MS,()=>{if(!disposed)collectDocs(view);});
  const stop=()=>{if(disposed)return;disposed=true;unsubscribe();timer?.cancel?.();};
  view.stopDocs=stop;(view.fileSubscriptions??=[]).push(stop);
  return stop;
}
