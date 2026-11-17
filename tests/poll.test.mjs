import test from 'node:test';
import assert from 'node:assert/strict';
import {createPoll,changeGate} from '../mods/sixfold-desk/poll.js';
import {createSharedPublisher,slackHealthView} from '../mods/sixfold-desk/shared-publish.js';

function host(){
  const state={ticks:[],tasks:[],refuse:0,at:0,cancelled:0};
  const cx={timer:{every(ms,fn){state.ticks.push({ms,fn});return {cancel(){state.cancelled++;}};}},
    spawn(task){if(state.refuse>0){state.refuse--;throw new Error('host rejected spawn');}state.tasks.push(task(cx));}};
  const tick=async()=>{for(const {fn} of state.ticks)fn(cx);await Promise.all(state.tasks.splice(0));};
  return {cx,state,tick,now:()=>state.at};
}

test('a poll never overlaps, skips hidden ticks and runs once on return',async()=>{
  const h=host();let runs=0,shown=true,release;
  const poll=createPoll(h.cx,{every:1000,now:h.now,visible:()=>shown,job:async()=>{runs++;await new Promise(r=>{release=r;});}});
  for(const {fn} of h.state.ticks)fn(h.cx);for(const {fn} of h.state.ticks)fn(h.cx);
  assert.equal(runs,1,'an in-flight job is not started again');
  release();await Promise.all(h.state.tasks.splice(0));
  shown=false;h.state.at=1000;await h.tick();assert.equal(runs,1,'hidden: skipped');
  shown=true;h.state.at=2000;for(const {fn} of h.state.ticks)fn(h.cx);assert.equal(runs,2,'shown again: runs');
  release();await Promise.all(h.state.tasks.splice(0));
  poll.stop();assert.equal(h.state.cancelled,1);
});

test('a poll runs only when due or after its fallback, and kick forces a run',async()=>{
  const h=host();let runs=0,due=false;
  const poll=createPoll(h.cx,{every:1000,now:h.now,due:()=>due,fallback:5000,job:()=>{runs++;}});
  await h.tick();assert.equal(runs,1,'the first tick is past the fallback');
  for(h.state.at=1000;h.state.at<5000;h.state.at+=1000)await h.tick();
  assert.equal(runs,1,'not due: waits for the fallback');
  h.state.at=6000;await h.tick();assert.equal(runs,2);
  due=true;h.state.at=7000;await h.tick();assert.equal(runs,3);
  due=false;poll.kick(h.cx);await Promise.all(h.state.tasks.splice(0));assert.equal(runs,4);
});

test('failures back off, success resets, and a refused spawn is not a run',async()=>{
  const h=host();let runs=0,fail=true;
  createPoll(h.cx,{every:1000,now:h.now,backoff:{base:4000,max:8000},job:()=>{runs++;if(fail)throw new Error('down');}});
  h.state.refuse=1;await h.tick();assert.equal(runs,0);
  await h.tick();assert.equal(runs,1,'the refused spawn is retried on the next tick');
  h.state.at=3000;await h.tick();assert.equal(runs,1,'4 s backoff');
  h.state.at=4000;await h.tick();assert.equal(runs,2);
  h.state.at=11000;await h.tick();assert.equal(runs,2,'8 s backoff');
  fail=false;h.state.at=12000;await h.tick();assert.equal(runs,3);
  h.state.at=13000;await h.tick();assert.equal(runs,4,'success resets the backoff');
});

test('changeGate reports only a different key',()=>{
  const changed=changeGate();
  assert.equal(changed('a'),true);assert.equal(changed('a'),false);assert.equal(changed('b'),true);
  changed.reset();assert.equal(changed('b'),true);
});

test('the shared publisher writes a key only when its value or token changes',()=>{
  const writes=[],publish=createSharedPublisher((key,value)=>writes.push([key,value]));
  assert.equal(publish('k',{a:1},'t1'),true);
  assert.equal(publish('k',{a:1},'t1'),false,'same token: not serialised again');
  assert.equal(publish('k',{a:1},'t2'),false,'new token, same value: not written');
  assert.equal(publish('k',{a:2}),true);
  assert.equal(publish('other',{a:2}),true,'keys are independent');
  assert.deepEqual(writes.map(([key])=>key),['k','k','other']);
  assert.deepEqual(slackHealthView({state:'ok',duration_seconds:3,mirror_latest_at:'x'}),{state:'ok',mirror_latest_at:'x'});
  assert.deepEqual(slackHealthView(null),{});
});
