import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadSidebar} from './live-sidebar-loader.mjs';

// The native message log is sampled once a second, and the first refresh runs before
// the sampler's first delivery. That refresh must already see the current log: with
// an empty or older copy it set the watermark too low, and the delivery then replayed
// old sends all at once, long after they were made.
let loads=0;
async function sidebar(log,{home=null}={}){
  const state={log,visible:true,workflow:JSON.stringify({nodes:[],events:[]})};
  const timers=[],wakeTimers=[],commandQueue=[],heldCommands=[],subscriptions=new Map();let waitingCommand=null;
  const cx={
    notify(){},
    spawn(task){return task(cx);},
    timer:{every(ms,callback,options){const timer={ms,callback,options,cancelled:false,cancel(){this.cancelled=true;},is_done(){return this.cancelled;}};timers.push(timer);return timer;},
      after(ms,callback){if(ms===0&&state.failWake){state.failWake=false;throw Error('fixture wake failure');}const timer={cancelled:false,cancel(){this.cancelled=true;}};if(ms===0)wakeTimers.push({timer,callback});return timer;}},
  };
  const snapshot=path=>{
    const raw=path.endsWith('/workflow.json')?state.workflow:null;
    if(raw===null)return {status:'missing',hash:null};
    return {status:'ready',hash:createHash('sha256').update(raw).digest('hex'),value:JSON.parse(raw)};
  };
  const deliver=command=>{if(waitingCommand){const resolve=waitingCommand;waitingCommand=null;resolve(command);}else commandQueue.push(command);};
  const runtime={
    messageEvents:()=>state.log,
    props:()=>({role:'sidebar'}),appHome:()=>home??`/watermark-${loads}`,
    window:()=>({active:false,visible:state.visible}),
    terminals:()=>[{address:'source'},{address:'target'}],
    readTextFile:async()=>{throw Error('no raw reads');},
    subscribeJsonFile:(context,path,callback)=>{let live=true;subscriptions.set(path,value=>runtime.fileDelivery(context).enqueue(value=>{if(live)callback(value);},value));return()=>{live=false;subscriptions.delete(path);};},
    readJsonSnapshot:async path=>snapshot(path),
    run:()=>{if(state.failCommand){state.failCommand=false;throw Error('fixture command failure');}if(state.holdCommands){heldCommands.push('file-feed-changed');return;}deliver('file-feed-changed');},
    nextCommand:()=>commandQueue.length?Promise.resolve(commandQueue.shift()):new Promise(resolve=>{waitingCommand=resolve;}),
    focused:()=>null,panes:()=>[],agents:()=>[],spaces:()=>[],shared:()=>undefined,setShared(){},
  };
  const {default:Sidebar}=await loadSidebar(runtime,`watermark-${++loads}`);
  const view=new Sidebar();
  const settle=async()=>{for(let count=0;count<20;count++){const pending=wakeTimers.splice(0);for(const {timer,callback} of pending)if(!timer.cancelled)callback(cx);await new Promise(resolve=>setImmediate(resolve));if(!wakeTimers.length)return;}assert.fail('delivery did not settle');};
  const publishFiles=()=>{for(const [path,callback] of subscriptions)callback(snapshot(path));};
  const sample=()=>timers.filter(item=>item.ms===1000&&item.options?.owner===null&&!item.cancelled).at(-1).callback(cx);
  const visibility=async value=>{state.visible=value;deliver('window.visibility');await settle();};
  const flows=()=>[...view.activeFlows,...view.pendingFlows].map(flow=>flow.id);
  const stop=()=>{view.stopLiveMessages?.();for(const release of view.fileSubscriptions)release();delete globalThis.__sixfoldTest;};
  view.init({},cx);publishFiles();await settle();
  return {state,view,settle,publishFiles,sample,visibility,flows,stop,timers,
    releaseCommands(){state.holdCommands=false;for(const command of heldCommands.splice(0))deliver(command);},
    heldCommands,delivery:()=>runtime.fileDelivery(cx).diagnostics()};
}
const send=(seq,at=Date.now())=>({id:`send-${seq}`,source:'source',target:'target',at,seq});

test('a failed delivery wake recovers on the next native sample without a UI or focus event',async()=>{
  const s=await sidebar([]);
  try{
    s.state.failWake=true;s.state.log=[send(1)];s.sample();await s.settle();
    assert.deepEqual(s.flows(),[]);
    assert.equal(s.view.stopLiveMessages.is_active(),true);
    s.sample();await s.settle();assert.deepEqual(s.flows(),['send-1']);
    s.state.log=[...s.state.log,send(2)];s.sample();await s.settle();
    assert.deepEqual(s.flows(),['send-1','send-2']);
    assert.equal(s.view.liveMessageError?.kind,'delivery_failed');
  }finally{s.stop();}
});

test('closing the actual sidebar explicitly cancels its owner-null sampler',async()=>{
  const s=await sidebar([]);
  const sampler=s.timers.find(timer=>timer.ms===1000&&timer.options?.owner===null&&!timer.cancelled);
  try{s.view.close();assert(sampler.cancelled);assert.equal(s.view.stopLiveMessages,null);}
  finally{s.stop();}
});

test('a newly evaluated sidebar root owns its sampler before the host cancels the previous root tasks',async()=>{
  const home='/fixture-native-root-reload-order',old=await sidebar([send(1)],{home});
  let fresh;
  try{
    const oldTimer=old.timers.find(timer=>timer.ms===1000&&timer.options?.owner===null&&!timer.cancelled);
    fresh=await sidebar([send(1)],{home});
    assert(oldTimer.cancelled,'new root initialization retires the old root service before native retirement');
    assert.equal(old.view.stopLiveMessages.is_active(),false);
    assert.equal(fresh.timers.filter(timer=>timer.ms===1000&&timer.options?.owner===null&&!timer.cancelled).length,1);
    oldTimer.cancel();oldTimer.callback();
    fresh.state.log=[send(1),send(2)];fresh.sample();await fresh.settle();
    assert.deepEqual(old.flows(),[]);assert.deepEqual(fresh.flows(),['send-2']);
    old.view.stopLiveMessages();assert.equal(fresh.view.stopLiveMessages.is_active(),true);
  }finally{old.stop();fresh?.stop();}
});

test('a retired sampler handle cannot block explicit sidebar re-subscription or replay history',async()=>{
  const s=await sidebar([send(1)]);
  try{
    const first=s.view.stopLiveMessages;
    s.timers.find(timer=>timer.ms===1000&&timer.options?.owner===null&&!timer.cancelled).cancel();
    assert.equal(first.is_active(),false);
    s.view.startLiveMessages();await s.settle();
    assert.notEqual(s.view.stopLiveMessages,first);
    assert.equal(s.view.stopLiveMessages.is_active(),true);assert.deepEqual(s.flows(),[]);
    s.state.log=[...s.state.log,send(2)];s.sample();await s.settle();assert.deepEqual(s.flows(),['send-2']);
  }finally{s.stop();}
});

test('a failed native command wake retries the same last message without another event or UI action',async()=>{
  const s=await sidebar([]);
  try{
    s.state.failCommand=true;s.state.log=[send(1)];s.sample();await s.settle();
    assert.deepEqual(s.flows(),[]);
    s.sample();await s.settle();assert.deepEqual(s.flows(),['send-1']);
    assert.equal(s.view.stopLiveMessages.is_active(),true);
    assert.equal(s.view.liveMessageError?.kind,'delivery_failed');
  }finally{s.stop();}
});

test('ten delayed native samples are not delivery errors and a late flush preserves the next send',async()=>{
  const s=await sidebar([]);
  try{
    s.state.holdCommands=true;s.state.log=[send(1)];s.sample();await s.settle();
    for(let i=0;i<10;i++){s.sample();await s.settle();}
    assert.equal(s.view.stopLiveMessages.is_active(),true);
    assert.equal(s.view.stopLiveMessages.diagnostics().failures,0);
    assert.equal(s.delivery().acknowledgements,1);assert.equal(s.heldCommands.length,1);
    s.releaseCommands();await s.settle();assert.deepEqual(s.flows(),['send-1']);
    s.state.log=[...s.state.log,send(2)];s.sample();await s.settle();
    assert.deepEqual(s.flows(),['send-1','send-2']);
  }finally{s.stop();}
});

test('a permanently delayed valid command keeps one waiter and explicit stop clears it without extra wakes',async()=>{
  const s=await sidebar([]);
  try{
    s.state.holdCommands=true;s.state.log=[send(1)];s.sample();await s.settle();
    for(let i=0;i<100;i++){s.sample();await s.settle();}
    assert.equal(s.view.stopLiveMessages.is_active(),true);assert.equal(s.delivery().acknowledgements,1);
    assert.equal(s.heldCommands.length,1);assert.equal(s.view.stopLiveMessages.diagnostics().waitingForDelivery,true);
    s.view.stopLiveMessages();await s.settle();
    assert.equal(s.delivery().acknowledgements,0);assert.equal(s.delivery().queued,0);
    s.releaseCommands();await s.settle();assert.deepEqual(s.flows(),[]);
  }finally{s.stop();}
});

test('permanent wake failures stop after three attempts despite shared-file churn and reset only on a new visibility lifetime',async()=>{
  const s=await sidebar([]);
  try{
    s.state.log=[send(1)];
    for(let count=0;count<3;count++){s.state.failWake=true;s.sample();await s.settle();}
    assert.equal(s.view.stopLiveMessages.is_active(),false);
    assert.equal(s.view.liveMessageError.retrying,false);
    const timers=s.timers.length;
    for(let count=0;count<20;count++)s.view.startLiveMessages();
    assert.equal(s.timers.length,timers,'unrelated shared changes do not restart a dead receiver forever');
    await s.visibility(false);await s.visibility(true);
    assert.equal(s.view.stopLiveMessages.is_active(),true);assert.deepEqual(s.flows(),[]);
    s.state.log=[...s.state.log,send(2)];s.sample();await s.settle();assert.deepEqual(s.flows(),['send-2']);
  }finally{s.stop();}
});

test('loading the sidebar never replays sends already in the native log', async () => {
  // A mod save reloads the sidebar: the newest sends were made minutes ago.
  const old=Array.from({length:20},(_,index)=>send(index+1,Date.now()-600000+index*1000));
  const s=await sidebar(old);
  assert.equal(s.view.messageEvents.length,20,'the log is read');
  assert.deepEqual(s.flows(),[],'no old send starts a packet on load');
  // The next real send leaves alone, when it is made.
  s.state.log=[...old,send(21)];s.sample();await s.settle();
  assert.deepEqual(s.flows(),['send-21']);
  s.stop();
});

test('showing the window replays only the latest three hidden sends even after a sidebar file changed', async () => {
  const before=[send(1),send(2)];
  const s=await sidebar(before);
  assert.deepEqual(s.flows(),[]);
  await s.visibility(false);
  const hidden=Array.from({length:5},(_,index)=>send(3+index));
  s.state.log=[...before,...hidden];
  // The workflow file is rewritten often; while hidden its change is only cached.
  s.state.workflow=JSON.stringify({nodes:[],events:[],at:Date.now()});s.publishFiles();await s.settle();
  assert.deepEqual(s.flows(),[],'nothing moves while hidden');
  await s.visibility(true);
  assert.deepEqual(s.flows(),hidden.slice(-3).map(event=>event.id),'the latest three, not every hidden send');
  s.stop();
});
