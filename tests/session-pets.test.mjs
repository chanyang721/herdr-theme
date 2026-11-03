import test from 'node:test';
import assert from 'node:assert/strict';
import {petSessions,petOptions,petTooltip} from '../mods/session-pets/model.js';
test('observed identity survives status transition; other spaces and duplicates excluded',()=>{
 const a={address:'t1',space:'one',title:'분석',space_name:'업무'};
 for(const [status,pose] of [['working','walk'],['idle','sleep'],['blocked','raise'],['done','sit']]) {
  const result=petSessions([{...a,status},{...a,status},{address:'t2',space:'two',status}], 'one');
  assert.equal(result.length,1); assert.equal(result[0].pose,pose); assert.equal(result[0].address,'t1');
  assert.match(petTooltip(result[0]),/업무 · 분석 · t1/);
 }
 assert.equal(petSessions([{...a,status:'disconnected'}],'one')[0].label,'상태 미확인');
 assert.deepEqual(petSessions([], 'one'),[]);
});
test('enabled by default with opt out and both reduced-motion switches',()=>{
 const read=values=>key=>values[key];
 assert.equal(petOptions(read({})).enabled,true);
 assert.equal(petOptions(read({'sixfold.pets':false})).enabled,false);
 assert.equal(petOptions(read({'sixfold.pets':true})).enabled,true);
 for(const key of ['sixfold.motion','sixfold.pets.motion']) assert.equal(petOptions(read({[key]:false})).motion,false);
});
test('rendered pet press only stops propagation and reduced motion removes loops',async()=>{
 const {readFile}=await import('node:fs/promises');
 const rows=new Map(),loops=[];let enabled=true,motion=true,stopped=0;
 function element(){const target={};let proxy;proxy=new Proxy(target,{get(t,key){
  if(key==='then')return undefined;
  if(key==='id')return id=>{rows.set(id,proxy);return proxy;};
  if(key==='when')return (condition,fn)=>{if(condition)fn(proxy);return proxy;};
  if(key==='loop')return (...args)=>{loops.push(args);return proxy;};
  if(key==='on_mouse_down')return (_button,fn)=>{t.press=fn;return proxy;};
  if(key==='press')return t.press;
  return ()=>proxy;
 }});return proxy;}
 globalThis.__petRuntime={View:class{},div:element,svg:element,h_flex:element,
  agents:()=>[{address:'t1',space:'s',status:'working'},{address:'t2',space:'s',status:'blocked'}],
  focused:()=>({space:'s'}),props:()=>({}),theme:()=>({}),
  shared:key=>key==='sixfold.pets'?enabled:key==='sixfold.motion'?motion:undefined};
 let source=await readFile(new URL('../mods/session-pets/main.js',import.meta.url),'utf8');
 source=source.replace(/import \{([^}]+)\} from '(gpui-kit|gpui-base|herdr)';/g,'const {$1}=globalThis.__petRuntime;')
  .replace("'./model.js'",JSON.stringify(new URL('../mods/session-pets/model.js',import.meta.url).href));
 try{
  const {default:Pets}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  new Pets().render();assert.equal(loops.length,1);assert.equal(loops[0][1].period,12000);
  rows.get('pet-t1').press({}, {stop_propagation:()=>stopped++});assert.equal(stopped,1);
  rows.clear();loops.length=0;motion=false;new Pets().render();assert.equal(loops.length,0);
  rows.clear();enabled=false;new Pets().render();assert.equal(rows.size,0);
 }finally{delete globalThis.__petRuntime;}
});
