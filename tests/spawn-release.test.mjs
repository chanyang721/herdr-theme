import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../mods/sixfold-desk/main.js',import.meta.url),'utf8');
const helperText=source.match(/export function spawnOrRelease\(cx, release, task\) \{[\s\S]*?\n\}/)[0].replace('export ','');
const spawnOrRelease=new Function(`${helperText}\nreturn spawnOrRelease;`)();
const {createPoll,changeGate}=await import(new URL('../mods/sixfold-desk/poll.js',import.meta.url).href);
const heartbeatMs=Number(source.match(/const VOICE_HEARTBEAT_MS = (\d+);/)[1]);

test('a spawn that throws before its callback runs releases the busy flag',()=>{
 let busy=true,ran=0;
 assert.equal(spawnOrRelease({spawn(){throw new Error('host rejected spawn');}},()=>{busy=false;},()=>{ran++;}),false);
 assert.equal(busy,false);assert.equal(ran,0);
 let scheduled=null;
 busy=true;
 assert.equal(spawnOrRelease({spawn(task){scheduled=task;}},()=>{busy=false;},()=>{}),true);
 assert.equal(busy,true,'a scheduled task releases the flag itself in its finally');
 assert.equal(typeof scheduled,'function');
});

test('the unread ledger job keeps running after one spawn throws, and runs only on change or fallback',async()=>{
 const block=source.match(/    const readInputs=changeGate\(\);\n[\s\S]*?\n      \}\}\);\n/)[0];
 let tick,attempts=0,reads=0,now=0;const pending=[];
 const view={sidebarVisible:true,messageEvents:[{id:'one',at:1}],readMessages:{}};
 const cx={timer:{every(_ms,fn){tick=fn;return {cancel(){}};}},notify(){},spawn(){attempts++;throw new Error('host temporarily rejected spawn');}};
 const poll=(c,options)=>createPoll(c,{...options,now:()=>now});
 new Function('cx','createPoll','changeGate','focused','agents','appHome','readTextFile','writeTextFile','readThrough',block).call(view,cx,poll,changeGate,
  ()=>({terminal:'t-demo'}),()=>[],()=>'/demo-app',async()=>{reads++;return null;},async()=>{},()=>({}));
 tick(cx);
 cx.spawn=task=>{attempts++;pending.push(task(cx));};
 tick(cx);await Promise.all(pending.splice(0));
 assert.equal(attempts,2);assert.equal(reads,1,'the next tick schedules the ledger write again');
 now=1000;tick(cx);now=2000;tick(cx);await Promise.all(pending.splice(0));
 assert.equal(reads,1,'unchanged events, focus and agents: no ledger read');
 view.messageEvents=[...view.messageEvents,{id:'two',at:2}];now=3000;tick(cx);await Promise.all(pending.splice(0));
 assert.equal(reads,2,'a new event reads at once');
 now=8000;tick(cx);await Promise.all(pending.splice(0));
 assert.equal(reads,3,'the 5 s fallback covers reads due by time');
});

test('every busy-flag job starts through spawnOrRelease',()=>{
 const lines=source.split('\n');
 const starts=lines.flatMap((line,i)=>/Busy\s*=\s*true/.test(line)?[i]:[]);
 assert(starts.length>=5,'the periodic jobs are all found');
 for(const name of ['readPoll','collaborationPoll'])assert.match(source,new RegExp(`this\\.${name}=createPoll\\(cx,`),`${name} runs through createPoll`);
 for(const i of starts){
  const next=lines.slice(i+1,i+10).find(line=>line.trim()&&!line.trim().startsWith('//'));
  assert.match(next,/spawnOrRelease\(cx,/,`line ${i+1} starts its job without a release on spawn failure`);
 }
});

const voiceBlock=()=>source.match(/    let voiceBusy=false, voiceActionBusy=false, voiceKey=null, voiceText=null, voiceAt=0;\n    cx\.timer\.every\(500,[\s\S]*?\n    \}\);\n/)[0];
async function voiceRun(spawnPlan,helper,focus={terminal:'t-demo'}){
 let tick,spawnCalls=0,helperCalls=0,heartbeats=0,now=10000;const pending=[],written=[];
 const cx={timer:{every(_ms,fn){tick=fn;}},spawn(task){spawnCalls++;if(spawnPlan(spawnCalls))throw new Error('host rejected spawn');pending.push(task(cx));}};
 const view={sidebarFiles:{voice:{command:['demo-helper']}}};
 new Function('cx','spawnOrRelease','focused','terminals','window','agents','appHome','readTextFile','writeTextFile','invokeHelper','exec','Date','VOICE_HEARTBEAT_MS',voiceBlock()).call(view,cx,spawnOrRelease,
  ()=>focus,()=>[{address:'t-demo',labels:{}},{address:'t-other',labels:{}}],()=>({active:true}),()=>[],()=>'/demo-app',async()=>null,
  async(_path,text)=>{heartbeats++;written.push(JSON.parse(text));},async()=>{helperCalls++;return helper(helperCalls);},async()=>({code:0}),{now:()=>now},heartbeatMs);
 const settle=async()=>{while(pending.length)await Promise.allSettled(pending.splice(0));};
 return {tick:async(ms=500)=>{now+=ms;tick(cx);await settle();},counts:()=>({spawnCalls,helperCalls,heartbeats}),written,focus};
}

test('a voice action whose spawn is rejected runs on the next tick for the same focus',async()=>{
 const run=await voiceRun(n=>n===2,()=>({code:0}));
 await run.tick();assert.equal(run.counts().helperCalls,0);
 await run.tick();
 assert.deepEqual(run.counts(),{spawnCalls:4,helperCalls:1,heartbeats:1},'the focus change is not consumed by a rejected spawn');
 await run.tick();
 assert.equal(run.counts().helperCalls,1,'once the helper ran, the same focus is not sent again');
});

test('a voice helper that started and failed is not retried for the same focus',async()=>{
 const run=await voiceRun(()=>false,()=>{throw new Error('helper failed');});
 await run.tick();await run.tick();
 assert.equal(run.counts().helperCalls,1,'a tried action keeps the focus key consumed');
});

test('voice focus is written on change at once and otherwise only as a heartbeat inside the 2.5 s staleness window',async()=>{
 assert.ok(heartbeatMs+500<2500,'the heartbeat plus one sample stays below the focus-queue staleness threshold');
 const run=await voiceRun(()=>false,()=>({code:0}));
 await run.tick();assert.equal(run.counts().heartbeats,1);
 for(let elapsed=500;elapsed<heartbeatMs;elapsed+=500)await run.tick();
 assert.equal(run.counts().heartbeats,1,'unchanged focus is not rewritten every sample');
 await run.tick();assert.equal(run.counts().heartbeats,2,'the heartbeat is due');
 run.focus.terminal='t-other';await run.tick();
 assert.equal(run.counts().heartbeats,3,'a focus change is written on the next sample');
 assert.equal(run.written.at(-1).terminal,'t-other');assert.equal(typeof run.written.at(-1).at,'number');
 assert.equal(run.counts().helperCalls,2,'and announced to the helper');
});

test('collaborate drain runs every tick only while the ledger holds work, else on the 60 s fallback while shown',async()=>{
 const block=source.match(/    this\.collaborationWork=true;[\s\S]*?\n      \}\}\);\n/)[0];
 const work=new Set(JSON.parse(source.match(/const COLLABORATION_WORK = new Set\((\[[^\]]*\])\)/)[1].replace(/'/g,'"')));
 let tick,deliver,now=0,drains=0;const pending=[];
 const view={collaborationScript:['demo'],fileSubscriptions:[]};
 const cx={timer:{every(_ms,fn){tick=fn;return {cancel(){}};}},spawn(task){pending.push(task(cx));}};
 new Function('cx','createPoll','subscribeJsonFile','appHome','invokeHelper','COLLABORATION_WORK','COLLABORATION_FALLBACK_MS',block).call(view,cx,
  (c,options)=>createPoll(c,{...options,now:()=>now}),(_cx,_path,callback)=>{deliver=callback;return()=>{};},()=>'/demo-app',async()=>{drains++;},work,60000);
 const run=async ms=>{now+=ms;tick(cx);await Promise.all(pending.splice(0));};
 deliver({status:'ready',value:{tasks:{a:{state:'completed'}}}});
 await run(0);assert.equal(drains,1,'the first tick is past the fallback');
 for(let i=0;i<10;i++)await run(2000);
 assert.equal(drains,1,'no pending work: no drain every 2 s');
 deliver({status:'ready',value:{tasks:{a:{state:'pending'}}}});await Promise.all(pending.splice(0));
 assert.equal(drains,2,'new work drains at once');
 await run(2000);await run(2000);assert.equal(drains,4,'and every tick while it lasts');
 deliver({status:'ready',value:{tasks:{a:{state:'completed'}}}});
 await run(2000);assert.equal(drains,4);
 await run(60000);assert.equal(drains,5,'the fallback still drains once a minute');
 view.sidebarVisible=false;await run(60000);await run(60000);assert.equal(drains,5,'a hidden sidebar holds the fallback');
 deliver({status:'ready',value:{tasks:{a:{state:'pending'}}}});await Promise.all(pending.splice(0));
 assert.equal(drains,6,'work found while hidden still drains');
 deliver({status:'ready',value:{tasks:{a:{state:'completed'}}}});
 view.sidebarVisible=true;await run(60000);assert.equal(drains,7,'shown again: the fallback resumes');
});

test('peer status is asked only while the sidebar is shown, and catches up when it is',async()=>{
 const block=source.match(/    let computersBusy=false, computersAt=0;\n[\s\S]*?\n    \}\);\n/)[0];
 let tick,calls=0,now=100000;const pending=[];
 const view={computers:{tailscale:true},tailscalePeers:[],sidebarVisible:false};
 const cx={timer:{every(_ms,fn){tick=fn;}},notify(){},spawn(task){pending.push(task(cx));}};
 new Function('cx','spawnOrRelease','exec','native','Date',block).call(view,cx,spawnOrRelease,
  async()=>{calls++;return {code:0,stdout:'{"peers":[]}'};},()=>'demo-helper',{now:()=>now});
 const run=async ms=>{now+=ms;tick(cx);await Promise.all(pending.splice(0));};
 await run(0);await run(20000);assert.equal(calls,0,'hidden: no helper run');
 view.sidebarVisible=true;await run(1000);assert.equal(calls,1,'shown: asks at once');
 await run(1000);assert.equal(calls,1,'then at most every 15 s');
 await run(15000);assert.equal(calls,2);
});
