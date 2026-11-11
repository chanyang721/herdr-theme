import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('project document index recovers after cold install and partial writes and follows active space', async()=>{
  let receive,active='Demo',notifications=0,unsubscribed=0,cancelled=0;const view={projectDocs:null};
  const cx={notify(){notifications++;},timer:{every(ms){assert.equal(ms,30000);return {cancel(){cancelled++;}};}}};
  const collects=[];
  globalThis.__docsRuntime={appHome:()=>'/app',spaces:()=>[{id:active,name:active,active:true}],subscribeJsonFile:(context,path,callback)=>{assert.equal(context,cx);assert.equal(path,'/app/data/sixfold/project-docs-index.json');receive=callback;return()=>{unsubscribed++;};},exec:async(command,args)=>{collects.push([command,...args]);return {code:0};}};
  let source=await readFile(new URL('../mods/sixfold-desk/docs.js',import.meta.url),'utf8');
  source=source.replace(/\r\n/g,'\n');
  source=source.replace(/^import .*;\n/gm,'');source='const {appHome,spaces,exec,subscribeJsonFile}=globalThis.__docsRuntime;\n'+source;
  try{
    const {watchDocs,currentDocs}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
    const stop=watchDocs(view,cx);await new Promise(resolve=>setImmediate(resolve));receive({status:'missing',hash:null,value:null});assert.equal(currentDocs(view.projectDocs),null);
    assert.deepEqual(collects,[['/app/scripts/sixfold/herdr-theme','collect_docs']],'the index is rebuilt on start, then at most every 30 seconds');
    const data={version:1,spaces:{Demo:{folder:'/docs',files:[{name:'guide.md',path:'/docs/guide.md',mtime:12}]}}};
    const parse=JSON.parse;JSON.parse=()=>{throw Error('UI file parsing');};
    try{receive({status:'ready',hash:'first',value:data});receive({status:'ready',hash:'first',value:{...data}});receive({status:'invalid',hash:'partial',value:data});receive({status:'missing',hash:null,value:data});}finally{JSON.parse=parse;}
    assert.equal(currentDocs(view.projectDocs).files[0].name,'guide.md');assert.equal(notifications,1);assert.ok(Number.isFinite(view.docsIndexAt),'the finder header shows when the index last changed');
    assert.equal(currentDocs(view.projectDocs).files.length,1);
    receive({status:'ready',hash:'wrong-shape',value:{version:1,spaces:{Demo:null}}});assert.equal(notifications,1);
    active='Unconfigured';assert.equal(currentDocs(view.projectDocs),null);
    active='Demo';receive({status:'ready',hash:'empty',value:{version:1,spaces:{}}});assert.equal(currentDocs(view.projectDocs),null);assert.equal(notifications,2);
    view.panelTrackingActive=true;receive({status:'ready',hash:'newer',value:data});assert.equal(view.projectDocs,data);assert.equal(notifications,3,'task tracking keeps document updates visible');
    view.panelTrackingActive=false;assert.equal(currentDocs(view.projectDocs).files.length,1,'switching back can use the latest typed cache');
    assert.equal(view.fileSubscriptions[0],stop);stop();stop();assert.equal(unsubscribed,1);assert.equal(cancelled,1);
    receive({status:'ready',hash:'after-close',value:{version:1,spaces:{}}});assert.equal(view.projectDocs,data,'late delivery after close is ignored');
    assert.equal(collects.length,1);
  }finally{delete globalThis.__docsRuntime;}
});

test('document collectors are shared per app home, never overlap and pause while the sidebar is hidden',async()=>{
  const tasks=[],views=[],timers=[],collects=[];let at=0,release;
  const runtime={appHome:()=>'/collector-demo',spaces:()=>[],subscribeJsonFile:()=>()=>{},exec:async(...args)=>{collects.push(args);if(collects.length===1)await new Promise(resolve=>{release=resolve;});return {code:0};}};
  globalThis.__docsCollectors=runtime;
  let source=(await readFile(new URL('../mods/sixfold-desk/docs.js',import.meta.url),'utf8')).replace(/\r\n/g,'\n').replace(/^import .*;\n/gm,'');
  source='const {appHome,spaces,exec,subscribeJsonFile}=globalThis.__docsCollectors;\n'+source;
  const {watchDocs}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const now=Date.now;Date.now=()=>at;
  try{
    for(let index=0;index<2;index++){
      const view={projectDocs:null},cx={notify(){assert.fail('collector timer must not repaint');},timer:{every(ms,callback){assert.equal(ms,30000);timers.push(callback);return {cancel(){}};}}};views.push(view);tasks.push(watchDocs(view,cx));
    }
    await new Promise(resolve=>setImmediate(resolve));assert.equal(collects.length,1);
    at=30000;timers.forEach(callback=>callback());await new Promise(resolve=>setImmediate(resolve));assert.equal(collects.length,1,'a slow collector is not overlapped');
    release();await new Promise(resolve=>setImmediate(resolve));
    views.forEach(view=>{view.panelTrackingActive=true;view.sidebarVisible=false;});timers.forEach(callback=>callback());await new Promise(resolve=>setImmediate(resolve));assert.equal(collects.length,1);
    views[1].sidebarVisible=true;timers.forEach(callback=>callback());await new Promise(resolve=>setImmediate(resolve));assert.equal(collects.length,2);
    at=59999;timers.forEach(callback=>callback());await new Promise(resolve=>setImmediate(resolve));assert.equal(collects.length,2);
  }finally{Date.now=now;tasks.forEach(stop=>stop());delete globalThis.__docsCollectors;}
});
