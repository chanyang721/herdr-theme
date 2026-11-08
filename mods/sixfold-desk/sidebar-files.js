import {subscribeJsonFile} from './panel-io.js';

const sources={
  messages:'messages.json',routing:'routing.json',collaboration:'collaboration.json',queue:'routing-queue.json',
  workflow:'workflow.json',icons:'workspace-icons.json',pins:'workspace-pins.local.json',
  computers:'computers.local.json',site:'site.local.json',voice:'voice-integration.json',
};

// Task rows and the native navigator share these inputs and one native-backed
// file hub. Hidden windows cache changes without repainting.
export function watchSidebarFiles(view,cx,folder,onChange,{nativeMessages=false}={}){
  view.sidebarFiles??={};const stops=[];
  for(const [name,file] of Object.entries(sources)){
    if(name==='messages'&&nativeMessages)continue;
    stops.push(subscribeJsonFile(cx,`${folder}/${file}`,snapshot=>{
      if(snapshot.status==='ready')view.sidebarFiles[name]=snapshot.value;
      else if(name==='voice'&&snapshot.status==='missing')view.sidebarFiles.voice=null;
      if(view.sidebarVisible!==false)onChange(cx);
    }));
  }
  const stop=()=>{for(const release of stops)release();};
  (view.fileSubscriptions??=[]).push(stop);return stop;
}
