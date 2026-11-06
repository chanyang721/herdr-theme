import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {filePathKey} from '../mods/sixfold-desk/file-feed.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));let serial=0;
async function fixture({home=`/panel-io-${serial}/app`,nativeJson=true}={}){
  const key=`__panelIoRuntime${serial++}`,reads=[],watchCalls=[],waiting=new Map(),contexts=[],starts=[],commands=[],raw=new Map();
  let reader=async path=>({status:'ok',hash:`hash:${path}`,changed:true,value:{path}});
  const runtime={appHome:()=>home,watchFolder:root=>{watchCalls.push(root);const wait=new Promise(resolve=>{const list=waiting.get(filePathKey(root))??[];list.push(resolve);waiting.set(filePathKey(root),list);});return wait;},
    run:command=>{assert.equal(command,'sixfold-desk.file-feed-changed');commands.push(command);},
    readTextFile:async path=>raw.get(path)??null,
    ...(nativeJson?{readJsonFile:async(path,options)=>{reads.push({path,options});return reader(path,options);}}:{}),
  };
  globalThis[key]=runtime;
  let source=(await readFile(new URL('../mods/sixfold-desk/panel-io.js',import.meta.url),'utf8'))
    .replace(/import \* as native from 'herdr';/,`const native=globalThis[${JSON.stringify(key)}];`)
    .replace("'./file-feed.js'",JSON.stringify(new URL('../mods/sixfold-desk/file-feed.js',import.meta.url).href));
  source+=`\n// ${key}`;
  const io=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));delete globalThis[key];let copies=0;
  const copy=async()=>{globalThis[key]=runtime;try{return await import('data:text/javascript;base64,'+Buffer.from(source+`\n// copy ${++copies}`).toString('base64'));}finally{delete globalThis[key];}};
  const context=()=>{
    const immediate=[];
    const cx={timer:{after(ms,callback){const task={cancelled:false,cancel(){this.cancelled=true;}};if(ms===0)immediate.push({task,callback});return task;}},
      spawn(body,options){const task={cancelled:false,done:false,cancel(){this.cancelled=true;this.done=true;},is_done(){return this.done;}};starts.push({task,options,cx});Promise.resolve(body(cx)).finally(()=>{task.done=true;});return task;},
    };
    contexts.push({cx,immediate});return cx;
  };
  const pump=async()=>{for(let count=0;count<20;count++){await tick();const before=commands.length;for(const {cx,immediate} of contexts)for(const {task,callback} of immediate.splice(0))if(!task.cancelled)callback(cx);if(commands.length>before)for(const {cx} of contexts)io.fileDelivery(cx).flush();await tick();if(contexts.every(item=>!item.immediate.length))return;}assert.fail('Owned command delivery did not settle');};
  return {io,copy,home,context,pump,reads,watchCalls,starts,commands,raw,reader:next=>{reader=next;},async batch(root,paths){const callbacks=waiting.get(filePathKey(root));assert.ok(callbacks?.length,`Missing native wait for ${root}`);callbacks.shift()(paths);await pump();}};
}

test('default and explicitly configured external roots share one service per root across copies',async()=>{
  const f=await fixture(),copy=await f.copy(),a=f.context(),b=f.context(),local=[],external=[],peer=[],json=[];
  const outside=f.home.replace(/\/app$/,'/cards');
  const stopLocal=f.io.subscribeJsonFile(a,`${f.home}/config.json`,snapshot=>local.push(snapshot));
  const stopInside=copy.subscribeFileChanges(b,`${f.home}/cards`,()=>{});
  const stopExternal=f.io.subscribeFileChanges(a,outside,paths=>external.push(paths));
  const stopPeer=copy.subscribeFileChanges(b,`${outside}/`,paths=>peer.push(paths));
  const stopJson=copy.subscribeJsonFile(b,`${outside}/card.json`,snapshot=>json.push(snapshot));
  try{
    await f.pump();assert.equal(local.length,1);assert.equal(json.length,1);
    assert.deepEqual(f.watchCalls,[f.home,outside]);assert.equal(f.starts.length,2,'copies do not start their own OS wait');
    await f.batch(f.home,[`${f.home}/unrelated.json`]);assert.equal(external.length,0);
    await f.batch(outside,[`${outside}/new-card.json`]);assert.equal(external.length,1);assert.equal(peer.length,1);
    assert.equal(f.reads.length,2,'change-only card events do not read unrelated JSON');
    stopExternal();stopPeer();stopJson();await f.pump();
    assert.equal(f.starts.filter(item=>!item.task.cancelled&&!item.task.done).length,1,'closing external consumers leaves only appHome running');
    await f.batch(f.home,[`${f.home}/config.json`]);assert.equal(local.length,1,'unchanged hashes stay quiet');
  }finally{stopLocal();stopInside();stopExternal();stopPeer();stopJson();}
});

test('unknown external JSON paths and filesystem-wide roots never create watches',async()=>{
  const f=await fixture(),cx=f.context();
  assert.throws(()=>f.io.subscribeJsonFile(cx,'/outside/unregistered/file.json',()=>{}),/explicit directory/);
  for(const root of ['/','C:/',String.raw`\\server\share`,'relative/cards','/outside/../cards'])assert.throws(()=>f.io.subscribeFileChanges(cx,root,()=>{}),/specific absolute/);
  assert.deepEqual(f.watchCalls,[]);
});

test('Windows drive, case, slash and extended-path variants share their external root',async()=>{
  const f=await fixture({home:`C:/PanelIo-${serial}/App`}),a=f.context(),b=f.context(),rows=[];
  const first=f.io.subscribeFileChanges(a,String.raw`D:\DemoCards`,paths=>rows.push(paths));
  const second=f.io.subscribeFileChanges(b,String.raw`\\?\d:\democards`+'/',()=>{});
  try{await f.pump();assert.equal(f.starts.length,1);await f.batch('d:/democards',['D:/DemoCards/card.json']);assert.equal(rows.length,1);}finally{first();second();}
});

test('native statuses normalize errors without resetting last valid data and recover once',async()=>{
  const f=await fixture(),cx=f.context(),rows=[],path=`${f.home}/feed.json`;
  let result={status:'ok',hash:'first',changed:true,value:{title:'First'}};f.reader(async()=>result);
  const stop=f.io.subscribeJsonFile(cx,path,snapshot=>rows.push(snapshot));
  try{
    await f.pump();const original=rows[0].value;assert.equal(rows[0].status,'ready');
    result={status:'ok',hash:'first',changed:false,value:null};await f.batch(f.home,[path]);assert.equal(rows.length,1);
    const unchanged=await f.io.readJsonSnapshot(path,{hash:'first'});assert.equal(unchanged.status,'ready');assert.equal(Object.hasOwn(unchanged,'value'),false);
    for(const status of ['parse_error','read_error','too_large']){
      result={status,hash:null,changed:false,value:null};
      const normalized=await f.io.readJsonSnapshot(path,{hash:'first'});assert.equal(normalized.status,'invalid');assert.equal(normalized.changed,true);
      await f.batch(f.home,[path]);assert.equal(rows.at(-1).status,'invalid');assert.equal(rows.at(-1).value,original);
    }
    result={status:'ok',hash:'recovered',changed:true,value:{title:'Recovered'}};await f.batch(f.home,[path]);assert.equal(rows.at(-1).value.title,'Recovered');
    const count=rows.length;result={status:'ok',hash:'recovered',changed:false,value:null};await f.batch(f.home,[path]);assert.equal(rows.length,count);
    result={status:'ok',hash:'json-null',changed:true,value:null};await f.batch(f.home,[path]);assert.equal(rows.at(-1).status,'ready');assert.equal(rows.at(-1).value,null,'changed JSON null is not the unchanged sentinel');
    assert.ok(f.reads.every(read=>read.options.maxBytes===2*1024*1024));
  }finally{stop();}
});

test('older hosts keep explicit text compatibility semantics and diagnostics',async()=>{
  const f=await fixture({nativeJson:false}),path=`${f.home}/compat.json`;
  assert.equal(f.io.typedFileReadsAvailable(),false);
  assert.equal((await f.io.readJsonSnapshot(path)).status,'missing');
  f.raw.set(path,'{"title":"Compatibility"}');
  const first=await f.io.readJsonSnapshot(path);assert.equal(first.status,'ready');assert.equal(first.value.title,'Compatibility');
  assert.equal(first.hash,createHash('sha256').update(f.raw.get(path)).digest('hex'));
  const same=await f.io.readJsonSnapshot(path,{hash:first.hash});assert.equal(same.changed,false);assert.equal(Object.hasOwn(same,'value'),false);
  f.raw.set(path,'{partial');assert.equal((await f.io.readJsonSnapshot(path)).status,'invalid');
  assert.equal(f.io.panelIoDiagnostics().backgroundJson,false);
});
