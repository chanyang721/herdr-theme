import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('a large burst stays below the host task limit and drains every packet',async()=>{
  const source=(await readFile(new URL('../mods/sixfold-desk/main.js',import.meta.url),'utf8')).replace(/^import .*;$/gm,'');
  const {default:Sidebar}=await import('data:text/javascript;base64,'+Buffer.from('class View {}\n'+source).toString('base64'));
  const view=new Sidebar(),timers=[],arrived=new Set();
  Object.assign(view,{activeFlows:[],pendingFlows:Array.from({length:400},(_,i)=>({id:String(i),source:'a',target:'b'}))});
  const cx={notify(){for(const flow of view.activeFlows)if(flow.phase==='arrived')arrived.add(flow.id);},timer:{after(ms,fn){timers.push({ms,fn});}}};
  view.startFlows(cx);
  assert.equal(view.activeFlows.length,64);
  assert.equal(view.pendingFlows.length,336);
  while(timers.length){assert.ok(timers.length<=192);assert.ok(view.activeFlows.length<=64);timers.shift().fn(cx);}
  assert.equal(arrived.size,400);
  assert.equal(view.activeFlows.length,0);
  assert.equal(view.pendingFlows.length,0);
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
  const cx={notify(){},timer:{after(ms,fn){timers.push({ms,fn});}}};
  view.startFlows(cx);
  assert.equal(view.activeFlows.length,3);
  assert.equal(view.activeFlows[0].lane,view.activeFlows[1].lane);
  assert.notEqual(view.activeFlows[0].lane,view.activeFlows[2].lane);
  assert.equal(view.activeFlows[0].travelMs,1600);
  assert.equal(view.activeFlows[1].travelMs,1780);
  for(const timer of timers.sort((a,b)=>a.ms-b.ms))timer.fn(cx);
  assert.equal(view.activeFlows.length,0);
  assert.equal(view.pendingFlows.length,0);
  assert.equal(timers.length,9,'three finite transitions per send, no recurring animation timer');
});
