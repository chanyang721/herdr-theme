import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('a large burst keeps only the newest sends, leaves them one by one and drains',async()=>{
  const source=(await readFile(new URL('../mods/sixfold-desk/main.js',import.meta.url),'utf8')).replace(/^import .*;$/gm,'');
  const {default:Sidebar}=await import('data:text/javascript;base64,'+Buffer.from('class View {}\n'+source).toString('base64'));
  const view=new Sidebar(),timers=[],arrived=new Set(),departed=[];
  Object.assign(view,{activeFlows:[],pendingFlows:Array.from({length:400},(_,i)=>({id:String(i),source:'a',target:'b',at:1000+i,seq:i+1})).reverse()});
  const cx={notify(){for(const flow of view.activeFlows){if(flow.phase==='arrived')arrived.add(flow.id);if(!departed.includes(flow.id))departed.push(flow.id);}},timer:{after(ms,fn){const timer={ms,fn,cancel(){}};timers.push(timer);return timer;}}};
  view.startFlows(cx);cx.notify();
  assert.equal(view.activeFlows.length,1,'one departure, the rest wait for their slot');
  assert.equal(view.activeFlows[0].id,'388','the oldest of the newest twelve');
  assert.equal(view.pendingFlows.length,11);assert.equal(view.skippedFlows,388);
  const gap=timers.at(-1).ms;assert(gap>=90&&gap<320,'a long queue shortens the gap to catch up');
  while(timers.length){assert.ok(timers.length<=4*12);assert.ok(view.activeFlows.length<=64);timers.sort((a,b)=>a.ms-b.ms).shift().fn(cx);}
  assert.deepEqual(departed,Array.from({length:12},(_,i)=>String(388+i)),'left in send order');
  assert.equal(arrived.size,12);
  assert.equal(view.activeFlows.length,0);
  assert.equal(view.pendingFlows.length,0);
  assert.equal(view.skippedFlows,0,'the skipped count clears once everything has arrived');
});

test('departures wait for the real gap between sends, within 320ms to 1.2s',async()=>{
  const source=(await readFile(new URL('../mods/sixfold-desk/main.js',import.meta.url),'utf8')).replace(/^import .*;$/gm,'');
  const {default:Sidebar}=await import('data:text/javascript;base64,'+Buffer.from('class View {}\n'+source).toString('base64'));
  for(const [delta,expected] of [[0,320],[700,700],[5000,1200]]){
    const view=new Sidebar(),timers=[];
    Object.assign(view,{activeFlows:[],pendingFlows:[{id:'a',source:'x',target:'y',at:1000,seq:1},{id:'b',source:'x',target:'y',at:1000+delta,seq:2}]});
    view.startFlows({notify(){},timer:{after(ms,fn){const timer={ms,fn,cancel(){}};timers.push(timer);return timer;}}});
    assert.equal(view.activeFlows.length,1);assert.equal(timers.at(-1).ms,expected);
  }
});

// Run the actual finite lifecycle: repeated packets share a lane, reverse
// traffic uses another lane, and every packet expires without replaying history.
test('live transfers keep direction and all expire after the brief notice',async()=>{
  const source=(await readFile(new URL('../mods/sixfold-desk/main.js',import.meta.url),'utf8')).replace(/^import .*;$/gm,'');
  const {default:Sidebar}=await import('data:text/javascript;base64,'+Buffer.from('class View {}\n'+source).toString('base64'));
  const view=new Sidebar(),timers=[];
  Object.assign(view,{workflowNodes:[],expandedAgents:new Set(),activeFlows:[],pendingFlows:[
    {id:'one',source:'a',target:'b'},{id:'two',source:'a',target:'b'},{id:'back',source:'b',target:'a'},
  ]});
  const cx={notify(){},timer:{after(ms,fn){const timer={ms,fn,cancel(){}};timers.push(timer);return timer;}}};
  view.startFlows(cx);
  assert.equal(view.activeFlows.length,1,'sends leave one at a time');
  // Open the next two departure slots before any packet lands.
  for(let i=0;i<2;i++){const slot=timers.filter(timer=>timer.ms===320).shift();timers.splice(timers.indexOf(slot),1);slot.fn(cx);}
  assert.equal(view.activeFlows.length,3);
  assert.equal(view.activeFlows[0].lane,view.activeFlows[1].lane);
  assert.notEqual(view.activeFlows[0].lane,view.activeFlows[2].lane);
  assert(view.activeFlows.every(flow=>flow.travelMs===1600),'every send moves at the same visible speed');
  while(timers.length)timers.sort((a,b)=>a.ms-b.ms).shift().fn(cx);
  assert.equal(view.activeFlows.length,0);
  assert.equal(view.pendingFlows.length,0);
});
