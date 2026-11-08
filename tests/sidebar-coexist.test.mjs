import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {makePanelLoadFixture} from './panel-fixtures.mjs';

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
const flatten=node=>node?.nodes?[node,...node.nodes.flatMap(flatten)]:[];

test('native computer navigator, task rows, documents, badges and local questions coexist',async()=>{
  const raw=makePanelLoadFixture({spaces:2,agentsPerSpace:2,now:Date.now()}),local=raw.spaces[0],remote=raw.spaces[1];
  local.nav={space_id:'sp-local',machine:null};remote.nav={space_id:'sp-remote',machine:'worker'};
  const native=[{id:'sp-local',name:'Demo',machine:null,active:true,tabs:[{id:'tab-local',name:'Local'}]},
    {id:'worker/sp-remote',name:'Demo',machine:'worker',active:false,tabs:[{id:'tab-remote',name:'Remote'}]}];
  const store=new Map([['sixfold.panel.enabled',true],['sixfold.motion',false],['sixfold.workspace.badges',{'|sp-local':[{id:'memo',text:'Memory',tone:'accent'}]}]]);
  const theme={background:'#101318',chrome:'#14191f',surface:'#1b232d',border:'#39434f',selected:'#253249',foreground:'#e5edf5',muted:'#a6b0bf',dim:'#788594',accent:'#a9b8ff',ansi6:'#68c9bc',blocked:'#edac67',hover:'#253249',ansi5:'#bca0ff',ansi3:'#e7c988',ansi2:'#8cc38c',ansi4:'#8cb5e8'};
  const path=()=>new Proxy({},{get:(_t,key)=>key==='build'?()=>[]:()=>path()});
  globalThis.__sidebarCoexist={View:class{},div:element,svg:element,image:element,h_flex:element,v_flex:element,
    PathBuilder:{stroke:path},Input:{new:element},InputState:{new:()=>({on(){},value(){return '';}})},Popover:{new:element},
    props:()=>({role:'sidebar'}),theme:()=>theme,window:()=>({platform:'windows',visible:true}),layout:()=>({}),settings:()=>({zoom:1}),
    shared:key=>store.get(key),setShared:(key,value)=>store.set(key,value),spaces:()=>native,panes:()=>[],agents:()=>[],terminals:()=>[],
    focused:()=>({space:'sp-local',tab:'tab-local'}),machines:()=>[{name:null,layout:'ready'},{name:'worker',layout:'ready'}],
    run(){},setAgentOrder(){},appHome:()=>'/demo'};
  globalThis.window={paint_path:element};
  const modules=new Map();
  async function load(name){
    if(modules.has(name))return modules.get(name);
    let source=await readFile(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url),'utf8');
    source=source.replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base|herdr)';/g,'const {$1}=globalThis.__sidebarCoexist;')
      .replace(/import \* as (\w+) from 'herdr';/g,'const $1=globalThis.__sidebarCoexist;');
    for(const match of [...source.matchAll(/from '(\.\/([^']+)\.js)'/g)])source=source.replaceAll(`'${match[1]}'`,JSON.stringify(await load(match[2])));
    const url=`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;modules.set(name,url);return url;
  }
  const {default:Desk}=await import(await load('main'));
  const {createRetainedPanel}=await import(await load('panel-retained'));
  const {cleanPanelFeed}=await import(await load('panel-model'));
  const entities=[],cx={notify(){},timer:{after(){return {cancel(){}};}},
    new(Class,props){const view=new Class();view.init?.(props,cx);const entity={view,release(){}};entities.push(entity);return entity;}};
  const c=createRetainedPanel(cx,{embedded:true});c.apply(cleanPanelFeed(raw),'ready');
  const desk=new Desk();Object.assign(desk,{panelRetained:c,panelTrackingActive:true,panelState:{feed:c.feed},computers:{local:{label:'Local'},machines:{worker:{label:'Worker'}}},
    site:{},messageEvents:[],workflowNodes:[],workflowEvents:[],activeFlows:[],pendingFlows:[],queuedRoutes:[],expandedAgents:new Set(),readMessages:{},
    workspaceIcons:{},workspacePins:{spaces:[]},docsSpaces:new Set(),docsHeights:{},alerts:[],
    asks:[{id:'demo-question',revision:'r1',kind:'permission',title:'Demo question',actions:[{id:'cancel',label:'Cancel'}]}],
    askChoices:{},askBusy:{},askErrors:{},sessionReports:[]});
  const ids=tree=>flatten(tree).flatMap(node=>node.calls.filter(call=>call[0]==='id').map(call=>call[1]));
  const localTree=desk.render(cx),localIds=ids(localTree);
  assert(localIds.includes('sf-computer-local'));assert(localIds.includes('sf-computer-remote:worker'));
  assert(localIds.includes('sf-docs-toggle-sp-local'));assert(!localIds.includes('sf-docs-toggle-worker/sp-remote'));
  assert(localIds.includes('sf-badge-sp-local-memo'));assert(localIds.includes('sf-settings'));assert(localIds.includes('sf-new-space'));
  assert(localIds.includes('sf-space-extras-sp-local'),'workspace badges have their own row instead of taking the title width');
  assert(localIds.includes('sf-asks'));assert(localIds.includes('sf-ask-demo-question-action-0'));
  assert(flatten(localTree).some(node=>node.nodes.includes(c.bodyFor(native[0]))),'retained tasks are inside the native workspace card');
  const card=tree=>flatten(tree).find(node=>node.calls.some(call=>call[0]==='id'&&call[1]==='sf-space-sp-local'));
  assert.equal(card(localTree).calls.find(call=>call[0]==='mr')[1],41,'original native card margin is preserved');
  const sized=localTree.calls.find(call=>call[0]==='on_size_change')[1];sized({width:432},cx);
  const gutterTree=desk.render(cx),gutter=flatten(gutterTree).find(node=>node.calls.some(call=>call[0]==='id'&&call[1]==='sf-message-gutter'));
  assert(gutter);assert.equal(gutter.calls.find(call=>call[0]==='w')[1],120);
  assert.equal(card(gutterTree).calls.find(call=>call[0]==='mr')[1],161);
  assert.equal(c.panelWidth,312,'the message gap never consumes native card content width');
  desk.computerFollow={follow:false};store.set('sixfold.computing.selected','remote:worker');
  const remoteTree=desk.render(cx),remoteIds=ids(remoteTree);
  assert(remoteIds.includes('sf-docs-toggle-worker/sp-remote'));assert(!remoteIds.includes('sf-docs-toggle-sp-local'));
  assert(flatten(remoteTree).some(node=>node.nodes.includes(c.bodyFor(native[1]))));
  c.resize(224,cx);
  const agent=c.feed.spaces[0].agents[0],row=entities.find(entity=>entity.view.id===agent.id);
  assert(ids(row.view.render()).includes(`panel-stacked-${agent.id}`),'narrow native cards put the stage below the one-line title');
  c.resize(280,cx);
  assert(!ids(row.view.render()).includes(`panel-stacked-${agent.id}`),'wide cards restore the inline stage');
  c.dispose();delete globalThis.__sidebarCoexist;
});
