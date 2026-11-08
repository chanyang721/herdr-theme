import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

let serial=0;
async function fixture(){
  globalThis.__retainedCardPrimitives={View:class{},div:()=>({empty:true})};
  const source=(await readFile(new URL('../mods/sixfold-desk/retained-cards.js',import.meta.url),'utf8'))
    .replace("import {View,div} from 'gpui-kit';",'const {View,div}=globalThis.__retainedCardPrimitives;');
  const {createRetainedCards}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${serial++}`);
  const timers=[],entities=[],notifies=[],builds=new Map();let rendering=false;
  const cx={
    new(Class,props){
      assert(!rendering,'cx.new is forbidden during parent render');assert.equal(typeof props.controller,'string');assert.equal(typeof props.id,'string');
      assert(Object.values(props).every(value=>typeof value==='string'),'no builder/function enters native props');
      const view=new Class();view.init(props);
      const entity={props,view,releases:0,released:false,release(){assert(!rendering,'release is forbidden during parent render');this.releases++;if(this.released)throw new Error('already released');this.released=true;},render(){return view.render(cx);}};
      entities.push(entity);return entity;
    },
    notify(entity){assert(!rendering,'notify is forbidden during parent render');notifies.push(entity??'parent');},
    timer:{after(ms,fn){assert.equal(ms,0);const task={fn,cancelled:false,cancel(){this.cancelled=true;}};timers.push(task);return task;}},
  };
  const cache=createRetainedCards(cx);
  const build=(id,label=id)=>()=>{builds.set(id,(builds.get(id)||0)+1);return {id,label,unique:{}};};
  const render=rows=>{rendering=true;try{cache.begin();const result=rows.map(([id,signature,label])=>cache.card(id,signature,build(id,label)));cache.end();return result;}finally{rendering=false;}};
  const flush=()=>{const batch=timers.splice(0);for(const task of batch)if(!task.cancelled)task.fn();};
  return {cache,cx,render,flush,timers,entities,notifies,builds,build,createRetainedCards,setRendering(value){rendering=value;}};
}

test('initial render uses one fresh fallback then creates retained entities outside render',async()=>{
  const f=await fixture(),rows=Array.from({length:20},(_,i)=>[`space-${i}`,'v1']);
  const first=f.render(rows);assert.equal(f.entities.length,0);assert.equal(f.timers.length,1);
  assert.equal(first.length,20);assert.equal([...f.builds.values()].reduce((a,b)=>a+b,0),20);
  f.flush();assert.equal(f.entities.length,20);assert.deepEqual(f.notifies,['parent']);
  const second=f.render(rows);assert(second.every((entity,i)=>entity===f.entities[i]));
  assert.equal([...f.builds.values()].reduce((a,b)=>a+b,0),20,'cache lookup never builds or reuses a consumed element');
  for(const entity of second)entity.render();assert.equal([...f.builds.values()].reduce((a,b)=>a+b,0),40);f.cache.dispose();f.flush();
});

test('changing one signature invalidates only that retained entity; other19 never build',async()=>{
  const f=await fixture(),rows=Array.from({length:20},(_,i)=>[`space-${i}`,'v1']);
  f.render(rows);f.flush();f.render(rows);for(const entity of f.entities)entity.render();
  f.builds.clear();f.notifies.length=0;
  rows[7][1]='v2';f.render(rows);assert.equal(f.notifies.length,0);assert.equal(f.builds.size,0);assert.equal(f.timers.length,1);
  f.flush();assert.deepEqual(f.notifies,[f.entities[7]]);f.notifies[0].render();
  assert.deepEqual([...f.builds],[['space-7',1]]);f.cache.dispose();f.flush();
});

test('an unchanged signature refreshes the closure without notify or build',async()=>{
  const f=await fixture();f.render([['space','v1','before']]);f.flush();f.notifies.length=0;f.builds.clear();
  f.render([['space','v1','latest']]);assert.equal(f.timers.length,0);assert.equal(f.notifies.length,0);assert.equal(f.builds.size,0);
  assert.equal(f.entities[0].render().label,'latest');f.cache.dispose();f.flush();
});

test('removed cards release after render and rapid reappearance keeps the live entity',async()=>{
  const f=await fixture();f.render([['one','v1'],['two','v1']]);f.flush();
  f.render([['one','v1']]);assert.equal(f.entities[1].releases,0);
  f.render([['one','v1'],['two','v1']]);f.flush();assert.equal(f.entities[1].releases,0);assert.equal(f.entities.length,2);
  f.render([['one','v1']]);f.flush();assert.equal(f.entities[1].releases,1);f.cache.dispose();f.flush();
});

test('dispose is idempotent and tolerates source-generation native cleanup',async()=>{
  const f=await fixture();f.render([['one','v1'],['two','v1']]);f.flush();f.entities[0].released=true;
  f.setRendering(true);f.cache.dispose();f.cache.dispose();f.setRendering(false);
  assert.equal(f.entities[0].releases,0);f.flush();assert.equal(f.entities[0].releases,1);assert.equal(f.entities[1].releases,1);
  f.cache.dispose();f.flush();assert.equal(f.entities[1].releases,1);assert.deepEqual(f.entities[1].render(),{empty:true});
});

test('disposing before deferred creation never allocates or notifies',async()=>{
  const f=await fixture();f.render([['one','v1']]);f.cache.dispose();f.flush();
  assert.equal(f.entities.length,0);assert.equal(f.notifies.length,0);
});

test('old hosts without retained views always build fresh elements',async()=>{
  const f=await fixture(),cache=f.createRetainedCards({});let count=0;
  cache.begin();const first=cache.card('one','same',()=>({count:++count}));cache.end();
  cache.begin();const second=cache.card('one','same',()=>({count:++count}));cache.end();
  assert.notEqual(first,second);assert.equal(count,2);cache.dispose();
});
