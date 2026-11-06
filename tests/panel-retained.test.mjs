import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {makePanelLoadFixture,makePanelFixture,eventSequence} from './panel-fixtures.mjs';
import {cleanPanelFeed} from '../mods/sixfold-desk/panel-model.js';

function element(){let value;value=new Proxy({nodes:[],calls:[]},{get(target,key){
  if(key==='then')return undefined;if(key in target)return target[key];
  if(key==='child')return child=>{if(child!=null)target.nodes.push(child);return value;};
  if(key==='children')return children=>{target.nodes.push(...children.filter(Boolean));return value;};
  if(key==='when')return (condition,fn)=>{if(condition)fn(value);return value;};
  return (...args)=>{target.calls.push([key,...args]);return value;};
}});return value;}
let loads=0;
async function runtime(motion=false){
  const objects=[],timers=[],store=new Map([['sixfold.motion',motion]]);let rendering=false;globalThis.__retainedThemePatch={};globalThis.__retainedHostVisible=true;
  const cx={notify(entity){assert(!rendering,'notify during render');entity.dirty=true;},timer:{after(ms,fn){assert(!rendering);const timer={ms,fn,cancelled:false,cancel(){this.cancelled=true;}};timers.push(timer);return timer;}},
    new(Class,props){assert(!rendering,'new view during render');const view=new Class();view.init?.(props,cx);const entity={view,dirty:true,released:false,release(){this.released=true;return true;}};objects.push(entity);return entity;}};
  const path=()=>new Proxy({},{get:(_t,key)=>key==='build'?()=>[]:()=>path()});
  globalThis.__retainedRuntime={View:class{},div:element,svg:element,h_flex:element,v_flex:element,PathBuilder:{stroke:path},
    theme:()=>({background:'#101318',chrome:'#14191f',surface:'#1b232d',border:'#39434f',selected:'#253249',foreground:'#e5edf5',muted:'#a6b0bf',dim:'#788594',accent:'#a9b8ff',ansi6:'#68c9bc',blocked:'#edac67',hover:'#253249',...globalThis.__retainedThemePatch}),
    window:()=>({active:false,visible:globalThis.__retainedHostVisible}),spaces:()=>[],panes:()=>[],shared:key=>store.get(key),setShared:(key,value)=>store.set(key,value),run(){},settings:()=>({zoom:1})};
  globalThis.window={paint_path:element};
  const transform=source=>source.replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base|herdr)';/g,'const {$1}=globalThis.__retainedRuntime;');
  let view=transform(await readFile(new URL('../mods/sixfold-desk/panel-view.js',import.meta.url),'utf8'));
  for(const name of ['panel-model','collab-flow'])view=view.replace(`'./${name}.js'`,JSON.stringify(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url).href));
  const viewUrl=`data:text/javascript;base64,${Buffer.from(view).toString('base64')}#${loads++}`;
  let source=transform(await readFile(new URL('../mods/sixfold-desk/panel-retained.js',import.meta.url),'utf8'));
  for(const name of ['panel-model','collab-flow'])source=source.replace(`'./${name}.js'`,JSON.stringify(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url).href));
  source=source.replace("'./panel-view.js'",JSON.stringify(viewUrl));
  const mod=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${loads++}`);
  const controller=mod.createRetainedPanel(cx);
  const flush=()=>{for(const entity of objects)if(entity.dirty&&!entity.released){entity.dirty=false;rendering=true;try{entity.tree=entity.view.render(cx);}finally{rendering=false;}}};
  return {controller,flush,timers,store,objects,native:globalThis.__retainedRuntime};
}

test('20 spaces and 60 rows retain their entities; one title change only renders that row',async()=>{
  const r=await runtime(),feed=cleanPanelFeed(makePanelLoadFixture({now:Date.now()}));
  r.controller.apply(feed,'ready');r.flush();
  const before={...r.controller.stats.renders},notifications=r.controller.stats.notifications;
  const next=cleanPanelFeed(makePanelLoadFixture({now:Date.now(),changedRow:0,marker:'Changed title'}));
  r.controller.apply(next,'ready');r.flush();
  assert.equal(r.controller.stats.notifications-notifications,1);
  assert.equal(r.controller.stats.renders['root:all'],before['root:all']);
  assert.equal(r.controller.stats.renders['list:all'],before['list:all']);
  assert.equal(r.controller.stats.renders['flows:all'],before['flows:all']);
  const changed=Object.keys(r.controller.stats.renders).filter(key=>r.controller.stats.renders[key]!==before[key]);
  assert.deepEqual(changed,[`row:${next.spaces[0].agents[0].id}`]);
  assert.equal(r.controller.projection.stats.agentsReused,59);
  assert.equal(r.controller.projection.stats.groupsReused,19);
  r.controller.dispose();
});

test('identical input and data timestamps alone cause no entity notifications or timer wake',async()=>{
  const r=await runtime(),feed=cleanPanelFeed(makePanelLoadFixture({now:Date.now()}));
  r.controller.apply(feed,'ready');r.flush();const before=r.controller.stats.notifications;
  r.controller.apply(feed,'ready');r.flush();assert.equal(r.controller.stats.notifications,before);
  r.controller.apply({...feed,at:feed.at+1000},'ready');r.flush();assert.equal(r.controller.stats.notifications,before);
  assert.equal(r.controller.wake,null);r.controller.dispose();
});

test('hiding cancels the finite animation wake; data can change while hidden without restarting it',async()=>{
  const r=await runtime(true),feed=cleanPanelFeed(makePanelFixture());
  r.controller.apply(feed,'ready');r.flush();
  r.controller.apply(cleanPanelFeed(eventSequence.find(step=>step.name==='dispatch-existing').apply(feed,Date.now())),'ready');
  assert(r.controller.wake);const wake=r.controller.wake;
  r.controller.setVisible(false);r.flush();
  assert(wake.cancelled);assert.equal(r.controller.wake,null);assert.equal(r.controller.wakeAt,null);assert.equal(r.controller.motion,false);
  r.controller.apply({...r.controller.input,at:Date.now()},'ready');r.flush();assert.equal(r.controller.wake,null);
  r.controller.dispose();
});

test('theme changes invalidate retained colors, unrelated preferences do no projection work',async()=>{
  const r=await runtime(),feed=cleanPanelFeed(makePanelLoadFixture({now:Date.now()}));
  r.controller.apply(feed,'ready');r.flush();
  const updates=r.controller.stats.updates,notifications=r.controller.stats.notifications;
  r.controller.preferences();r.flush();
  assert.equal(r.controller.stats.updates,updates);assert.equal(r.controller.stats.notifications,notifications);
  globalThis.__retainedThemePatch={foreground:'#ffffff'};
  r.controller.preferences();r.flush();
  assert.equal(r.controller.stats.updates,updates+1);
  for(const [key,count] of Object.entries(r.controller.stats.renders))assert(count>=2,key);
  r.controller.dispose();
});

test('retiring an older generation whose handles are released cannot abort the next controller',async()=>{
  globalThis.__sixfoldPanelControllers.set('retired-test',{key:'retired-test',protocol:'old',dispose(){throw Error('released handle');}});
  const r=await runtime();assert(!globalThis.__sixfoldPanelControllers.has('retired-test'));
  r.controller.dispose();r.controller.dispose();
});

test('native visibility is independent of focus and cancels finite motion when hidden',async()=>{
  const r=await runtime(true),feed=cleanPanelFeed(makePanelFixture());
  r.controller.apply(feed,'ready');assert.equal(r.controller.motion,true,'unfocused visible window still animates');
  r.controller.apply(cleanPanelFeed(eventSequence.find(step=>step.name==='dispatch-existing').apply(feed,Date.now())),'ready');
  const wake=r.controller.wake;assert(wake);
  globalThis.__retainedHostVisible=false;r.controller.preferences();
  assert(wake.cancelled);assert.equal(r.controller.hostVisible,false);assert.equal(r.controller.motion,false);assert.equal(r.controller.wake,null);
  globalThis.__retainedHostVisible=true;r.controller.preferences();assert.equal(r.controller.motion,true);
  r.controller.dispose();
});
