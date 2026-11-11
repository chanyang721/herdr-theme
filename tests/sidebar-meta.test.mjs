import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {makePanelFixture,makePanelLoadFixture} from './panel-fixtures.mjs';

const element=()=>{
  let proxy;const data={nodes:[],calls:[]};
  proxy=new Proxy(data,{get(target,key){
    if(key==='then')return undefined;if(key in target)return target[key];
    if(key==='child')return value=>{if(value!=null)data.nodes.push(value);return proxy;};
    if(key==='children')return values=>{data.nodes.push(...values.filter(Boolean));return proxy;};
    if(key==='when')return (condition,fn)=>{if(condition)fn(proxy);return proxy;};
    return (...args)=>{data.calls.push([key,...args]);return proxy;};
  }});return proxy;
};
// Children, plus elements handed to a method (a popover's trigger).
const flatten=node=>node?.nodes?[node,...node.nodes.flatMap(flatten),...node.calls.flatMap(call=>call.slice(1).filter(arg=>arg?.nodes).flatMap(flatten))]:[];
const ids=tree=>flatten(tree).flatMap(node=>node.calls.filter(call=>call[0]==='id').map(call=>call[1]));
const texts=tree=>flatten(tree).flatMap(node=>node.nodes.filter(value=>typeof value==='string'));
const theme={background:'#101318',chrome:'#14191f',surface:'#1b232d',border:'#39434f',selected:'#253249',foreground:'#e5edf5',muted:'#a6b0bf',dim:'#788594',accent:'#a9b8ff',ansi6:'#68c9bc',blocked:'#edac67',hover:'#253249',ansi5:'#bca0ff',ansi3:'#e7c988',ansi2:'#8cc38c',ansi4:'#8cb5e8'};

// Real modules (main, panel-retained, sidebar-meta, badges…) with only the host API stubbed.
let runs=0;
async function sidebar({native,feed,badges={},pins=[]}){
  const run=++runs;   // fresh module instances per case: each binds its own host stubs
  const store=new Map([['sixfold.panel.enabled',true],['sixfold.motion',false],['sixfold.workspace.badges',badges]]);
  const path=()=>new Proxy({},{get:(_t,key)=>key==='build'?()=>[]:()=>path()});
  globalThis.__sidebarMeta={View:class{},div:element,svg:element,image:element,h_flex:element,v_flex:element,
    PathBuilder:{stroke:path},Input:{new:element},InputState:{new:()=>({on(){},value(){return '';}})},Popover:{new:element},
    props:()=>({role:'sidebar'}),theme:()=>theme,window:()=>({platform:'windows',visible:true}),layout:()=>({}),settings:()=>({zoom:1}),
    shared:key=>store.get(key),setShared:(key,value)=>store.set(key,value),spaces:()=>native,panes:()=>[],agents:()=>[],terminals:()=>[],
    focused:()=>({space:native[0].id,tab:native[0].tabs[0].id}),machines:()=>[{name:null,layout:'ready'}],
    run(){},setAgentOrder(){},appHome:()=>'/demo'};
  globalThis.window={paint_path:element};
  const modules=new Map();
  async function load(name){
    if(modules.has(name))return modules.get(name);
    let source=await readFile(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url),'utf8');
    source=source.replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base|herdr)';/g,'const {$1}=globalThis.__sidebarMeta;')
      .replace(/import \* as (\w+) from 'herdr';/g,'const $1=globalThis.__sidebarMeta;');
    for(const match of [...source.matchAll(/from '(\.\/([^']+)\.js)'/g)])source=source.replaceAll(`'${match[1]}'`,JSON.stringify(await load(match[2])));
    source+=`\n// case ${run}`;
    const url=`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;modules.set(name,url);return url;
  }
  const {default:Desk}=await import(await load('main'));
  const {createRetainedPanel}=await import(await load('panel-retained'));
  const {cleanPanelFeed}=await import(await load('panel-model'));
  const meta=await import(await load('sidebar-meta'));
  const notified=[],entities=[],cx={notify(entity){notified.push(entity);},timer:{after(){return {cancel(){}};}},
    new(Class,props){const view=new Class();view.init?.(props,cx);const entity={view,release(){}};entities.push(entity);return entity;}};
  const desk=new Desk();
  const c=createRetainedPanel(cx,{embedded:true,cardBadges:meta.metaBadges(desk)});c.apply(cleanPanelFeed(feed),'ready');
  Object.assign(desk,{panelRetained:c,panelTrackingActive:true,panelState:{feed:c.feed},computers:{local:{label:'Local'},machines:{}},
    site:{},messageEvents:[],workflowNodes:[],workflowEvents:[],activeFlows:[],pendingFlows:[],queuedRoutes:[],expandedAgents:new Set(),readMessages:{},
    workspaceIcons:{},workspacePins:{spaces:pins},docsSpaces:new Set(),docsHeights:{},alerts:[],asks:[],askChoices:{},askBusy:{},askErrors:{},sessionReports:[]});
  const body=id=>entities.find(entity=>entity.view.id===id&&entity.view.constructor.name==='PanelSpace');
  return {desk,c,cx,store,notified,body,meta,render:()=>desk.render(cx),done(){c.dispose();delete globalThis.__sidebarMeta;}};
}
const card=(tree,id)=>flatten(tree).find(node=>node.calls.some(call=>call[0]==='id'&&call[1]===`sf-space-${id}`));
const nativeSpace=(id,name)=>({id,name,machine:null,active:false,tabs:[{id:`tab-${id}`,name:'1'}]});

test('space cards show pinned, then working, then the rest, each in native order',async()=>{
  const raw=makePanelLoadFixture({spaces:3,agentsPerSpace:1,status:'idle'});
  const [a,b,p]=raw.spaces;
  a.nav={space_id:'sp-a',machine:null};b.nav={space_id:'sp-b',machine:null};p.nav={space_id:'sp-p',machine:null};
  b.agents[0].status='working';
  const native=[nativeSpace('sp-a','Alpha'),nativeSpace('sp-b','Beta'),nativeSpace('sp-p','Pinned')];
  const s=await sidebar({native,feed:raw,pins:[{id:'sp-p',machine:null}]});
  const order=tree=>ids(tree).filter(id=>/^sf-space-sp-[abp]$/.test(id));
  assert.deepEqual(order(s.render()),['sf-space-sp-p','sf-space-sp-b','sf-space-sp-a']);
  // A working agent that is being closed does not count as working.
  b.agents[0].closing={step:2};s.c.apply((await import('../mods/sixfold-desk/panel-model.js')).cleanPanelFeed(raw),'ready');
  assert.deepEqual(order(s.render()),['sf-space-sp-p','sf-space-sp-a','sf-space-sp-b'],'native order again once nothing works');
  s.done();
});

test('order helper is stable and display only',async()=>{
  const {orderWorkspaceGroups}=await import('../mods/sixfold-desk/workspace-order.js');
  const groups=['a','b','c','d','e'].map(id=>({s:{id},members:[]}));
  const working=new Set(['b','d']),pinned=new Set(['e']);
  assert.deepEqual(orderWorkspaceGroups(groups,s=>pinned.has(s.id),g=>working.has(g.s.id)).map(g=>g.s.id),['e','b','d','a','c']);
  assert.deepEqual(groups.map(g=>g.s.id),['a','b','c','d','e'],'the input order is untouched');
});

test('a state badge joins the Slack · Linear meta line; no badge row, no empty alert child',async()=>{
  const raw=makePanelFixture({tool:'linear',slack:true,nav:{space_id:'sp-local',machine:null}});
  const id=raw.spaces[0].id;
  const s=await sidebar({native:[nativeSpace('sp-local','Demo workspace')],feed:raw,
    badges:{'|sp-local':[{id:'harness-memory',text:'! 6',tone:'blocked',tooltip:'기억 · 막힘·확인 대기 6건'}]}});
  const tree=s.render(),own=card(tree,'sp-local')
  assert(!ids(tree).includes('sf-space-extras-sp-local'),'no separate badge row');
  assert(!ids(tree).some(x=>x.startsWith('sf-channel-alerts')),'no alerts row without alerts');
  assert(own.nodes.every(node=>!node.calls||node.calls.length||node.nodes.length),'no empty child adds a 2px gap');
  const bodyTree=s.body(id).view.render();
  assert(ids(bodyTree).includes('sf-badge-sp-local-harness-memory'),'the badge is on the task meta line');
  assert(texts(bodyTree).includes('확인 대기 6'),"'! 6' says what it means");
  assert(ids(bodyTree).includes(`panel-tool-${id}`)&&ids(bodyTree).includes(`panel-slack-${id}`),'Slack and Linear stay on the same line');
  // A badge change redraws only that task card.
  s.notified.length=0;
  s.store.set('sixfold.workspace.badges',{'|sp-local':[{id:'harness-memory',text:'! 2',tone:'blocked'}]});
  s.c.alertsChanged();
  assert.deepEqual(s.notified,[s.body(id)],'the card with the badge redraws');
  assert(texts(s.body(id).view.render()).includes('확인 대기 2'));
  s.notified.length=0;s.c.alertsChanged();
  assert.equal(s.notified.length,0,'nothing redraws when nothing changed');
  s.done();
});

test("a launcher-only badge sits in the header; a card without a meta line keeps its badge row",async()=>{
  const raw=makePanelFixture({tool:'linear',slack:true,nav:{space_id:'sp-local',machine:null}});
  const s=await sidebar({native:[nativeSpace('sp-local','Demo workspace')],feed:raw,badges:{'|sp-local':[{id:'harness-memory',text:'기억',tone:'dim'}]}});
  const tree=s.render(),header=card(tree,'sp-local').nodes[0];
  assert(ids(header).includes('sf-badge-sp-local-harness-memory'),'the launcher is in the header');
  assert(!ids(tree).includes('sf-space-extras-sp-local'));
  assert(!ids(s.body(raw.spaces[0].id).view.render()).includes('sf-badge-sp-local-harness-memory'));
  s.done();
  const plain=makePanelFixture({nav:{space_id:'sp-local',machine:null}});
  const p=await sidebar({native:[nativeSpace('sp-local','Demo workspace')],feed:plain,badges:{'|sp-local':[{id:'harness-memory',text:'! 1',tone:'blocked'}]}});
  assert(ids(p.render()).includes('sf-space-extras-sp-local'),'no meta line: the badge keeps a row');
  p.done();
});
