import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

function element(){
  const data={calls:[],nodes:[]};let proxy;
  proxy=new Proxy(data,{get(target,key){
    if(key in target)return target[key];
    return (...args)=>{
      if(key==='child')target.nodes.push(args[0]);
      else if(key==='children')target.nodes.push(...args[0]);
      else if(key==='when'){if(args[0])args[1](proxy);}
      else target.calls.push([key,...args]);
      return proxy;
    };
  }});return proxy;
}
async function load(){
  globalThis.__pipelineDiv=element;
  const url=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
  const stub=source=>source.replace("import { div } from 'gpui-kit';",'const div=globalThis.__pipelineDiv;');
  const pixel=url(stub(await readFile(new URL('../mods/sixfold-desk/pixel.js',import.meta.url),'utf8')));
  const source=stub(await readFile(new URL('../mods/sixfold-desk/pipeline.js',import.meta.url),'utf8')).replace("'./pixel.js'",JSON.stringify(pixel));
  return import(url(source));
}
const call=(node,key)=>node.calls.find(c=>c[0]===key)?.[1];
const find=(node,id)=>node.calls.some(c=>c[0]==='id'&&c[1]===id)?node:node.nodes.map(n=>find(n,id)).find(Boolean);
const chain=(tree,id)=>{const out=find(tree,`sf-pipeline-out-${id}`),along=out.nodes[0],block=along.nodes[0];return [out,along,block];};
// Where a native transition puts a property `ms` after its target changed.
function at(from,to,policy,ms){
  if(!policy)return to;
  const {duration,delay=0}=policy;
  if(ms<=delay)return from;if(ms>=delay+duration)return to;
  return from+(to-from)*(ms-delay)/duration;
}
const transition=(node,property)=>node.calls.find(c=>c[0]==='transition'&&c[1]===property)?.[2];

test('a workspace pipe packet leaves the sender, runs down the lane and enters the receiver',async()=>{
  const {pipeline,pipeLegs}=await load();
  const options={id:'route',width:8,inset:14,from:10,to:100,color:'#79D1DC',motion:true};
  const draw=phase=>pipeline({...options,phase,packets:[{id:'one',phase,travelMs:1600}]});
  const [startOut,startAlong,startBlock]=chain(draw('start'),'one');
  const travel=draw('travel'),[out,along,block]=chain(travel,'one');
  const legs=pipeLegs(1600);
  const position=ms=>({
    x:at(call(startOut,'left'),call(out,'left'),transition(out,'left'),ms)+at(call(startBlock,'left'),call(block,'left'),transition(block,'left'),ms)+1,
    y:at(call(startAlong,'top'),call(along,'top'),transition(along,'top'),ms)+1,
  });
  const source={x:14,y:0},lane={x:22},receiver={x:14,y:90};
  assert.deepEqual(position(0),source,'starts on the sending row end');
  assert.deepEqual(position(legs.out),{x:lane.x,y:source.y},'turns at the top corner of the lane');
  assert.deepEqual(position(legs.out+legs.down),{x:lane.x,y:receiver.y},'turns at the bottom corner of the lane');
  assert.deepEqual(position(1600),receiver,'ends on the receiving row end');
  for(let ms=0;ms<=1600;ms+=40){const p=position(ms);assert(p.x>=14&&p.x<=22&&p.y>=0&&p.y<=90,`stays on the pipe at ${ms}ms`);}
  const ring=find(draw('arrived'),'sf-pipeline-receiver-one');
  assert.equal(call(ring,'left')+7,receiver.x,'the arrival ring opens on the receiving end');
  const [,,arrivedBlock]=chain(draw('arrived'),'one');
  assert.equal(call(arrivedBlock,'left'),call(block,'left'),'arrival keeps the final targets, so nothing moves back');
  assert.equal(legs.out+legs.down+legs.back,1600);
  assert(Math.min(legs.out,legs.back)>=200,'each corner leg is visible');
});

test('an upward send runs up the same lane, and motion off draws only the pixel pipe',async()=>{
  const {pipeline}=await load();
  const options={id:'up',width:18,inset:14,from:100,to:10,color:'#79D1DC'};
  const [startOut,startAlong]=chain(pipeline({...options,motion:true,phase:'start',packets:[{id:'u',phase:'start'}]}),'u');
  const [out,along]=chain(pipeline({...options,motion:true,phase:'travel',packets:[{id:'u',phase:'travel'}]}),'u');
  assert(call(startAlong,'top')>call(along,'top'),'moves up');
  assert.equal(call(out,'left')-call(startOut,'left'),18);
  const still=pipeline({...options,motion:false,phase:'travel',packets:[{id:'u',phase:'travel'}]});
  assert(!find(still,'sf-pipeline-out-u'));
  const all=node=>[node,...node.nodes.flatMap(all)];
  assert(!all(still).some(node=>node.calls.some(c=>c[0]==='transition'||c[0]==='rounded')));
});
