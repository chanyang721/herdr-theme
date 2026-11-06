import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {makePanelMatrix,makePanelFixture,PANEL_IDS,eventSequence} from './panel-fixtures.mjs';
import {cleanPanelFeed} from '../mods/sixfold-desk/panel-model.js';

function node(kind='div',value=null){
  const data={kind,value,nodes:[],calls:[]};let proxy;
  proxy=new Proxy(data,{get(target,key){
    if(key==='then')return undefined;
    if(key in target)return target[key];
    if(key==='child')return child=>{if(child!==null&&child!==undefined)data.nodes.push(child);return proxy;};
    if(key==='children')return children=>{data.nodes.push(...children.filter(x=>x!==null&&x!==undefined));return proxy;};
    if(key==='when')return (condition,fn)=>{if(condition)fn(proxy);return proxy;};
    return (...args)=>{data.calls.push([key,...args]);return proxy;};
  }});return proxy;
}
const all=tree=>[tree,...(tree.nodes||[]).flatMap(n=>typeof n==='object'?all(n):[])];
const call=(tree,name)=>tree.calls?.find(c=>c[0]===name);
const byId=(tree,id)=>all(tree).find(n=>call(n,'id')?.[1]===id);
const words=tree=>all(tree).flatMap(n=>n.nodes?.filter(x=>typeof x==='string')||[]);
const t={background:'#101318',chrome:'#14191f',surface:'#1b232d',border:'#39434f',selected:'#253249',foreground:'#e5edf5',muted:'#a6b0bf',dim:'#788594',accent:'#a9b8ff',ansi6:'#68c9bc',ansi4:'#8caaf8',blocked:'#edac67',hover:'#253249'};
let serial=0;
async function renderer(motion=true,{nativeSpaces=[],nativePanes=[]}={}){
  const store=new Map([['sixfold.motion',motion]]),commands=[],paths=[];
  const path=()=>new Proxy({},{get:(_target,key)=>key==='build'?()=>[]:()=>path()});
  globalThis.__panelView={div:()=>node(),svg:value=>node('svg',value),h_flex:()=>node('row'),v_flex:()=>node('column'),
    PathBuilder:{stroke:()=>path()},spaces:()=>nativeSpaces,panes:()=>nativePanes,settings:()=>({zoom:1}),shared:key=>store.get(key),setShared:(k,v)=>store.set(k,v),run:(...args)=>commands.push(args)};
  globalThis.window={paint_path:(...args)=>{paths.push(args);return node('path');}};
  let source=await readFile(new URL('../mods/sixfold-desk/panel-view.js',import.meta.url),'utf8');
  source=source.replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base|herdr)';/g,'const {$1}=globalThis.__panelView;');
  for(const name of ['panel-model','collab-flow'])source=source.replace(`'./${name}.js'`,JSON.stringify(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url).href));
  const mod=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${serial++}`);
  const timers=[],cx={notify(){},timer:{after:(ms,fn)=>{timers.push({ms,fn});return {cancel(){}};}}};
  return {...mod,cx,timers,commands,paths,store};
}
const viewFor=feed=>({panelState:{feed:cleanPanelFeed(feed),status:'ready'},panelEvents:null,panelReducedMotion:false});

test('all 18 fixture combinations pass the actual view builder, with one-line rows and no addresses',async()=>{
  const r=await renderer(false);
  for(const item of makePanelMatrix(Date.now())){
    const feed=item.feed||item,view=viewFor(feed),tree=r.renderPanelTracking(view,t,r.cx);
    const model=view.panelState.feed,layout=r.panelLayout(model,view.panelEvents);
    assert.equal(layout.cards.length,model.spaces.length);
    for(const space of model.spaces){
      assert(byId(tree,`panel-space-${space.id}`));
      for(const agent of space.agents){
        const row=byId(tree,`panel-agent-${agent.id}`);assert(row);assert.equal(call(row,'h')[1],28);
        assert(words(row).includes(agent.title));
      }
    }
    assert(!words(tree).some(text=>/\bt\d+\b|조정 중|구현 중/.test(text)));
    assert.equal(all(tree).filter(n=>call(n,'loop')).length,0);
    assert.equal(r.commands.length,0,'rendering never changes real focus');
  }
});

test('message paths have a finite native transition and a stationary task title',async()=>{
  const r=await renderer(true),view=viewFor(makePanelFixture());
  const before=r.renderPanelTracking(view,t,r.cx);
  const step=eventSequence.find(x=>x.name==='dispatch-existing');assert(step);
  view.panelState.feed=cleanPanelFeed(step.apply(view.panelState.feed,Date.now()));
  const after=r.renderPanelTracking(view,t,r.cx);
  assert(r.paths.length>0);assert(r.timers.some(timer=>timer.ms>0&&timer.ms<=40));
  const titles=view.panelState.feed.spaces.flatMap(s=>s.agents.map(a=>a.title));
  for(const title of titles){assert(words(before).includes(title));assert(words(after).includes(title));}
  const packet=all(after).find(n=>call(n,'id')?.[1]?.startsWith('panel-packet-'));
  assert(packet);assert.equal(call(packet,'size')[1],4);
  assert(packet.calls.some(c=>c[0]==='transition'&&c[1]==='top'));
  assert(packet.calls.some(c=>c[0]==='transition'&&c[1]==='left'));
});

test('system reduced motion removes every loop and moving packet, retaining labels and counts',async()=>{
  const r=await renderer(true),view=viewFor(makePanelFixture({share:'space'}));view.panelReducedMotion=true;
  r.renderPanelTracking(view,t,r.cx);
  view.panelState.feed=cleanPanelFeed(eventSequence.find(x=>x.name==='dispatch-existing').apply(view.panelState.feed,Date.now()));
  const tree=r.renderPanelTracking(view,t,r.cx);
  assert.equal(all(tree).filter(n=>call(n,'loop')||call(n,'transition')).length,0);
  assert(words(tree).includes('Motion off'));assert(view.panelEvents.tags.size>0);
});

test('card row geometry includes borders, issue headings and the hidden-row remainder',async()=>{
  const r=await renderer(false),view=viewFor(makePanelFixture({share:'agent',tool:'linear'}));
  r.renderPanelTracking(view,t,r.cx);const layout=r.panelLayout(view.panelState.feed,view.panelEvents);
  for(const card of layout.cards){
    for(const row of card.rows.filter(row=>row.kind==='agent')){
      assert.equal(layout.anchors.get(row.agent.id).y,row.y+14);
      assert(row.y>card.top+32+24);assert(row.y+28<card.top+card.height);
    }
  }
});

test('default 224px sidebar reserves space name and compact controls; wide panels retain full labels',async()=>{
  const r=await renderer(false),view=viewFor(makePanelFixture({share:'space',tool:'linear',slack:true}));
  view.panelWidth=224;const compact=r.renderPanelTracking(view,t,r.cx);
  assert(all(compact).some(n=>call(n,'w')?.[1]===64&&call(n,'h')?.[1]===18));
  assert(all(compact).some(n=>n.calls?.some(c=>c[0]==='min_w'&&c[1]===28)));
  view.panelState.feed.spaces[0].memory.proposals=9999;
  const many=r.renderPanelTracking(view,t,r.cx);
  const memory=byId(many,`panel-memory-${view.panelState.feed.spaces[0].id}`);
  assert.equal(call(memory,'w')[1],32);assert(words(memory).includes('◈ 9999'));
  view.panelWidth=540;const wide=r.renderPanelTracking(view,t,r.cx);
  assert(all(wide).some(n=>call(n,'w')?.[1]===82&&call(n,'h')?.[1]===18));
});

test('workspace navigation remains explicitly available without resolving opaque feed IDs',async()=>{
  const r=await renderer(false),tree=r.renderPanelTracking(viewFor(makePanelFixture()),t,r.cx);
  const button=byId(tree,'panel-workspaces');assert(button);
  call(button,'on_click')[1]();
  assert.equal(r.store.get('sixfold.panel.enabled'),false);
  assert.equal(r.commands.length,0,'changing the view cannot guess a workspace or terminal');
});

test('only explicit current native pane navigation can focus an agent, including remote machine qualification',async()=>{
  const nativePanes=[{pane:'worker/p7',tab:'worker/tb2'}],r=await renderer(false,{nativePanes});
  const agent={nav:{pane_id:'p7',machine:'worker'},closing:null};
  assert.equal(r.navigatePanelAgent(agent),true);
  assert.deepEqual(r.commands,[['pane.focus',{pane:'worker/p7'}]]);
  nativePanes.length=0;assert.equal(r.navigatePanelAgent(agent),false);
  assert.equal(r.navigatePanelAgent({...agent,closing:{step:4}}),false);
  assert.equal(r.navigatePanelAgent({nav:null}),false);
  assert.equal(r.commands.length,1);
});
