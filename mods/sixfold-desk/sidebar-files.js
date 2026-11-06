import {subscribeJsonFile} from './panel-io.js';

const sources={
  messages:'messages.json',routing:'routing.json',collaboration:'collaboration.json',queue:'routing-queue.json',
  workflow:'workflow.json',icons:'workspace-icons.json',pins:'workspace-pins.local.json',
  computers:'computers.local.json',site:'site.local.json',voice:'voice-integration.json',
};

// All readers use the same shared native-backed file hub. A feed-only panel
// still caches legacy data for an explicit return to the normal navigator,
// but does not redraw or run collectors in response to it.
export function watchSidebarFiles(view,cx,folder,onChange,{nativeMessages=false}={}){
  view.sidebarFiles??={};const stops=[];
  for(const [name,file] of Object.entries(sources)){
    if(name==='messages'&&nativeMessages)continue;
    stops.push(subscribeJsonFile(cx,`${folder}/${file}`,snapshot=>{
      if(snapshot.status==='ready')view.sidebarFiles[name]=snapshot.value;
      else if(name==='voice'&&snapshot.status==='missing')view.sidebarFiles.voice=null;
      if(!view.panelTrackingActive)onChange(cx);
    }));
  }
  const stop=()=>{for(const release of stops)release();};
  (view.fileSubscriptions??=[]).push(stop);return stop;
}
