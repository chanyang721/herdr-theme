import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {makePanelLoadFixture} from './panel-fixtures.mjs';

// The real sidebar render: requests from two panes of one space share that space's tab.
const element=()=>{
  let proxy;const data={nodes:[],calls:[]};
  proxy=new Proxy(data,{get(target,key){
    if(key==='then')return undefined;if(key in target)return target[key];
    if(key==='child')return value=>{if(value!=null)data.nodes.push(value);return proxy;};
    if(key==='children')return values=>{data.nodes.push(...values.filter(Boolean));return proxy;};
    if(key==='trigger')return value=>{if(value!=null)data.nodes.push(value);return proxy;};
    if(key==='when')return (condition,fn)=>{if(condition)fn(proxy);return proxy;};
    return (...args)=>{data.calls.push([key,...args]);return proxy;};
  }});return proxy;
};
const flatten=node=>node?.nodes?[node,...node.nodes.flatMap(flatten)]:[];
const byId=(tree,id)=>flatten(tree).find(node=>node.calls.some(call=>call[0]==='id'&&call[1]===id));

test('a space tab opens each asking pane in turn; requests it cannot open stay in 확인 대기',async()=>{
  const raw=makePanelLoadFixture({spaces:2,agentsPerSpace:2,now:Date.now()}),local=raw.spaces[0],other=raw.spaces[1];
  local.nav={space_id:'sp-local',machine:null};other.nav={space_id:'sp-other',machine:null};
  raw.asks=[{id:'req-a',revision:'r1',kind:'permission',title:'Run A',space:local.id,agent:local.agents[0].id},
    {id:'req-b',revision:'r1',kind:'question',title:'Answer B',space:local.id,agent:local.agents[1].id},
    {id:'req-gone',revision:'r1',kind:'plan',title:'No card',space:local.id,agent:null}];
  const native=[{id:'sp-local',name:'Demo',machine:null,active:true,tabs:[{id:'tab-local',name:'Local'}]},
    {id:'sp-other',name:'Other',machine:null,active:false,tabs:[{id:'tab-other',name:'Other'}]}];
  const store=new Map([['sixfold.panel.enabled',true],['sixfold.motion',false]]),overlays=[];
  const theme={background:'#101318',chrome:'#14191f',surface:'#1b232d',border:'#39434f',selected:'#253249',foreground:'#e5edf5',muted:'#a6b0bf',dim:'#788594',accent:'#a9b8ff',ansi6:'#68c9bc',blocked:'#edac67',hover:'#253249',ansi5:'#bca0ff',ansi3:'#e7c988',ansi2:'#8cc38c',ansi4:'#8cb5e8'};
  const path=()=>new Proxy({},{get:(_t,key)=>key==='build'?()=>[]:()=>path()});
  globalThis.__spaceAskTab={View:class{},div:element,svg:element,image:element,h_flex:element,v_flex:element,
    PathBuilder:{stroke:path},Input:{new:element},InputState:{new:()=>({on(){},value(){return '';}})},Popover:{new:element},
    props:()=>({role:'sidebar'}),theme:()=>theme,window:()=>({platform:'windows',visible:true}),layout:()=>({}),settings:()=>({zoom:1}),
    shared:key=>store.get(key),setShared:(key,value)=>store.set(key,value),spaces:()=>native,panes:()=>[],agents:()=>[],terminals:()=>[],
    focused:()=>({space:'sp-local',tab:'tab-local'}),machines:()=>[{name:null,layout:'ready'}],
    openOverlay:spec=>{overlays.push(spec);return 'overlay';},closeOverlay(){},
    run(){},setAgentOrder(){},appHome:()=>'/demo'};
  const previousWindow=globalThis.window;globalThis.window={paint_path:element};
  const modules=new Map();
  async function load(name){
    if(modules.has(name))return modules.get(name);
    let source=await readFile(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url),'utf8');
    source=source.replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base|herdr)';/g,'const {$1}=globalThis.__spaceAskTab;')
      .replace(/import \* as (\w+) from 'herdr';/g,'const $1=globalThis.__spaceAskTab;');
    for(const match of [...source.matchAll(/from '(\.\/([^']+)\.js)'/g)])source=source.replaceAll(`'${match[1]}'`,JSON.stringify(await load(match[2])));
    const url=`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;modules.set(name,url);return url;
  }
  let c;
  try{
    const {default:Desk}=await import(await load('main'));
    const {createRetainedPanel}=await import(await load('panel-retained'));
    const {cleanPanelFeed}=await import(await load('panel-model'));
    const cx={notify(){},timer:{after(){return {cancel(){}};}},new(Class,props){const view=new Class();view.init?.(props,cx);return {view,release(){}};}};
    c=createRetainedPanel(cx,{embedded:true});c.apply(cleanPanelFeed(raw),'ready');
    const card=(id,terminal,title)=>({id,revision:'r1',kind:'permission',title,terminal,actions:[{id:'cancel',label:'Cancel'}]});
    const desk=new Desk();Object.assign(desk,{panelRetained:c,panelTrackingActive:true,panelState:{feed:c.feed},computers:{local:{label:'Local'},machines:{}},
      site:{},messageEvents:[],workflowNodes:[],workflowEvents:[],activeFlows:[],pendingFlows:[],sidebarNotices:[],expandedAgents:new Set(),readMessages:{},
      workspaceIcons:{},workspacePins:{spaces:[]},docsSpaces:new Set(),docsHeights:{},alerts:[],boxSizes:{'sp-local':{w:265,h:90},'sp-other':{w:265,h:90}},
      asks:[card('req-a','term-a','Run A'),card('req-b','term-b','Answer B'),card('req-free','term-c','Unplaced')],
      askChoices:{},askBusy:{},askErrors:{},sessionReports:[]});
    const tree=desk.render(cx),tab=byId(tree,`sf-space-ask-${local.id}`);
    assert(tab,'the asking space has its tab');
    assert(!byId(tree,`sf-space-ask-${other.id}`),'a space that did not ask has none');
    assert(tab.calls.find(call=>call[0]==='tooltip')[1].includes('2개 페인'),'the tab says it holds two panes');
    const press=()=>desk.render(cx)&&byId(desk.render(cx),`sf-space-ask-${local.id}`).calls.find(call=>call[0]==='on_click')[1](null,{stop_propagation(){}});
    press();press();press();
    assert.deepEqual(overlays.map(spec=>spec.props.terminal),['term-a','term-b','term-a'],'each press opens the next pane; req-b is reachable');
    // The bottom list keeps only what no tab can open (another space's request).
    const words=JSON.stringify(flatten(byId(tree,'sf-asks')).flatMap(node=>node.calls.flat().filter(v=>typeof v==='string')));
    assert(byId(tree,'sf-asks'),'an unplaced request keeps the 확인 대기 list');
    assert(!flatten(byId(tree,'sf-asks')).some(node=>node.calls.some(call=>call[0]==='id'&&/req-(a|b)/.test(String(call[1])))),'tab requests leave the list');
    assert(byId(tree,'sf-ask-group-0'),words);assert(!byId(tree,'sf-ask-group-1'),'only the one unplaced pane is listed');
  }finally{
    c?.dispose();delete globalThis.__spaceAskTab;
    if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;
  }
});
