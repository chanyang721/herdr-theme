import {loadSidebar} from './live-sidebar-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// Exercise the real sidebar lifecycle without a GUI. No filesystem change or
// focus event is needed for native memory events. Legacy files arrive through
// the same typed subscriptions as other sidebar state, not a read timer.
for (const native of [false,true]) test(`background messages refresh through ${native?'native 1 s memory sampling':'typed legacy file subscriptions'} without focus changes`, async () => {
  let log = JSON.stringify({events:[]});
  let notifications = 0;
  let pinText='{}';
  let malformedAuxiliary=false;
  let appLocation='/app';
  let visible=true;
  const tasks = [];
  const timers = [];
  const wakeTimers=[],commandQueue=[],commands=[],ownershipViolations=[];let waitingCommand=null,ownership='init';
  const subscriptions=new Map();let rawReads=0;
  const cx = {
    notify() { if(ownership==='watcher')ownershipViolations.push('watcher notification');notifications++; },
    spawn(task) { const promise=task(cx); tasks.push(promise); return promise; },
    timer:{every(ms,callback,options){const timer={ms,callback,options,cancelled:false,cancel(){this.cancelled=true;},is_done(){return this.cancelled;}};timers.push(timer);return timer;},after(ms,callback){const timer={cancelled:false,cancel(){this.cancelled=true;}};if(ms===0)wakeTimers.push({timer,callback});return timer;}},
  };
  const snapshot=path=>{
    let raw=null;
    if(path.endsWith('/workspace-pins.local.json'))raw=pinText;
    else if(path.endsWith('/messages.json')){assert.equal(native,false,'native mode never subscribes to the legacy message file');raw=log;}
    else if(malformedAuxiliary&&(path.endsWith('/workflow.json')||path.endsWith('/sidebar-notices.json')))raw='{partial';
    if(raw===null)return {status:'missing',hash:null};
    const hash=createHash('sha256').update(raw).digest('hex');
    try{return {status:'ready',hash,value:JSON.parse(raw)};}catch{return {status:'invalid',hash};}
  };
  const runtime = {
    ...(native?{messageEvents:()=>JSON.parse(log).events}:{}),
    props:()=>({role:'sidebar'}), appHome:()=>appLocation,
    window:()=>({active:false,visible}),
    terminals:()=>[{address:'source'},{address:'target'}],
    readTextFile:async()=>{rawReads++;throw Error('Legacy inputs must use typed subscriptions');},
    subscribeJsonFile:(context,path,callback)=>{let live=true;subscriptions.set(path,value=>runtime.fileDelivery(context).enqueue(value=>{if(live)callback(value);},value));return()=>{live=false;subscriptions.delete(path);};},
    readJsonSnapshot:async path=>snapshot(path),
    run:name=>{assert.equal(name,'sixfold-desk.file-feed-changed','file wake is the only command emitted');commands.push(name);if(waitingCommand){const resolve=waitingCommand;waitingCommand=null;resolve('file-feed-changed');}else commandQueue.push('file-feed-changed');},
    nextCommand:()=>{ownership='idle';return (commandQueue.length?Promise.resolve(commandQueue.shift()):new Promise(resolve=>{waitingCommand=resolve;})).then(command=>{ownership='command';return command;});},
    focused:()=>{assert.fail('file commands must not run focus/selection command handling');},panes:()=>[],
  };
  const {default: Sidebar,helperInvocation} = await loadSidebar(runtime,native);
  assert.deepEqual(helperInvocation('/app/scripts/sixfold/focus_queue.py','focus_queue',['--app-focus']),['/app/scripts/sixfold/herdr-theme',['focus_queue','--app-focus']]);
  assert.deepEqual(helperInvocation('/custom/scripts/sixfold/focus_queue.py','focus_queue',['--app-focus']),['python3',['/custom/scripts/sixfold/focus_queue.py','--app-focus']]);
  assert.deepEqual(helperInvocation(['/custom/native','adapter'],'focus_queue',['--app-focus']),['/custom/native',['adapter','--app-focus']]);
  assert.deepEqual(helperInvocation('/custom/voice.py','focus_queue',['--app-focus']),['python3',['/custom/voice.py','--app-focus']]);
  appLocation='\\\\fixture-host\\share\\app';
  assert.deepEqual(helperInvocation(null,'focus_queue',['--app-focus']),[`${appLocation}/scripts/sixfold/herdr-theme.exe`,['focus_queue','--app-focus']]);
  assert.deepEqual(helperInvocation('\\\\FIXTURE-HOST\\SHARE\\APP\\scripts\\sixfold\\focus_queue.py','focus_queue',['--app-focus']),[`${appLocation}/scripts/sixfold/herdr-theme.exe`,['focus_queue','--app-focus']]);
  appLocation='/app';
  const view = new Sidebar();
  view.init({},cx);
  const settle=async()=>{for(let count=0;count<20;count++){const pending=wakeTimers.splice(0);ownership='watcher';for(const {timer,callback} of pending)if(!timer.cancelled)callback(cx);await new Promise(resolve=>setImmediate(resolve));if(!wakeTimers.length)return;}assert.fail('Native command delivery did not settle');};
  const publishFiles=()=>{const previous=ownership;ownership='watcher';for(const [path,callback] of subscriptions)callback(snapshot(path));ownership=previous;};
  publishFiles();await settle();
  assert.deepEqual(view.messageEvents,[]);
  const sampler=timers.find(item=>item.ms===1000&&item.options?.owner===null);
  assert.equal(Boolean(sampler),native,'only a native in-memory event source needs a sampler');
  assert.equal(subscriptions.has('/app/data/sixfold/messages.json'),!native);
  const enqueue=()=>{const previous=ownership;ownership='watcher';if(native)sampler.callback(cx);publishFiles();ownership=previous;};
  const refresh=async()=>{enqueue();await settle();};
  log = JSON.stringify({events:[{id:'live',source:'source',target:'target',at:Date.now()}]});
  const beforeDelivery=notifications;enqueue();
  assert.deepEqual(view.messageEvents,[],'the watcher cannot directly change the shown receiver');
  assert.equal(notifications,beforeDelivery,'queued watcher delivery has not redrawn');
  await settle();
  assert.equal(view.messageEvents[0].id,'live');
  assert.equal(view.activeFlows[0].id,'live');
  const unchanged = notifications;
  await refresh();
  assert.equal(notifications,unchanged,'unchanged snapshot must not redraw');
  log = '{partial';
  await refresh();
  assert.equal(view.messageEvents[0].id,'live','partial writes must preserve the previous badges');
  // A partial unrelated writer must not stop message ingestion. A burst found
  // by one refresh leaves one send at a time, in the order the sends were made.
  malformedAuxiliary=true;
  const burst=Array.from({length:12},(_,index)=>({id:`burst-${index}`,source:'source',target:'target',at:Date.now(),seq:index+1}));
  log=JSON.stringify({events:[{id:'live',source:'source',target:'target',at:Date.now()},...burst]});
  await refresh();
  assert.equal(view.activeFlows.length,1,'the burst waits for the next departure slot');
  assert.deepEqual(view.pendingFlows.map(flow=>flow.id),burst.map(flow=>flow.id),'waiting in send order');
  pinText=JSON.stringify({spaces:[{id:'stable-id',machine:null}]});
  await refresh();
  assert.equal(view.workspacePins.spaces[0].id,'stable-id','config-only edits refresh without a message or focus change');
  pinText='{partial';await refresh();
  assert.equal(view.workspacePins.spaces[0].id,'stable-id','partial config keeps the last valid pins');
  pinText=JSON.stringify({spaces:{invalid:true}});await refresh();
  assert.equal(view.workspacePins.spaces[0].id,'stable-id','invalid schema keeps the last valid pins');
  pinText=JSON.stringify({spaces:[]});await refresh();
  assert.deepEqual(view.workspacePins,{spaces:[]});
  assert.equal(rawReads,0,'no raw message/config read polling remains');
  assert.ok(commands.length>0,'native command wakes deliver queued data');
  assert.deepEqual(ownershipViolations,[],'notifications only run after the receiver command resumes');
  const visibilityEvent=async value=>{
    visible=value;
    if(waitingCommand){const resolve=waitingCommand;waitingCommand=null;resolve('window.visibility');}
    else commandQueue.push('window.visibility');
    await settle();
  };
  const activeTimers=[...view.flowTimers];assert(activeTimers.length>0);
  await visibilityEvent(false);
  assert.equal(view.sidebarVisible,false);assert.equal(view.activeFlows.length,0);
  assert(activeTimers.every(timer=>timer.cancelled),'hidden event cancels all pending packet transitions without a render');
  if(native)assert.equal(sampler.cancelled,true,'hidden event cancels the memory sampler');
  const hidden=Array.from({length:5},(_,index)=>({id:`while-hidden-${index}`,source:'source',target:'target',at:Date.now(),seq:13+index}));
  log=JSON.stringify({events:[...burst,{id:'stale-hidden',source:'source',target:'target',at:Date.now()-120000,seq:12.5},...hidden]});
  if(!native){publishFiles();await settle();}
  assert.equal(view.activeFlows.length,0,'hidden delivery cannot start motion');
  await visibilityEvent(true);
  assert.equal(view.sidebarVisible,true);
  assert.deepEqual([...view.activeFlows,...view.pendingFlows].map(flow=>flow.id),hidden.slice(-3).map(flow=>flow.id),'showing replays only the latest three hidden sends, in order');
  if(native)assert.equal(timers.filter(item=>item.ms===1000&&item.options?.owner===null).at(-1).cancelled,false,'shown event resumes one native sampler');
  view.stopLiveMessages?.();for(const stop of view.fileSubscriptions)stop();assert.equal(subscriptions.size,0);
  delete globalThis.__sixfoldTest;
});
