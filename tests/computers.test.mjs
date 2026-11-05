import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Exercise the sidebar's rendered rows and their callbacks, with two machines
// whose terminal IDs overlap. Listing a machine never changes terminal focus.
test('computer selection scopes workspaces and agents and restores each selection', async()=>{
  const rows=new Map(),calls=[],state={};
  function element(){
    let proxy;
    proxy=new Proxy({nodes:[]}, {get(_target,key){
      if(key==='then')return undefined;
      if(key==='when')return (condition,fn)=>{if(condition)fn(proxy);return proxy;};
      if(key==='id')return id=>{_target.rowId=id;return proxy;};
      if(key==='child')return node=>{_target.nodes.push(node);return proxy;};
      if(key==='children')return nodes=>{_target.nodes.push(...nodes);return proxy;};
      if(key==='nodes' || key==='rowId')return _target[key];
      if(key==='on_click')return fn=>{proxy.click=fn;return proxy;};
      if(key==='click')return _target.click;
      return ()=>proxy;
    },set(target,key,value){target[key]=value;return true;}});
    return proxy;
  }
  const spaces=[
    {id:'home-a',machine:null,name:'Home A',tabs:[{id:'ha'}]},
    {id:'home-b',machine:null,name:'Home B',tabs:[{id:'hb'}]},
    {id:'worker/a',machine:'worker',name:'Remote A',tabs:[{id:'worker/ta'}]},
    {id:'worker/b',machine:'worker',name:'Remote B',tabs:[{id:'worker/tb'}]},
  ];
  let focus={space:'home-b',tab:'hb'},order;
  const agents=[{address:'t1',space:'home-b',status:'blocked'}, {address:'worker/t1',space:'worker/a',status:'working'}];
  const runtime={
    View:class {},div:element,svg:element,image:element,h_flex:element,v_flex:element,
    props:()=>({role:'sidebar'}),theme:()=>({}),focused:()=>focus,spaces:()=>spaces,
    agents:()=>agents,panes:()=>[],terminals:()=>[],window:()=>({}),layout:()=>({}),
    machines:()=>[{name:null,layout:'ready'},{name:'worker',layout:'ready'},{name:'empty',layout:'ready'},{name:'offline',layout:'unavailable'}],
    shared:key=>state[key],setShared:(key,value)=>{state[key]=value;},setAgentOrder:list=>{order=list;},
    run:(command,args)=>calls.push({command,args}),openOverlay:args=>calls.push({overlay:args}),
  };
  globalThis.__computersRuntime=runtime;
  let source=await readFile(new URL('../mods/sixfold-desk/main.js',import.meta.url),'utf8');
  source=source.replace(/import \{ View, div, svg, image \} from 'gpui-kit';/,'const {View,div,svg,image}=globalThis.__computersRuntime;')
    .replace(/import \{ h_flex, v_flex \} from 'gpui-base';/,'const {h_flex,v_flex}=globalThis.__computersRuntime;')
    .replace(/import \* as herdrNative from 'herdr';/,'const herdrNative=globalThis.__computersRuntime;')
    .replace(/import \{([^}]+)\} from 'herdr';/,'const {$1}=globalThis.__computersRuntime;')
    .replace(/import \{[^}]*\} from '.\/docs.js';/,'const currentDocs=()=>null;const docsSection=()=>null;const prepareDocsInput=()=>{};')
    .replace(/import \{ watchAlerts, alertSection, visibleAlerts \} from '.\/alerts.js';/,'const visibleAlerts=()=>[];')
    .replace(/import .* from '.\/alert-inbox.js';/,'const workspaceAlertsRow=()=>null, hasWorkspaceAlerts=()=>false;')
    .replace(/import \{ panePet \} from '.\/pets.js';/,'const panePet=()=>null;')
    .replace(/import \{ paneUsage \} from '.\/session-usage.js';/,'const paneUsage=()=>null;').replace(/import \{ paneMeta, paneMetaChip, showPaneIndex, showTitle \} from '.\/pane-meta.js';/,'const paneMeta=()=>null,paneMetaChip=()=>null,showPaneIndex=()=>false,showTitle=()=>true;')
    .replace(/import \{ watchBadges, workspaceBadges \} from '.\/badges.js';/,'const watchBadges=()=>{},workspaceBadges=()=>null;');
  source = source.replace("import { breathingBorder, borderComet } from './collab-flow-view.js';", 'const breathingBorder=o=>{(globalThis.__breathCalls??=[]).push(o);return div().absolute().top(-1).left(-1).right(-1).bottom(-1).rounded(7).border(2).border_color(o.color);},borderComet=o=>{(globalThis.__flowCalls??=[]).push(o);return null;};');
  for(const name of ['model','flow','workflow','pipeline','sidebar-identity','collab', 'collab-flow'])source=source.replace(`'./${name}.js'`,JSON.stringify(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url).href));
  // A path is never painted in this test; avoid loading the native path builder.
  source=source.replace(/import \{ pipeline \} from [^;]+;/,'const pipeline=()=>{throw Error("unexpected path");};');
  try{
    const {default:Sidebar}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
    const view=new Sidebar();
    Object.assign(view,{workflowNodes:[],workflowEvents:[],messageEvents:[],activeFlows:[],pendingFlows:[],queuedRoutes:[],workspaceIcons:{},expandedAgents:new Set(),readMessages:{},computers:{}});
    const render=()=>{
      rows.clear();
      const visit=node=>{if(!node || typeof node!=='object')return;if(node.rowId)rows.set(node.rowId,node);for(const child of node.nodes??[])visit(child);};
      visit(view.render());
    };
    render();
    assert(rows.has('sf-space-home-a'));assert(rows.has('sf-space-home-b'));
    assert(!rows.has('sf-space-worker/a'));assert.deepEqual(order,['t1']);
    assert(!rows.has('sf-pinned-home-a'),'no hardcoded default pins');
    view.workspacePins={spaces:[{id:'home-a',machine:null}]};render();
    assert(rows.has('sf-pinned-home-a'));
    assert(!rows.has('sf-pinned-home-b'));
    view.workspacePins={spaces:[]};render();
    assert(!rows.has('sf-pinned-home-a'),'empty configuration removes the marker');
    const beforeSelection=calls.length;
    rows.get('sf-computer-remote:worker').click();render();
    assert.equal(state['sixfold.computing.selected'],'remote:worker');
    assert(rows.has('sf-space-worker/b'));assert(!rows.has('sf-space-home-b'));
    assert.deepEqual(order,['worker/t1']);
    assert.deepEqual(focus,{space:'home-b',tab:'hb'});
    // Recreate the view against persisted shared state to simulate a mod restart.
    const restarted=new Sidebar();
    assert.equal(restarted.selectedComputer(),'remote:worker');
    // Even a native focus change cannot replace the explicitly chosen computer.
    focus={space:'home-a',tab:'ha'};render();
    assert(rows.has('sf-space-worker/a'));assert(!rows.has('sf-space-home-a'));
    rows.get('sf-computer-local').click();render();
    assert(rows.has('sf-space-home-b'));assert(!rows.has('sf-space-worker/b'));
    rows.get('sf-computer-remote:empty').click();render();
    assert(rows.has('sf-empty-workspaces'));assert(!rows.has('sf-space-home-a'));
    assert(!rows.has('sf-computer-remote:offline'),'disconnected machines start collapsed');
    assert(!rows.has('sf-computers-summary'));
    assert(![...rows.keys()].some(key=>key.startsWith('sf-compact-')));
    rows.get('sf-computers-toggle').click();render();
    assert(rows.has('sf-computers-other'));
    rows.get('sf-computer-remote:offline').click();render();
    assert.equal(state['sixfold.computing.selected'],'remote:offline');
    assert(rows.has('sf-empty-workspaces'));
    assert.equal(calls.length,beforeSelection,'computer clicks must not select spaces, open overlays, or connect');
    view.computers={tailscale:true};
    view.tailscalePeers=[{name:'desktop-test',host:'DESKTOP-TEST',ips:['100.1.2.3'],os:'windows',online:true}];
    render();
    assert(rows.has('sf-tailscale-desktop-test'));
    rows.get('sf-tailscale-desktop-test').click();render();
    assert.equal(state['sixfold.computing.selected'],'tailscale:desktop-test');
    assert(rows.has('sf-empty-workspaces'));assert(!rows.has('sf-space-home-a'));
    assert(!rows.has('sf-new-space'),'unregistered peer cannot create a local workspace accidentally');
    assert.equal(calls.length,beforeSelection);
    rows.get('sf-computers-toggle').click();render();
    assert(!rows.has('sf-computers-other'));
    assert(rows.has('sf-tailscale-desktop-test'),'online Tailscale peers stay listed while collapsed');
    assert(!rows.has('sf-compact-tailscale:desktop-test'));
    view.tailscalePeers.push(...Array.from({length:10},(_,i)=>({name:`offline-${i}`,os:'ios',online:false})));
    view.tailscalePeers.push({name:'unknown',os:'linux',online:null});
    render();
    assert.equal([...rows.keys()].filter(key=>key.startsWith('sf-compact-')).length,0,'collapsed devices have no icons regardless of count or selection');
    assert.deepEqual([...rows.keys()].filter(key=>key.startsWith('sf-tailscale-')),['sf-tailscale-desktop-test'],'offline and unknown peers stay folded');
    assert.equal(calls.length,beforeSelection);
    view.tailscaleError=true;render();
    assert(!rows.has('sf-computers-summary'));
    assert(!rows.has('sf-computers-error'));
    rows.get('sf-computers-toggle').click();render();
    assert(rows.has('sf-computers-error'));
    assert(rows.has('sf-tailscale-unknown'));
    assert(rows.has('sf-tailscale-offline-9'));
    view.computers={tailscale:false};render();
    assert(!rows.has('sf-tailscale-desktop-test'));
    view.computers={local:{label:'My PC'},machines:{worker:{label:'Build',folder:'/projects'}}};
    view.newWorkspace('worker');
    assert.deepEqual(calls.at(-1).overlay.props,{machine:'worker',machineLabel:'Build',folder:'/projects'});
  }finally{delete globalThis.__computersRuntime;}
});

test('remote creation stays on its original machine and uses remote home for a blank folder', async()=>{
  let inputs={machine:'worker',machineLabel:'Build'},called,task,closed=false;
  const runtime={
    props:()=>inputs,home:()=>'/LOCAL-HOME',run:(command,args)=>{called={command,args};},
    closeOverlay:()=>{closed=true;},
    knownAgents:()=>{throw Error('must not inspect local agent installation for a remote terminal');},
  };
  globalThis.__remoteCreateRuntime=runtime;
  let source=await readFile(new URL('../mods/sixfold-new-space/main.js',import.meta.url),'utf8');
  source=source.replace(/import \{ View, div \} from 'gpui-kit';/,'class View {}')
    .replace(/import \{[^}]+\} from 'gpui-base';/,'const InputState={new:({value=""})=>({value:()=>value,on(){},focus(){}})};')
    .replace(/import \{([^}]+)\} from 'herdr';/,'const {$1}=globalThis.__remoteCreateRuntime;');
  try{
    const {default:Dialog}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
    const view=new Dialog();view.init({},{});view.name={value:()=> 'Remote project'};
    const cx={notify(){},spawn(fn){task=()=>fn(cx);}};
    view.create(cx);
    // A focus change cannot retarget an already opened creation dialog.
    inputs={machine:'another',overlay:'dialog'};
    await task();
    assert.deepEqual(called,{command:'space.new',args:{name:'Remote project',machine:'worker',tab:'터미널'}});
    assert.equal(closed,true);assert.equal(view.error,'');
  }finally{delete globalThis.__remoteCreateRuntime;}
});

test('local creation needs only Claude installed; Codex is not required for the one starting session', async()=>{
  const run=async(agents)=>{
    let execCall=null,closed=false,task;
    globalThis.__localCreateRuntime={
      props:()=>({overlay:'dialog'}),home:()=>'/Users/me',appHome:()=>'/app',
      run:()=>{throw Error('local creation must go through workspace.py');},
      closeOverlay:()=>{closed=true;},exec:async(cmd,args)=>{execCall={cmd,args};return {code:0,stdout:'',stderr:''};},
      theme:()=>({}),pickFolder:async()=>null,knownAgents:async()=>agents,
    };
    let source=await readFile(new URL('../mods/sixfold-new-space/main.js',import.meta.url),'utf8');
    source=source.replace(/import \{ View, div \} from 'gpui-kit';/,'class View {}')
      .replace(/import \{[^}]+\} from 'gpui-base';/,'const InputState={new:({value=""})=>({value:()=>value,on(){},focus(){}})};')
      .replace(/import \{([^}]+)\} from 'herdr';/,'const {$1}=globalThis.__localCreateRuntime;');
    try{
      const {default:Dialog}=await import('data:text/javascript;base64,'+Buffer.from(source+'\n//'+Math.random()).toString('base64'));
      const view=new Dialog();view.init({},{});view.name={value:()=>'Local project'};view.folder={value:()=>'/proj'};
      const cx={notify(){},spawn(fn){task=()=>fn(cx);}};
      view.create(cx);await task();
      return {execCall,closed,error:view.error};
    }finally{delete globalThis.__localCreateRuntime;}
  };
  const claudeOnly=await run([{key:'claude',installed:true},{key:'codex',installed:false}]);
  assert.equal(claudeOnly.error,'');assert.equal(claudeOnly.closed,true);
  assert(claudeOnly.execCall.args.some(a=>a.endsWith('workspace.py')));
  const noClaude=await run([{key:'claude',installed:false},{key:'codex',installed:true}]);
  assert.match(noClaude.error,/claude/);assert.equal(noClaude.execCall,null);assert.equal(noClaude.closed,false);
});
