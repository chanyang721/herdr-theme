import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

async function loadPets(){
 const glyphs=[],loops=[],frames=[],sizes=new Map();
 function element(path){const target={path};let proxy;proxy=new Proxy(target,{get(t,key){
  if(key==='then')return undefined;
  if(key==='id')return id=>{t.id=id;if(t.path)glyphs.push({id,path:t.path});return proxy;};
  if(key==='w'||key==='h')return value=>{if(t.id){const box=sizes.get(t.id)||{};box[key]=value;sizes.set(t.id,box);}return proxy;};
  if(key==='loop')return (axis,config)=>{loops.push({id:t.id,axis,...config});return proxy;};
  if(key==='frames')return (list,ms)=>{frames.push({list,ms});return proxy;};
  if(key==='when')return (condition,fn)=>{if(condition)fn(proxy);return proxy;};
  return ()=>proxy;
 }});return proxy;}
 globalThis.__panePetRuntime={div:()=>element(),svg:path=>element(path)};
 const source=(await readFile(new URL('../mods/sixfold-desk/pets.js',import.meta.url),'utf8'))
  .replace("import {div,svg} from 'gpui-kit';",'const {div,svg}=globalThis.__panePetRuntime;');
 const module=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 return {module,glyphs,loops,frames,sizes};
}

test('the header cat gallops natively while working and rests otherwise',async()=>{
 try{
  const {module,glyphs,loops,frames,sizes}=await loadPets();
  const palette={working:'#11aaee',blocked:'#ee3344',done:'#44cc77',ansi2:'#44cc77',accent:'#eeeeee',canvas:'#000000'};
  const on=()=>true;
  module.panePet({pane:'p1',terminal:'t1',status:'working',title:'session'},palette,on,{base:'#101010',background:'#11aaee24'});
  assert.deepEqual(glyphs.map(g=>g.path.split('/').pop()),['run-0.svg','run-4.svg','run-3.svg','run-2.svg','run-1.svg'],'frame 0 at the bottom, then 4 to 1 stacked above it');
  assert.equal(new Set(glyphs.map(g=>g.id)).size,glyphs.length,'glyph ids stay unique');
  assert.equal(frames.length,module.RUN_LAYERS.length,'each stacked frame has a native gate');
  assert.ok(frames.every(f=>f.ms===module.RUN_STEP_MS&&f.list.length===module.RUN_FRAMES*2),'gates share one half-frame cadence');
  const layers=module.RUN_LAYERS.map((layer,i)=>({frame:layer.frame,list:frames[i].list}));
  const top=open=>{let shown=0;layers.forEach((l,i)=>{if(open[i])shown=l.frame;});return shown;};
  const openAt=step=>layers.map(l=>l.list[step]!=='');
  const steps=module.RUN_FRAMES*2;
  assert.deepEqual(Array.from({length:steps},(_,s)=>top(openAt(s))),[0,0,1,1,2,2,3,3,4,4],'frames 0 to 4 in order, 110 ms each');
  for(let s=0;s<steps;s++){
   const before=openAt(s),after=openAt((s+1)%steps);
   assert.ok(before.filter((o,i)=>o!==after[i]).length<=1,`only one gate changes at step edge ${s}`);
   // Gates sampled on either side of the edge: any mix shows the frame before or after.
   for(let mask=0;mask<1<<layers.length;mask++){
    const mixed=before.map((o,i)=>mask>>i&1?after[i]:o);
    assert.ok([top(before),top(after)].includes(top(mixed)),`edge ${s}: no stray frame`);
   }
  }
  assert.deepEqual(sizes.get('pane-pet-p1'),{w:24,h:22},'the header box never changes size');
  assert.equal(loops.length,0,'running is a frame cycle, not a native swing');
  const poses={blocked:'sit.svg',done:'sit.svg',idle:'sleep.svg'};
  for(const [status,pose] of Object.entries(poses)){
   glyphs.length=0;
   module.panePet({pane:'p1',terminal:'t1',status},palette,on);
   assert.equal(glyphs[0].path.split('/').pop(),pose,status);
  }
  assert.ok(loops.some(l=>l.axis==='top'&&l.period===3200),'idle breathes slowly');
  glyphs.length=0;frames.length=0;
  module.panePet({pane:'p1',terminal:'t1',status:'working'},palette,key=>key!=='sixfold.motion');
  assert.deepEqual(glyphs.map(g=>g.path.split('/').pop()),['run-0.svg'],'motion off holds one frame');
  assert.equal(frames.length,0,'motion off runs no frame cycle');
  assert.equal(module.petRunning('working',on),true);
  assert.equal(module.petRunning('idle',on),false,'an idle pane never redraws for the cat');
  assert.equal(module.petRunning('working',key=>key!=='sixfold.pets'),false);
  const main=await readFile(new URL('../mods/sixfold-desk/main.js',import.meta.url),'utf8');
  assert.match(main,/\.child\(panePet\(p,t,shared,style\)\)\s*\.child\(this\.badge\(/,'the cat stands right before the status badge, on the header ground');
  assert.match(main,/if \(role === 'pane'\) return this\.paneHeader\(all, t, w\);/,'headers skip the sidebar work');
  assert.doesNotMatch(main,/RUN_FRAME_MS|petFrame/,'a pane header keeps no cat timer');
  assert.match(main,/if \(props\(\)\?\.role === 'pane'\) return;/,'a pane header starts no timers');
  for(const name of ['run-0','run-1','run-2','run-3','run-4','sit','sleep'])
   assert.match(await readFile(new URL(`../mods/sixfold-desk/icons/cat/${name}.svg`,import.meta.url),'utf8'),/viewBox="0 0 24 16"/);
  const layout=JSON.parse(await readFile(new URL('../layouts/sixfold.json',import.meta.url),'utf8'));
  assert.equal(JSON.stringify(layout).includes('"id":"session-pets"'),false);
  const findHeader=node=>node?.header||node?.pane?.header||Object.values(node||{}).map(value=>value&&typeof value==='object'?findHeader(value):null).find(Boolean);
  assert.equal(findHeader(layout)?.height,43,'fixed header offsets the removed 16px row');
 }finally{delete globalThis.__panePetRuntime;}
});
