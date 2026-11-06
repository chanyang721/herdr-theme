import test from 'node:test';
import assert from 'node:assert/strict';
import {subscribeLiveEvents} from '../mods/sixfold-desk/live-events.js';

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
  subscribeLiveEvents({key:f.key,read:f.read,cx,onChange:async()=>{throw new Error('closed context');}});
  const stop=subscribeLiveEvents({key:f.key,read:f.read,cx,onChange:value=>rows.push(value)});await tick();
  f.set([{id:'still-live'}]);f.sample();assert.equal(rows.length,2);stop();
});

test('closing the latest reader restores a surviving binding without another timer',async()=>{
  const f=setup(),cx=f.context('shared'),rows=[];let latestReads=0;
  const first=subscribeLiveEvents({key:f.key,read:f.read,cx,onChange:value=>rows.push(value)});
  const latest=subscribeLiveEvents({key:f.key,read:()=>{latestReads++;return [];},cx,onChange:()=>{}});await tick();
  f.sample();assert.equal(latestReads,1);latest();
  const reads=f.reads;f.set([{id:'surviving-reader'}]);f.sample();
  assert.equal(f.reads,reads+1);assert.equal(latestReads,1);assert.equal(f.timers.length,1);assert.equal(rows.at(-1)[0].id,'surviving-reader');first();
});
