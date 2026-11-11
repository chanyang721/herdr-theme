import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../mods/sixfold-desk/main.js',import.meta.url),'utf8');
const helperText=source.match(/export function spawnOrRelease\(cx, release, task\) \{[\s\S]*?\n\}/)[0].replace('export ','');
const spawnOrRelease=new Function(`${helperText}\nreturn spawnOrRelease;`)();

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

test('the unread ledger job keeps running after one spawn throws',()=>{
 const block=source.match(/    let readBusy=false;\n    cx\.timer\.every\(1000,[\s\S]*?\n    \}\);\n/)[0];
 let tick,attempts=0,scheduled=0;
 const view={sidebarVisible:true,messageEvents:[{id:'one'}]};
 const cx={timer:{every(_ms,fn){tick=fn;}},spawn(){attempts++;throw new Error('host temporarily rejected spawn');}};
 new Function('cx','spawnOrRelease',block).call(view,cx,spawnOrRelease);
 tick(cx);
 cx.spawn=()=>{attempts++;scheduled++;};
 tick(cx);
 assert.equal(attempts,2);assert.equal(scheduled,1,'the next tick schedules the ledger write again');
});

test('every busy-flag job starts through spawnOrRelease',()=>{
 const lines=source.split('\n');
 const starts=lines.flatMap((line,i)=>/Busy\s*=\s*true/.test(line)?[i]:[]);
 assert(starts.length>=7,'the periodic jobs are all found');
 for(const i of starts){
  const next=lines.slice(i+1,i+10).find(line=>line.trim()&&!line.trim().startsWith('//'));
  assert.match(next,/spawnOrRelease\(cx,/,`line ${i+1} starts its job without a release on spawn failure`);
 }
});

const voiceBlock=()=>source.match(/    let voiceBusy=false, voiceActionBusy=false, voiceKey=null;\n    cx\.timer\.every\(500,[\s\S]*?\n    \}\);\n/)[0];
async function voiceRun(spawnPlan,helper){
 let tick,spawnCalls=0,helperCalls=0,heartbeats=0;const pending=[];
 const cx={timer:{every(_ms,fn){tick=fn;}},spawn(task){spawnCalls++;if(spawnPlan(spawnCalls))throw new Error('host rejected spawn');pending.push(task(cx));}};
 const view={sidebarFiles:{voice:{command:['demo-helper']}}};
 new Function('cx','spawnOrRelease','focused','terminals','window','agents','appHome','readTextFile','writeTextFile','invokeHelper','exec',voiceBlock()).call(view,cx,spawnOrRelease,
  ()=>({terminal:'t-demo'}),()=>[{address:'t-demo',labels:{}}],()=>({active:true}),()=>[],()=>'/demo-app',async()=>null,
  async()=>{heartbeats++;},async()=>{helperCalls++;return helper(helperCalls);},async()=>({code:0}));
 const settle=async()=>{while(pending.length)await Promise.allSettled(pending.splice(0));};
 return {tick:async()=>{tick(cx);await settle();},counts:()=>({spawnCalls,helperCalls,heartbeats})};
}

test('a voice action whose spawn is rejected runs on the next tick for the same focus',async()=>{
 const run=await voiceRun(n=>n===2,()=>({code:0}));
 await run.tick();assert.equal(run.counts().helperCalls,0);
 await run.tick();
 assert.deepEqual(run.counts(),{spawnCalls:4,helperCalls:1,heartbeats:2},'the focus change is not consumed by a rejected spawn');
 await run.tick();
 assert.equal(run.counts().helperCalls,1,'once the helper ran, the same focus is not sent again');
});

test('a voice helper that started and failed is not retried for the same focus',async()=>{
 const run=await voiceRun(()=>false,()=>{throw new Error('helper failed');});
 await run.tick();await run.tick();
 assert.equal(run.counts().helperCalls,1,'a tried action keeps the focus key consumed');
});
