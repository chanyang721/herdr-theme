import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {filePathKey} from '../mods/sixfold-desk/file-feed.js';
import {touchesCards} from '../mods/sixfold-desk/ask-model.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve)),nativeParse=JSON.parse;let serial=0;
async function fixture({home=`/panel-io-${serial}/app`,nativeJson=true}={}){
  const key=`__panelIoRuntime${serial++}`,reads=[],watchCalls=[],waiting=new Map(),contexts=[],starts=[],commands=[],raw=new Map(),opens=[],writes=[];
  let reader=async path=>({status:'ok',hash:`hash:${path}`,changed:true,value:{path}});
  const runtime={appHome:()=>home,watchFolder:root=>{watchCalls.push(root);const wait=new Promise(resolve=>{const list=waiting.get(filePathKey(root))??[];list.push(resolve);waiting.set(filePathKey(root),list);});return wait;},
    run:command=>{assert.equal(command,'sixfold-desk.file-feed-changed');commands.push(command);},
    readTextFile:async path=>raw.get(path)??null,
    writeTextFile:async(path,value,expected)=>{if((raw.get(path)??null)!==expected)throw Error('CAS conflict');raw.set(path,value);writes.push({path,value,expected});},
    setShared(){},openOverlay:value=>opens.push(value),exec:async()=>({code:0,stdout:''}),
    ...(nativeJson?{readJsonFile:async(path,options)=>{reads.push({path,options});return reader(path,options);}}:{}),
  };
  globalThis[key]=runtime;
  let source=(await readFile(new URL('../mods/sixfold-desk/panel-io.js',import.meta.url),'utf8'))
    .replace(/import \* as native from 'herdr';/,`const native=globalThis[${JSON.stringify(key)}];`)
    .replace("'./file-feed.js'",JSON.stringify(new URL('../mods/sixfold-desk/file-feed.js',import.meta.url).href));
  source+=`\n// ${key}`;
  const ioUrl='data:text/javascript;base64,'+Buffer.from(source).toString('base64');
  const io=await import(ioUrl);delete globalThis[key];let copies=0;
  const copy=async()=>{globalThis[key]=runtime;try{return await import('data:text/javascript;base64,'+Buffer.from(source+`\n// copy ${++copies}`).toString('base64'));}finally{delete globalThis[key];}};
  const context=()=>{
    const immediate=[];
    const cx={notifications:0,notify(){this.notifications++;},timer:{after(ms,callback){const task={cancelled:false,cancel(){this.cancelled=true;}};if(ms<=20)immediate.push({task,callback});return task;}},
      spawn(body,options){const task={cancelled:false,done:false,cancel(){this.cancelled=true;this.done=true;},is_done(){return this.done;}};starts.push({task,options,cx});Promise.resolve(body(cx)).finally(()=>{task.done=true;});return task;},
    };
    contexts.push({cx,immediate});return cx;
  };
  const loadConsumer=async name=>{
    globalThis[key]=runtime;
    let body=(await readFile(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url),'utf8')).replace(/^import .* from 'gpui-kit';\r?\n/m,'').replace(/^import .* from 'gpui-base';\r?\n/m,'')
      .replace(/import \{([^}]+)\} from 'herdr';/,`const {$1}=globalThis[${JSON.stringify(key)}];`)
      .replace("'./panel-io.js'",JSON.stringify(ioUrl)).replace("'./ask-model.js'",JSON.stringify(new URL('../mods/sixfold-desk/ask-model.js',import.meta.url).href))
      .replace("'./arrival-store.js'",JSON.stringify(new URL('../mods/sixfold-desk/arrival-store.js',import.meta.url).href))
      .replace("'./arrival-model.js'",JSON.stringify(new URL('../mods/sixfold-desk/arrival-model.js',import.meta.url).href));
    try{return await import('data:text/javascript;base64,'+Buffer.from(body).toString('base64'));}finally{delete globalThis[key];}
  };
  const wakeOnly=async()=>{await tick();for(const {cx,immediate} of contexts)for(const {task,callback} of immediate.splice(0))if(!task.cancelled)callback(cx);await tick();};
  const pump=async()=>{for(let count=0;count<20;count++){await tick();const before=commands.length;for(const {cx,immediate} of contexts)for(const {task,callback} of immediate.splice(0))if(!task.cancelled)callback(cx);if(commands.length>before)for(const {cx} of contexts)io.fileDelivery(cx).flush();await tick();if(contexts.every(item=>!item.immediate.length))return;}assert.fail('Owned command delivery did not settle');};
  return {io,copy,loadConsumer,runtime,home,context,pump,wakeOnly,reads,watchCalls,starts,commands,raw,opens,writes,reader:next=>{reader=next;},async batch(root,paths,{hidden=false}={}){const callbacks=waiting.get(filePathKey(root));assert.ok(callbacks?.length,`Missing native wait for ${root}`);callbacks.shift()(paths);await (hidden?wakeOnly():pump());}};
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

test('compatibility bounds ASCII and multibyte UTF-8 before parsing and recovers without losing cached data',async()=>{
  const f=await fixture({nativeJson:false}),path=`${f.home}/bounded.json`,rows=[];
  const limit=2*1024*1024;
  const sized=character=>{
    const width=Buffer.byteLength(character),count=Math.floor((limit-2)/width);
    return '"'+character.repeat(count)+'"'+' '.repeat(limit-2-count*width);
  };
  f.raw.set(path,'{"title":"Last valid"}');
  const stop=f.io.subscribeJsonFile(f.context(),path,snapshot=>rows.push(snapshot));
  try{
    await f.pump();const original=rows.at(-1).value;
    for(const raw of [sized('a'),sized('é'),sized('😀')]){
      assert.equal(Buffer.byteLength(raw),limit);
      f.raw.set(path,raw);const boundary=await f.io.readJsonSnapshot(path);
      assert.equal(boundary.status,'ready');assert.equal(boundary.value,nativeParse(raw));
    }
    for(const raw of [sized('a')+' ',sized('é')+' ',sized('😀')+' ']){
      f.raw.set(path,raw);let parsed=0;const parse=JSON.parse;
      JSON.parse=()=>{parsed++;throw Error('Oversized text must never be parsed');};
      try{
        const tooLarge=await f.io.readJsonSnapshot(path);
        assert.equal(tooLarge.status,'invalid');assert.equal(tooLarge.hash,null);
        await f.batch(f.home,[path]);assert.equal(rows.at(-1).status,'invalid');
        assert.equal(rows.at(-1).value,original);assert.equal(parsed,0);
      }finally{JSON.parse=parse;}
    }
    f.raw.set(path,'{"title":"Recovered"}');await f.batch(f.home,[path]);
    const recovered=rows.at(-1);assert.equal(recovered.status,'ready');assert.equal(recovered.value.title,'Recovered');
    const count=rows.length;await f.batch(f.home,[path]);assert.equal(rows.length,count,'unchanged hash retains the valid cache silently');
    const unchanged=await f.io.readJsonSnapshot(path,{hash:recovered.hash});
    assert.equal(unchanged.changed,false);assert.equal(Object.hasOwn(unchanged,'value'),false);
  }finally{stop();}
});

test('only explicit read_error not_found metadata maps to missing',async()=>{
  const f=await fixture(),path=`${f.home}/optional.json`;
  for(const [status,errorKind,expected] of [['read_error','not_found','missing'],['read_error','io','invalid'],['read_error',undefined,'invalid'],['read_error','NOT_FOUND','invalid'],['parse_error','not_found','invalid']]){
    f.reader(async()=>({status,errorKind,hash:null,changed:false,value:null}));
    const snapshot=await f.io.readJsonSnapshot(path);
    assert.equal(snapshot.status,expected);assert.equal(snapshot.hash,null);assert.equal(snapshot.changed,true);
  }
});

function fileReader(f){
  return async(path,{hash}={})=>{
    const raw=f.raw.get(path);
    if(raw===undefined)return {status:'read_error',errorKind:'not_found',hash:null,changed:false,value:null};
    const digest=createHash('sha256').update(raw).digest('hex');
    if(digest===hash)return {status:'ok',hash:digest,changed:false,value:null};
    try{return {status:'ok',hash:digest,changed:true,value:nativeParse(raw)};}catch{return {status:'parse_error',hash:null,changed:false,value:null};}
  };
}

test('real alert consumer seeds absent optional inputs and later opens a new mention with native metadata',async()=>{
  const f=await fixture();f.reader(fileReader(f));
  const {watchAlerts}=await f.loadConsumer('alerts'),cx=f.context(),view={alerts:[]},stop=watchAlerts(view,cx);
  try{
    const parse=JSON.parse;JSON.parse=()=>{throw Error('UI parsed an alert file');};
    try{await f.pump();}finally{JSON.parse=parse;}
    assert.deepEqual(view.alerts,[]);assert.equal(cx.notifications,1);
    const ledger=`${f.home}/data/sixfold/slack-popup-events.json`;
    assert.deepEqual(nativeParse(f.raw.get(ledger)),{schema:1,seen:[]});
    const mention=`${f.home}/data/sixfold/slack-mentions.json`;
    f.raw.set(mention,'{"items":[{"id":"demo-new-mention"}]}');await f.batch(f.home,[mention]);
    assert.equal(f.opens.length,1);assert.deepEqual(nativeParse(f.raw.get(ledger)).seen,['mention:demo-new-mention']);
  }finally{stop();}
});

test('real ask consumer preserves an io error but disables only a metadata-confirmed deletion',async()=>{
  const f=await fixture(),config=`${f.home}/data/sixfold/bridge.json`,cards=`${f.home}/data/sixfold/cards.json`;
  const source='{"python":"demo-python","script":"/demo/bridge/dispatch.py","args":[]}';f.raw.set(config,source);
  f.raw.set(cards,JSON.stringify({schema:1,cards:[{id:'demo-card',revision:'v1',kind:'permission',title:'Demo confirmation',questions:[],actions:[{id:'allow',label:'Allow'}]}]}));
  const read=fileReader(f);let failure=false,calls=0;
  f.reader((path,options)=>failure&&path===config?{status:'read_error',errorKind:'io',hash:null,changed:false,value:null}:read(path,options));
  f.runtime.exec=async()=>{calls++;throw Error('Reading cards must not execute a command');};
  const {watchAsks}=await f.loadConsumer('asks'),cx=f.context(),view={},stop=watchAsks(view,cx);
  try{
    await f.pump();assert.equal(view.asks.length,1);assert.equal(calls,0);
    failure=true;await f.batch(f.home,[config]);assert.equal(view.asks.length,1);assert.ok(view.askBridge);
    failure=false;f.raw.delete(config);await f.batch(f.home,[config]);assert.equal(view.asks,null);assert.equal(view.askBridge,null);
    f.raw.set(config,source);await f.batch(f.home,[config]);assert.equal(view.asks.length,1);assert.equal(calls,0,'byte-identical restored connection redisplays cards without executing anything');
  }finally{stop();}
});

test('hidden delivery keeps the latest value per stable callback and only one outstanding wake',async()=>{
  const f=await fixture(),cx=f.context(),receiver=f.io.fileDelivery(cx),rows=[],peer=[];
  const deliver=value=>rows.push(value),other=value=>peer.push(value);
  for(let index=0;index<1000;index++)receiver.enqueue(deliver,index);
  receiver.enqueue(other,'first');receiver.enqueue(other,'latest');
  const state=globalThis.__sixfoldFileDeliveries.get(cx);
  assert.equal(state.queue.length,2);await f.wakeOnly();assert.equal(f.commands.length,1);assert.deepEqual(rows,[]);
  for(let index=1000;index<2000;index++)receiver.enqueue(deliver,index);
  await f.wakeOnly();assert.equal(f.commands.length,1,'a hidden receiver does not keep sending zero-timer wakes');assert.equal(state.queue.length,2);
  receiver.flush();assert.deepEqual(rows,[1999]);assert.deepEqual(peer,['latest']);assert.equal(state.queue.length,0);
  receiver.enqueue(deliver,'resumed');await f.pump();assert.deepEqual(rows,[1999,'resumed']);assert.equal(f.commands.length,2);
});

test('owned typed file subscriptions use one stable hidden callback for successive writes',async()=>{
  const f=await fixture(),cx=f.context(),rows=[],path=`${f.home}/feed.json`;let version=0;
  f.reader(async()=>({status:'ok',hash:`version-${version}`,changed:true,value:{version}}));
  const stop=f.io.subscribeJsonFile(cx,path,snapshot=>rows.push(snapshot));
  try{
    await f.wakeOnly();
    for(version=1;version<=20;version++)await f.batch(f.home,[path],{hidden:true});
    const state=globalThis.__sixfoldFileDeliveries.get(cx);assert.equal(state.queue.length,1);assert.equal(f.commands.length,1);assert.deepEqual(rows,[]);
    f.io.fileDelivery(cx).flush();assert.equal(rows.length,1);assert.equal(rows[0].value.version,20);
  }finally{stop();}
});

test('removing the last hidden callback rearms delivery after an unconsumed wake',async()=>{
  const f=await fixture(),cx=f.context(),receiver=f.io.fileDelivery(cx),rows=[];
  const retired=value=>rows.push(['retired',value]),active=value=>rows.push(['active',value]);
  receiver.enqueue(retired,'old');await f.wakeOnly();assert.equal(f.commands.length,1);
  receiver.remove(retired);assert.equal(globalThis.__sixfoldFileDeliveries.get(cx).queue.length,0);
  receiver.enqueue(active,'first');receiver.enqueue(active,'latest');await f.wakeOnly();
  assert.equal(f.commands.length,2,'a new subscription can wake without a window visibility transition');
  assert.deepEqual(rows,[]);receiver.flush();assert.deepEqual(rows,[['active','latest']]);
});

test('hidden directory delivery unions deltas and replaces overflow with one prefix invalidation',async()=>{
  const f=await fixture(),cx=f.context(),rows=[],prefix=`${f.home}/cards`;
  const stop=f.io.subscribeFileChanges(cx,prefix,batch=>rows.push(batch));
  try{
    await f.pump();
    const card=`${prefix}/cards.json`;
    await f.batch(f.home,[card],{hidden:true});
    await f.batch(f.home,[`${prefix}/demo.lease`,`${prefix}/temporary.tmp`],{hidden:true});
    f.io.fileDelivery(cx).flush();assert.equal(rows.length,1);assert.ok(rows[0].includes(card));assert.equal(touchesCards(rows[0],prefix),true);
    await f.batch(f.home,Array.from({length:513},(_,index)=>`${prefix}/file-${index}.json`),{hidden:true});
    await f.batch(f.home,Array.from({length:2000},(_,index)=>`${prefix}/extra-${index}.tmp`),{hidden:true});
    assert.equal(globalThis.__sixfoldFileDeliveries.get(cx).queue.length,1);
    f.io.fileDelivery(cx).flush();assert.deepEqual(rows[1],[prefix]);assert.equal(touchesCards(rows[1],prefix),true);
    await f.batch(f.home,[card]);assert.deepEqual(rows[2],[card],'overflow state clears after owned delivery');
  }finally{stop();}
});

test('hidden subscription churn removes queued dead callbacks without losing a live peer',async()=>{
  const f=await fixture(),cx=f.context(),rows=[],dead=[],live=f.io.subscribeJsonFile(cx,`${f.home}/live.json`,snapshot=>rows.push(snapshot));
  await f.wakeOnly();const receiver=f.io.fileDelivery(cx),state=globalThis.__sixfoldFileDeliveries.get(cx);
  assert.equal(state.queue.length,1);
  for(let index=0;index<50;index++){
    const stop=f.io.subscribeJsonFile(cx,`${f.home}/temporary.json`,snapshot=>dead.push(snapshot));
    await f.wakeOnly();assert.equal(state.queue.length,2);stop();assert.equal(state.queue.length,1,'release immediately drops the dead pending payload');
  }
  // Keep the shared OS watch alive while temporary directory subscribers churn.
  // Its unrelated prefix must not receive or retain their pending changes.
  const peer=f.io.subscribeFileChanges(cx,`${f.home}/peer`,batch=>rows.push(batch));
  receiver.flush();assert.equal(rows.length,1);assert.equal(dead.length,0);live();assert.equal(state.queue.length,0);
  const before=f.commands.length;
  for(let index=0;index<50;index++){
    const stop=f.io.subscribeFileChanges(cx,`${f.home}/cards`,batch=>dead.push(batch));
    await f.batch(f.home,[`${f.home}/cards/temporary-${index}.json`],{hidden:true});
    assert.equal(state.queue.length,1);stop();assert.equal(state.queue.length,0);
  }
  assert.equal(f.commands.length,before+50,'each new subscription lifetime can wake after its predecessor is released');
  receiver.flush();assert.equal(dead.length,0);assert.equal(rows.length,1);peer();
});

test('a receiver that never gets its command keeps one entry per callback, and the sidebar passes fixed callbacks',async()=>{
  // A hidden or retired receiver never consumes FILE_CHANGED, so nothing flushes the queue.
  const f=await fixture(),cx=f.context(),receiver=f.io.fileDelivery(cx),state=globalThis.__sixfoldFileDeliveries.get(cx);
  const fixed=()=>{};
  for(let i=0;i<1000;i++)receiver.enqueue(fixed,i);
  assert.equal(state.queue.length,1);assert.equal(state.queue[0][1],999);
  for(let i=0;i<10;i++)receiver.enqueue(()=>{},i);
  assert.equal(state.queue.length,11,'a fresh arrow per call adds an entry each time');
  receiver.flush();assert.equal(state.queue.length,0);
  const main=await readFile(new URL('../mods/sixfold-desk/main.js',import.meta.url),'utf8');
  assert.doesNotMatch(main,/fileReceiver\.enqueue\(\(\)=>/,'main.js must not enqueue a new arrow per call');
});
