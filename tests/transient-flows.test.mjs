import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

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
  assert.equal(view.activeFlows[0].travelMs,2600);
  assert.equal(view.activeFlows[1].travelMs,2820);
  for(const timer of timers.sort((a,b)=>a.ms-b.ms))timer.fn(cx);
  assert.equal(view.activeFlows.length,0);
  assert.equal(view.pendingFlows.length,0);
  assert.equal(timers.length,9,'three finite transitions per send, no recurring animation timer');
});

for(const motion of [true,false])test(`native pipeline shows forward/reverse arrows and independent packets with motion=${motion}`,async()=>{
  const ids=new Map(),strokes=[],transitions=[];
  function element(){
    let proxy;
    const target={};
    proxy=new Proxy(target,{get(obj,key){
      if(key==='then')return undefined;
      if(key==='when')return (condition,fn)=>{if(condition)fn(proxy);return proxy;};
      if(key==='id')return id=>{ids.set(id,target);return proxy;};
      if(key==='children')return ()=>proxy;
      if(key==='transition')return (...args)=>{transitions.push(args);return proxy;};
      return (...args)=>{obj[key]=args;return proxy;};
    }});
    return proxy;
  }
  const builder=new Proxy({},{get:()=>()=>builder});
  globalThis.__pipelineTest={div:element,PathBuilder:{stroke(width){strokes.push(width);return builder;}},window:{paint_path:element}};
  const source=(await readFile(new URL('../mods/sixfold-desk/pipeline.js',import.meta.url),'utf8'))
    .replace("import { div, PathBuilder } from 'gpui-kit';",'const {div,PathBuilder,window}=globalThis.__pipelineTest;');
  const {pipeline}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64')+`#motion=${motion}`);
  pipeline({id:'down',from:10,to:110,width:37,color:'#ffffff',phase:'travel',motion,packets:[{id:'p1',phase:'travel',travelMs:2600},{id:'p2',phase:'start',travelMs:2820}]});
  assert.deepEqual(ids.get('sf-route-target-down').child,['▼']);
  assert(ids.has('sf-route-source-down'));
  assert(ids.has('sf-pipeline-window-p1'));assert(ids.has('sf-pipeline-window-p2'));
  assert(strokes.includes(7) && strokes.includes(2) && strokes.includes(5),'glow, base and bright packet strokes remain distinct');
  assert.equal(transitions.filter(([property])=>property==='top').length,motion?4:0);
  pipeline({id:'up',from:110,to:10,width:32,color:'#ffffff',phase:'arrived',motion,packets:[]});
  assert.deepEqual(ids.get('sf-route-target-up').child,['▲']);
  delete globalThis.__pipelineTest;
});
