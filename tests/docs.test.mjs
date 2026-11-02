import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('project document index recovers after cold install and partial writes and follows active space', async()=>{
  let text,refresh,active='Demo',notifications=0;const tasks=[];const view={projectDocs:null};
  const cx={notify(){notifications++;},spawn(task){const p=task(cx);tasks.push(p);return p;},timer:{every(ms,fn){assert.equal(ms,2000);refresh=fn;}}};
  globalThis.__docsRuntime={appHome:()=>'/app',spaces:()=>[{id:active,name:active,active:true}],readTextFile:async()=>{if(text===undefined)throw Error('missing');return text;}};
  let source=await readFile(new URL('../mods/sixfold-desk/docs.js',import.meta.url),'utf8');
  source=source.replace(/^import .* from 'gpui-kit';\n/m,'').replace(/^import .* from 'gpui-base';\n/m,'').replace(/^import .* from 'herdr';/m,'const {appHome,readTextFile,spaces}=globalThis.__docsRuntime;');
  try{
    const {watchDocs,currentDocs}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
    watchDocs(view,cx);await tasks.at(-1);assert.equal(currentDocs(view.projectDocs),null);
    text=JSON.stringify({version:1,spaces:{Demo:{folder:'/docs',files:[{name:'guide.md',path:'/docs/guide.md',mtime:12}]}}});
    refresh(cx);await tasks.at(-1);assert.equal(currentDocs(view.projectDocs).files[0].name,'guide.md');assert.equal(notifications,1);
    text='{partial';refresh(cx);await tasks.at(-1);assert.equal(currentDocs(view.projectDocs).files.length,1);
    active='Unconfigured';assert.equal(currentDocs(view.projectDocs),null);
    active='Demo';text=JSON.stringify({version:1,spaces:{}});refresh(cx);await tasks.at(-1);assert.equal(currentDocs(view.projectDocs),null);assert.equal(notifications,2);
  }finally{delete globalThis.__docsRuntime;}
});

test('all document open actions report nonzero exits and clear errors after a successful retry',async()=>{
  const handlers=new Map(),calls=[],tasks=[];let active='Demo',code=1,notifications=0;
  function element(){let id;let proxy;proxy=new Proxy({}, {get(_target,key){
    if(key==='id')return value=>{id=value;return proxy;};
    if(key==='on_click')return callback=>{handlers.set(id,callback);return proxy;};
    if(key==='when')return (condition,callback)=>condition?callback(proxy):proxy;
    return ()=>proxy;
  }});return proxy;}
  const runtime={div:element,h_flex:element,v_flex:element,spaces:()=>[{id:active,name:active,active:true}],exec:async(command,args)=>{calls.push({command,args});return {code,stderr:'not opened'};}};
  globalThis.__docsActions=runtime;
  let source=await readFile(new URL('../mods/sixfold-desk/docs.js',import.meta.url),'utf8');
  source=source.replace(/^import .* from 'gpui-kit';\n/m,'').replace(/^import .* from 'gpui-base';\n/m,'').replace(/^import .* from 'herdr';/m,'const {div,h_flex,v_flex,spaces,exec}=globalThis.__docsActions;');
  const view={projectDocs:{spaces:{Demo:{folder:'/docs with spaces',files:[{name:'guide.md',path:'/source/guide.md',mtime:12}]}}}};
  const cx={notify(){notifications++;},spawn(task){const promise=task(cx);tasks.push(promise);return promise;}};
  try{
    const {docsSection}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
    docsSection(view,{});
    for(const id of ['sf-doc-0','sf-doc-code-0','sf-docs-folder']){
      code=1;handlers.get(id)({},cx);await tasks.at(-1);assert.match(view.projectDocsError,/열지 못했습니다/);
      code=0;handlers.get(id)({},cx);await tasks.at(-1);assert.equal(view.projectDocsError,null);
    }
    assert.equal(notifications,6);
    assert.deepEqual(calls[0],{command:'code',args:['--reuse-window','/docs with spaces','/source/guide.md']});
    assert.deepEqual(calls.at(-1).args,['--reuse-window','/docs with spaces']);
    active='Other';const count=calls.length;handlers.get('sf-doc-0')({},cx);assert.equal(calls.length,count,'stale project controls must not launch a document');
  }finally{delete globalThis.__docsActions;}
});
