import test from 'node:test';
import assert from 'node:assert/strict';
import {createFileHub,getSharedFileHub} from '../mods/sixfold-desk/file-feed.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const pending=[],reads=[],watchRoots=[],starts=[],errors=[];
  let result={status:'ready',hash:'one',changed:true,value:{spaces:[{id:'s-demo',title:'First'}]}};
  let reader=async()=>result;
  const adapter={root:'/demo/views',readJson:async(path,options)=>{reads.push({path,options});return reader(path,options);},
    watch:root=>{watchRoots.push(root);return new Promise((resolve,reject)=>pending.push({resolve,reject}));},
    start(body,options,cx){const task={done:false,cancelled:false,cancel(){this.cancelled=true;this.done=true;},is_done(){return this.done;}};starts.push({task,options,cx});Promise.resolve(body()).catch(error=>errors.push(error)).finally(()=>{task.done=true;});return task;},
    onError(error,where){errors.push({error,where});}};
  return {adapter,reads,watchRoots,starts,errors,set(value){result=value;},reader(value){reader=value;},
    async batch(paths){assert(pending.length,'one native watch is waiting');pending.shift().resolve(paths);await tick();},
    async fail(){pending.shift().reject(new Error('watch unavailable'));await tick();}};
}

test('twenty panel subscribers share one initial native read and watch loop',async()=>{
  const f=fixture(),hub=createFileHub(f.adapter),received=Array.from({length:20},()=>[]);
  const stops=received.map(rows=>hub.subscribe('/demo/views/feed.json',value=>rows.push(value)));
  await tick();
  assert.equal(f.reads.length,1);assert.equal(f.starts.length,1);assert.equal(f.watchRoots.length,1);
  assert.deepEqual(f.starts[0].options,{owner:null});
  for(const rows of received){assert.equal(rows.length,1);assert.equal(rows[0].value,received[0][0].value);}
  assert(Object.isFrozen(received[0][0].value));assert(Object.isFrozen(received[0][0].value.spaces[0]));
  stops.forEach(stop=>stop());assert.equal(f.starts[0].task.cancelled,true);
});

test('unrelated events do no reads; one native burst reads a changed path once',async()=>{
  const f=fixture(),hub=createFileHub(f.adapter),rows=[];
  hub.subscribe('/demo/views/feed.json',value=>rows.push(value));await tick();
  await f.batch(['/demo/views/other.json']);assert.equal(f.reads.length,1);
  f.set({status:'ready',hash:'two',changed:true,value:{spaces:[]}});
  await f.batch(['/demo/views/feed.json','/demo/views/feed.json','/demo/views/.temporary']);
  assert.equal(f.reads.length,2);assert.equal(rows.length,2);assert.deepEqual(f.reads[1].options,{hash:'one'});
  hub.dispose();
});

test('unchanged hash emits no callbacks and preserves cached object identity',async()=>{
  const f=fixture(),hub=createFileHub(f.adapter),rows=[];
  hub.subscribe('/demo/views/feed.json',value=>rows.push(value));await tick();
  const initial=rows[0].value;
  f.set({status:'ready',hash:'one',changed:false});
  await f.batch(['/demo/views/feed.json']);
  assert.equal(rows.length,1);
  const second=[];hub.subscribe('/demo/views/feed.json',value=>second.push(value));await tick();
  assert.equal(f.reads.length,2);assert.equal(second[0].value,initial);hub.dispose();
});

test('invalid/missing input retains last valid immutable value and recovery notifies once',async()=>{
  const f=fixture(),hub=createFileHub(f.adapter),rows=[];
  hub.subscribe('/demo/views/feed.json',value=>rows.push(value));await tick();
  const valid=rows[0].value;
  f.set({status:'invalid',hash:'partial',changed:true,value:null});await f.batch(['/demo/views/feed.json']);
  assert.equal(rows[1].status,'invalid');assert.equal(rows[1].value,valid);
  await f.batch(['/demo/views/feed.json']);assert.equal(rows.length,2);
  f.set({status:'missing',hash:null,changed:true});await f.batch(['/demo/views/feed.json']);assert.equal(rows[2].value,valid);
  f.set({status:'ready',hash:'new',changed:true,value:{spaces:[{id:'s-demo',title:'Recovered'}]}});await f.batch(['/demo/views/feed.json']);
  assert.equal(rows.length,4);assert.equal(rows[3].value.spaces[0].title,'Recovered');hub.dispose();
});

test('root/directory invalidation refreshes affected files while preserving per-path reads',async()=>{
  const f=fixture(),hub=createFileHub(f.adapter);
  hub.subscribe('/demo/views/feed.json',()=>{});hub.subscribe('/demo/views/nested/second.json',()=>{});await tick();
  assert.equal(f.reads.length,2);
  await f.batch(['/demo/views/nested']);assert.equal(f.reads.length,3);
  assert.equal(f.reads[2].path,'/demo/views/nested/second.json');
  await f.batch(['/demo/views']);assert.equal(f.reads.length,5);assert.equal(f.starts.length,1);hub.dispose();
});

test('in-flight reads coalesce subscribers and a later invalidation is not lost',async()=>{
  const f=fixture(),hub=createFileHub(f.adapter),rows=[];let complete;
  f.reader(()=>new Promise(resolve=>{complete=resolve;}));
  hub.subscribe('/demo/views/feed.json',value=>rows.push(value));hub.subscribe('/demo/views/feed.json',()=>{});
  await tick();assert.equal(f.reads.length,1);
  const batch=f.batch(['/demo/views/feed.json']);
  complete({status:'ready',hash:'first',value:{n:1}});await tick();
  assert.equal(f.reads.length,2);complete({status:'ready',hash:'second',value:{n:2}});await batch;await tick();
  assert.deepEqual(rows.map(row=>row.value.n),[1,2]);hub.dispose();
});

test('a dead consumer cannot break other panels and unsubscribe is idempotent',async()=>{
  const f=fixture(),hub=createFileHub(f.adapter),rows=[];
  hub.subscribe('/demo/views/feed.json',()=>{throw new Error('stale async context');});
  const stop=hub.subscribe('/demo/views/feed.json',value=>rows.push(value));await tick();
  assert.equal(rows.length,1);assert.equal(f.errors.length,1);stop();stop();
  assert.equal(f.starts[0].task.cancelled,true);hub.dispose();
});

test('a new source generation replaces the old global hub without replaying its callbacks',async()=>{
  const f=fixture(),one=getSharedFileHub(f.adapter,{appHome:'/unique-file-hub-test',generation:'a'});
  assert.equal(getSharedFileHub(f.adapter,{appHome:'/unique-file-hub-test',generation:'a'}),one);
  one.subscribe('/demo/views/feed.json',()=>{});await tick();
  const two=getSharedFileHub(f.adapter,{appHome:'/unique-file-hub-test',generation:'b'});
  assert.notEqual(one,two);assert(one.disposed);assert.equal(f.starts[0].task.cancelled,true);two.dispose();
});

test('Windows slash/case variants share one path and one read',async()=>{
  const f=fixture();f.adapter.root='C:/demo/views';const hub=createFileHub(f.adapter);
  hub.subscribe('C:\\demo\\views\\feed.json',()=>{});hub.subscribe('c:/demo/views/feed.json',()=>{});await tick();
  assert.equal(f.reads.length,1);hub.dispose();
});

test('watch stays armed during reads and closing the starter hands off to another consumer',async()=>{
  const f=fixture(),hub=createFileHub(f.adapter),firstCx={id:1},secondCx={id:2};let complete;
  const first=hub.subscribe('/demo/views/feed.json',()=>{},firstCx);
  hub.subscribe('/demo/views/feed.json',()=>{},secondCx);await tick();
  f.reader(()=>new Promise(resolve=>{complete=resolve;}));
  await f.batch(['/demo/views/feed.json']);
  assert.equal(f.watchRoots.length,2,'second native wait is armed before file read settles');
  first();assert.equal(f.starts[0].task.cancelled,true);assert.equal(f.starts.length,2);
  complete({status:'ready',hash:'two',value:{n:2}});await tick();hub.dispose();
});

test('identical callback functions remain separate subscriptions',async()=>{
  const f=fixture(),hub=createFileHub(f.adapter),rows=[],callback=value=>rows.push(value);
  const first=hub.subscribe('/demo/views/feed.json',callback);
  hub.subscribe('/demo/views/feed.json',callback);await tick();assert.equal(rows.length,2);
  first();f.set({status:'ready',hash:'two',value:{n:2}});await f.batch(['/demo/views/feed.json']);
  assert.equal(rows.length,3);hub.dispose();
});

test('same-version module copies rebind adapters and a retired starter resumes without replay',async()=>{
  const first=fixture(),second=fixture(),fresh=fixture(),options={appHome:'/same-version-reload-test',generation:'panel-cache-v1'};
  const hub=getSharedFileHub(first.adapter,options),a=[],b=[],c=[];
  hub.subscribe('/demo/views/feed.json',value=>a.push(value),{id:'first'});await tick();
  assert.equal(getSharedFileHub(second.adapter,options),hub);
  hub.subscribe('/demo/views/feed.json',value=>b.push(value),{id:'second'});await tick();
  assert.equal(first.starts.length,1);assert.equal(second.starts.length,0);assert.equal(second.reads.length,0);
  second.set({status:'ready',hash:'two',value:{n:2}});
  await first.batch(['/demo/views/feed.json']);
  assert.equal(second.reads.length,1,'new host callback handles the next read');
  assert.equal(second.watchRoots.length,1,'next native wait uses the rebound callback');
  const before=[a.length,b.length];
  first.starts[0].task.done=true;
  fresh.set({status:'ready',hash:'two',changed:false});
  assert.equal(getSharedFileHub(fresh.adapter,options),hub);
  const freshCx={id:'fresh'};hub.subscribe('/demo/views/feed.json',value=>c.push(value),freshCx);await tick();
  assert.equal(fresh.starts.length,1);assert.equal(fresh.starts[0].cx,freshCx);
  assert.equal(first.starts[0].task.cancelled,true);
  assert.equal(fresh.reads.length,1);assert.deepEqual(fresh.reads[0].options,{hash:'two'});
  assert.deepEqual([a.length,b.length],before,'unchanged recovery does not replay old callbacks');
  assert.equal(c.length,1);assert.equal(c[0].value,b.at(-1).value,'cache identity survives module reload');
  await second.batch(['/demo/views/feed.json']);
  assert.equal(second.reads.length,1,'retired loop ignores late native wakeups');
  fresh.set({status:'ready',hash:'three',value:{n:3}});await fresh.batch(['/demo/views/feed.json']);
  assert.equal(b.at(-1).value.n,3);assert.equal(c.at(-1).value.n,3);hub.dispose();
});

test('a retired generation cannot strand or overwrite a new in-flight read',async()=>{
  const old=fixture(),fresh=fixture(),hub=createFileHub(old.adapter),rows=[];let late;
  old.reader(()=>new Promise(resolve=>{late=resolve;}));
  hub.subscribe('/demo/views/feed.json',value=>rows.push(value),{id:'old'});await tick();
  old.starts[0].task.done=true;
  fresh.set({status:'ready',hash:'fresh',value:{n:2}});hub.rebind(fresh.adapter);
  hub.subscribe('/demo/views/feed.json',()=>{},{id:'fresh'});await tick();
  assert.equal(fresh.reads.length,1);assert.equal(rows.length,1);assert.equal(rows[0].value.n,2);
  late({status:'ready',hash:'retired',value:{n:1}});await tick();
  assert.equal(rows.length,1,'late old-generation answer is ignored');hub.dispose();
});

test('starter unsubscribe retires an orphaned read while retaining the remaining cache',async()=>{
  const f=fixture(),hub=createFileHub(f.adapter),rows=[],completions=[];
  const first=hub.subscribe('/demo/views/feed.json',()=>{},{id:'first'});
  hub.subscribe('/demo/views/feed.json',value=>rows.push(value),{id:'second'});await tick();
  const original=rows[0].value;
  f.reader(()=>new Promise(resolve=>completions.push(resolve)));
  await f.batch(['/demo/views/feed.json']);assert.equal(completions.length,1);
  first();await tick();assert.equal(completions.length,2);
  completions[0]({status:'ready',hash:'late',value:{n:'stale'}});await tick();assert.equal(rows.length,1);
  completions[1]({status:'ready',hash:'one',changed:false});await tick();
  assert.equal(rows.length,1);assert.equal(rows[0].value,original);hub.dispose();
});

test('twenty change-only consumers share one watcher and perform zero JSON reads',async()=>{
  const f=fixture(),hub=createFileHub(f.adapter),rows=Array.from({length:20},()=>[]);
  const stops=rows.map(items=>hub.subscribeChanges('/demo/views/asks',paths=>items.push(paths)));
  await tick();assert.equal(f.reads.length,0);assert.equal(f.starts.length,1);assert.equal(f.watchRoots.length,1);
  await f.batch(['/demo/views/asks/request.json','/demo/views/asks/request.json']);
  assert.equal(f.reads.length,0);
  for(const items of rows){assert.equal(items.length,1);assert.deepEqual(items[0],['/demo/views/asks/request.json']);assert.equal(items[0],rows[0][0]);assert(Object.isFrozen(items[0]));}
  stops.forEach(stop=>stop());assert.equal(f.starts[0].task.cancelled,true);
});

test('change prefixes filter unrelated batches and root invalidation calls once',async()=>{
  const f=fixture(),hub=createFileHub(f.adapter),rows=[];
  hub.subscribeChanges('/demo/views/asks',paths=>rows.push(paths));
  await f.batch(['/demo/views/askside/file.json','/demo/views/other.json']);assert.equal(rows.length,0);
  await f.batch(['/demo/views/asks']);assert.equal(rows.length,1);
  await f.batch(['/demo/views','/demo/views/asks/file.json','/demo/views']);assert.equal(rows.length,2);
  assert.deepEqual(rows[1],['/demo/views','/demo/views/asks/file.json']);assert.equal(f.reads.length,0);hub.dispose();
});

test('file and change consumers share one loop and hand off ownership across kinds',async()=>{
  const f=fixture(),hub=createFileHub(f.adapter),changes=[],files=[],changeCx={kind:'changes'},fileCx={kind:'file'};
  const stopChanges=hub.subscribeChanges('/demo/views/asks',paths=>changes.push(paths),changeCx);
  const stopFile=hub.subscribe('/demo/views/feed.json',value=>files.push(value),fileCx);await tick();
  assert.equal(f.starts.length,1);assert.equal(f.reads.length,1);
  stopChanges();assert.equal(f.starts[0].task.cancelled,true);assert.equal(f.starts.length,2);assert.equal(f.starts[1].cx,fileCx);
  await tick();assert.equal(files.length,1,'unchanged handoff does not replay data');
  stopFile();assert.equal(f.starts[1].task.cancelled,true);hub.dispose();
});

test('change-only rebind resumes a retired source and a dead callback cannot stop peers',async()=>{
  const old=fixture(),fresh=fixture(),hub=createFileHub(old.adapter),rows=[];
  hub.subscribeChanges('/demo/views/asks',()=>{throw new Error('stale context');},{id:'old'});
  hub.subscribeChanges('/demo/views/asks',paths=>rows.push(paths),{id:'peer'});
  old.starts[0].task.done=true;hub.rebind(fresh.adapter);
  hub.subscribeChanges('/demo/views/asks',()=>{},{id:'fresh'});await tick();
  assert.equal(fresh.starts.length,1);assert.equal(old.starts[0].task.cancelled,true);
  await fresh.batch(['/demo/views/asks/x.json']);assert.equal(rows.length,1);assert.equal(fresh.reads.length,0);hub.dispose();
});

test('a change consumer keeps the watcher after the last file consumer closes',async()=>{
  const f=fixture(),hub=createFileHub(f.adapter),rows=[];
  const closeFile=hub.subscribe('/demo/views/feed.json',()=>{},{id:'file'});
  const changeCx={id:'changes'},closeChanges=hub.subscribeChanges('/demo/views/asks',paths=>rows.push(paths),changeCx);await tick();
  closeFile();assert.equal(f.starts[0].task.cancelled,true);assert.equal(f.starts[1].cx,changeCx);
  const reads=f.reads.length;
  await f.batch(['/demo/views/asks/late-retired-event.json']);
  await f.batch(['/demo/views/asks/fresh-event.json']);
  assert.equal(rows.length,1);assert.equal(f.reads.length,reads);
  closeChanges();assert.equal(f.starts[1].task.cancelled,true);
});

test('asynchronous subscriber failures are isolated for data and change consumers',async()=>{
  const f=fixture(),hub=createFileHub(f.adapter),data=[],changes=[];
  hub.subscribe('/demo/views/feed.json',async()=>{await Promise.resolve();throw new Error('closed data context');},{id:'data'});
  hub.subscribe('/demo/views/feed.json',value=>data.push(value),{id:'peer'});
  hub.subscribeChanges('/demo/views/asks',async()=>{await Promise.resolve();throw new Error('closed change context');},{id:'changes'});
  hub.subscribeChanges('/demo/views/asks',paths=>changes.push(paths),{id:'peer2'});await tick();
  assert.equal(data.length,1);assert.equal(f.errors.length,1);
  // The retired watch wait is harmless; the fresh leader's wait delivers.
  await f.batch(['/demo/views/asks/retired.json']);
  await f.batch(['/demo/views/asks/fresh.json']);await tick();
  assert.equal(changes.length,1);assert.equal(f.errors.length,2);hub.dispose();
});

test('Windows extended drive watch paths match ordinary subscriptions and root batches',async()=>{
  const f=fixture();f.adapter.root='D:/demo/views';const hub=createFileHub(f.adapter),rows=[],changes=[];
  hub.subscribe('d:/demo/views/feed.json',value=>rows.push(value));
  hub.subscribeChanges('D:/demo/views/asks',paths=>changes.push(paths));await tick();
  f.set({status:'ready',hash:'two',value:{n:2}});
  await f.batch([String.raw`\\?\D:\demo\views\feed.json`,String.raw`\\?\d:\demo\views\asks\item.json`]);
  assert.equal(rows.length,2);assert.equal(changes.length,1);assert.equal(f.reads.length,2);
  f.set({status:'ready',hash:'three',value:{n:3}});
  await f.batch([String.raw`\\?\D:\demo\views`]);
  assert.equal(rows.length,3);assert.equal(changes.length,2);assert.equal(f.reads.length,3);hub.dispose();
});

test('Windows extended UNC and ordinary UNC paths share reads and prefix invalidations',async()=>{
  const f=fixture();f.adapter.root=String.raw`\\server\Share\demo`;const hub=createFileHub(f.adapter),rows=[];
  hub.subscribe(String.raw`\\server\Share\demo\feed.json`,value=>rows.push(value));
  hub.subscribe(String.raw`\\?\UNC\SERVER\share\demo\feed.json`,()=>{});await tick();assert.equal(f.reads.length,1);
  f.set({status:'ready',hash:'two',value:{n:2}});
  await f.batch([String.raw`\\?\UNC\server\Share\demo\feed.json`]);assert.equal(rows.length,2);
  f.set({status:'ready',hash:'three',value:{n:3}});
  await f.batch([String.raw`\\?\unc\server\share\demo`]);assert.equal(rows.length,3);hub.dispose();
});

test('diagnostics expose shared watcher activity without reads, notifications or mutation',async()=>{
  const f=fixture(),hub=createFileHub(f.adapter),rows=[];
  hub.subscribe('/demo/views/feed.json',value=>rows.push(value));await tick();
  const before=hub.diagnostics();assert.equal(before.watchStarts,1);assert.equal(before.nativeReads,1);
  assert.equal(before.callbacks,1);assert.equal(before.subscriptions,1);assert.equal(before.pending,0);assert(before.watchWaiting);
  assert(Object.isFrozen(before));assert(Object.isFrozen(before.files));assert(Object.isFrozen(before.lastPaths));
  await f.batch(['/demo/views/unrelated.json']);
  const after=hub.diagnostics();assert.equal(after.watchBatches,1);assert.equal(after.nativeReads,1);assert.equal(after.callbacks,1);
  assert.deepEqual(after.lastPaths,['/demo/views/unrelated.json']);assert.equal(rows.length,1);hub.dispose();
});

test('one application shares independent canonical roots without replacing peer subscriptions',async()=>{
  const local=fixture(),outside=fixture(),peer=fixture();local.adapter.root='/mux-demo/app';outside.adapter.root='/mux-demo/cards';peer.adapter.root='/mux-demo/cards/';
  const options={appHome:'/mux-demo/app',generation:'root-multiplex-test'};
  const home=getSharedFileHub(local.adapter,options),external=getSharedFileHub(outside.adapter,options),left=[],right=[];
  home.subscribe('/mux-demo/app/data.json',()=>{}, {id:'home'});
  const first=external.subscribeChanges('/mux-demo/cards',paths=>left.push(paths),{id:'first'});
  assert.equal(getSharedFileHub(peer.adapter,options),external);
  const second=external.subscribeChanges('/mux-demo/cards',paths=>right.push(paths),{id:'second'});await tick();
  assert.notEqual(home,external);assert.equal(local.starts.length,1);assert.equal(outside.starts.length,1);assert.equal(peer.starts.length,0);
  await outside.batch(['/mux-demo/cards/card.json']);assert.equal(left.length,1);assert.equal(right.length,1);
  first();assert.equal(home.disposed,false);assert.equal(local.starts[0].task.cancelled,false,'external ownership changes do not stop appHome');
  second();assert.equal(external.diagnostics().subscriptions,0);home.dispose();external.dispose();
});

test('generation replacement disposes every configured root of that application only',async()=>{
  const a=fixture(),b=fixture(),other=fixture();a.adapter.root='/generation-mux/app';b.adapter.root='/generation-mux/cards';other.adapter.root='/generation-other/app';
  const options={appHome:'/generation-mux/app',generation:'before'};
  const one=getSharedFileHub(a.adapter,options),two=getSharedFileHub(b.adapter,options),unrelated=getSharedFileHub(other.adapter,{appHome:'/generation-other/app',generation:'before'});
  one.subscribeChanges(a.adapter.root,()=>{});two.subscribeChanges(b.adapter.root,()=>{});unrelated.subscribeChanges(other.adapter.root,()=>{});await tick();
  const next=getSharedFileHub(a.adapter,{...options,generation:'after'});
  assert.equal(one.disposed,true);assert.equal(two.disposed,true);assert.equal(unrelated.disposed,false);
  assert.equal(a.starts[0].task.cancelled,true);assert.equal(b.starts[0].task.cancelled,true);assert.equal(other.starts[0].task.cancelled,false);
  next.dispose();unrelated.dispose();
});
