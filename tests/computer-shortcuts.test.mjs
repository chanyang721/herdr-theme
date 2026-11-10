import {classicPanelImports} from './classic-panel-imports.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {computerSlots,computerHub} from '../mods/sixfold-desk/sidebar-identity.js';

const machine=(name,layout='ready')=>({name,layout});

test('slots: this computer first, then registered machines in sidebar order, disconnected last', () => {
  assert.deepEqual(computerSlots([machine(null),machine('alpha','unavailable'),machine('beta'),machine('gamma','loading')]),
    ['local','remote:beta','remote:gamma','remote:alpha']);
  // Local stays first even if the native list ever put it elsewhere.
  assert.deepEqual(computerSlots([machine('beta'),machine(null)]),['local','remote:beta']);
  assert.deepEqual(computerSlots([]),[]);
  assert.deepEqual(computerSlots(undefined),[]);
});

test('hub: explicit id or Share role name on that computer only; ambiguous or missing is null', () => {
  const sp=(id,name,machine=null,tabs=[])=>({id,name,machine,tabs});
  const spaces=[sp('a','Share'),sp('b','Work'),sp('w/c','Chanyang','worker'),sp('w/d','공통','worker'),sp('x/e','Share','other'),sp('x/f','common','other')];
  assert.equal(computerHub(spaces,'local').id,'a');
  assert.equal(computerHub(spaces,'remote:worker').id,'w/d');
  assert.equal(computerHub(spaces,'remote:other'),null,'two role names: never guess');
  assert.equal(computerHub(spaces,'remote:other',{},{machines:{other:{hub_space_ids:['x/f']}}}).id,'x/f','explicit id wins');
  assert.equal(computerHub(spaces,'remote:worker',{hub_space_ids:['w/c']}).id,'w/c');
  assert.equal(computerHub(spaces,'remote:missing'),null);
  assert.equal(computerHub(spaces,'tailscale:peer'),null);
  assert.equal(computerHub([sp('w/c','Chanyang','worker')],'remote:worker'),null,'a personal name is not a Share');
});

test('keys: cmd-ctrl-1..9 map to numbered computer commands and keep every existing key', () => {
  const now=JSON.parse(execFileSync('git',['show','HEAD:keys.json'],{cwd:new URL('..',import.meta.url),encoding:'utf8'}).toString());
  return readFile(new URL('../keys.json',import.meta.url),'utf8').then(text=>{
    const keys=JSON.parse(text), layout=keys['layout:sixfold'];
    for(let i=1;i<=9;i++)assert.equal(layout[`cmd-ctrl-${i}`],`sixfold-desk.computer-${i}`);
    for(const [section,bindings] of Object.entries(now))
      for(const [key,action] of Object.entries(bindings))assert.equal(keys[section]?.[key],action,`${section} ${key} unchanged`);
    assert.equal(layout['cmd-alt-1'],'sixfold-desk.pane-1');
    assert.equal(keys.global?.['cmd-1']??'tab.select:1','tab.select:1');
  });
});

// Drive the mod's real command loop with a fake runtime; shortcuts must act like a sidebar click.
test('computer commands select the listed computer without moving focus, running commands, or connecting', async () => {
  const state={},calls=[],queue=[];
  let waiting;
  const focus={space:'home-a',tab:'ha',pane:'p1',terminal:'t1'};
  const spaces=[{id:'home-a',machine:null,name:'A',tabs:[]}];
  let machines=[{name:null,layout:'ready'},{name:'worker',layout:'ready'},{name:'offline',layout:'unavailable'}];
  const noop=()=>new Proxy(function(){}, {get:(_t,key)=>key==='then'?undefined:noop(),apply:()=>noop()});
  const runtime={
    View:class {},div:noop,svg:noop,image:noop,h_flex:noop,v_flex:noop,
    props:()=>({role:'sidebar'}),theme:()=>({}),focused:()=>focus,spaces:()=>spaces,
    agents:()=>[],panes:()=>[{pane:'p1',tab:'ha',focused:true,terminal:'t1'},{pane:'wp1',tab:'wt',focused:true,terminal:'w/t1'},{pane:'wp2',tab:'wt',focused:false,terminal:'w/t2'}],terminals:()=>[],window:()=>({}),layout:()=>({}),settings:()=>({}),
    machines:()=>machines,shared:key=>state[key],setShared:(key,value)=>{state[key]=value;},setAgentOrder:()=>{},
    run:(command,args)=>calls.push({command,args}),openOverlay:args=>calls.push({overlay:args}),exec:async()=>{calls.push({exec:true});return '';},
    readTextFile:async()=>null,writeTextFile:async()=>{},appHome:()=>'/nowhere',
    nextCommand:()=>queue.length?Promise.resolve(queue.shift()):new Promise(resolve=>{waiting=resolve;}),
  };
  globalThis.__shortcutRuntime=runtime;
  let source=await readFile(new URL('../mods/sixfold-desk/main.js',import.meta.url),'utf8');
  source=source.replace("'./panel-host.js'",JSON.stringify(new URL('../mods/sixfold-desk/panel-host.js',import.meta.url).href));
  source=classicPanelImports(source).replace("'./panel-model.js'",JSON.stringify(new URL('../mods/sixfold-desk/panel-model.js',import.meta.url).href));
  source=source.replace("import {createRetainedPanel} from './panel-retained.js';",'const createRetainedPanel=()=>null;');
  for(const name of ['task-feed-source','task-issue-state'])source=source.replace(`'./${name}.js'`,JSON.stringify(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url).href));
  source=source.replace("import {createRetainedCards} from './retained-cards.js';",'const createRetainedCards=()=>({begin(){},card(_id,_signature,build){return build();},end(){},dispose(){}});');
  source=source.replace(/import .* from '.\/panel-io.js';/,'const subscribeJsonFile=()=>()=>{},readJsonSnapshot=async()=>({status:"missing",hash:null}),FILE_CHANGED_COMMAND="file-feed-changed",fileDelivery=()=>({enqueue:(callback,value)=>callback(value),flush(){}});')
    .replace(/import .* from '.\/sidebar-files.js';/,'const watchSidebarFiles=()=>{};')
    .replace("'./live-events.js'",JSON.stringify(new URL('../mods/sixfold-desk/live-events.js',import.meta.url).href));
  source=source.replace(/import \{ View, div, svg, image \} from 'gpui-kit';/,'const {View,div,svg,image}=globalThis.__shortcutRuntime;')
    .replace(/import \{ h_flex, v_flex \} from 'gpui-base';/,'const {h_flex,v_flex}=globalThis.__shortcutRuntime;')
    .replace(/import \* as herdrNative from 'herdr';/,'const herdrNative=globalThis.__shortcutRuntime;')
    .replace(/import \{([^}]+)\} from 'herdr';/,'const {$1}=globalThis.__shortcutRuntime;')
    .replace(/import \{[^}]*\} from '.\/docs.js';/,'const watchDocs=()=>{},currentDocs=()=>null,docsSection=()=>null,prepareDocsInput=()=>{};')
    .replace(/import \{ watchAlerts[^}]*\} from '.\/alerts.js';/,'const watchAlerts=()=>{},alertSection=()=>null,visibleAlerts=()=>[];')
    .replace(/import \{ watchBadges[^}]*\} from '.\/badges.js';/,'const watchBadges=()=>{},workspaceBadges=()=>null;').replace(/import \{ watchAsks[^}]*\} from '.\/asks.js';/,'const watchAsks=()=>{},askSection=()=>null,hasAsks=()=>false;').replace(/import \{ askFor \} from '.\/ask-model.js';/,'const askFor=()=>null;').replace(/import \{ watchReports[^}]*\} from '.\/session-reports.js';/,'const watchReports=()=>{},reportsSection=()=>null;')
    .replace(/import .* from '.\/alert-inbox.js';/,'const workspaceAlertsRow=()=>null,hasWorkspaceAlerts=()=>false,openInbox=()=>{};').replace(/import .* from '.\/alert-arrivals.js';/,"const startAlertArrivals=()=>()=>{},alertArrivalLayer=()=>[],alertCardSignature=()=>'';")
    .replace(/import \{ panePet \} from '.\/pets.js';/,'const panePet=()=>null;')
    .replace(/import \{ paneUsage \} from '.\/session-usage.js';/,'const paneUsage=()=>null;')
    .replace(/import \{ paneMeta[^}]*\} from '.\/pane-meta.js';/,'const paneMeta=()=>null,paneMetaChip=()=>null,showPaneIndex=()=>false,showTitle=()=>true;')
    .replace(/import \{ breathingBorder[^}]*\} from '.\/collab-flow-view.js';/,'const breathingBorder=()=>null,borderComet=()=>null;')
    .replace(/import \{ pipeline \} from [^;]+;/,'const pipeline=()=>null;');
  for(const name of ['model','flow','workflow','sidebar-identity','collab','collab-flow'])source=source.replace(`'./${name}.js'`,JSON.stringify(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url).href));
  try{
    const {default:Sidebar}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
    const view=new Sidebar();
    const cx={notify(){},timer:{every(){},after(){}},spawn:fn=>{Promise.resolve().then(()=>fn(cx)).catch(()=>{});}};
    view.init({},cx);
    const send=async command=>{ if(waiting){const resolve=waiting;waiting=null;resolve(command);} else queue.push(command); await new Promise(r=>setTimeout(r,5)); };
    await new Promise(r=>setTimeout(r,5));
    calls.length=0;
    await send('computer-2');
    assert.equal(state['sixfold.computing.selected'],'remote:worker');
    await send('computer-1');
    assert.equal(state['sixfold.computing.selected'],'local');
    // The disconnected machine is the last slot; a Tailscale peer never owns one.
    view.computers={tailscale:true};view.tailscalePeers=[{name:'peer',online:true}];
    await send('computer-3');
    assert.equal(state['sixfold.computing.selected'],'remote:offline');
    for(const missing of ['computer-4','computer-9']){
      await send(missing);
      assert.equal(state['sixfold.computing.selected'],'remote:offline',`${missing} is a no-op`);
    }
    assert.deepEqual(calls,[],'no Share on those computers: list only, nothing runs');
    assert.deepEqual(focus,{space:'home-a',tab:'ha',pane:'p1',terminal:'t1'});
    // With a Share on that computer, the shortcut also shows that space and focuses its pane.
    spaces.push({id:'w/share',machine:'worker',name:'Share',tabs:[{id:'wt',active:true}]});
    await send('computer-2');
    assert.equal(state['sixfold.computing.selected'],'remote:worker');
    assert.deepEqual(calls,[{command:'space.select',args:{id:'w/share'}},{command:'pane.focus',args:{pane:'wp1'}}]);
    calls.length=0;
    // Already inside that Share: nothing moves.
    focus.space='w/share';
    await send('computer-2');
    assert.deepEqual(calls,[]);
    focus.space='home-a';calls.length=0;
    // Existing numbered commands still work next to the new ones.
    await send('pane-1');
    assert.deepEqual(calls,[{command:'pane.focus',args:{pane:'p1'}}]);
    // Newly registered machines take the next slot, in list order.
    machines=[...machines,{name:'newer',layout:'ready'}];
    await send('computer-3');
    assert.equal(state['sixfold.computing.selected'],'remote:newer');
  }finally{delete globalThis.__shortcutRuntime;}
});
