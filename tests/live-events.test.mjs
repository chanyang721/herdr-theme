import test from 'node:test';
import assert from 'node:assert/strict';
import {subscribeLiveEvents,liveEventDiagnostics} from '../mods/sixfold-desk/live-events.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
let seq=0;
function setup(){
  const timers=[],key=`native-memory-test-${++seq}`;let reads=0,value=[];
  const read=()=>{reads++;return value;};
  const context=id=>({id,timer:{every(ms,fn,options){const timer={ms,fn,options,owner:id,closed:false,cancel(){this.closed=true;},is_done(){return this.closed;}};timers.push(timer);return timer;}}});
  return {key,timers,context,read,set(next){value=next;},get reads(){return reads;},sample(){const active=timers.filter(timer=>!timer.closed);assert.equal(active.length,1);active[0].fn();}};
}

test('twenty live consumers share one initial memory read and one interval',async()=>{
  const f=setup(),rows=Array.from({length:20},()=>[]),cx=f.context('shared');
  const stops=rows.map(values=>subscribeLiveEvents({key:f.key,read:f.read,cx,onChange:value=>values.push(value)}));await tick();
  assert.equal(f.reads,1);assert.equal(f.timers.length,1);assert.equal(f.timers[0].ms,500);assert.deepEqual(f.timers[0].options,{owner:null});
  for(const values of rows){assert.equal(values.length,1);assert.deepEqual(values[0],[]);assert.equal(values[0],rows[0][0]);}
  stops.forEach(stop=>stop());assert(f.timers[0].closed);
});

test('unchanged typed arrays never broadcast while one change broadcasts once to every consumer',async()=>{
  const f=setup(),a=[],b=[],cx=f.context('shared');
  const closeA=subscribeLiveEvents({key:f.key,read:f.read,cx,onChange:value=>a.push(value)});
  const closeB=subscribeLiveEvents({key:f.key,read:f.read,cx,onChange:value=>b.push(value)});await tick();
  for(let i=0;i<5;i++){f.set([]);f.sample();}assert.equal(a.length,1);assert.equal(b.length,1);
  f.set([{id:'event-demo',at:10}]);f.sample();assert.equal(a.length,2);assert.equal(b.length,2);assert.equal(a[1],b[1]);
  f.set([{id:'event-demo',at:10}]);f.sample();assert.equal(a.length,2);closeA();closeB();
});

test('a new subscriber receives a watermark without replay to existing consumers',async()=>{
  const f=setup(),a=[],b=[],cx=f.context('shared');f.set([{id:'already-present'}]);
  const first=subscribeLiveEvents({key:f.key,read:f.read,cx,onChange:value=>a.push(value)});await tick();
  const second=subscribeLiveEvents({key:f.key,read:f.read,cx,onChange:value=>b.push(value)});await tick();
  assert.equal(f.reads,1);assert.equal(a.length,1);assert.equal(b.length,1);assert.equal(a[0],b[0]);first();second();
});

test('latest read binding and retired starter context recover across source reload',async()=>{
  const f=setup(),a=[],b=[],cx=f.context('old');let freshReads=0;
  const first=subscribeLiveEvents({key:f.key,read:f.read,cx,onChange:value=>a.push(value)});await tick();
  f.timers[0].closed=true;
  const fresh=f.context('fresh'),second=subscribeLiveEvents({key:f.key,read:()=>{freshReads++;return [];},cx:fresh,onChange:value=>b.push(value)});await tick();
  assert.equal(f.timers.length,2);assert.equal(f.timers[1].owner,'fresh');assert.equal(freshReads,1);assert.equal(a.length,1);assert.equal(b.length,1);
  f.sample();assert.equal(freshReads,2);assert.equal(a.length,1);assert.equal(b.length,1);first();second();
});

test('starter close hands one timer to a surviving context and stale callbacks do nothing',async()=>{
  const f=setup(),a=[],b=[];
  const first=subscribeLiveEvents({key:f.key,read:f.read,cx:f.context('first'),onChange:value=>a.push(value)});
  const second=subscribeLiveEvents({key:f.key,read:f.read,cx:f.context('second'),onChange:value=>b.push(value)});await tick();
  const old=f.timers[0];first();assert(old.closed);assert.equal(f.timers.length,2);assert.equal(f.timers[1].owner,'second');
  const count=f.reads;old.fn();assert.equal(f.reads,count);
  f.set([{id:'next'}]);f.sample();assert.equal(a.length,1);assert.equal(b.length,2);second();assert(f.timers[1].closed);
});

test('no consumers means no sampling, and a later consumer starts with a fresh watermark',async()=>{
  const f=setup(),cx=f.context('one'),rows=[];
  const first=subscribeLiveEvents({key:f.key,read:f.read,cx,onChange:value=>rows.push(value)});await tick();first();
  const count=f.reads;f.timers[0].fn();assert.equal(f.reads,count);
  f.set([{id:'while-tracking-mode'}]);const second=subscribeLiveEvents({key:f.key,read:f.read,cx,onChange:value=>rows.push(value)});await tick();
  assert.equal(f.reads,count+1);assert.equal(rows.length,2);assert.equal(rows[1][0].id,'while-tracking-mode');second();
});

test('malformed/throwing reads retain the last typed array without notifying',async()=>{
  const f=setup(),cx=f.context('one'),rows=[];let current=[];
  const read=()=>{if(current instanceof Error)throw current;return current;};
  const stop=subscribeLiveEvents({key:f.key,read,cx,onChange:value=>rows.push(value)});await tick();
  current={not:'array'};f.sample();current=new Error('retired binding');f.sample();assert.equal(rows.length,1);
  current=[{id:'recovered'}];f.sample();assert.equal(rows.length,2);stop();
});

test('a failing asynchronous consumer cannot stop another consumer',async()=>{
  const f=setup(),cx=f.context('shared'),rows=[];
  const broken=subscribeLiveEvents({key:f.key,read:f.read,cx,onChange:async()=>{throw new Error('closed context');}});
  const stop=subscribeLiveEvents({key:f.key,read:f.read,cx,onChange:value=>rows.push(value)});await tick();
  f.set([{id:'still-live'}]);f.sample();assert.equal(rows.length,2);await tick();
  f.sample();await tick();assert.equal(broken.is_active(),false);stop();assert(f.timers[0].closed);
});

test('closing the latest reader restores a surviving binding without another timer',async()=>{
  const f=setup(),cx=f.context('shared'),rows=[];let latestReads=0;
  const first=subscribeLiveEvents({key:f.key,read:f.read,cx,onChange:value=>rows.push(value)});
  const latest=subscribeLiveEvents({key:f.key,read:()=>{latestReads++;return [];},cx,onChange:()=>{}});await tick();
  f.sample();assert.equal(latestReads,1);latest();
  const reads=f.reads;f.set([{id:'surviving-reader'}]);f.sample();
  assert.equal(f.reads,reads+1);assert.equal(latestReads,1);assert.equal(f.timers.length,1);assert.equal(rows.at(-1)[0].id,'surviving-reader');first();
});

test('an equal fresh copy does not broadcast; a new event or a flipped started flag does',async()=>{
  const f=setup(),rows=[],cx=f.context('shared');
  f.set([{id:'a',seq:1,at:1,started:false}]);
  const stop=subscribeLiveEvents({key:f.key,read:f.read,cx,onChange:value=>rows.push(value)});await tick();
  f.set([{id:'a',seq:1,at:1,started:false}]);f.sample();assert.equal(rows.length,1);
  f.set([{id:'a',seq:1,at:1,started:true}]);f.sample();assert.equal(rows.length,2,'a send confirmed in place');
  f.set([{id:'a',seq:1,at:1,started:true},{id:'b',seq:2,at:2}]);f.sample();assert.equal(rows.length,3);
  stop();
});

test('middle-event rendering corrections are delivered without serializing message text',async()=>{
  const f=setup(),rows=[],cx=f.context('corrections');
  const first={id:'first',seq:1,at:1,source:'source',target:'old',started:true,animate:true,status:'held'};
  const last={id:'last',seq:2,at:2,source:'source',target:'target',started:true};
  f.set([first,last]);
  const stop=subscribeLiveEvents({key:f.key,read:f.read,cx,onChange:value=>rows.push(value)});await tick();
  for(const change of [{target:'corrected'},{animate:false},{status:'confirmed'}]){
    f.set([{...first,...change},last]);f.sample();
  }
  assert.equal(rows.length,4);
  f.set([{...first,status:'confirmed',text:{toJSON(){throw Error('private body must not be serialized');}}},last]);f.sample();
  assert.equal(rows.length,4,'message bodies are outside the typed rendering fingerprint');
  stop();
});

test('a sole consumer retries the same snapshot after one synchronous delivery failure',async()=>{
  const f=setup(),rows=[],failures=[];let broken=true;
  const stop=subscribeLiveEvents({key:f.key,read:f.read,cx:f.context('recover'),
    onChange:value=>{if(broken)throw Error('private error text');rows.push(value);},onError:value=>failures.push(value)});
  await tick();
  assert.equal(failures.length,1,'one attempt per sampling round');
  assert.equal(stop.is_active(),true);
  broken=false;f.sample();assert.equal(rows.length,1);
  f.set([{id:'after-recovery'}]);f.sample();assert.equal(rows.length,2);
  assert(!JSON.stringify(failures).includes('private error text'));
  const diagnostics=liveEventDiagnostics().find(item=>item.key===f.key);
  assert.equal(diagnostics.deliveryFailures,1);assert.equal(diagnostics.retries,1);
  assert.equal(diagnostics.subscribers,1);assert.equal(diagnostics.sampling,true);
  assert.equal(stop.diagnostics().totalFailures,1);
  stop();assert.equal(stop.is_active(),false);assert(f.timers[0].closed);
});

test('async rejection recovers without overlapping deliveries, but permanent failures stop after three attempts',async()=>{
  const f=setup(),cx=f.context('async'),rows=[];let attempts=0;
  const stop=subscribeLiveEvents({key:f.key,read:f.read,cx,onChange:async value=>{if(++attempts===1)throw Error('transient');rows.push(value);}});
  await tick();f.sample();await tick();assert.equal(rows.length,1);stop();
  const dead=setup(),errors=[];let failed=0;
  const ended=subscribeLiveEvents({key:dead.key,read:dead.read,cx:dead.context('dead'),onChange:async()=>{failed++;throw Error('permanent');},onError:error=>errors.push(error)});
  await tick();dead.sample();await tick();dead.sample();await tick();
  assert.equal(failed,3);assert.equal(ended.is_active(),false);
  assert(dead.timers[0].closed);assert.equal(errors.at(-1).retrying,false);
  dead.timers[0].fn();await tick();assert.equal(failed,3,'retired callbacks cannot retry forever');
});

test('a never-settling consumer has bounded attempts and late resolution cannot revive a disposed subscription',async()=>{
  const f=setup(),resolves=[],errors=[];
  const stop=subscribeLiveEvents({key:f.key,read:f.read,cx:f.context('hung'),onChange:()=>new Promise(resolve=>resolves.push(resolve)),onError:error=>errors.push(error)});
  await tick();
  for(let count=0;count<9;count++)if(!f.timers[0].closed)f.sample();
  assert.equal(resolves.length,3);assert.equal(stop.is_active(),false);assert(f.timers[0].closed);
  resolves.forEach(resolve=>resolve());await tick();
  assert.equal(stop.is_active(),false);assert.equal(errors.at(-1).kind,'delivery_timeout');
});

test('an asynchronous delivery never overlaps and the next sample delivers the newest snapshot once',async()=>{
  const f=setup(),resolves=[],rows=[];
  const stop=subscribeLiveEvents({key:f.key,read:f.read,cx:f.context('serial'),onChange:value=>{rows.push(value);return new Promise(resolve=>resolves.push(resolve));}});
  await tick();f.set([{id:'newest'}]);f.sample();assert.equal(rows.length,1);
  resolves[0]();await tick();f.sample();assert.equal(rows.length,2);assert.equal(rows[1][0].id,'newest');
  stop();resolves[1]();await tick();assert.equal(stop.is_active(),false);
  assert(!liveEventDiagnostics().some(item=>item.key===f.key));
});

test('disposing a V2 service cancels owner-null sampling and late completions cannot revive it or delete its replacement',async()=>{
  const f=setup(),resolves=[];
  const a=subscribeLiveEvents({key:f.key,read:f.read,cx:f.context('dispose-a'),onChange:()=>new Promise(resolve=>resolves.push(resolve))});
  const b=subscribeLiveEvents({key:f.key,read:f.read,cx:f.context('dispose-b'),onChange:()=>{}});await tick();
  const registry=globalThis.__sixfoldLiveEventSamplesV2,service=registry.get(f.key);
  assert.equal(service.protocol,2);assert.deepEqual(f.timers[0].options,{owner:null});
  service.dispose();assert(f.timers[0].closed);assert.equal(a.is_active(),false);assert.equal(b.is_active(),false);
  const reads=f.reads;f.timers[0].fn();resolves.forEach(resolve=>resolve());await tick();
  assert.equal(f.reads,reads);assert(!registry.has(f.key));
  const next=subscribeLiveEvents({key:f.key,read:f.read,cx:f.context('replacement'),onChange:()=>{}});await tick();
  service.dispose();assert.equal(next.is_active(),true);assert(registry.has(f.key));next();
});
