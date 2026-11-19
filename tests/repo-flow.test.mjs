import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanRepositoryGraph,projectRepositoryGraph,createRepositoryController,repositoryEventState,repositoryLayout,repositorySection,repositoryFlowLayer,repositorySource,REPO_TIMING,GIT_OPERATIONS,REPO_LIMITS,REPO_EVIDENCE} from '../mods/sixfold-desk/repo-flow.js';
import {cleanPanelFeed,projectPanelFeed} from '../mods/sixfold-desk/panel-model.js';
import {makePanelFixture,makePanelLoadFixture} from './panel-fixtures.mjs';

const graph=()=>({source:'private_catalog',coverage:'gap',accounts:[{id:'personal',name:'Demo account',kind:'personal',connection:'unknown',source:'private_catalog'}],
  repos:[{id:'repo',account:'personal',name:'example/project',state:'ready',source:'private_catalog',branch:'main'}],
  bindings:[{agent:'agent-a',repo:'repo',state:'connected'},{agent:'agent-b',repo:'repo',state:'connected'}],events:[]});
const dto=()=>({schema:'repo_activity_v1',accounts:[{id:'personal',name:'Demo account',kind:'personal',connection:'unknown',source:'private_catalog'}],
  repositories:[{id:'repo',account_id:'personal',namespace:'example',name:'project'}],
  bindings:[{agent_id:'agent-a',repository_id:'repo',state:'cwd'},{agent_id:'agent-b',repository_id:'repo',state:'cwd'}],events:[],
  coverage:{state:'gap',sensor:'opt_in_callback',live_connected:false,gaps:['remote_effects']}});
const wireEvent=()=>({id:'event',operation_id:'operation',machine_id:'machine',agent_id:'agent-a',repository_id:'repo',operation:'push',phase:'result',result:'succeeded',evidence:'process_exit',observed_at:1000});
const event=(at,id='event')=>({id,agent:'agent-a',repo:'repo',at,operation:'push',result:'success',source:'process_exit'});
const palette={foreground:'#eee',muted:'#bbb',dim:'#888',accent:'#99f',ansi2:'#8d8',ansi4:'#89f',blocked:'#f98'};
function node(){let proxy;const data={nodes:[],calls:[]};proxy=new Proxy(data,{get(t,key){
  if(key==='then')return undefined;if(key in t)return t[key];
  if(key==='child'||key==='trigger')return value=>{if(value!=null)t.nodes.push(value);return proxy;};
  if(key==='children')return values=>{t.nodes.push(...values.filter(value=>value!=null));return proxy;};
  if(key==='when')return (condition,fn)=>{if(condition)fn(proxy);return proxy;};
  return (...args)=>{t.calls.push([key,...args]);return proxy;};
}});return proxy;}
const ui={div:node,h_flex:node,v_flex:node};
const nodes=tree=>tree&&typeof tree==='object'?[tree,...(tree.nodes||[]).flatMap(nodes)]:[];
const byId=(tree,id)=>nodes(tree).find(n=>n.calls?.some(c=>c[0]==='id'&&c[1]===id));
const words=tree=>nodes(tree).flatMap(n=>(n.nodes||[]).filter(value=>typeof value==='string'));

test('optional repository data is sanitized, retained and removed without altering the old feed shape',()=>{
  const raw=makePanelFixture(),old=cleanPanelFeed(raw);assert(!Object.hasOwn(old,'repo_activity'));
  raw.repo_activity=dto();raw.repo_activity.bindings[0].agent_id=raw.spaces[0].agents[0].id;
  raw.repo_activity.repositories[0].cwd='private path';raw.repo_activity.accounts[0].token='private value';
  const clean=cleanPanelFeed(raw);
  assert.equal(clean.repo_activity.bindings.length,1);
  assert.equal(clean.repo_activity.repositories[0].cwd,undefined);assert.equal(clean.repo_activity.accounts[0].token,undefined);
  const projected=projectPanelFeed(clean);
  assert.deepEqual(projected.feed.repo_activity,clean.repo_activity);
  assert.notEqual(projected.feed.repo_activity,clean.repo_activity);
  delete raw.repo_activity;
  assert(!Object.hasOwn(projectPanelFeed(cleanPanelFeed(raw),projected).feed,'repo_activity'));
  raw.repo_activity={schema:'future',accounts:[],repositories:[]};
  assert(!Object.hasOwn(cleanPanelFeed(raw),'repo_activity'));
});

test('credential/path-like labels are dropped, absent account/authentication evidence stays unknown',()=>{
  for(const name of ['https://token@example.test/repo','C:/private/repo','/private/repo','~/repo','token=private','github_pat_example']){
    const data=dto();data.accounts[0].name=name;data.repositories[0].name=name;
    const clean=cleanRepositoryGraph(data);assert.equal(clean.accounts.length,0);assert.equal(clean.repositories.length,0,name);
  }
  const data=dto();data.accounts[0].connection='connected';
  assert.equal(cleanRepositoryGraph(data).accounts[0].connection,'unknown','catalog alone cannot prove authentication');
  data.accounts[0].source='explicit_probe';
  assert.equal(cleanRepositoryGraph(data).accounts[0].connection,'connected');
});

test('duplicate worktree relations do not duplicate a repo node, and folder metadata cannot prove Git success',()=>{
  const data=dto();data.repositories.push({...data.repositories[0],id:'duplicate'});data.bindings.push({...data.bindings[0]});
  data.events=[{...wireEvent(),evidence:'approval'}];
  const clean=cleanRepositoryGraph(data,new Set(['agent-a','agent-b']));
  assert.equal(clean.repositories.length,1);assert.equal(clean.bindings.length,2);
  assert.equal(clean.events.length,0,'approval is never a successful Git result');
});

test('producer evidence phases and Unix seconds keep approval, command results and local HEAD independent',()=>{
  const data=dto(),agents=new Set(['agent-a','agent-b']);
  for(const [evidence,phase,result,expected] of [
    ['pre_tool','attempt','unknown','push · 실행 전'],['approval','authorization','unknown','push · 승인만'],
    ['process_exit','result','succeeded','push · 명령 성공'],['process_exit','result','failed','push · 명령 실패'],
    ['timeout','result','unknown','push · 결과 미확인'],['sensor_error','result','unknown','push · 결과 미확인'],
    ['post_tool','result','unknown','push · 실행 후 · 결과 미확인'],
  ]){
    data.events=[{...wireEvent(),evidence,phase,result}];
    const graph=projectRepositoryGraph(cleanRepositoryGraph(data,agents));
    assert.equal(graph.events[0].at,1000000);
    assert(words(repositorySection(graph,palette,ui)).includes(expected));
    assert(!words(repositorySection(graph,palette,ui)).some(word=>/원격 성공|배포 성공|CI 성공/.test(word)));
  }
  data.events=[{...wireEvent(),evidence:'head_verified',operation:'merge'}];
  assert(words(repositorySection(projectRepositoryGraph(cleanRepositoryGraph(data,agents)),palette,ui)).includes('merge · 로컬 반영'));
  for(const invalid of [{evidence:'approval'},{evidence:'head_verified'},{evidence:'post_tool'},{observed_at:true},{operation:'status'},{phase:'attempt'},{result:'future'}]){
    data.events=[{...wireEvent(),...invalid}];assert.equal(cleanRepositoryGraph(data,agents).events.length,0);
  }
});

test('unknown agents do not inherit cwd attribution and null bindings keep local/unlinked/unknown distinct',()=>{
  const data=dto();data.events=[wireEvent()];data.events[0].agent_id='unproven';
  data.bindings=[{agent_id:'agent-a',repository_id:null,state:'local'},{agent_id:'agent-b',repository_id:null,state:'unlinked'},{agent_id:'agent-c',repository_id:null,state:'unknown'}];
  const clean=cleanRepositoryGraph(data,new Set(['agent-a','agent-b','agent-c'])),graph=projectRepositoryGraph(clean);
  assert.equal(clean.events[0].agent_id,null);
  const tree=repositorySection(graph,palette,ui);
  for(const label of ['로컬 폴더 1','목록 미연결 1','폴더 미확인 1'])assert(words(tree).includes(label));
});

test('new event floods are bounded, and input order is stable for the fixed catalog',()=>{
  const data=dto();data.events=Array.from({length:300},(_,i)=>({...wireEvent(),id:`event_${i}`}));
  const clean=cleanRepositoryGraph(data,new Set(['agent-a']));assert.equal(clean.events.length,REPO_LIMITS.events);
  const initial=repositoryEventState({...graph(),events:[]},1000000,{motion:true});
  const state=repositoryEventState(projectRepositoryGraph(clean),1000000,{previous:initial,motion:true});
  assert.equal(state.packets.length,REPO_LIMITS.active);
  assert.equal(state.seen.length,REPO_LIMITS.events,'overflow becomes watermark rather than a replay queue');
  assert.deepEqual(clean.accounts.map(row=>row.id),['personal']);
});

test('the native deadline controller cancels on hide or disposal and never replays a hidden burst',()=>{
  let now=1000,shown=true,enabled=true,notifies=0;const timers=[];
  const c=createRepositoryController({clock:()=>now,visible:()=>shown,motion:()=>enabled,notify:()=>notifies++,after:(ms,fn)=>{
    const timer={ms,fn,cancelled:false,cancel(){this.cancelled=true;}};timers.push(timer);return timer;
  }});
  const data=graph();c.apply(data);assert.equal(timers.length,0);
  data.events=[event(++now)];c.apply(data);assert.equal(c.state.packets.length,1);assert.equal(timers.length,1);
  shown=false;c.apply(data);assert(timers[0].cancelled);assert.equal(c.state.nextAt,null);
  const count=notifies;data.events.push(event(++now,'hidden'));c.apply(data);assert.equal(notifies,count);
  shown=true;c.apply(data);assert.equal(c.state.packets.length,0);
  data.events.push(event(++now,'live'));c.apply(data);assert.equal(c.state.packets.length,1);
  const last=timers.at(-1);c.dispose();assert(last.cancelled);
  c.apply(data);assert.equal(timers.at(-1),last);
});

test('optional schema uses the same bounds and mutation catalog as the producer-compatible consumer',async()=>{
  const {readFile}=await import('node:fs/promises');
  const schema=JSON.parse(await readFile(new URL('../schemas/herdr/panel-feed.schema.json',import.meta.url),'utf8'));
  assert.equal(schema.properties.repo_activity.$ref,'#/$defs/repo_activity');
  assert(!schema.required.includes('repo_activity'));
  assert.deepEqual(schema.$defs.repo_event.properties.operation.enum,GIT_OPERATIONS);
  for(const [field,limit] of [['accounts','accounts'],['repositories','repos'],['bindings','bindings'],['events','events']])
    assert.equal(schema.$defs.repo_activity.properties[field].maxItems,REPO_LIMITS[limit]);
  assert.equal(schema.$defs.repo_event.additionalProperties,false);
  assert.equal(schema.$defs.repo_event.properties.observed_at.type,'integer');
});

test('schema evidence enum and oneOf branches agree with the consumer evidence table',async()=>{
  const {readFile}=await import('node:fs/promises');
  const event=JSON.parse(await readFile(new URL('../schemas/herdr/panel-feed.schema.json',import.meta.url),'utf8')).$defs.repo_event;
  const values=rule=>rule?.const!==undefined?[rule.const]:rule?.enum||[];
  assert.deepEqual([...event.properties.evidence.enum].sort(),Object.keys(REPO_EVIDENCE).sort());
  for(const [name,[phase,results]] of Object.entries(REPO_EVIDENCE)){
    const branches=event.oneOf.filter(branch=>values(branch.properties.evidence).includes(name));
    assert.equal(branches.length,1,`${name} has exactly one schema branch`);
    assert.deepEqual(values(branches[0].properties.phase),[phase],name);
    assert.deepEqual([...values(branches[0].properties.result)].sort(),[...results].sort(),name);
  }
  assert.deepEqual(values(event.oneOf.find(branch=>values(branch.properties.evidence).includes('post_tool')).properties.result),['unknown']);
  assert(Object.isFrozen(REPO_EVIDENCE)&&Object.values(REPO_EVIDENCE).every(rule=>Object.isFrozen(rule)&&Object.isFrozen(rule[1])));
});

test('existing evidence combinations are unchanged by the post_tool extension',()=>{
  assert.deepEqual(Object.fromEntries(Object.entries(REPO_EVIDENCE).filter(([name])=>name!=='post_tool')),{
    pre_tool:['attempt',['unknown']],approval:['authorization',['unknown']],process_exit:['result',['succeeded','failed']],
    head_verified:['result',['succeeded']],timeout:['result',['unknown']],sensor_error:['result',['unknown']]});
  const data=dto(),agents=new Set(['agent-a']);
  data.events=[{...wireEvent(),id:'exit'},{...wireEvent(),id:'pre',evidence:'pre_tool',phase:'attempt',result:'unknown'},
    {...wireEvent(),id:'merge',operation:'merge',evidence:'head_verified'},{...wireEvent(),id:'bad',evidence:'post_tool',result:'succeeded'}];
  assert.deepEqual(cleanRepositoryGraph(data,agents).events.map(e=>e.id),['exit','pre','merge'],'an invalid post_tool row drops only itself');
});

test('post_tool shows an after-execution observation with an unconfirmed result and no motion',()=>{
  const data=dto(),agents=new Set(['agent-a']);
  const post={...wireEvent(),evidence:'post_tool',phase:'result',result:'unknown'};
  data.events=[post];
  const clean=cleanRepositoryGraph(data,agents);
  assert.deepEqual(clean.events,[{...post}]);
  const projected=projectRepositoryGraph(clean);
  assert.equal(projected.events[0].result,'unknown');assert.equal(projected.events[0].source,'post_tool');
  assert.equal(repositorySource('post_tool'),'실행 후 관측(결과 미확인)');
  const tree=repositorySection(projected,palette,ui);
  assert(words(tree).includes('push · 실행 후 · 결과 미확인'));
  assert(!words(tree).some(word=>/명령 성공|명령 실패|성공|실패/.test(word)),'unknown never reads as success or failure');
  assert.match(byId(tree,'sf-repo-repo').calls.find(c=>c[0]==='tooltip')[1],/실행 후 관측\(결과 미확인\)/);
  assert.equal(byId(tree,'sf-repo-result-repo').calls.find(c=>c[0]==='text_color')[1],palette.muted);
  // Motion on, visible, fresh and attributed: still no packet, no deadline.
  let state=repositoryEventState({...projected,events:[]},1000000,{motion:true});
  state=repositoryEventState(projected,1000000,{previous:state,motion:true});
  assert.equal(state.packets.length,0);assert.equal(state.active.length,0);assert.equal(state.nextAt,null);
  assert.deepEqual(state.seen,['event'],'consumed into the watermark rather than queued');
  const layout={agents:new Map([['agent-a',{y:20}]]),repos:repositoryLayout(projected,100).anchors,height:240};
  assert(!nodes(repositoryFlowLayer(projected,layout,state,palette,ui)).some(n=>n.calls.some(c=>c[0]==='transition')));
  const timers=[];let notifies=0;
  const c=createRepositoryController({clock:()=>1000000,visible:()=>true,motion:()=>true,notify:()=>notifies++,after:(ms,fn)=>{timers.push(ms);return {cancel(){}};}});
  c.apply({...projected,events:[]});c.apply(projected);
  assert.equal(timers.length,0,'no deadline is armed for an unknown observation');
  c.dispose();
});

test('post_tool rejects succeeded/failed, wrong phases and non-string or near-miss values',()=>{
  const data=dto(),agents=new Set(['agent-a']);
  const base=()=>({...wireEvent(),evidence:'post_tool',phase:'result',result:'unknown'});
  const cases=[
    ...['succeeded','failed','started','success','failure','UNKNOWN',' unknown','unknown ','',null,1,true,['unknown'],{}].map(result=>({result})),
    ...['attempt','authorization','RESULT','',null,['result'],{}].map(phase=>({phase})),
    ...['POST_TOOL','post_tool ','post-tool','postTool',['post_tool'],new String('post_tool'),{toString:()=>'post_tool'}].map(evidence=>({evidence})),
  ];
  for(const change of cases){
    data.events=[{...base(),...change}];
    assert.equal(cleanRepositoryGraph(data,agents).events.length,0,JSON.stringify(change));
  }
  for(const field of ['phase','result','evidence']){
    const item=base();delete item[field];data.events=[item];
    assert.equal(cleanRepositoryGraph(data,agents).events.length,0,`missing ${field}`);
  }
});

test('post_tool fields must be own properties, never inherited from a prototype or a JSON __proto__ key',()=>{
  const data=dto(),agents=new Set(['agent-a']);
  const rest=()=>{const item={...wireEvent()};delete item.evidence;delete item.phase;delete item.result;return item;};
  const fromProto=Object.assign(Object.create({evidence:'post_tool',phase:'result',result:'unknown'}),rest());
  const partial=Object.assign(Object.create({phase:'result',result:'unknown'}),rest(),{evidence:'post_tool'});
  for(const item of [fromProto,partial]){
    data.events=[item];assert.equal(cleanRepositoryGraph(data,agents).events.length,0);
  }
  const text=JSON.stringify({...dto(),events:[{...rest(),id:'json_proto'}]})
    .replace('"id":"json_proto",','"id":"json_proto","__proto__":{"evidence":"post_tool","phase":"result","result":"unknown"},');
  assert.equal(cleanRepositoryGraph(JSON.parse(text),agents).events.length,0);
  for(const name of ['__proto__','constructor','toString','hasOwnProperty','valueOf']){
    data.events=[{...wireEvent(),evidence:name,phase:'result',result:'unknown'}];
    assert.equal(cleanRepositoryGraph(data,agents).events.length,0,name);
  }
});

test('post_tool keeps operation identity and per-event deduplication',()=>{
  const data=dto(),agents=new Set(['agent-a']);
  const pre={...wireEvent(),id:'pre',operation_id:'op_one',evidence:'pre_tool',phase:'attempt',result:'unknown'};
  const post={...wireEvent(),id:'post',operation_id:'op_one',evidence:'post_tool',phase:'result',result:'unknown'};
  data.events=[pre,post,{...post},{...post,result:'succeeded',id:'post_ok'}];
  const clean=cleanRepositoryGraph(data,agents);
  assert.deepEqual(clean.events.map(e=>[e.id,e.operation_id,e.evidence]),[['pre','op_one','pre_tool'],['post','op_one','post_tool']]);
  const graph=projectRepositoryGraph(clean);
  assert(words(repositorySection(graph,palette,ui)).includes('push · 실행 후 · 결과 미확인'),'the latest supplied row is the label');
});

test('old feeds keep their exact sidebar; an explicit empty catalog remains distinguishable',()=>{
  assert.equal(repositorySection(null,palette,ui),null);
  const data=graph();data.accounts=[];data.repos=[];
  assert(words(repositorySection(data,palette,ui)).includes('고정 레포 없음'));
  assert(words(repositorySection(data,palette,ui)).includes('관측 공백 있음'));
});

test('one stable repo node retains two session relations and a bounded narrow layout',()=>{
  const data=graph(),layout=repositoryLayout(data,200);
  assert.equal(layout.anchors.size,1);
  assert.equal(layout.rows.filter(row=>row.kind==='repo').length,1);
  const tree=repositorySection(data,palette,ui);
  assert(words(tree).includes('2 연결'));
  assert(words(tree).includes('미확인'),'configuration does not prove an authenticated connection');
  assert.equal(byId(tree,'sf-repo-repo').calls.find(c=>c[0]==='h')[1],40);
  assert(byId(tree,'sf-repo-name-repo').calls.some(c=>c[0]==='truncate'));
  assert(!nodes(tree).some(n=>n.calls.some(c=>c[0]==='w'&&c[1]>176)));
});

test('catalog labels remain literal text, and remote namespace never claims a pusher',()=>{
  const data=graph();data.accounts[0].name='<b>Account</b>';
  const tree=repositorySection(data,palette,ui);
  assert(words(tree).includes('<b>Account</b>'));
  assert.match(byId(tree,'sf-repo-account-personal').calls.find(c=>c[0]==='tooltip')[1],/pusher 증명이 아닙니다/);
  assert.match(byId(tree,'sf-repo-repo').calls.find(c=>c[0]==='tooltip')[1],/로컬 main 관측/);
});

test('an initial history is consumed without animation and only a new evidenced event moves',()=>{
  const data=graph();data.events=[event(1000,'old')];
  let state=repositoryEventState(data,1000,{motion:true});
  assert.equal(state.packets.length,0);
  data.events.push(event(1001,'new'));
  state=repositoryEventState(data,1001,{previous:state,motion:true});
  assert.deepEqual(state.packets.map(e=>e.id),['new']);
  assert.equal(state.nextAt,1001+REPO_TIMING.start);
  state=repositoryEventState(data,1001+REPO_TIMING.end,{previous:state,motion:true});
  assert.equal(state.packets.length,0);assert.equal(state.nextAt,null);
});

test('unknown or explicitly non-animating evidence produces labels but no moving success',()=>{
  const data=graph();let state=repositoryEventState(data,1000,{motion:true});
  data.events=[{...event(1001),result:'unknown'},{...event(1001,'quiet'),animate:false}];
  state=repositoryEventState(data,1001,{previous:state,motion:true});
  assert.equal(state.packets.length,0);assert.equal(state.nextAt,null);
  assert(words(repositorySection(data,palette,ui)).includes('push · 명령 성공'));
  data.events=[{...event(1001),result:'unknown'}];
  assert(words(repositorySection(data,palette,ui)).includes('push · 결과 미확인'));
});

test('hidden/reduced-motion snapshots update labels without a backlog on reopening',()=>{
  const data=graph();let state=repositoryEventState(data,1000,{motion:true});
  data.events=[event(1001)];
  state=repositoryEventState(data,1001,{previous:state,motion:false});
  assert.equal(state.nextAt,null);assert.equal(state.packets.length,0);
  state=repositoryEventState(data,1002,{previous:state,motion:true});
  assert.equal(state.packets.length,0);
  assert(words(repositorySection(data,palette,ui)).includes('push · 명령 성공'));
});

test('event removal and correction immediately withdraw an earlier success effect',()=>{
  for(const correction of ['remove','unknown','animate']){
    const data=graph();let state=repositoryEventState(data,1000,{motion:true});
    data.events=[event(1001)];state=repositoryEventState(data,1001,{previous:state,motion:true});
    assert.equal(state.packets.length,1);
    if(correction==='remove')data.events=[];
    else if(correction==='unknown')data.events[0].result='unknown';
    else data.events[0].animate=false;
    state=repositoryEventState(data,1010,{previous:state,motion:true});
    assert.equal(state.packets.length,0);assert.equal(state.nextAt,null);
  }
});

test('cwd relationships stay stationary; missing or hidden endpoints never acquire invented routes',()=>{
  const data=graph(),layout={agents:new Map([['agent-a',{y:20}],['agent-b',{y:44}]]),repos:repositoryLayout(data,100).anchors,height:240};
  const tree=repositoryFlowLayer(data,layout,null,palette,ui);
  assert(byId(tree,'sf-repo-line-cwd-0'));assert(byId(tree,'sf-repo-line-cwd-1'));
  assert(!nodes(tree).some(n=>n.calls.some(c=>c[0]==='transition')));
  layout.agents.delete('agent-a');
  assert(!byId(repositoryFlowLayer(data,layout,null,palette,ui),'sf-repo-line-cwd-0'));
  data.bindings[1].state='unknown';
  assert(!byId(repositoryFlowLayer(data,layout,null,palette,ui),'sf-repo-line-cwd-1'));
});

test('evidenced packets use finite native targets and no repeating animation',()=>{
  const data=graph(),layout={agents:new Map([['agent-a',{y:20}]]),repos:repositoryLayout(data,100).anchors,height:240};
  let state=repositoryEventState(data,1000,{motion:true});data.events=[event(1001)];
  state=repositoryEventState(data,1001,{previous:state,motion:true});
  const tree=repositoryFlowLayer(data,layout,state,palette,ui),packet=byId(tree,'sf-repo-packet-event');
  assert(packet);assert.deepEqual(packet.calls.find(c=>c[0]==='size'),['size',3]);
  assert(packet.calls.some(c=>c[0]==='transition'&&c[2].duration<3000));
  assert(!nodes(tree).some(n=>n.calls.some(c=>['loop','spin','frames'].includes(c[0]))));
});

test('actual sidebar facade retains 224/360px repo edges, computer filtering and document actions',async()=>{
  const {readFile}=await import('node:fs/promises');
  const raw=makePanelLoadFixture({spaces:2,agentsPerSpace:2,now:Date.now()}),local=raw.spaces[0],remote=raw.spaces[1];
  local.nav={space_id:'sp-local',machine:null};remote.nav={space_id:'sp-remote',machine:'worker'};
  const native=[{id:'sp-local',name:'Demo',machine:null,active:true,tabs:[{id:'tab-local',name:'Local'}]},
    {id:'worker/sp-remote',name:'Demo',machine:'worker',active:false,tabs:[{id:'tab-remote',name:'Remote'}]}];
  const store=new Map([['sixfold.panel.enabled',true],['sixfold.motion',false]]),commands=[];
  const theme={background:'#101318',chrome:'#14191f',surface:'#1b232d',border:'#39434f',selected:'#253249',foreground:'#e5edf5',muted:'#a6b0bf',dim:'#788594',accent:'#a9b8ff',ansi6:'#68c9bc',blocked:'#edac67',hover:'#253249',ansi5:'#bca0ff',ansi3:'#e7c988',ansi2:'#8cc38c',ansi4:'#8cb5e8'};
  const path=()=>new Proxy({},{get:(_t,key)=>key==='build'?()=>[]:()=>path()});
  globalThis.__repoSidebarRuntime={View:class{},div:node,svg:node,image:node,h_flex:node,v_flex:node,
    PathBuilder:{stroke:path},Input:{new:node},InputState:{new:()=>({on(){},value(){return '';}})},Popover:{new:node},
    props:()=>({role:'sidebar'}),theme:()=>theme,window:()=>({platform:'windows',visible:true}),layout:()=>({}),settings:()=>({zoom:1}),
    shared:key=>store.get(key),setShared:(key,value)=>store.set(key,value),spaces:()=>native,panes:()=>[],agents:()=>[],terminals:()=>[],
    focused:()=>({space:'sp-local',tab:'tab-local'}),machines:()=>[{name:null,layout:'ready'},{name:'worker',layout:'ready'}],
    run:(...args)=>commands.push(args),setAgentOrder(){},appHome:()=>'/demo'};
  const previousWindow=globalThis.window;globalThis.window={paint_path:node};
  const modules=new Map();
  async function load(name){
    if(modules.has(name))return modules.get(name);
    let source=await readFile(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url),'utf8');
    source=source.replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base|herdr)';/g,'const {$1}=globalThis.__repoSidebarRuntime;')
      .replace(/import \* as (\w+) from 'herdr';/g,'const $1=globalThis.__repoSidebarRuntime;');
    for(const match of [...source.matchAll(/from '(\.\/([^']+)\.js)'/g)])source=source.replaceAll(`'${match[1]}'`,JSON.stringify(await load(match[2])));
    const url=`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;modules.set(name,url);return url;
  }
  let c;
  try{
    const {default:Desk}=await import(await load('main'));
    const {createRetainedPanel}=await import(await load('panel-retained'));
    const {cleanPanelFeed:clean}=await import(await load('panel-model'));
    const cx={notify(){},timer:{after(){return {cancel(){}};}},new(Class,props){
      const view=new Class();view.init?.(props,cx);return {view,release(){}};
    }};
    c=createRetainedPanel(cx,{embedded:true});c.apply(clean(raw),'ready');
    const desk=new Desk();Object.assign(desk,{panelRetained:c,panelTrackingActive:true,panelState:{feed:c.feed},
      computers:{local:{label:'Local'},machines:{worker:{label:'Worker'}}},site:{},messageEvents:[],workflowNodes:[],workflowEvents:[],
      activeFlows:[],pendingFlows:[],sidebarNotices:[],expandedAgents:new Set(),readMessages:{},workspaceIcons:{},workspacePins:{spaces:[]},
      docsSpaces:new Set(),docsHeights:{},alerts:[],asks:[],askChoices:{},askBusy:{},askErrors:{},sessionReports:[]});
    assert(!byId(desk.render(cx),'sf-repositories'),'old feed keeps its original section structure');
    raw.repo_activity=dto();raw.repo_activity.bindings=local.agents.map(agent=>({agent_id:agent.id,repository_id:'repo',state:'cwd'}));
    c.apply(clean(raw),'ready');desk.panelState={feed:c.feed};store.set('sixfold.computing.selected','local');
    for(const width of [224,360]){
      c.resize(width,cx);
      const tree=desk.render(cx);
      assert(byId(tree,'sf-repo-account-personal'));assert(byId(tree,'sf-repo-repo'));
      assert(byId(tree,'sf-repo-line-cwd-0'));assert(byId(tree,'sf-repo-line-cwd-1'));
      assert(byId(tree,'sf-docs-open-sp-local'),'repo catalog preserves native document actions');
      assert.equal(byId(tree,'sf-space-sp-local').calls.find(call=>call[0]==='mr')[1],48,'existing card gutter remains fixed');
    }
    store.set('sixfold.computing.selected','remote:worker');
    const filtered=desk.render(cx);
    assert(byId(filtered,'sf-repo-repo'),'fixed list survives computer switching');
    assert(!byId(filtered,'sf-repo-line-cwd-0'),'hidden local session has no invented remote route');
    assert(byId(filtered,'sf-docs-open-worker/sp-remote'),'remote document action remains scoped to its computer');
    assert.equal(commands.length,0,'render never changes focus or connects to a computer');
  }finally{
    c?.dispose();delete globalThis.__repoSidebarRuntime;
    if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;
  }
});

test('malformed optional evidence is dropped on the JSON path while the rest of the feed keeps updating',async()=>{
  const {reconcilePanelFeed}=await import('../mods/sixfold-desk/panel-model.js');
  const {repositoryResult,repositorySource}=await import('../mods/sixfold-desk/repo-flow.js');
  const raw=makePanelFixture(),agent=raw.spaces[0].agents[0].id;
  raw.repo_activity=dto();raw.repo_activity.bindings[0].agent_id=agent;
  const valid={...wireEvent(),id:'valid',agent_id:agent};
  const before=cleanPanelFeed(JSON.stringify({...raw,repo_activity:{...raw.repo_activity,events:[valid]}}));
  assert.deepEqual(before.repo_activity.events.map(e=>e.id),['valid']);
  // Inherited names, non-string values and an array that coerces to a real key,
  // each with and without the phase/result that the table would otherwise expect.
  const evidences=['__proto__','constructor','toString','hasOwnProperty','valueOf',{},{0:'result',1:['succeeded']},['process_exit'],null,7,true,undefined];
  const shapes=[{},{phase:'result'},{phase:'result',result:'succeeded'},{phase:'attempt',result:'unknown'},{phase:'authorization',result:'unknown'}];
  const bad=[];
  for(const [i,evidence] of evidences.entries())for(const [j,shape] of shapes.entries()){
    const item={...wireEvent(),id:`bad_${i}_${j}`};delete item.phase;delete item.result;delete item.evidence;
    Object.assign(item,shape);if(evidence!==undefined)item.evidence=evidence;bad.push(item);
  }
  bad.push(JSON.parse('{"id":"own_proto","operation_id":"operation","machine_id":"machine","repository_id":"repo","operation":"push","observed_at":1000,"__proto__":{"evidence":"process_exit","phase":"result","result":"succeeded"}}'));
  raw.repo_activity.events=[...bad.slice(0,30),valid,...bad.slice(30)];
  raw.spaces[0].name='Renamed workspace';
  const text=JSON.stringify(raw).replace('"id":"own_proto",','"id":"own_proto","__proto__":{"evidence":"process_exit","phase":"result","result":"succeeded"},');
  let clean;
  assert.doesNotThrow(()=>{clean=cleanPanelFeed(text);});
  assert(clean,'a malformed optional event never invalidates the whole snapshot');
  assert.deepEqual(clean.repo_activity.events.map(e=>e.id),['valid']);
  assert.equal(typeof clean.repo_activity.events[0].evidence,'string');
  assert.equal(clean.spaces[0].name,'Renamed workspace','the ordinary feed update still lands');
  assert.deepEqual({...clean,spaces:before.spaces},before,'only the space rename differs from the clean snapshot');
  const next=reconcilePanelFeed(text,{feed:before});
  assert.equal(next.status,'ready');assert(next.changed);assert.equal(next.feed.spaces[0].name,'Renamed workspace');
  const projected=projectPanelFeed(clean);
  assert.deepEqual(projected.feed.repo_activity.events.map(e=>e.id),['valid']);
  const graph=projectRepositoryGraph(clean.repo_activity);
  assert(words(repositorySection(graph,palette,ui)).includes('push · 명령 성공'));
  for(const name of ['__proto__','constructor','toString','hasOwnProperty']){
    assert.equal(repositoryResult(name),'결과 미확인');assert.equal(repositorySource(name),'출처 미확인');
  }
});
