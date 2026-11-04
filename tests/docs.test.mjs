import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('project document index recovers after cold install and partial writes and follows active space', async()=>{
  let text,refresh,active='Demo',notifications=0;const tasks=[];const view={projectDocs:null};
  const cx={notify(){notifications++;},spawn(task){const p=task(cx);tasks.push(p);return p;},timer:{every(ms,fn){assert.equal(ms,2000);refresh=fn;}}};
  const collects=[];
  globalThis.__docsRuntime={appHome:()=>'/app',spaces:()=>[{id:active,name:active,active:true}],readTextFile:async()=>{if(text===undefined)throw Error('missing');return text;},exec:async(command,args)=>{collects.push([command,...args]);return {code:0};}};
  let source=await readFile(new URL('../mods/sixfold-desk/docs.js',import.meta.url),'utf8');
  source=source.replace(/\r\n/g,'\n');
  source=source.replace(/^import .* from 'gpui-kit';\n/m,'').replace(/^import .* from 'gpui-base';\n/m,'').replace(/^import .* from 'herdr';/m,'const {appHome,readTextFile,spaces,exec}=globalThis.__docsRuntime;');
  try{
    const {watchDocs,currentDocs}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
    watchDocs(view,cx);await tasks.at(-1);assert.equal(currentDocs(view.projectDocs),null);
    assert.deepEqual(collects,[['python3','/app/data/sixfold/doc-tabs/collect_docs.py']],'the index is rebuilt on start, then at most every 30 seconds');
    text=JSON.stringify({version:1,spaces:{Demo:{folder:'/docs',files:[{name:'guide.md',path:'/docs/guide.md',mtime:12}]}}});
    refresh(cx);await tasks.at(-1);assert.equal(currentDocs(view.projectDocs).files[0].name,'guide.md');assert.equal(notifications,1);
    text='{partial';refresh(cx);await tasks.at(-1);assert.equal(currentDocs(view.projectDocs).files.length,1);
    active='Unconfigured';assert.equal(currentDocs(view.projectDocs),null);
    active='Demo';text=JSON.stringify({version:1,spaces:{}});refresh(cx);await tasks.at(-1);assert.equal(currentDocs(view.projectDocs),null);assert.equal(notifications,2);
    assert.equal(collects.length,1);
  }finally{delete globalThis.__docsRuntime;}
});


const doc=(path,mtime=1)=>({path,name:path.split('/').at(-1),mtime});
let moduleId=0;
async function sidebar(){
  const handlers=new Map(),calls=[],tasks=[],labels=[];let active='Demo',run=async()=>({code:0}),rendering=false;
  function element(){let id,proxy;proxy=new Proxy({}, {get(_target,key){
    if(key==='id')return value=>{id=value;return proxy;};
    if(key==='on_click')return callback=>{handlers.set(id,callback);return proxy;};
    if(key==='when')return (condition,callback)=>condition?callback(proxy):proxy;
    if(key==='child')return value=>{if(typeof value==='string')labels.push(value);return proxy;};
    return ()=>proxy;
  }});return proxy;}
  const runtime={div:element,h_flex:element,v_flex:element,appHome:()=>'/app',
    InputState:{new:()=>{assert.equal(rendering,false,'native input creation during render');return {events:{},text:'',value(){return this.text;},on(event,callback){this.events[event]=callback;}};}},Input:{new:element},
    spaces:()=>[{id:active,name:active,active:true}],exec:async(command,args)=>{calls.push({command,args});return run(command,args);}};
  const key=`__sidebarDocs${moduleId++}`;globalThis[key]=runtime;
  let source=await readFile(new URL('../mods/sixfold-desk/docs.js',import.meta.url),'utf8');
  source=source.replace(/\r\n/g,'\n');
  source=source.replace(/^import .*;\n/gm,'');source=`const {${Object.keys(runtime).join(',')}}=globalThis[${JSON.stringify(key)}];\n${source}`;
  const {docsSection,prepareDocsInput}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));delete globalThis[key];
  const view={docsSpaces:new Set(['Demo','Other']),projectDocs:{spaces:{Demo:{folder:'/project',files:[doc('/docs/guide.md',20),doc('/docs/report.pdf',10)]},Other:{folder:'/other',files:[doc('/other/other.md',30)]}}}};
  const cx={notify(){},spawn(fn){const promise=fn(cx);tasks.push(promise);return promise;}};
  for(const id of ['Demo','Other'])prepareDocsInput(view,{id});
  const render=(id='Demo',name=id)=>{handlers.clear();labels.length=0;rendering=true;try{docsSection(view,{}, {id,name});}finally{rendering=false;}};render();
  return {view,cx,handlers,calls,labels,render,prepare:id=>prepareDocsInput(view,{id}),setActive:value=>{active=value;},setRun:fn=>{run=fn;},flush:async()=>{await Promise.all(tasks);}};
}

test('workspace document sections stay collapsed until requested and folders open with twenty-item pagination',async()=>{
  const h=await sidebar();h.view.docsSpaces.clear();h.render();assert.equal(h.handlers.size,0);
  h.view.docsSpaces.add('Demo');h.view.projectDocs.spaces.Demo.files=Array.from({length:45},(_,i)=>doc(`/docs/page-${i}.md`,100-i));h.render();
  assert.equal([...h.handlers.keys()].filter(k=>k.startsWith('sf-doc-Demo')).length,0);
  h.handlers.get('sf-docs-folder-Demo-0')({},h.cx);h.render();
  assert.equal([...h.handlers.keys()].filter(k=>k.startsWith('sf-doc-Demo')).length,20);
  h.handlers.get('sf-docs-more-Demo-0')({},h.cx);h.render();
  assert.equal([...h.handlers.keys()].filter(k=>k.startsWith('sf-doc-Demo')).length,40);
  h.handlers.get('sf-docs-more-Demo-0')({},h.cx);h.render();
  assert.equal([...h.handlers.keys()].filter(k=>k.startsWith('sf-doc-Demo')).length,45);
  assert.equal(h.handlers.has('sf-docs-more-Demo-0'),false);
});

test('NFC/NFD filename search expands matching folders and Enter opens first match in its background workspace',async()=>{
  for(const filenameForm of ['NFC','NFD'])for(const queryForm of ['NFC','NFD']){
    const h=await sidebar();h.setActive('Other');
    const file=doc(`/docs/${'프로젝트비-보고서.md'.normalize(filenameForm)}`,30);h.view.projectDocs.spaces.Demo.files=[file,doc('/docs/unrelated.md')];h.render('Demo');
    const input=h.view.docsInputs.Demo;input.text='프로젝트비'.normalize(queryForm);input.events.change({},h.cx);h.render('Demo');
    assert.equal([...h.handlers.keys()].filter(k=>k.startsWith('sf-doc-Demo')).length,1);
    input.events.submit({},h.cx);await h.flush();assert.deepEqual(h.calls.at(-1),{command:'python3',args:['/app/data/sixfold/doc-tabs/open_doc_tab.py',file.path,'--space','Demo']});
    h.render('Other');const other=h.view.docsInputs.Other;assert.notEqual(input,other);assert.equal(h.view.docsQueries.Other,undefined);
    other.events.submit({},h.cx);await h.flush();assert.deepEqual(h.calls.at(-1).args.slice(1),['/other/other.md','--space','Other']);
    assert.equal(h.view.docsQueries.Demo,input.text);
  }
});

test('archive paths and flagged files are hidden by default and appear only after archive toggle',async()=>{
  const h=await sidebar();
  const archived=['/docs/Archive/old.md','/docs/아카이브/old.md'.normalize('NFD'),'/docs/보관/old.md','/docs/guide.before-v1.md'].map(p=>doc(p));
  archived.push({...doc('/docs/legacy.md'),archived:true});h.view.projectDocs.spaces.Demo.files.push(...archived);
  const input=h.view.docsInputs.Demo;input.text='.';input.events.change({},h.cx);h.render();
  assert.equal([...h.handlers.keys()].filter(k=>k.startsWith('sf-doc-Demo')).length,2);
  h.handlers.get('sf-docs-archive-Demo')({},h.cx);h.render();
  assert.equal([...h.handlers.keys()].filter(k=>k.startsWith('sf-doc-Demo')).length,7);
  h.handlers.get('sf-docs-archive-Demo')({},h.cx);h.render();
  assert.equal([...h.handlers.keys()].filter(k=>k.startsWith('sf-doc-Demo')).length,2);
});

test('folder groups and their document rows are newest first',async()=>{
  const h=await sidebar();h.view.projectDocs.spaces.Demo.files=[doc('/old/first.md',1),doc('/new/older.md',10),doc('/new/latest.md',30)];h.render();
  assert.match(h.labels.find(s=>s.startsWith('▸')),/new/);
  h.handlers.get('sf-docs-folder-Demo-0')({},h.cx);h.render();h.handlers.get('sf-doc-Demo-0-0')({},h.cx);await h.flush();
  assert.equal(h.calls[0].args[1],'/new/latest.md');
});

test('Markdown opens in the 문서 tab, other files in the default app, ↗ in VS Code; errors clear on retry',async()=>{
  const h=await sidebar();h.handlers.get('sf-docs-folder-Demo-0')({},h.cx);h.render();
  for(const [id,command,args] of [['sf-doc-Demo-0-0','python3',['/app/data/sixfold/doc-tabs/open_doc_tab.py','/docs/guide.md','--space','Demo']],['sf-doc-Demo-0-1','open',['/docs/report.pdf']],['sf-doc-code-Demo-0-0','code',['--reuse-window','/docs/guide.md']]]){
    h.setRun(async()=>({code:1}));h.handlers.get(id)({},h.cx);await h.flush();assert.match(h.view.docsErrors.Demo,/열지 못했습니다/);
    assert.deepEqual(h.calls.at(-1),{command,args});
    h.setRun(async()=>({code:0}));h.handlers.get(id)({},h.cx);await h.flush();assert.equal(h.view.docsErrors.Demo,null);
  }
  h.setRun(async()=>{throw Error('missing app');});h.handlers.get('sf-doc-Demo-0-1')({},h.cx);await h.flush();assert.match(h.view.docsErrors.Demo,/기본 앱/);
  h.handlers.get('sf-doc-Demo-0-0')({},h.cx);await h.flush();assert.match(h.view.docsErrors.Demo,/문서 탭/);
  h.render('Other');assert.equal(h.view.docsErrors.Other,undefined);
});

test('Enter uses the refreshed index rather than the first rendered document snapshot',async()=>{
  const h=await sidebar();
  h.view.projectDocs={spaces:{Demo:{folder:'/project',files:[doc('/docs/fresh.md',100)]}}};h.render();
  h.view.docsInputs.Demo.events.submit({},h.cx);await h.flush();assert.equal(h.calls.at(-1).args[1],'/docs/fresh.md');
});


test('native search state survives collapse and reopen without being created during render',async()=>{
  const h=await sidebar(),input=h.view.docsInputs.Demo;
  input.text='guide';input.events.change({},h.cx);
  h.view.docsSpaces.delete('Demo');h.render();assert.equal(h.handlers.size,0);
  h.prepare('Demo');h.view.docsSpaces.add('Demo');h.render();
  assert.equal(h.view.docsInputs.Demo,input);
  assert.equal(h.view.docsQueries.Demo,'guide');
  assert.equal([...h.handlers.keys()].filter(k=>k.startsWith('sf-doc-Demo')).length,1);
});

test('workspace IDs resolve exact project names, empty indexes and ID overrides',async()=>{
  const h=await sidebar();
  for(const [id,name,files] of [['sp-b','Project B',[]],['sp-a','Project A',[doc('/pa/docs/guide.md')]]]){
    h.view.projectDocs.spaces[name]={folder:'/project',files,warning:'source_unavailable'};
    h.prepare(id);h.view.docsSpaces.add(id);h.render(id,name);
    assert.ok(h.labels.includes('문서 폴더 조회 확인 필요'));
    assert.equal(h.labels.includes('문서가 없습니다.'),files.length===0);
    assert.equal(h.handlers.has(`sf-docs-folder-${id}-0`),files.length>0);
  }
  h.view.projectDocs.spaces['sp-b']={folder:'/id-specific',files:[doc('/id-specific/guide.md')]};
  h.render('sp-b','Project B');assert.ok(h.handlers.has('sf-docs-folder-sp-b-0'));
  assert.equal(h.labels.includes('문서가 없습니다.'),false);
});
