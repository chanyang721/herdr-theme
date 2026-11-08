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
  const path=(steps=[])=>new Proxy({},{get:(_target,key)=>key==='build'?()=>steps:(...args)=>{steps.push([key,...args]);return path(steps);}});
  globalThis.__panelView={div:()=>node(),svg:value=>node('svg',value),image:value=>node('image',value),h_flex:()=>node('row'),v_flex:()=>node('column'),
    PathBuilder:{stroke:()=>path()},spaces:()=>nativeSpaces,panes:()=>nativePanes,settings:()=>({zoom:1}),shared:key=>store.get(key),setShared:(k,v)=>store.set(k,v),run:(...args)=>commands.push(args)};
  globalThis.window={paint_path:(...args)=>{paths.push(args);return node('path',args[0]);}};
  let source=await readFile(new URL('../mods/sixfold-desk/panel-view.js',import.meta.url),'utf8');
  source=source.replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base|herdr)';/g,'const {$1}=globalThis.__panelView;');
  for(const name of ['panel-model','collab-flow','panel-host'])source=source.replace(`'./${name}.js'`,JSON.stringify(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url).href));
  const details=(await readFile(new URL('../mods/sixfold-desk/task-row-details.js',import.meta.url),'utf8'))
    .replace(/import \{([^}]+)\} from 'gpui-kit';/,'const {$1}=globalThis.__panelView;');
  source=source.replace("'./task-row-details.js'",JSON.stringify(`data:text/javascript;base64,${Buffer.from(details).toString('base64')}#${serial}`));
  const mod=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${serial++}`);
  const timers=[],cx={notify(){},timer:{after:(ms,fn)=>{timers.push({ms,fn});return {cancel(){}};}}};
  return {...mod,cx,timers,commands,paths,store};
}
const viewFor=feed=>({panelState:{feed:cleanPanelFeed(feed),status:'ready'},panelEvents:null,panelReducedMotion:false});

test('brand SVG assets use full-color images while the space grid remains a tinted mask',async()=>{
  const r=await renderer(false);
  for(const tool of ['linear','jira']){
    const tree=r.renderPanelTracking(viewFor(makePanelFixture({share:'space',tool,slack:true})),t,r.cx);
    const nodes=all(tree);
    for(const filename of [`tool-${tool}.svg`,'slack.svg']){
      const icons=nodes.filter(n=>n.value===`mods/sixfold-desk/icons/${filename}`);
      assert(icons.length>0,`${filename} appears in the rendered panel`);
      assert(icons.every(n=>n.kind==='image'),`${filename} preserves source RGBA through image()`);
      assert(icons.every(n=>!call(n,'text_color')),`${filename} is not theme tinted`);
    }
    const grid=nodes.filter(n=>n.value==='mods/sixfold-desk/icons/space-grid.svg');
    assert(grid.length>0);
    assert(grid.every(n=>n.kind==='svg'&&call(n,'text_color')),'space grid uses a theme-tinted SVG mask');
  }
});

test('all 24 fixture combinations pass the actual view builder, with one-line rows and no addresses',async()=>{
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
  const packet=all(after).find(n=>{const id=call(n,'id')?.[1];return id?.startsWith('panel-packet-')&&!id.startsWith('panel-packet-tail-');});
  assert(packet);assert.equal(call(packet,'size')[1],8);
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
      assert(row.y>=card.top+r.PANEL_GEOMETRY.border+r.PANEL_GEOMETRY.header+r.PANEL_GEOMETRY.meta);assert(row.y+28<card.top+card.height);
    }
  }
});

test('default 224px sidebar reserves space name and compact controls; wide panels retain full labels',async()=>{
  const r=await renderer(false),view=viewFor(makePanelFixture({share:'space',tool:'linear',slack:true}));
  view.panelWidth=224;const compact=r.renderPanelTracking(view,t,r.cx);
  assert(all(compact).some(n=>call(n,'w')?.[1]===64&&call(n,'h')?.[1]===18));
  assert(all(compact).some(n=>n.calls?.some(c=>c[0]==='min_w'&&c[1]===0)));
  view.panelState.feed.spaces[0].memory.proposals=9999;
  const many=r.renderPanelTracking(view,t,r.cx);
  const memory=byId(many,`panel-memory-${view.panelState.feed.spaces[0].id}`);
  assert.equal(call(memory,'w')[1],32);assert(words(memory).includes('◈ 9999'));
  view.panelWidth=540;const wide=r.renderPanelTracking(view,t,r.cx);
  assert(all(wide).some(n=>call(n,'w')?.[1]===120&&call(n,'h')?.[1]===18));
  view.panelWidth=340;const standard=r.renderPanelTracking(view,t,r.cx);
  assert(all(standard).some(n=>call(n,'w')?.[1]===120&&call(n,'h')?.[1]===18),'design-width panels reserve the full transient label slot');
});

test('workspace navigation remains explicitly available without resolving opaque feed IDs',async()=>{
  const r=await renderer(false),tree=r.renderPanelTracking(viewFor(makePanelFixture()),t,r.cx);
  const button=byId(tree,'panel-workspaces');assert(button);
  call(button,'on_click')[1]();
  assert.equal(r.store.get('sixfold.panel.enabled'),false);
  assert.equal(r.commands.length,0,'changing the view cannot guess a workspace or terminal');
});

test('stage marks are fixed 9 by 3 segments and completed or child rows have no stage bar',async()=>{
  const r=await renderer(false),view=viewFor(makePanelFixture()),agent=view.panelState.feed.spaces[0].agents[0];
  let tree=r.renderPanelTracking(view,t,r.cx),row=byId(tree,`panel-agent-${agent.id}`);
  const segments=all(row).filter(n=>call(n,'id')?.[1]?.startsWith(`panel-stage-${agent.id}-`));
  assert.equal(segments.length,4);
  assert(segments.every(n=>call(n,'w')?.[1]===9&&call(n,'h')?.[1]===3&&!call(n,'flex_1')));
  agent.stage=5;tree=r.renderPanelTracking(view,t,r.cx);row=byId(tree,`panel-agent-${agent.id}`);
  assert.equal(all(row).filter(n=>call(n,'id')?.[1]?.startsWith('panel-stage-')).length,0);
  assert(words(byId(row,`panel-status-${agent.id}`)).includes('✓'));
  agent.stage=2;view.rowMeta=new Map([[agent.id,{parent:'parent',depth:2}]]);
  row=r.agentRow(view,agent,view.panelState.feed.spaces[0],null,view.panelEvents,t.accent,t,false);
  assert.equal(call(row,'h')[1],20);assert.equal(call(row,'pl')[1],46);
  assert(byId(row,`panel-child-branch-${agent.id}`));
  assert(byId(row,`panel-child-dot-${agent.id}`));
  assert.equal(all(row).filter(n=>call(n,'id')?.[1]?.startsWith('panel-stage-')).length,0);
});

test('explicit task details overlay the family icon and reuse the status slot',async()=>{
  const r=await renderer(false),view=viewFor(makePanelFixture()),space=view.panelState.feed.spaces[0],agent=space.agents[0];
  Object.assign(agent,{report_missing:true,error:'Connection failed',unread:120,usage:{label:'Daily limit',limited:true}});
  space.nav={machine:'native-machine-never-display'};space.computer=view.panelState.feed.computers[1].id;
  const row=byId(r.renderPanelTracking(view,t,r.cx),`panel-agent-${agent.id}`);
  assert(words(row).includes('99+'));assert(words(byId(row,`panel-status-${agent.id}`)).includes('!'));
  assert.equal(call(byId(row,`panel-status-${agent.id}`),'text_color')[1],t.blocked);
  assert(all(row).some(n=>n.kind==='svg'&&n.value.endsWith('device-computer.svg')));
  assert.match(call(row,'tooltip')[1],/보고 없음/);
  assert.match(call(row,'tooltip')[1],/Remote: Worker/);
  assert(!call(row,'tooltip')[1].includes('native-machine-never-display'));
});

test('all four closing stages keep their bars even after the task itself is completed',async()=>{
  const r=await renderer(false),view=viewFor(makePanelFixture()),space=view.panelState.feed.spaces[0],agent=space.agents[0];
  for(const step of [1,2,3,4]){
    Object.assign(agent,{stage:5,status:'done',closing:{step,blocked_reason:'',memory:{state:step===1?'pending':step===2?'saved':'proposed',proposals:2}}});
    const row=r.agentRow(view,agent,space,null,{packets:[],spawning:new Set()},t.accent,t,false);
    const stages=all(row).filter(node=>call(node,'id')?.[1]?.startsWith(`panel-stage-${agent.id}-`));
    assert.equal(stages.length,4);
    assert.equal(stages.filter(node=>call(node,'bg')[1]===t.ansi6).length,step);
    assert(words(byId(row,`panel-status-${agent.id}`)).includes(step===1?'◌':'◈'));
  }
});

test('header metrics share the exact memory endpoint and reserve nonoverlapping badges',async()=>{
  const r=await renderer(false),view=viewFor(makePanelFixture({share:'space'})),space=view.panelState.feed.spaces[0];
  space.memory.proposals=9999;
  const tree=r.renderPanelTracking(view,t,r.cx),partner=byId(tree,`panel-partner-${space.id}`);
  assert.equal(call(partner,'h')[1],18);assert.equal(call(partner,'rounded')[1],9);
  assert(call(partner,'border'));assert(call(partner,'bg'));
  const metrics=r.panelHeaderMetrics(space,224);
  assert.equal(metrics.header,34);assert.equal(metrics.meta,26);assert.equal(metrics.issue,18);
  assert.equal(metrics.memoryWidth,32);
  assert.equal(metrics.memoryAnchorX,-(metrics.padding+metrics.border+metrics.countWidth+metrics.gap+metrics.memoryWidth/2));
  const layout=r.panelLayout(view.panelState.feed,view.panelEvents);
  const state={...view.panelEvents,packets:[{id:'memory-ping',from:space.agents[0].id,to:space.id,kind:'memory',phase:'ping'}]};
  const layer=r.panelFlowLayer(view.panelState.feed,layout,state,()=>t.accent,t,true,224);
  const ping=byId(layer,'panel-receiver-memory-ping');assert(ping);
  assert.equal(call(ping,'left')[1],metrics.memoryAnchorX-12);assert.equal(call(ping,'w')[1],24);
  assert.equal(call(ping,'h')[1],24);
});

test('summary counts exclude cleaned sessions and classify completion and blocked work first',async()=>{
  const r=await renderer(false);
  assert.deepEqual(r.panelCounts({spaces:[{agents:[
    {status:'working',stage:2},{status:'idle',stage:0},{status:'working',stage:5},
    {status:'working',stage:2,closing:{blocked_reason:'Approval needed'}},
    {status:'working',stage:2,closing:{step:4}},
  ]}]}),{working:1,idle:1,done:1,blocked:1,total:4});
});

test('newborn dotted reveal uses a finite native transition and motion off stays still',async()=>{
  const r=await renderer(false),view=viewFor(makePanelFixture()),space=view.panelState.feed.spaces[0],agent=space.agents[0];
  const state={packets:[],spawning:new Set([agent.id]),active:[{kind:'spawn',to:agent.id,elapsed:0}]};
  const first=r.agentRow(view,agent,space,null,state,t.accent,t,true);
  assert(call(first,'border_dashed'));assert(first.calls.some(c=>c[0]==='transition'&&c[1]==='opacity'));
  const still=r.agentRow(view,agent,space,null,state,t.accent,t,false);
  assert.equal(all(still).filter(n=>call(n,'loop')||call(n,'transition')).length,0);
});

test('same-task relations are solid gray brackets without dashes or animation',async()=>{
  const r=await renderer(true),view=viewFor(makePanelFixture());
  const tree=r.renderPanelTracking(view,t,r.cx),link=view.panelState.feed.links[0];
  const relation=byId(tree,`panel-route-task-${link.a}-${link.b}`);assert(relation);
  assert.equal(all(relation).filter(n=>call(n,'border_dashed')||call(n,'loop')||call(n,'transition')).length,0);
  assert(r.paths.some(([,color])=>color===t.dim));
});

test('explicit local collaboration has purple solid bracket, two square ends and partner-space chips',async()=>{
  const raw=makePanelFixture(),first=raw.spaces[0];
  raw.spaces.push({...first,id:PANEL_IDS.remoteSpace,name:'Platform',share:null,agents:[]});
  raw.links=[{kind:'collaboration',a:first.id,b:PANEL_IDS.remoteSpace}];
  const r=await renderer(true),view=viewFor(raw),tree=r.renderPanelTracking(view,t,r.cx);
  const relation=byId(tree,`panel-route-collaboration-${first.id}-${PANEL_IDS.remoteSpace}`);assert(relation);
  assert.equal(call(relation,'opacity')[1],0.55);
  assert.equal(all(relation).filter(n=>call(n,'border_dashed')||call(n,'loop')||call(n,'transition')).length,0);
  for(const index of [0,1])assert(byId(tree,`panel-collaboration-end-${first.id}-${PANEL_IDS.remoteSpace}-${index}`));
  assert(words(byId(tree,`panel-local-partner-${first.id}`)).includes('Platform'));
  assert(words(byId(tree,`panel-local-partner-${PANEL_IDS.remoteSpace}`)).includes(first.name));
  assert(r.paths.some(([,color])=>color==='#c3a6ff'));
  raw.links=[];const unrelated=r.renderPanelTracking(viewFor(raw),t,r.cx);
  assert.equal(byId(unrelated,`panel-local-partner-${first.id}`),undefined,'same computer alone never infers collaboration');
});

test('local message packets use teal ease and a delayed fading native tail; motion off has no animations',async()=>{
  const r=await renderer(true),view=viewFor(makePanelFixture()),feed=view.panelState.feed;
  r.renderPanelTracking(view,t,r.cx);const layout=r.panelLayout(feed,view.panelEvents),[a,b]=feed.spaces[0].agents;
  const packet={id:'local-message',from:a.id,to:b.id,kind:'message',phase:'travel',elapsed:350};
  const state={...view.panelEvents,packets:[packet]};
  const tree=r.panelFlowLayer(feed,layout,state,()=>t.accent,t,true,224),head=byId(tree,'panel-packet-local-message');
  assert(head);assert.equal(call(head,'bg')[1],'#8FEFFF');
  assert.equal(head.calls.find(c=>c[0]==='transition'&&c[1]==='top')[2].easing,'ease-in-out');
  for(const [index,delay,opacity] of [[1,30,0.7],[2,60,0.4],[3,90,0.2]]){
    const tail=byId(tree,`panel-packet-tail-local-message-${index}`);assert(tail);
    assert.equal(call(tail,'opacity')[1],opacity);
    assert.equal(tail.calls.find(c=>c[0]==='transition'&&c[1]==='top')[2].delay,delay);
  }
  const arrival=byId(r.panelFlowLayer(feed,layout,{...state,packets:[{...packet,phase:'ping'}]},()=>t.accent,t,true,224),'panel-receiver-local-message');
  assert.equal(call(arrival,'w')[1],24);assert.equal(call(arrival,'opacity')[1],0);
  assert(arrival.calls.some(c=>c[0]==='transition'&&c[1]==='width'));
  const still=r.panelFlowLayer(feed,layout,{...state,packets:[],connections:[packet]},()=>t.accent,t,false,224);
  assert.equal(all(still).filter(n=>call(n,'transition')||call(n,'loop')).length,0);
});

test('task and local collaboration brackets occupy separate lanes when both are present',async()=>{
  const r=await renderer(false),view=viewFor(makePanelFixture({share:'local'}));
  const tree=r.renderPanelTracking(view,t,r.cx),links=view.panelState.feed.links;
  const lane=link=>{
    const route=byId(tree,`panel-route-${link.kind==='task'?'task':'collaboration'}-${link.a}-${link.b}`);
    const paint=all(route).find(item=>item.kind==='path');
    const vertical=paint.value.filter(step=>step[0]==='line_to')[1];
    return call(paint,'left')[1]+vertical[1];
  };
  assert(lane(links.find(link=>link.kind==='collaboration'))-lane(links.find(link=>link.kind==='task'))>=4,'simultaneous relation strokes must not cover each other');
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


test('filtered remote messages retain a computer dash and bright packet; departure and arrival clear the card edge',async()=>{
 const r=await renderer(true),view=viewFor(makePanelFixture({share:'space'})),feed=view.panelState.feed;
 r.renderPanelTracking(view,t,r.cx);const layout=r.panelLayout(feed,view.panelEvents);
 const local=feed.spaces[0],remoteComputer=feed.computers.find(computer=>computer.id!==local.computer);
 feed.spaces.push({id:'remote-space',computer:remoteComputer.id,agents:[{id:'remote-agent'}]});
 const packet={id:'remote-message',from:local.agents[0].id,to:'remote-agent',kind:'message',phase:'travel',elapsed:350};
 const tree=r.panelFlowLayer(feed,layout,{...view.panelEvents,packets:[packet]},()=>t.accent,t,true,224);
 assert(byId(tree,'panel-route-remote-remote-message'));assert(byId(tree,'panel-packet-remote-message'));
 const sender=byId(tree,'panel-sender-remote-message');assert(sender);assert.equal(call(sender,'left')[1],2);assert.equal(call(sender,'w')[1],24);
 const arrival=r.panelFlowLayer(feed,layout,{...view.panelEvents,packets:[{...packet,phase:'ping'}]},()=>t.accent,t,true,224);
 assert.equal(call(byId(arrival,'panel-receiver-remote-message'),'left')[1],48);
 const route=byId(tree,'panel-route-remote-message');assert.equal(call(route,'right')[1],8);assert.equal(call(route,'w')[1],64);
});


test('curved packet targets bow outward, stay in the gutter and reverse with send direction',async()=>{
 const r=await renderer(true),view=viewFor(makePanelFixture()),feed=view.panelState.feed;
 r.renderPanelTracking(view,t,r.cx);const layout=r.panelLayout(feed,view.panelEvents),[a,b]=feed.spaces[0].agents;
 const samples=(from,to)=>[0,40,240,440,640,840,1040,1240,1440].map(elapsed=>{
  const packet={id:'arc',kind:'message',from,to,phase:elapsed?'travel':'start',elapsed};
  const tree=r.panelFlowLayer(feed,layout,{...view.panelEvents,packets:[packet]},()=>t.accent,t,true,224),head=byId(tree,'panel-packet-arc');
  return {x:call(head,'left')[1]+4.5,y:call(head,'top')[1]+4.5};
 });
 const down=samples(a.id,b.id),up=samples(b.id,a.id);
 assert(Math.max(...down.map(p=>p.x))>down[0].x+10);assert(down.every(p=>p.x>=0&&p.x<=96));
 assert(down[0].y<down.at(-1).y);assert(up[0].y>up.at(-1).y);
 assert(Math.abs(down[0].x-down.at(-1).x)<0.01);assert(Math.abs(up[0].x-up.at(-1).x)<0.01);
});


test('a message pipe has an outlined translucent tube and only one native horizontal turn',async()=>{
 const r=await renderer(true),view=viewFor(makePanelFixture()),feed=view.panelState.feed;
 r.renderPanelTracking(view,t,r.cx);const layout=r.panelLayout(feed,view.panelEvents),[a,b]=feed.spaces[0].agents;
 for(const elapsed of [120,495]){
  const packet={id:'tube',kind:'message',from:a.id,to:b.id,phase:'travel',elapsed};
  const tree=r.panelFlowLayer(feed,layout,{...view.panelEvents,packets:[packet]},()=>t.accent,t,true,340),head=byId(tree,'panel-packet-tube');
  assert.equal(call(head,'size')[1],9);
  const left=head.calls.find(c=>c[0]==='transition'&&c[1]==='left')[2],top=head.calls.find(c=>c[0]==='transition'&&c[1]==='top')[2];
  assert.equal(left.duration,375);assert.equal(left.easing,'ease-in-out');assert.equal(top.duration,750);
  assert(r.paths.some(args=>args[1]==='#8FEFFFBB'));assert(r.paths.some(args=>args[1]==='#8FEFFF44'));
 }
});


test('retired collaboration evidence removes the bracket and both partner chips without changing rows',async()=>{
 const r=await renderer(false),view=viewFor(makePanelFixture({share:'local'}));
 const before=r.renderPanelTracking(view,t,r.cx),edge=view.panelState.feed.links.find(link=>link.kind==='collaboration');
 assert(byId(before,`panel-route-collaboration-${edge.a}-${edge.b}`));
 view.panelState.feed={...view.panelState.feed,links:view.panelState.feed.links.filter(link=>link.kind!=='collaboration')};
 const after=r.renderPanelTracking(view,t,r.cx);assert(!byId(after,`panel-route-collaboration-${edge.a}-${edge.b}`));
 for(const space of view.panelState.feed.spaces){assert(!byId(after,`panel-local-partner-${space.id}`));for(const agent of space.agents)assert(byId(after,`panel-agent-${agent.id}`));}
});


test('hosted message tube uses the external gutter without narrowing the original card',async()=>{
 const r=await renderer(true),view=viewFor(makePanelFixture()),feed=view.panelState.feed;
 r.renderPanelTracking(view,t,r.cx);const layout=r.panelLayout(feed,view.panelEvents),[a,b]=feed.spaces[0].agents;
 const state={...view.panelEvents,packets:[{id:'external',kind:'message',from:a.id,to:b.id,phase:'travel',elapsed:120}]};
 const tree=r.panelFlowLayer(feed,layout,state,()=>t.accent,t,true,224,161),head=byId(tree,'panel-packet-external');
 const route=byId(tree,'panel-route-external');assert.equal(call(route,'w')[1],153);
 const x=432-161+call(head,'left')[1]+4.5;assert(x>392&&x<432,'orb reaches deep into gap beyond312px panel without entering CLI');
});
