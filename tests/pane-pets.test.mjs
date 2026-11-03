import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('pane pet poses and motion vary by status while its header box stays fixed',async()=>{
 const ids=new Map(),loops=[],sizes=new Map();
 function element(){const target={};let proxy;proxy=new Proxy(target,{get(t,key){
  if(key==='then')return undefined;
  if(key==='id')return id=>{t.id=id;ids.set(id,proxy);return proxy;};
  if(key==='w'||key==='h')return value=>{const box=sizes.get(t.id)||{};box[key]=value;sizes.set(t.id,box);return proxy;};
  if(key==='loop')return (axis,config)=>{loops.push({id:t.id,axis,...config});return proxy;};
  if(key==='when')return (condition,fn)=>{if(condition)fn(proxy);return proxy;};
  return ()=>proxy;
 }});return proxy;}
 globalThis.__panePetRuntime={div:element,svg:element};
 let source=await readFile(new URL('../mods/sixfold-desk/pets.js',import.meta.url),'utf8');
 source=source.replace("import {div,svg} from 'gpui-kit';",'const {div,svg}=globalThis.__panePetRuntime;')
   .replace("import {petSessions,petOptions,petTooltip} from '../session-pets/model.js';",`const {petSessions,petOptions,petTooltip}=await import(${JSON.stringify(new URL('../mods/session-pets/model.js',import.meta.url).href)});`);
 try{
  const {panePet}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const palette={working:'#11aaee',blocked:'#ee3344',done:'#44cc77',ansi2:'#44cc77',accent:'#eeeeee',canvas:'#000000',muted:'#999999'};
  const shared=()=>true;
  const expected={working:['left',620],blocked:['left',180],done:['top',1250],idle:['top',3200]};
  for(const [status,[axis,period]] of Object.entries(expected)){
   panePet({pane:'p1',terminal:'t1',space:'s',status,title:'session'},palette,shared);
   assert.deepEqual(sizes.get('pane-pet-p1'),{w:24,h:22});
   assert.ok(loops.some(loop=>loop.id==='pane-pet-glyph-p1'&&loop.axis===axis&&loop.period===period),status);
  }
  const count=loops.length;
  panePet({pane:'p1',terminal:'t1',space:'s',status:'working'},palette,()=>false);
  assert.equal(loops.length,count);
  panePet({pane:'p1',terminal:'t1',space:'s',status:'blocked'},palette,()=>false);
  assert.deepEqual(sizes.get('pane-pet-p1'),{w:24,h:22});
  const main=await readFile(new URL('../mods/sixfold-desk/main.js',import.meta.url),'utf8');
  assert.match(main,/\.child\(panePet\(p,t,shared\)\)/);
  assert.match(main,/\.border\(1\)\.border_color\(style\.border\)/);
  const layout=JSON.parse(await readFile(new URL('../layouts/sixfold.json',import.meta.url),'utf8'));
  assert.equal(JSON.stringify(layout).includes('"id":"session-pets"'),false);
  const findHeader=node=>node?.header||node?.pane?.header||Object.values(node||{}).map(value=>value&&typeof value==='object'?findHeader(value):null).find(Boolean);
  assert.equal(findHeader(layout)?.height,43,'fixed header offsets the removed 16px row');
 }finally{delete globalThis.__panePetRuntime;}
});
