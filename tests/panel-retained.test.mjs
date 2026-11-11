import test from 'node:test';
import assert from 'node:assert/strict';
import {linearReadsUrl} from './linear-reads-url.mjs';
import {readFile} from 'node:fs/promises';
import {makePanelLoadFixture,makePanelFixture,eventSequence} from './panel-fixtures.mjs';
import {cleanPanelFeed,PANEL_TIMING} from '../mods/sixfold-desk/panel-model.js';

function element(){let value;value=new Proxy({nodes:[],calls:[]},{get(target,key){
  if(key==='then')return undefined;if(key in target)return target[key];
  if(key==='child')return child=>{if(child!=null)target.nodes.push(child);return value;};
  if(key==='children')return children=>{target.nodes.push(...children.filter(Boolean));return value;};
  if(key==='when')return (condition,fn)=>{if(condition)fn(value);return value;};
  return (...args)=>{target.calls.push([key,...args]);return value;};
}});return value;}
let loads=0;
async function runtime(motion=false,options={}){
  const objects=[],timers=[],store=new Map([['sixfold.motion',motion]]);let rendering=false;globalThis.__retainedThemePatch={};globalThis.__retainedHostVisible=true;globalThis.__retainedNativeSpaces=[];
  const cx={notify(entity){assert(!rendering,'notify during render');entity.dirty=true;},timer:{after(ms,fn){assert(!rendering);const timer={ms,fn,cancelled:false,cancel(){this.cancelled=true;}};timers.push(timer);return timer;}},
    new(Class,props){assert(!rendering,'new view during render');const view=new Class();view.init?.(props,cx);const entity={view,dirty:true,released:false,release(){this.released=true;return true;},set_props(next){assert(!rendering,'set_props during render');view.update?.(next,cx);this.dirty=true;}};objects.push(entity);return entity;}};
  const path=()=>new Proxy({},{get:(_t,key)=>key==='build'?()=>[]:()=>path()});
  globalThis.__retainedRuntime={View:class{},div:element,svg:element,image:element,h_flex:element,v_flex:element,Popover:{new:element},Input:{new:state=>{if(state?.released)throw TypeError('this input state has been released and can no longer be rendered');const value=element();value.calls.push(['input',state]);return value;}},InputState:{new:(options={})=>{assert(!rendering,'InputState.new during render');const state={options,events:new Map(),text:options.value||'',released:false,on(name,callback){this.events.set(name,callback);},value(){if(this.released)throw TypeError('this input state has been released');return this.text;},set_value(next){if(this.released)throw TypeError('this input state has been released');this.text=next;},release(){const was=!this.released;this.released=true;return was;}};(globalThis.__retainedInputs??=[]).push(state);return state;}},PathBuilder:{stroke:path},
    theme:()=>({background:'#101318',chrome:'#14191f',surface:'#1b232d',border:'#39434f',selected:'#253249',foreground:'#e5edf5',muted:'#a6b0bf',dim:'#788594',accent:'#a9b8ff',ansi6:'#68c9bc',blocked:'#edac67',hover:'#253249',...globalThis.__retainedThemePatch}),
    window:()=>({active:false,visible:globalThis.__retainedHostVisible}),spaces:()=>globalThis.__retainedNativeSpaces,panes:()=>[],shared:key=>store.get(key),setShared:(key,value)=>store.set(key,value),run(){},settings:()=>({zoom:1})};
  globalThis.window={paint_path:element};
  const transform=source=>source.replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base|herdr)';/g,'const {$1}=globalThis.__retainedRuntime;');
  const localModule=async name=>`data:text/javascript;base64,${Buffer.from(transform(await readFile(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url),'utf8')).replace("'./alert-model.js'",JSON.stringify(new URL('../mods/sixfold-desk/alert-model.js',import.meta.url).href)).replace("'./issue-model.js'",JSON.stringify(new URL('../mods/sixfold-desk/issue-model.js',import.meta.url).href)).replace("'./issue-detail-view.js'",JSON.stringify(globalThis.__detailViewUrl||''))).toString('base64')}#${loads++}`;
  globalThis.__detailViewUrl=await localModule('issue-detail-view');
  const detailsUrl=await localModule('task-row-details'),issuesUrl=await localModule('task-issues-view');
  let view=transform(await readFile(new URL('../mods/sixfold-desk/panel-view.js',import.meta.url),'utf8'));
  view=view.replace("'./task-row-details.js'",JSON.stringify(detailsUrl));
  view=view.replace("'./pixel.js'",JSON.stringify(await localModule('pixel')));
  const statusSource=transform(await readFile(new URL('../mods/sixfold-desk/session-status.js',import.meta.url),'utf8'))
    .replace("'./collab-flow.js'",JSON.stringify(new URL('../mods/sixfold-desk/collab-flow.js',import.meta.url).href));
  view=view.replace("'./session-status.js'",JSON.stringify(`data:text/javascript;base64,${Buffer.from(statusSource).toString('base64')}#${loads++}`));
  for(const name of ['panel-model','collab-flow','panel-host'])view=view.replace(`'./${name}.js'`,JSON.stringify(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url).href));
  const viewUrl=`data:text/javascript;base64,${Buffer.from(view).toString('base64')}#${loads++}`;
  let source=transform(await readFile(new URL('../mods/sixfold-desk/panel-retained.js',import.meta.url),'utf8'));
  for(const name of ['panel-model','collab-flow','panel-host'])source=source.replace(`'./${name}.js'`,JSON.stringify(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url).href));
  source=source.replace("'./panel-view.js'",JSON.stringify(viewUrl));
  source=source.replace("'./alert-model.js'",JSON.stringify(new URL('../mods/sixfold-desk/alert-model.js',import.meta.url).href));
  source=source.replace("'./linear-reads.js'",JSON.stringify(await linearReadsUrl()));
  source=source.replace("'./issue-model.js'",JSON.stringify(new URL('../mods/sixfold-desk/issue-model.js',import.meta.url).href));
  source=source.replace("'./linear-cache.js'",JSON.stringify(await localModule('linear-cache')));
  const autoModel=new URL('../mods/sixfold-desk/linear-auto-model.js',import.meta.url).href;
  const autoModule=async name=>`data:text/javascript;base64,${Buffer.from(transform(await readFile(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url),'utf8')).replace("'./linear-auto-model.js'",JSON.stringify(autoModel))).toString('base64')}#${loads++}`;
  source=source.replace("'./linear-auto-model.js'",JSON.stringify(autoModel)).replace("'./linear-auto.js'",JSON.stringify(await autoModule('linear-auto')))
    .replace("'./linear-auto-view.js'",JSON.stringify(await autoModule('linear-auto-view')));
  source=source.replace("'./task-issues-view.js'",JSON.stringify(issuesUrl)).replace("'./task-issue-state.js'",JSON.stringify(new URL('../mods/sixfold-desk/task-issue-state.js',import.meta.url).href));
  const mod=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${loads++}`);
  const controller=mod.createRetainedPanel(cx,options);
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

test('child completion updates the retained card and fold without focus or expansion changes',async()=>{
  const r=await runtime(),raw=makePanelLoadFixture({spaces:2,agentsPerSpace:7,now:Date.now()});
  const parent=raw.spaces[0].agents[0];for(const child of raw.spaces[0].agents.slice(1))child.parent_id=parent.id;
  r.controller.apply(cleanPanelFeed(raw),'ready');r.flush();
  assert.equal(r.controller.layout.cards[0].rows.find(row=>row.kind==='children-more').fold.hidden,3);
  raw.spaces[0].agents[1].status='done';raw.spaces[0].agents[1].stage=5;
  raw.spaces[0].agents[2].status='done';raw.spaces[0].agents[2].stage=5;
  r.controller.apply(cleanPanelFeed(raw),'ready');r.flush();
  const card=r.controller.layout.cards[0];assert.equal(card.rows.find(row=>row.kind==='children-more').fold.hidden,1);
  assert.equal(card.rows.filter(row=>row.kind==='agent').length,4);
  for(const child of raw.spaces[0].agents.slice(1,3))assert(!card.rows.some(row=>row.agent?.id===child.id));
  assert.equal(r.controller.expandedParents.size,0);r.controller.dispose();
});

test('child and issue folds change only the affected retained card and flow geometry',async()=>{
  const r=await runtime(),raw=makePanelLoadFixture({spaces:2,agentsPerSpace:8,now:Date.now()});
  const space=raw.spaces[0],parent=space.agents[0];
  for(const agent of space.agents.slice(1))agent.parent_id=parent.id;
  const feed=cleanPanelFeed(raw);r.controller.apply(feed,'ready');r.flush();
  assert.equal(r.controller.layout.cards[0].rows.filter(row=>row.kind==='agent').length,4);
  assert.equal(r.controller.layout.cards[0].rows.find(row=>row.kind==='children-more').fold.hidden,4);
  const before={...r.controller.stats.renders};
  r.controller.toggleChildren(parent.id);r.flush();
  assert.equal(r.controller.layout.cards[0].rows.filter(row=>row.kind==='agent').length,8);
  assert.equal(r.controller.stats.renders[`space:${raw.spaces[1].id}`],before[`space:${raw.spaces[1].id}`]);
  assert.equal(r.controller.stats.renders['list:all'],before['list:all']);
  assert.equal(r.controller.rowMeta.get(space.agents[1].id).parent,parent.id);
  r.controller.dispose();
});

test('an open issue search shows the space auto work (반영 대기) above its alerts; a closed one builds none',async()=>{
  const r=await runtime(false);
  const raw=makePanelFixture({tool:'linear'}),space=raw.spaces[0];
  const feed=cleanPanelFeed(raw);r.controller.apply(feed,'ready');r.flush();
  const t=r.native.theme(),card=r.controller.spaceMap.get(space.id);
  r.store.set('sixfold.linearWrites',['comment','set_state']);
  r.store.set('sixfold.linearAuto',{v:1,switch:{enabled:true,mode:'live',spaces:{[card.name]:true}},entries:[
    {id:'a1b2c3d4-0000-4000-8000-000000000001',issue:'DEMO-1',title:'Demo issue',workspace:card.name,at:'2026-11-10T07:30:00Z',state:'proposed',
     proposal:{comment:'Herdr 자동 작업으로 처리했습니다.\n\n**한 일**\n연결했다.',state:'In Review',checks:['없음']}},
    {id:'ffffffff-0000-4000-8000-000000000002',issue:'DEMO-2',title:'Other space',workspace:'Elsewhere',at:'2026-11-10T07:30:00Z',state:'proposed',proposal:{comment:'x',checks:[]}}]});
  const walk=node=>[node,...(node.nodes||[]).filter(value=>typeof value==='object').flatMap(walk)];
  const ids=node=>walk(node).flatMap(n=>(n.calls||[]).filter(c=>c[0]==='id').map(c=>c[1]));
  let popup=r.controller.issuePopover(card,element(),t);
  assert(!ids(popup).includes(`task-issues-auto-${space.id}`),'closed: nothing built');
  popup.calls.find(call=>call[0]==='on_open_change')[1](true);r.flush();
  popup=r.controller.issuePopover(card,element(),t);
  const body=popup.calls.find(call=>call[0]==='content')[1],all=ids(body);
  assert(all.includes(`task-issues-auto-${space.id}`));
  assert(all.includes(`task-issues-auto-comment-${space.id}-a1b2c3d4`)&&all.includes(`task-issues-auto-state-${space.id}-a1b2c3d4`));
  assert(!all.includes(`task-issues-auto-comment-${space.id}-ffffffff`),'another space is not shown here');
  const mark=r.controller.alertMark(card);
  r.store.set('sixfold.linearAuto',{...r.store.get('sixfold.linearAuto'),entries:[{...r.store.get('sixfold.linearAuto').entries[0],state:'applied'}]});
  assert.notEqual(r.controller.alertMark(card),mark,'a ledger change redraws the open card');
});

test('native issue popover opens with retained input; completion returns via owning scheduler',async()=>{
  const queued=[],requests=[];
  const r=await runtime(false,{schedule:fn=>queued.push(fn),onIssueRequest:async(...args)=>{requests.push(args);return 'request-demo-001';}});
  const raw=makePanelFixture({tool:'linear'}),space=raw.spaces[0];
  space.issue_catalog={week:[space.issues[0]],milestone:[],all:[...space.issues,{key:'DEMO-99',title:'Manual pick',state:'waiting'}],import_request:{path:'panel-issue-requests',space:space.id}};
  const feed=cleanPanelFeed(raw);r.controller.apply(feed,'ready');r.flush();
  const t=r.native.theme(),card=r.controller.spaceMap.get(space.id);
  let popup=r.controller.issuePopover(card,element(),t);
  popup.calls.find(call=>call[0]==='on_open_change')[1](true);
  assert.equal(r.controller.issueStates.get(space.id).open,true);r.flush();
  const state=r.controller.issueStates.get(space.id);state.scope='all';
  const search=r.controller.issueInputs.get(space.id).search;search.text='manual';search.events.get('change')();
  state.hoverKey='DEMO-99';   // the pull button shows under the mouse
  popup=r.controller.issuePopover(card,element(),t);
  const body=popup.calls.find(call=>call[0]==='content')[1];
  assert.equal(body.calls.find(call=>call[0]==='ml')[1],66,'surface clears the route gutter and leaves ten pixels outside the sidebar');
  const walk=node=>[node,...(node.nodes||[]).filter(value=>typeof value==='object').flatMap(walk)];
  const button=walk(body).find(node=>node.calls?.some(call=>call[0]==='id'&&call[1]===`task-issues-pull-${space.id}-DEMO-99`));
  assert(button);button.calls.find(call=>call[0]==='on_click')[1](null,{stop_propagation(){}});
  assert(state.pending.has('DEMO-99'));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,1);assert.equal(queued.length,1);
  assert.equal(state.pending.get('DEMO-99').id,null,'promise cannot mutate retained UI before owner delivery');
  queued.shift()();assert.equal(state.pending.get('DEMO-99').id,'request-demo-001');
  raw.spaces[0].issues.push({key:'DEMO-99',title:'Manual pick',state:'waiting'});
  r.controller.apply(cleanPanelFeed(raw),'ready');assert(!state.pending.has('DEMO-99'));
  popup=r.controller.issuePopover(r.controller.spaceMap.get(space.id),element(),t);
  const removeBody=popup.calls.find(call=>call[0]==='content')[1];
  const remove=walk(removeBody).find(node=>node.calls?.some(call=>call[0]==='id'&&call[1]===`task-issues-pull-${space.id}-DEMO-99`));
  remove.calls.find(call=>call[0]==='on_click')[1](null,{stop_propagation(){}});
  await new Promise(resolve=>setImmediate(resolve));
  raw.spaces[0].issue_catalog.results=[{id:'request-demo-001',space:space.id,status:'rejected',keys:['DEMO-99'],message:'Selection unavailable'}];
  r.controller.apply(cleanPanelFeed(raw),'ready');assert(state.pending.has('DEMO-99'));
  queued.shift()();assert(!state.pending.has('DEMO-99'),'an early producer acknowledgement is reconciled after owner delivery');
  assert.equal(state.error,'Selection unavailable');
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

test('a newborn placeholder hides its content until the finite packet arrival boundary',async()=>{
  const original=Date.now;let now=1780000000000;Date.now=()=>now;let r;
  try{
    r=await runtime(true);const feed=cleanPanelFeed(makePanelFixture({now}));
    r.controller.apply(feed,'ready');r.flush();
    const next=cleanPanelFeed(eventSequence.find(step=>step.name==='spawn').apply(feed,now));
    r.controller.apply(next,'ready');r.flush();
    const id=[...r.controller.events.spawning][0],entity=r.controller.rows.get(id);
    const opacity=()=>{const walk=n=>[n,...n.nodes.filter(x=>x&&typeof x==='object').flatMap(walk)];return walk(entity.tree).find(n=>n.calls.some(c=>c[0]==='id'&&c[1]===`panel-agent-content-${id}`)).calls.find(c=>c[0]==='opacity')[1];};
    assert.equal(opacity(),0);assert.equal(r.controller.wakeAt,now+40);
    const renders=r.controller.stats.renders[`row:${id}`];now+=PANEL_TIMING.packetMs;r.controller.wake.fn();r.flush();
    assert.equal(opacity(),1);assert.equal(r.controller.stats.renders[`row:${id}`],renders+1);
  }finally{r?.controller.dispose();Date.now=original;}
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
  globalThis.__retainedHostVisible=true;globalThis.__retainedNativeSpaces=[];r.controller.preferences();assert.equal(r.controller.motion,true);
  r.controller.dispose();
});

test('hidden snapshots cache only the latest input, then resume without replay or hidden projections',async()=>{
  const r=await runtime(false),feed=cleanPanelFeed(makePanelLoadFixture({now:Date.now()}));
  r.controller.apply(feed,'ready');r.flush();r.controller.setVisible(false);
  const notifications=r.controller.stats.notifications,projections=r.controller.stats.projections.length;
  for(let i=0;i<100;i++){
    const value=makePanelLoadFixture({now:Date.now(),changedRow:0,marker:`Hidden ${i}`});
    value.events=[{id:'e-hidden-memory',at:new Date().toISOString(),kind:'memory',from:value.spaces[0].agents[0].id,to:value.spaces[0].id,label:'Memory'}];
    r.controller.apply(cleanPanelFeed(value),'ready');
  }
  assert.equal(r.controller.stats.notifications,notifications);
  assert.equal(r.controller.stats.projections.length,projections);assert.equal(r.controller.wake,null);
  r.controller.setVisible(true);r.flush();
  assert.equal(r.controller.feed.spaces[0].agents[0].title,'Hidden 99');
  assert.equal(r.controller.stats.notifications-notifications,1);
  assert.equal(r.controller.events.tags.size,0);assert.equal(r.controller.events.packets.length,0);
  r.controller.dispose();
});

test('native selection changes refresh its retained card without a feed-file edit',async()=>{
  const r=await runtime(false),value=makePanelLoadFixture({now:Date.now()});
  value.spaces[0].nav={space_id:'sp-native-demo',machine:null};
  globalThis.__retainedNativeSpaces=[{id:'sp-native-demo',machine:null,active:false,tabs:[]}];
  const feed=cleanPanelFeed(value);r.controller.apply(feed,'ready');r.flush();
  const before={...r.controller.stats.renders},notifications=r.controller.stats.notifications;
  globalThis.__retainedNativeSpaces=[{id:'sp-native-demo',machine:null,active:true,tabs:[]}];
  r.controller.navigation();r.flush();
  assert.equal(r.controller.spaceMap.get(feed.spaces[0].id).native.active,true);
  assert.equal(r.controller.stats.notifications-notifications,1);
  assert.deepEqual(Object.keys(r.controller.stats.renders).filter(key=>before[key]!==r.controller.stats.renders[key]),[`space:${feed.spaces[0].id}`]);
  r.controller.dispose();
});

test('an explicit local partner rename updates its chips without invalidating agent rows',async()=>{
  const r=await runtime(false),raw=makePanelLoadFixture({spaces:3,agentsPerSpace:2,now:Date.now()});
  const [a,b,unrelated]=raw.spaces;
  b.computer=a.computer;
  raw.links=[{kind:'collaboration',a:a.id,b:b.id}];
  r.controller.apply(cleanPanelFeed(raw),'ready');r.flush();
  const before={...r.controller.stats.renders};
  const next=structuredClone(raw);next.spaces[1].name='Renamed partner';
  r.controller.apply(cleanPanelFeed(next),'ready');r.flush();
  assert.deepEqual(Object.keys(r.controller.stats.renders).filter(key=>before[key]!==r.controller.stats.renders[key]).sort(),[`space:${a.id}`,`space:${b.id}`].sort());
  assert.equal(r.controller.stats.renders[`space:${unrelated.id}`],before[`space:${unrelated.id}`]);
  const renamed={...r.controller.stats.renders};next.links=[];
  r.controller.apply(cleanPanelFeed(next),'ready');r.flush();
  assert.deepEqual(Object.keys(r.controller.stats.renders).filter(key=>renamed[key]!==r.controller.stats.renders[key]).sort(),[`space:${a.id}`,`space:${b.id}`,'flows:all'].sort());
  r.controller.dispose();
});

test('opening another space closes the previous issue popup and only its retained card changes',async()=>{
 const r=await runtime(),raw=makePanelLoadFixture({spaces:2,agentsPerSpace:1,now:Date.now()});
 try{
  r.controller.apply(cleanPanelFeed(raw),'ready');r.flush();const [a,b]=r.controller.feed.spaces;
  const open=space=>r.controller.issuePopover(space,element(),r.native.theme()).calls.find(c=>c[0]==='on_open_change')[1](true,{});
  open(a);assert(r.controller.issueStates.get(a.id).open);open(b);
  assert(!r.controller.issueStates.get(a.id).open);assert(r.controller.issueStates.get(b.id).open);
  assert.equal(r.controller.issueStates.size,2,'local search/pending state is retained when another popup opens');
 }finally{r.controller.dispose();}
});

test('a cleanup countdown wakes only at its minute boundary and re-renders just that row',async()=>{
  const original=Date.now;let now=1780000000000;Date.now=()=>now;let r;
  try{
    r=await runtime(false);const raw=makePanelFixture({now});
    Object.assign(raw.spaces[0].agents[0],{status:'idle',state:'cleanup_wait',cleanup:{idle_since:new Date(now-60000).toISOString(),limit_s:1800,due_at:new Date(now+90000).toISOString()}});
    r.controller.apply(cleanPanelFeed(raw),'ready');r.flush();
    const id=raw.spaces[0].agents[0].id,entity=r.controller.rows.get(id);
    const reason=()=>{const walk=n=>[n,...n.nodes.filter(x=>x&&typeof x==='object').flatMap(walk)];
      // Compact rows (ROW 24) keep the reason in the row tooltip, not a second line.
      const row=walk(entity.tree).find(n=>n.calls.some(c=>c[0]==='id'&&c[1]===`panel-agent-${id}`));
      assert(!walk(entity.tree).some(n=>n.calls.some(c=>c[0]==='id'&&c[1]===`panel-reason-${id}`)),'no reason line');
      return row.calls.find(c=>c[0]==='tooltip')[1].split('\n').find(line=>line.startsWith('정리 대기'));};
    assert.equal(reason(),'정리 대기 · 30분 쉬면 닫힘 (남은 2분)');assert.equal(r.controller.wakeAt,now+30000);
    const renders={...r.controller.stats.renders};now+=30000;r.controller.wake.fn();r.flush();
    assert.equal(reason(),'정리 대기 · 30분 쉬면 닫힘 (남은 1분)');
    const changed=Object.keys(r.controller.stats.renders).filter(key=>r.controller.stats.renders[key]!==renders[key]);
    assert.deepEqual(changed,[`row:${id}`]);
    now+=60000;r.controller.wake.fn();r.flush();
    assert.equal(reason(),'정리 대기 · 다음 정리 때 닫힘');assert.equal(r.controller.wake,null,'no timer after the deadline');
  }finally{r?.controller.dispose();Date.now=original;}
});

test('a root row with a reason that gains a parent in place re-lays its height and route anchor',async()=>{
  const r=await runtime(),raw=makePanelFixture({now:Date.now()});
  try{
    const [,parent,row]=raw.spaces[0].agents;row.keep_reason='검수 대기';
    r.controller.apply(cleanPanelFeed(raw),'ready');r.flush();
    const card=()=>r.controller.layout.cards[0],find=()=>card().rows.find(item=>item.agent?.id===row.id);
    assert.equal(find().height,24,'compact: a reason never adds a second line');
    // Same order and no fold: only the parent relation changes.
    row.parent_id=parent.id;
    r.controller.apply(cleanPanelFeed(raw),'ready');r.flush();
    assert.equal(find().height,20);
    assert.equal(r.controller.layout.anchors.get(row.id).y,find().y+10);
    assert.equal(card().height,find().y+20-card().top+5);
  }finally{r.controller.dispose();}
});

test('adding or removing a Slack / work-tool link re-lays the card, since the meta line comes and goes',async()=>{
  for(const initial of [false,true]){
    const r=await runtime(false);
    try{
      const raw=makePanelFixture({slack:initial}),id=raw.spaces[0].agents[0].id;
      r.controller.apply(cleanPanelFeed(raw),'ready');r.flush();
      const key=r.controller.layoutKey,before=r.controller.layout.anchors.get(id).y,height=r.controller.layout.cards[0].height;
      raw.spaces[0].slack=initial?null:{channel:'new-channel'};
      r.controller.apply(cleanPanelFeed(raw),'ready');r.flush();
      const shift=initial?-20:20;
      assert.notEqual(r.controller.layoutKey,key);
      assert.equal(r.controller.layout.anchors.get(id).y,before+shift,'row anchor follows the meta line');
      assert.equal(r.controller.layout.cards[0].height,height+shift,'card height follows the meta line');
    }finally{r.controller.dispose();}
  }
});

test('one meta line carries both tools: Slack unread on its part, Linear unread on the issue chip; a count change redraws only that card',async()=>{
  const counts={slack:0,linear:0,hasSlack:true},chips=[];
  const r=await runtime(false,{cardAlerts:()=>({...counts}),slackAlerts:(space,trigger)=>{chips.push(space.id);return trigger;}});
  try{
    const raw=makePanelFixture({slack:true,tool:'linear'});
    r.controller.apply(cleanPanelFeed(raw),'ready');r.flush();
    const card=r.controller.cards.get(raw.spaces[0].id);
    // A popover keeps its trigger in a call, not as a child.
    const walk=n=>[n,...(n.nodes||[]).filter(x=>x&&typeof x==='object').flatMap(walk),...(n.calls||[]).filter(c=>c[0]==='trigger'&&c[1]&&typeof c[1]==='object').flatMap(c=>walk(c[1]))];
    const texts=()=>walk(card.tree).flatMap(n=>(n.nodes||[]).filter(x=>typeof x==='string'));
    const byId=id=>walk(card.tree).find(n=>n.calls?.some(c=>c[0]==='id'&&c[1]===id));
    assert(byId(`panel-tool-${raw.spaces[0].id}`),'issue chip');
    assert(!byId(`panel-tool-unread-${raw.spaces[0].id}`),'no unread: the chip is key · issues only');
    assert(chips.includes(raw.spaces[0].id),'the Slack part opens the Slack alerts');
    const before=r.objects.filter(o=>o.dirty).length;
    r.controller.alertsChanged();
    assert.equal(r.objects.filter(o=>o.dirty).length,before,'cards just drawn with these counts are not redrawn');
    counts.linear=2;counts.slack=1;r.controller.alertsChanged();
    assert.equal(card.dirty,true,'the card redraws for its new counts');
    assert.equal(r.objects.filter(o=>o.dirty).length,before+1,'only that card');
    r.flush();
    assert(texts().includes('미확인 2')&&texts().includes('1'));
    counts.delay=76;counts.delayAt='2026-11-07T01:16:11Z';r.controller.alertsChanged();r.flush();
    assert(texts().includes('사본 지연'),'a stopped Slack copy is shown');
    r.controller.alertsChanged();assert.equal(card.dirty,false,'unchanged counts: no redraw');
  }finally{r.controller.dispose();}
});

test('a peek is the alerted-issues top of a space issue search with the new alerts lit; its title opens the search; an open search makes alerts quiet',async()=>{
  const r=await runtime();
  try{
    const raw=makePanelFixture({slack:true,tool:'linear'});
    r.controller.apply(cleanPanelFeed(raw),'ready');r.flush();
    const space=r.controller.feed.spaces[0],t=r.native.theme();
    const N='11111111-1111-4111-8111-111111111111';
    r.store.set('sixfold.linearItems',[{id:N,issue:'DEMO-7',issue_title:'Peeked issue',workspace:space.name,read:false,category:'commentsAndReplies',
      subtitle:'Kim commented: look',at:'2026-11-10T06:44:37Z',url:'https://linear.app/demo/issue/DEMO-7/x#comment-c0ffee01'}]);
    r.store.set('sixfold.linearWrites',['mark_read']);
    const walk=n=>[n,...(n.nodes||[]).filter(x=>x&&typeof x==='object').flatMap(walk)];
    const byId=(tree,id)=>walk(tree).find(n=>n.calls?.some(c=>c[0]==='id'&&c[1]===id));
    const texts=tree=>walk(tree).flatMap(n=>(n.nodes||[]).filter(x=>typeof x==='string'));
    const peek=r.controller.peekIssues(space.name,[N],t);
    assert(texts(peek).includes(`${space.name} · 이슈 검색`)&&texts(peek).includes('Kim commented: look')&&texts(peek).includes('읽음'));
    const line=byId(peek,`task-issues-alerted-line-peek-${space.id}-DEMO-7-0`);
    assert(line.calls.some(c=>c[0]==='border_color'&&c[1]===t.accent),'the new alert is lit');
    assert.equal(r.controller.peekIssues('No such space',[N],t),null);
    r.store.set('sixfold.linearItems',[]);assert.equal(r.controller.peekIssues(space.name,[N],t),null,'nothing unread: no peek');
    // The search has not been drawn with an opener yet: render it once, then the peek title opens it.
    r.controller.issuePopover(space,element(),t);
    assert.equal(r.controller.anyIssuesOpen(),false);
    r.store.set('sixfold.linearItems',[{id:N,issue:'DEMO-7',workspace:space.name,read:false,category:'mentions',at:'1',url:''}]);
    const head=byId(r.controller.peekIssues(space.name,[N],t),`task-issues-peek-head-${space.id}`);
    head.calls.find(c=>c[0]==='on_click')[1]({},{stop_propagation(){}});
    assert.equal(r.controller.issueStates.get(space.id).open,true);
    assert.equal(r.controller.anyIssuesOpen(),true,'an open issue search: new alerts only count on the chip');
  }finally{r.controller.dispose();}
});

// Native retained state belongs to the view whose call created it. An input made in an event
// handler (a peek title, a popup) dies with that view while the card still draws it, and drawing
// a released input throws, which failed the whole card. The card now owns its inputs (init/update)
// and a released one is left out of render and replaced by the card's update.
const walkTree=(node,seen=new Set())=>{
  if(!node||typeof node!=='object'||!Array.isArray(node.nodes)||seen.has(node))return [];seen.add(node);
  const children=[...node.nodes,...(node.calls||[]).flatMap(call=>call.slice(1))];
  return [node,...children.flatMap(child=>walkTree(child,seen))];
};
const drawnInputs=tree=>walkTree(tree).flatMap(node=>(node.calls||[]).filter(call=>call[0]==='input').map(call=>call[1]));
test('a card owns its issue inputs: created in init, never by the opening event or render',async()=>{
  const r=await runtime();
  try{
    const raw=makePanelFixture({tool:'linear'}),space=raw.spaces[0];
    globalThis.__retainedInputs=[];
    r.controller.apply(cleanPanelFeed(raw),'ready');
    const inputs=r.controller.issueInputs.get(space.id);
    assert(inputs?.search&&inputs?.comment,'the card init made both inputs');
    const made=globalThis.__retainedInputs.length;
    r.flush();
    const t=r.native.theme(),card=r.controller.spaceMap.get(space.id);
    r.controller.issuePopover(card,element(),t).calls.find(call=>call[0]==='on_open_change')[1](true,{});
    assert.equal(globalThis.__retainedInputs.length,made,'opening creates no input in the event owner');
    r.flush();
    assert.deepEqual(drawnInputs(r.controller.issuePopover(card,element(),t)),[inputs.search],'the open search draws the card input');
    // The peek title opens the same search without making an input of its own.
    r.controller.issuePopover(card,element(),t).calls.find(call=>call[0]==='on_open_change')[1](false,{});
    r.store.set('sixfold.linearItems',[{id:'n-1',issue:space.issues[0].key,workspace:space.name,read:false,category:'mentions',at:'1',url:''}]);
    const peek=r.controller.peekIssues(space.name,['n-1'],t);
    const head=walkTree(peek).find(node=>node.calls?.some(call=>call[0]==='id'&&call[1]===`task-issues-peek-head-${space.id}`));
    head.calls.find(call=>call[0]==='on_click')[1]({},{stop_propagation(){}});
    assert.equal(r.controller.issueStates.get(space.id).open,true);
    assert.equal(globalThis.__retainedInputs.length,made,'the peek path creates no input either');
    assert.equal(r.controller.issueInputs.get(space.id).search,inputs.search);
  }finally{r.controller.dispose();}
});

test('a released issue input leaves the card drawable and the card update replaces it',async()=>{
  const r=await runtime();
  try{
    const raw=makePanelFixture({tool:'linear'}),space=raw.spaces[0];
    r.controller.apply(cleanPanelFeed(raw),'ready');r.flush();
    const t=r.native.theme(),card=r.controller.spaceMap.get(space.id),entity=r.controller.cards.get(space.id);
    const open=value=>r.controller.issuePopover(r.controller.spaceMap.get(space.id),element(),t).calls.find(call=>call[0]==='on_open_change')[1](value,{});
    open(true);r.flush();
    const first=r.controller.issueInputs.get(space.id).search;
    first.text='DEMO';first.events.get('change')();
    assert.equal(r.controller.issueStates.get(space.id).query,'DEMO');
    // The owner of the input went away (a closed peek, a retired popup): the handle is released.
    first.release();
    r.controller.notify(entity);
    assert.doesNotThrow(()=>r.flush(),'the card still renders with a released input');
    assert.deepEqual(drawnInputs(r.controller.issuePopover(card,element(),t)),[],'a released input is left out, not drawn');
    assert(r.controller.staleInputs.has(space.id),'render only marks the card');
    assert.equal(r.controller.issueInputs.get(space.id).search,first,'render does not replace it');
    // A closed search never draws its input, so a released one cannot fail the card either.
    open(false);r.controller.issueInputs.get(space.id).search.release();r.controller.notify(entity);
    assert.doesNotThrow(()=>r.flush());
    assert.deepEqual(drawnInputs(r.controller.issuePopover(card,element(),t)),[]);
    // The next apply (outside render) gives the card new props; its update makes the new inputs.
    r.controller.apply(cleanPanelFeed(makePanelFixture({tool:'linear'})),'ready');
    const second=r.controller.issueInputs.get(space.id).search;
    assert.notEqual(second,first,'update replaced the released input');
    assert.equal(second.released,false);assert.equal(second.text,'DEMO','the query survives the replacement');
    assert.equal(r.controller.staleInputs.size,0);
    open(true);r.flush();
    assert.deepEqual(drawnInputs(r.controller.issuePopover(r.controller.spaceMap.get(space.id),element(),t)),[second]);
    second.text='DEMO-2';second.events.get('change')();
    assert.equal(r.controller.issueStates.get(space.id).query,'DEMO-2','the new input is wired to the search');
    // The open event repairs a released input too (no apply needed).
    second.release();open(false);open(true);
    const third=r.controller.issueInputs.get(space.id).search;
    assert.notEqual(third,second);assert.equal(third.released,false);
    // The comment box: a released comment input is left out; the menu event replaces it.
    const comment=r.controller.issueInputs.get(space.id).comment;comment.release();
    const state=r.controller.issueStates.get(space.id);state.menu='comment';
    const extra=r.controller.issueExtra(r.controller.spaceMap.get(space.id),state,{});
    assert.equal(extra.commentBox,null,'a released comment input is not drawn');
    extra.onMenu('comment');
    const fresh=r.controller.issueInputs.get(space.id).comment;
    assert.notEqual(fresh,comment);assert.equal(fresh.released,false);
    assert(drawnInputs(r.controller.issueExtra(r.controller.spaceMap.get(space.id),state,{}).commentBox).includes(fresh));
  }finally{r.controller.dispose();}
});

test('issue inputs keep the query across close/reopen, follow a card that leaves and returns, and go with dispose',async()=>{
  const r=await runtime();
  const raw=makePanelFixture({tool:'linear'}),space=raw.spaces[0];
  r.controller.apply(cleanPanelFeed(raw),'ready');r.flush();
  const t=r.native.theme();
  const open=value=>r.controller.issuePopover(r.controller.spaceMap.get(space.id),element(),t).calls.find(call=>call[0]==='on_open_change')[1](value,{});
  const first=r.controller.issueInputs.get(space.id).search;
  assert.equal(first.options.value,'','the card init had no query yet');
  open(true);first.text='DEMO-1';first.events.get('change')();open(false);open(true);
  assert.equal(r.controller.issueInputs.get(space.id).search,first,'a live input survives close/reopen');
  assert.equal(r.controller.issueStates.get(space.id).query,'DEMO-1');
  assert.equal(first.text,'DEMO-1');
  // The card leaves: its entity, state and inputs go; a returning card starts with its own.
  const firstCard=r.controller.cards.get(space.id),{search,comment}=r.controller.issueInputs.get(space.id);
  r.controller.apply(cleanPanelFeed({...raw,spaces:raw.spaces.slice(1)}),'ready');
  assert.equal(firstCard.released,true);
  assert(!r.controller.issueInputs.has(space.id)&&!r.controller.issueStates.has(space.id));
  assert(search.released&&comment.released,'the removed card releases its inputs');
  r.controller.apply(cleanPanelFeed(raw),'ready');r.flush();
  const back=r.controller.issueInputs.get(space.id);
  assert(back&&back.search!==search&&!back.search.released&&!back.comment.released,'the returning card made new inputs in its init');
  assert.notEqual(r.controller.cards.get(space.id),firstCard);
  open(true);r.flush();
  assert.deepEqual(drawnInputs(r.controller.issuePopover(r.controller.spaceMap.get(space.id),element(),t)),[back.search]);
  // Dispose releases every card (the native store releases what each card owns with it).
  const cards=[...r.controller.cards.values()];
  r.controller.dispose();
  assert(cards.every(card=>card.released),'dispose releases the cards that own the inputs');
  assert.equal(r.controller.issueInputs.size,0,'dispose clears the input map');
});
