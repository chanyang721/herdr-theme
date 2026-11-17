import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadSidebar} from './live-sidebar-loader.mjs';

// The native message log is sampled once a second, and the first refresh runs before
// the sampler's first delivery. That refresh must already see the current log: with
// an empty or older copy it set the watermark too low, and the delivery then replayed
// old sends all at once, long after they were made.
let loads=0;
async function sidebar(log){
  const state={log,visible:true,workflow:JSON.stringify({nodes:[],events:[]})};
  const timers=[],wakeTimers=[],commandQueue=[],subscriptions=new Map();let waitingCommand=null;
  const cx={
    notify(){},
    spawn(task){return task(cx);},
    timer:{every(ms,callback,options){const timer={ms,callback,options,cancelled:false,cancel(){this.cancelled=true;},is_done(){return this.cancelled;}};timers.push(timer);return timer;},
      after(ms,callback){const timer={cancelled:false,cancel(){this.cancelled=true;}};if(ms===0)wakeTimers.push({timer,callback});return timer;}},
  };
  const snapshot=path=>{
    const raw=path.endsWith('/workflow.json')?state.workflow:null;
    if(raw===null)return {status:'missing',hash:null};
    return {status:'ready',hash:createHash('sha256').update(raw).digest('hex'),value:JSON.parse(raw)};
  };
  const deliver=command=>{if(waitingCommand){const resolve=waitingCommand;waitingCommand=null;resolve(command);}else commandQueue.push(command);};
  const runtime={
    messageEvents:()=>state.log,
    props:()=>({role:'sidebar'}),appHome:()=>`/watermark-${loads}`,
    window:()=>({active:false,visible:state.visible}),
    terminals:()=>[{address:'source'},{address:'target'}],
    readTextFile:async()=>{throw Error('no raw reads');},
    subscribeJsonFile:(context,path,callback)=>{let live=true;subscriptions.set(path,value=>runtime.fileDelivery(context).enqueue(value=>{if(live)callback(value);},value));return()=>{live=false;subscriptions.delete(path);};},
    readJsonSnapshot:async path=>snapshot(path),
    run:()=>deliver('file-feed-changed'),
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
  return {state,view,settle,publishFiles,sample,visibility,flows,stop};
}
const send=(seq,at=Date.now())=>({id:`send-${seq}`,source:'source',target:'target',at,seq});

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
