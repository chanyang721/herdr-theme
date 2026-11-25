import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {makePanelMatrix,makePanelFixture,PANEL_IDS,eventSequence,makeLedgerFieldFeed} from './panel-fixtures.mjs';
import {cleanPanelFeed,MESSAGE_TIMING,PANEL_TIMING,PANEL_LEGS} from '../mods/sixfold-desk/panel-model.js';

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
    PathBuilder:{stroke:()=>path()},spaces:()=>nativeSpaces,panes:()=>nativePanes,settings:()=>({zoom:globalThis.__panelZoom??1}),shared:key=>store.get(key),setShared:(k,v)=>store.set(k,v),run:(...args)=>commands.push(args)};
  globalThis.window={paint_path:(...args)=>{paths.push(args);return node('path',args[0]);}};
  let source=await readFile(new URL('../mods/sixfold-desk/panel-view.js',import.meta.url),'utf8');
  source=source.replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base|herdr)';/g,'const {$1}=globalThis.__panelView;');
  for(const name of ['panel-model','collab-flow','panel-host','motion'])source=source.replace(`'./${name}.js'`,JSON.stringify(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url).href));
  const details=(await readFile(new URL('../mods/sixfold-desk/task-row-details.js',import.meta.url),'utf8'))
    .replace(/import \{([^}]+)\} from 'gpui-kit';/,'const {$1}=globalThis.__panelView;');
  source=source.replace("'./task-row-details.js'",JSON.stringify(`data:text/javascript;base64,${Buffer.from(details).toString('base64')}#${serial}`));
  const pixel=(await readFile(new URL('../mods/sixfold-desk/pixel.js',import.meta.url),'utf8')).replace(/import \{([^}]+)\} from 'gpui-kit';/,'const {$1}=globalThis.__panelView;');
  source=source.replace("'./pixel.js'",JSON.stringify(`data:text/javascript;base64,${Buffer.from(pixel).toString('base64')}#${serial}`));
  const status=(await readFile(new URL('../mods/sixfold-desk/session-status.js',import.meta.url),'utf8'))
    .replace(/import \{([^}]+)\} from 'gpui-kit';/,'const {$1}=globalThis.__panelView;')
    .replace("'./collab-flow.js'",JSON.stringify(new URL('../mods/sixfold-desk/collab-flow.js',import.meta.url).href));
  source=source.replace("'./session-status.js'",JSON.stringify(`data:text/javascript;base64,${Buffer.from(status).toString('base64')}#${serial}`));
  const mod=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${serial++}`);
  const timers=[],cx={notify(){},timer:{after:(ms,fn)=>{timers.push({ms,fn});return {cancel(){}};}}};
  return {...mod,cx,timers,commands,paths,store};
}
const viewFor=feed=>({panelState:{feed:cleanPanelFeed(feed),status:'ready'},panelEvents:null,panelReducedMotion:false});

test('a recorded profession names the chip as literal bounded text in wide and narrow rows',async()=>{
  const r=await renderer(false),feed=makePanelFixture(),agent=feed.spaces[0].agents[0];
  Object.assign(agent,{role:'review',profession:{id:'custom-discipline',label:'QA'}});
  for(const width of [224,360]){
    const tree=r.renderPanelTracking({...viewFor(feed),panelWidth:width},t,r.cx);
    const chip=byId(tree,`${width<300?'panel-tags':'panel-role'}-${agent.id}`);
    assert.deepEqual(words(chip),['QA']);
    assert.match(call(chip,'accessibility_label')[1],/QA/);
    assert.match(call(byId(tree,`panel-agent-${agent.id}`),'tooltip')[1],/직무 QA/);
    assert(call(chip,'truncate'),'producer label cannot crowd out the title');
  }
  agent.profession.label='<b>QA & review</b>';
  const literal=r.renderPanelTracking({...viewFor(feed),panelWidth:360},t,r.cx);
  assert.deepEqual(words(byId(literal,`panel-role-${agent.id}`)),['<b>QA & review</b>']);
  delete agent.profession;
  assert.deepEqual(words(byId(r.renderPanelTracking({...viewFor(feed),panelWidth:360},t,r.cx),`panel-role-${agent.id}`)),['검수']);
});

test('lead rows sit flat under the Slack/Linear line, outside every issue, with their group or profession chip',async()=>{
  const r=await renderer(false),feed=makePanelFixture({tool:'linear',slack:true}),[lead,doer,checker]=feed.spaces[0].agents;
  Object.assign(lead,{coordinator:true,role:'integrate',role_group:{id:'lead',label:'LEAD'},issue:'DEMO-12'});
  Object.assign(doer,{role:'implement'});
  Object.assign(checker,{role:'review'});
  const clean=cleanPanelFeed(feed),{cards}=r.panelLayout(clean,{tags:new Map(),packets:[]});
  const rows=cards[0].rows;
  assert.equal(rows[0].agent?.id,lead.id,'the lead is the first row under the meta line');
  assert.equal(rows[0].coordinator,true);
  assert.equal(rows[1].kind,'issue-gap');
  assert(!rows.slice(1).some(row=>row.agent?.id===lead.id),'never repeated under an issue');
  for(const width of [224,360]){
    const tree=r.renderPanelTracking({...viewFor(feed),panelWidth:width},t,r.cx),chip=width<300?'panel-tags':'panel-role';
    assert.equal(byId(tree,`panel-issue-indent-${lead.id}`),undefined,'not indented into an issue block');
    assert(byId(tree,`panel-issue-indent-${doer.id}`),'workers stay under their issue');
    assert.deepEqual(words(byId(tree,`${chip}-${lead.id}`)),['LEAD']);
    assert.deepEqual(words(byId(tree,`${chip}-${doer.id}`)),[width<300?'구':'구현'],'no group is inferred for a worker');
    assert.deepEqual(words(byId(tree,`${chip}-${checker.id}`)),[width<300?'검':'검수']);
    assert.match(call(byId(tree,`panel-agent-${lead.id}`),'tooltip')[1],/역할군 LEAD[\s\S]*리드 칸/);
  }
  Object.assign(lead,{role_group:undefined,profession:{id:'ops',label:'Operations'}});delete lead.role_group;
  const assigned=r.renderPanelTracking({...viewFor(feed),panelWidth:360},t,r.cx);
  assert.deepEqual(words(byId(assigned,`panel-role-${lead.id}`)),['OPS'],'a lead with a profession shows its short id');
  for(const bad of [{id:'lead'},{id:'lead',label:'LEAD',x:1},'LEAD'])assert.equal(cleanPanelFeed({...feed,spaces:[{...feed.spaces[0],agents:[{...doer,role_group:bad,coordinator:'yes'}]}]}).spaces[0].agents[0].role_group,undefined);
});

test('a lead keeps its sub-tasks as its own tree; a finished sub-task leaves; no double gap',async()=>{
  const r=await renderer(false),feed=makePanelFixture({tool:'linear'}),[lead,kid,done]=feed.spaces[0].agents;
  Object.assign(lead,{coordinator:true,role_group:{id:'lead',label:'LEAD'}});
  Object.assign(kid,{parent_id:lead.id,subagent_kind:'agent',issue:'DEMO-18'});
  Object.assign(done,{parent_id:lead.id,subagent_kind:'agent',status:'done',stage:4});
  const groups=cleanPanelFeed(feed).spaces.map(space=>space)[0];
  const {cards}=r.panelLayout(cleanPanelFeed(feed),{tags:new Map(),packets:[]});
  const rows=cards[0].rows,ids=rows.filter(row=>row.agent).map(row=>row.agent.id);
  assert.deepEqual(ids.slice(0,2),[lead.id,kid.id],'the sub-task follows its lead');
  assert.equal(rows[1].coordinator,true);
  assert(!ids.includes(done.id),'a finished sub-task of a lead leaves');
  assert(!rows.some((row,i)=>row.kind==='issue-gap'&&rows[i+1]?.kind==='issue-gap'),'never two gaps in a row');
  assert(groups);
});

test('a space role_group is one header chip; its rows stay ordinary and malformed values drop',async()=>{
  const r=await renderer(false),feed=makePanelFixture({tool:'linear'}),space=feed.spaces[0],[first]=space.agents;
  space.role_group={id:'hub',label:'Coordination hub'};
  for(const width of [224,360]){
    const tree=r.renderPanelTracking({...viewFor(feed),panelWidth:width},t,r.cx),chip=byId(tree,`panel-space-role-${space.id}`);
    assert.deepEqual(words(chip),['Coordination hub']);
    assert(call(chip,'truncate'),'a long label cannot crowd out the name');
    assert.equal(call(chip,'max_w')[1],width<300?40:110,'a narrow panel caps the chip harder');
    assert.equal(byId(tree,`panel-space-name-${space.id}`).calls.findLast(c=>c[0]==='min_w')[1],28,'the name keeps a row title\'s minimum');
    assert.equal(call(chip,'tooltip')[1],'Coordination hub');
    assert(byId(tree,`panel-issue-indent-${first.id}`),'rows keep their issue placement');
  }
  for(const bad of [{id:'hub'},{id:'hub',label:'x',extra:1},'hub',{id:'a b',label:'x'}])
    assert.equal(cleanPanelFeed({...feed,spaces:[{...space,role_group:bad}]}).spaces[0].role_group,undefined);
  delete space.role_group;
  assert.equal(byId(r.renderPanelTracking({...viewFor(feed),panelWidth:360},t,r.cx),`panel-space-role-${space.id}`),undefined);
});

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

test('working rows draw the plan-usage chip marks in their family colours; resting rows draw them muted',async()=>{
  const r=await renderer(false);
  const feed=makePanelFixture({agents:[{title:'claude row',family:'claude',status:'working',state:'working'},{title:'codex row',family:'codex',status:'working',state:'working'},{title:'claude rest',family:'claude',status:'idle',state:'idle'}]});
  const nodes=all(r.renderPanelTracking(viewFor(feed),t,r.cx));
  const codex=nodes.filter(n=>n.value==='mods/sixfold-desk/icons/codex-mark.svg');
  const claude=nodes.filter(n=>n.value==='mods/plan-usage/claude.svg');
  assert(codex.length>0&&claude.length>0);
  assert(codex.every(n=>n.kind==='svg'&&call(n,'text_color')?.[1]==='#10A37F'));
  assert(claude.every(n=>n.kind==='svg')&&claude.some(n=>call(n,'text_color')?.[1]==='#D97757')&&claude.some(n=>call(n,'text_color')?.[1]===t.muted));
  assert.equal(nodes.filter(n=>n.value==='mods/sixfold-desk/icons/codex.svg').length,0);
  const mark=await readFile(new URL('../mods/sixfold-desk/icons/codex-mark.svg',import.meta.url),'utf8');
  assert.match(mark,/^<svg[^>]*viewBox="0 0 24 24"/);
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
        const row=byId(tree,`panel-agent-${agent.id}`);assert(row);assert.equal(call(row,'h')[1],24,'compact one-line row');
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
  const step=eventSequence.find(x=>x.name==='assign-existing');assert(step);
  view.panelState.feed=cleanPanelFeed(step.apply(view.panelState.feed,Date.now()));
  const after=r.renderPanelTracking(view,t,r.cx);
  assert(r.paths.length>0);assert(r.timers.some(timer=>timer.ms>0&&timer.ms<=40));
  const titles=view.panelState.feed.spaces.flatMap(s=>s.agents.map(a=>a.title));
  for(const title of titles){assert(words(before).includes(title));assert(words(after).includes(title));}
  const packet=all(after).find(n=>{const id=call(n,'id')?.[1];return id?.startsWith('panel-packet-')&&!id.startsWith('panel-packet-tail-');});
  assert(packet);assert.equal(call(packet,'w')[1],3);assert.equal(call(packet,'h')[1],3);
  assert(packet.calls.some(c=>c[0]==='transition'&&c[1]==='top'));
  assert(packet.calls.some(c=>c[0]==='transition'&&c[1]==='left'));
});

test('system reduced motion removes every loop and moving packet, retaining labels and counts',async()=>{
  const r=await renderer(true),view=viewFor(makePanelFixture({share:'space'}));view.panelReducedMotion=true;
  r.renderPanelTracking(view,t,r.cx);
  view.panelState.feed=cleanPanelFeed(eventSequence.find(x=>x.name==='assign-existing').apply(view.panelState.feed,Date.now()));
  const tree=r.renderPanelTracking(view,t,r.cx);
  assert.equal(all(tree).filter(n=>call(n,'loop')||call(n,'transition')).length,0);
  assert(words(tree).includes('Motion off'));assert(view.panelEvents.tags.size>0);
});

test('card row geometry includes borders, issue headings and the hidden-row remainder',async()=>{
  const r=await renderer(false),view=viewFor(makePanelFixture({share:'agent',tool:'linear'}));
  r.renderPanelTracking(view,t,r.cx);const layout=r.panelLayout(view.panelState.feed,view.panelEvents);
  for(const card of layout.cards){
    for(const row of card.rows.filter(row=>row.kind==='agent')){
      assert.equal(layout.anchors.get(row.agent.id).y,row.y+r.PANEL_GEOMETRY.row/2);
      assert(row.y>=card.top+r.PANEL_GEOMETRY.border+r.PANEL_GEOMETRY.header+r.PANEL_GEOMETRY.meta);assert(row.y+r.PANEL_GEOMETRY.row<card.top+card.height);
    }
  }
});

test('agents under an issue heading are indented and each later issue starts after a gap',async()=>{
  const r=await renderer(false),view=viewFor(makePanelFixture({share:'agent',tool:'linear'}));
  const tree=r.renderPanelTracking(view,t,r.cx);const layout=r.panelLayout(view.panelState.feed,view.panelEvents);
  const grouped=layout.cards.filter(card=>card.rows.some(row=>row.kind==='issue'));
  assert(grouped.length>0,'the fixture has an issue-grouped card');
  assert(grouped.some(card=>card.rows.filter(row=>row.kind==='issue').length>=2),'at least one card has two issues, so a gap is drawn');
  for(const card of grouped){
    const issues=card.rows.filter(row=>row.kind==='issue'),gaps=card.rows.filter(row=>row.kind==='issue-gap');
    assert.equal(gaps.length,issues.length-1,'one gap between consecutive issues, none before the first');
    for(const gap of gaps)assert.equal(card.rows[card.rows.indexOf(gap)+1].kind,'issue');
    for(const row of card.rows.filter(row=>row.kind==='agent')){
      const wrap=byId(tree,`panel-issue-indent-${row.agent.id}`);
      assert(wrap,'grouped agent rows sit in the indent wrapper');
      assert.equal(call(wrap,'pl')[1],r.PANEL_GEOMETRY.issueIndent);
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
  agent.stage=5;agent.status='done';tree=r.renderPanelTracking(view,t,r.cx);row=byId(tree,`panel-agent-${agent.id}`);
  assert.equal(all(row).filter(n=>call(n,'id')?.[1]?.startsWith('panel-stage-')).length,0);
  assert(words(byId(row,`panel-status-${agent.id}`)).includes('✓'));
  agent.stage=2;agent.status='working';view.rowMeta=new Map([[agent.id,{parent:'parent',depth:2}]]);
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
  assert.equal(metrics.header,34);assert.equal(metrics.meta,20);assert.equal(metrics.issue,18);
  assert.equal(metrics.memoryWidth,32);
  assert.equal(metrics.memoryAnchorX,-(metrics.padding+metrics.border+metrics.countWidth+metrics.gap+metrics.memoryWidth/2));
  const layout=r.panelLayout(view.panelState.feed,view.panelEvents);
  const state={...view.panelEvents,packets:[{id:'memory-ping',from:space.agents[0].id,to:space.id,kind:'memory',phase:'ping'}]};
  const layer=r.panelFlowLayer(view.panelState.feed,layout,state,()=>t.accent,t,true,224);
  const ping=byId(layer,'panel-receiver-memory-ping');assert(ping);
  assert.equal(call(ping,'left')[1],metrics.memoryAnchorX-7);assert.equal(call(ping,'w')[1],15);
  assert.equal(call(ping,'h')[1],15);
});

test('summary counts exclude cleaned sessions and preserve observed pane status',async()=>{
  const r=await renderer(false);
  assert.deepEqual(r.panelCounts({spaces:[{agents:[
    {status:'working',stage:2},{status:'idle',stage:0},{status:'done',stage:5},
    {status:'working',stage:2,closing:{blocked_reason:'Approval needed'}},
    {status:'working',stage:2,closing:{step:4}},
  ]}]}),{working:2,idle:1,done:1,blocked:0,total:4});
});

test('newborn dotted reveal uses a finite native transition and motion off stays still',async()=>{
  const r=await renderer(false),view=viewFor(makePanelFixture()),space=view.panelState.feed.spaces[0],agent=space.agents[0];
  const state={packets:[],spawning:new Set([agent.id]),active:[{kind:'spawn',to:agent.id,elapsed:0}]};
  const first=r.agentRow(view,agent,space,null,state,t.accent,t,true);
  assert(call(first,'border_dashed'));assert(all(first).some(n=>n.calls?.some(c=>c[0]==='transition'&&c[1]==='opacity')));
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

test('a local message rides the same pixel line, block and departure ring as a task event; motion off omits it',async()=>{
  const r=await renderer(true),view=viewFor(makePanelFixture()),feed=view.panelState.feed;
  r.renderPanelTracking(view,t,r.cx);const layout=r.panelLayout(feed,view.panelEvents),[a,b]=feed.spaces[0].agents;
  const draw=(kind,phase,elapsed)=>{r.paths.length=0;
    const tree=r.panelFlowLayer(feed,layout,{...view.panelEvents,packets:[{id:'p',kind,from:a.id,to:b.id,phase,elapsed}]},()=>t.accent,t,true,224);
    return {tree,paths:all(byId(tree,'panel-route-p')).filter(n=>n.kind==='path').length};};
  for(const elapsed of [0,PANEL_LEGS[0],PANEL_LEGS[1],PANEL_LEGS[2],PANEL_TIMING.packetMs-1]){
    const phase=elapsed<PANEL_TIMING.startMs?'start':'travel';
    const message=draw('message',phase,elapsed),task=draw('assign',phase,elapsed);
    assert.equal(message.paths,0,'no vector stroke: the line is pixel blocks');assert.equal(task.paths,0);
    const pixels=tree=>all(byId(tree,'panel-route-p')).filter(n=>!call(n,'id')).map(n=>n.calls);
    assert.deepEqual(pixels(message.tree),pixels(task.tree),'the same pixel line');
    for(const id of ['panel-packet-p','panel-sender-p']){
      const m=byId(message.tree,id),k=byId(task.tree,id);assert(m,id);assert(k,id);
      assert.deepEqual(m.calls,k.calls,`${id} at ${elapsed}ms matches the task-event packet`);
    }
    assert(!all(message.tree).some(n=>/^panel-packet-tail-/.test(call(n,'id')?.[1]||'')),'no tail');
    assert(!all(message.tree).some(n=>call(n,'rounded')),'square pixels only');
  }
  const {tree}=draw('message','travel',PANEL_LEGS[1]+1),head=byId(tree,'panel-packet-p');
  assert.equal(call(head,'w')[1],3);assert.equal(call(head,'h')[1],3);assert.equal(call(head,'bg')[1],'#79D1DC');assert.equal(head.nodes.length,0);
  assert.equal(call(head,'left')[1]+1,12,'centred on the inner message lane');
  assert.equal(head.calls.find(c=>c[0]==='transition'&&c[1]==='top')[2].duration,PANEL_LEGS[2]-PANEL_LEGS[1]);
  const arrival=byId(draw('message','ping',PANEL_TIMING.packetMs).tree,'panel-receiver-p');
  // A message lands with one small blink in its own colour, never the done mark.
  assert.equal(call(arrival,'w')[1],3);assert.equal(call(arrival,'bg')[1],'#79D1DC');assert.equal(call(arrival,'border'),undefined);
  assert.equal(call(arrival,'opacity')[1],0,'it fades once after landing');
  const still=r.panelFlowLayer(feed,layout,{...view.panelEvents,packets:[],connections:[{id:'off',kind:'message',from:a.id,to:b.id}]},()=>t.accent,t,false,224);
  assert(!byId(still,'panel-route-off'));assert.equal(all(still).filter(n=>call(n,'transition')||call(n,'loop')).length,0);
});

test('a task event done mark is easy to see (2px foreground ring held lit, second blink, core block), a message only blinks small in its colour, and only the line fades',async()=>{
  const r=await renderer(true),view=viewFor(makePanelFixture()),feed=view.panelState.feed;
  r.renderPanelTracking(view,t,r.cx);const layout=r.panelLayout(feed,view.panelEvents),[a,b]=feed.spaces[0].agents;
  const draw=(kind,phase)=>r.panelFlowLayer(feed,layout,{...view.panelEvents,packets:[{id:'d',kind,from:a.id,to:b.id,phase,elapsed:PANEL_TIMING.packetMs}]},()=>t.accent,t,true,224);
  const policy=(node,property)=>node.calls.find(c=>c[0]==='transition'&&c[1]===property)?.[2];
  const landing=draw('message','ping'),blink=byId(landing,'panel-receiver-d');
  assert.equal(call(blink,'w')[1],3);assert.equal(call(blink,'h')[1],3);assert.equal(call(blink,'bg')[1],'#79D1DC','the flow colour, not white');
  assert(!byId(landing,'panel-receiver-d-again')&&!byId(landing,'panel-receiver-d-core'),'no second ring or core block for a message');
  assert(!all(landing).some(n=>call(n,'border_color')?.[1]===t.foreground||call(n,'bg')?.[1]===t.foreground),'nothing in the foreground colour');
  const fadeOut=policy(blink,'opacity');assert(fadeOut.delay+fadeOut.duration<=600,'short');
  for(const kind of ['assign']){
    const ping=draw(kind,'ping');
    const ring=byId(ping,'panel-receiver-d'),again=byId(ping,'panel-receiver-d-again'),core=byId(ping,'panel-receiver-d-core');
    assert(ring&&again&&core,`${kind}: ring, second ring and core`);
    for(const node of [ring,again]){assert.equal(call(node,'border')[1],2);assert.equal(call(node,'border_color')[1],t.foreground);assert.equal(call(node,'w')[1],15);}
    assert.equal(call(core,'bg')[1],t.foreground);assert.equal(call(core,'w')[1],5);
    assert(policy(ring,'opacity').delay>=900,'held lit before it fades');
    assert(policy(again,'width').delay>=250,'the second ring blinks after the first');
    assert(PANEL_TIMING.pingMs+PANEL_TIMING.coolMs>=policy(ring,'opacity').delay+policy(ring,'opacity').duration,'the whole mark fits before the packet is removed');
    }
  for(const kind of ['message','assign']){
    const fade=draw(kind,'fade');
    assert.equal(call(byId(fade,'panel-route-d'),'opacity'),undefined,'the route itself is not dimmed');
    assert.equal(call(byId(fade,'panel-line-d'),'opacity')[1],0.2,'only the line fades');
    assert(!all(fade).some(n=>call(n,'rounded')),'square pixels only');
  }
  const L=hex=>{const c=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(x=>x<=0.03928?x/12.92:((x+0.055)/1.055)**2.4);return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2];};
  const ratio=(x,y)=>{const [hi,lo]=[L(x),L(y)].sort((p,q)=>q-p);return (hi+0.05)/(lo+0.05);};
  for(const name of ['sixfold-night','sixfold-day']){
    const theme=JSON.parse(await readFile(new URL(`../themes/${name}.json`,import.meta.url),'utf8'));
    for(const surface of [theme.background,theme.colors.canvas,theme.colors.chrome,theme.colors.selected])
      assert(ratio(theme.foreground,surface)>=4.5,`${name}: done mark ${theme.foreground} on ${surface}`);
  }
});

// 2026-11-16, user: "송신만 나오고" — the send's 15px ring showed, the 3x3 landing
// blink alone did not read as a receive. The receiving end mirrors the departure ring.
test('a message receiver opens the same flow-colour ring as its sender, closed during the flight, never the done mark',async()=>{
  const r=await renderer(true),view=viewFor(makePanelFixture()),feed=view.panelState.feed;
  r.renderPanelTracking(view,t,r.cx);const layout=r.panelLayout(feed,view.panelEvents),[a,b]=feed.spaces[0].agents;
  const draw=phase=>r.panelFlowLayer(feed,layout,{...view.panelEvents,packets:[{id:'m',kind:'message',from:a.id,to:b.id,phase,elapsed:PANEL_TIMING.packetMs}]},()=>t.accent,t,true,224);
  const landed=draw('ping'),sender=byId(landed,'panel-sender-m'),ring=byId(landed,'panel-receiver-m-ring');
  assert(ring,'the receiving end has its own ring');
  for(const key of ['w','h','border','border_color'])assert.deepEqual(call(ring,key),call(sender,key),`${key} matches the departure ring`);
  assert.equal(call(ring,'border')[1],1,'1px, not the 2px done mark');assert.equal(call(ring,'border_color')[1],'#79D1DC','the flow colour');
  assert.equal(call(byId(landed,'panel-receiver-m'),'w')[1],3,'the 3x3 blink stays inside it');
  const fade=ring.calls.find(c=>c[0]==='transition'&&c[1]==='opacity')[2];
  assert(PANEL_TIMING.pingMs+PANEL_TIMING.coolMs>=fade.delay+fade.duration,'it fades before the packet is removed');
  for(const phase of ['start','travel'])assert.equal(call(byId(draw(phase),'panel-receiver-m-ring'),'w')[1],0,`closed while ${phase}`);
  assert(!byId(landed,'panel-receiver-m-again')&&!byId(landed,'panel-receiver-m-core'),'no second ring or core block');
  assert(!all(landed).some(n=>call(n,'border_color')?.[1]===t.foreground),'nothing in the foreground colour');
});

test('a row an event arrives on gets a 2px foreground overlay that blinks twice without moving the row',async()=>{
  const r=await renderer(false),view=viewFor(makePanelFixture()),space=view.panelState.feed.spaces[0],agent=space.agents[0];
  const state={packets:[{id:'x',kind:'assign',to:agent.id,phase:'ping'}],spawning:new Set(),active:[]};
  const row=r.agentRow(view,agent,space,null,state,'#79D1DC',t,true);
  const overlay=byId(row,`panel-arrival-${agent.id}`);assert(overlay);
  assert.equal(call(row,'border'),undefined,'the row border never changes, so nothing shifts');
  assert.equal(call(overlay,'border')[1],2);assert.equal(call(overlay,'border_color')[1],t.foreground);
  assert(call(overlay,'absolute'));assert.equal(call(overlay,'bg')[1],'#79D1DC33');
  const blink=overlay.calls.find(c=>c[0]==='loop');assert.equal(blink?.[1],'opacity');assert(2*blink[2].period<=PANEL_TIMING.pingMs,'two blinks within the ping');
  const still=r.agentRow(view,agent,space,null,state,'#79D1DC',t,false);
  assert(byId(still,`panel-arrival-${agent.id}`));assert(!call(byId(still,`panel-arrival-${agent.id}`),'loop'),'motion off stays steady');
  const quiet=r.agentRow(view,agent,space,null,{...state,packets:[]},'#79D1DC',t,true);
  assert(!byId(quiet,`panel-arrival-${agent.id}`));
  for(const motion of [true,false]){
    const message=r.agentRow(view,agent,space,null,{...state,packets:[{id:'m',kind:'message',to:agent.id,phase:'ping'}],connections:[{id:'m',kind:'message',to:agent.id}]},'#79D1DC',t,motion);
    assert(!byId(message,`panel-arrival-${agent.id}`),'a message arrival never gets the done highlight');
    assert.equal(call(message,'border'),undefined);
  }
});

test('pixel lines are whole pixels with a stepped corner, and stay whole at any zoom',async()=>{
  for(const zoom of [1,1.25,2]){
    const r=await renderer(true);globalThis.__panelZoom=zoom;
    const u=1/zoom,line=r.pixelRoute(10.4,60.2,20,0,0,'#79D1DC'),blocks=line.nodes.map(n=>Object.fromEntries(['left','top','w','h'].map(k=>[k,call(n,k)[1]])));
    for(const block of blocks)for(const value of Object.values(block))assert(Math.abs(value/u-Math.round(value/u))<1e-9,`${value} is a whole device pixel at zoom ${zoom}`);
    assert(blocks.some(b=>b.w===u&&b.h===u),'a one-pixel corner step');
    assert(blocks.every(b=>b.w===u||b.h===u),'every run is one pixel thick');
  }
  delete globalThis.__panelZoom;
});

test('a message travels as long as a task event, and no leg is a jump',()=>{
  assert.deepEqual(MESSAGE_TIMING,{startMs:PANEL_TIMING.startMs,packetMs:PANEL_TIMING.packetMs,pingMs:PANEL_TIMING.pingMs,coolMs:PANEL_TIMING.coolMs});
  assert(MESSAGE_TIMING.packetMs-MESSAGE_TIMING.startMs>=2000,'slow enough to follow');
  const legs=[...PANEL_LEGS,PANEL_TIMING.packetMs];
  for(let i=1;i<legs.length;i++)assert(legs[i]-legs[i-1]>=300,`leg ${i} is visible, not a teleport`);
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


test('filtered remote messages ride the computer pipe lane and ping at the remote end',async()=>{
 const r=await renderer(true),view=viewFor(makePanelFixture({share:'space'})),feed=view.panelState.feed;
 r.renderPanelTracking(view,t,r.cx);const layout=r.panelLayout(feed,view.panelEvents);
 const local=feed.spaces[0],remoteComputer=feed.computers.find(computer=>computer.id!==local.computer);
 feed.spaces.push({id:'remote-space',computer:remoteComputer.id,agents:[{id:'remote-agent'}]});
 const packet={id:'remote-message',from:local.agents[0].id,to:'remote-agent',kind:'message',phase:'travel',elapsed:500};
 const tree=r.panelFlowLayer(feed,layout,{...view.panelEvents,packets:[packet]},()=>t.accent,t,true,224);
 assert(byId(tree,'panel-route-remote-message-pipe'));assert(!byId(tree,'panel-route-remote-remote-message'));
 const head=byId(tree,'panel-packet-remote-message');assert.equal(call(head,'left')[1]+1,28,'the packet runs in the computer pipe lane');
 assert.equal(call(head,'w')[1],3);assert(byId(tree,'panel-sender-remote-message'));
 const arrival=r.panelFlowLayer(feed,layout,{...view.panelEvents,packets:[{...packet,phase:'ping'}]},()=>t.accent,t,true,224);
 assert.equal(call(byId(arrival,'panel-receiver-remote-message'),'left')[1],-1,'a 3x3 landing blink centred on the remote end');
 const route=byId(tree,'panel-route-remote-message');assert.equal(call(route,'right')[1],8);assert.equal(call(route,'w')[1],40);
});


test('a message packet follows the pixel lane down or up with the send direction',async()=>{
 const r=await renderer(true),view=viewFor(makePanelFixture()),feed=view.panelState.feed;
 r.renderPanelTracking(view,t,r.cx);const layout=r.panelLayout(feed,view.panelEvents),[a,b]=feed.spaces[0].agents;
 const samples=(from,to)=>[0,PANEL_LEGS[0],PANEL_LEGS[1],PANEL_LEGS[2]].map(elapsed=>{
  const packet={id:'arc',kind:'message',from,to,phase:elapsed<PANEL_TIMING.startMs?'start':'travel',elapsed};
  const tree=r.panelFlowLayer(feed,layout,{...view.panelEvents,packets:[packet]},()=>t.accent,t,true,224),head=byId(tree,'panel-packet-arc');
  return {x:call(head,'left')[1]+1,y:call(head,'top')[1]+1};
 });
 const down=samples(a.id,b.id),up=samples(b.id,a.id);
 for(const points of [down,up]){
  assert.equal(points[1].x,12);assert.equal(points[2].x,12);assert(points.every(p=>p.x>=0&&p.x<=16&&Number.isInteger(p.x)&&Number.isInteger(p.y)));
  assert.equal(points[0].x,points[3].x);assert.equal(points[0].y,points[1].y);assert.equal(points[2].y,points[3].y);
 }
 assert(down[0].y<down[3].y);assert(up[0].y>up[3].y);
});

test('event pixels keep at least 3:1 contrast on dark and light backgrounds',()=>{
 const lum=hex=>{const c=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.03928?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2];};
 const ratio=(a,b)=>{const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return (x+.05)/(y+.05);};
 for(const [tone,background] of [['#79D1DC',t.background],['#79D1DC',t.chrome],['#006C77','#FFFFFF'],['#006C77','#F3F4F6']])
  assert(ratio(tone,background)>=3,`${tone} on ${background}: ${ratio(tone,background).toFixed(2)}`);
});

test('retired collaboration evidence removes the bracket and both partner chips without changing rows',async()=>{
 const r=await renderer(false),view=viewFor(makePanelFixture({share:'local'}));
 const before=r.renderPanelTracking(view,t,r.cx),edge=view.panelState.feed.links.find(link=>link.kind==='collaboration');
 assert(byId(before,`panel-route-collaboration-${edge.a}-${edge.b}`));
 view.panelState.feed={...view.panelState.feed,links:view.panelState.feed.links.filter(link=>link.kind!=='collaboration')};
 const after=r.renderPanelTracking(view,t,r.cx);assert(!byId(after,`panel-route-collaboration-${edge.a}-${edge.b}`));
 for(const space of view.panelState.feed.spaces){assert(!byId(after,`panel-local-partner-${space.id}`));for(const agent of space.agents)assert(byId(after,`panel-agent-${agent.id}`));}
});


test('hosted message line uses the external gutter without narrowing the original card',async()=>{
 const r=await renderer(true),view=viewFor(makePanelFixture()),feed=view.panelState.feed;
 r.renderPanelTracking(view,t,r.cx);const layout=r.panelLayout(feed,view.panelEvents),[a,b]=feed.spaces[0].agents;
 const state={...view.panelEvents,packets:[{id:'external',kind:'message',from:a.id,to:b.id,phase:'travel',elapsed:500}]};
 const tree=r.panelFlowLayer(feed,layout,state,()=>t.accent,t,true,224,161),head=byId(tree,'panel-packet-external');
 const route=byId(tree,'panel-route-external');assert.equal(call(route,'w')[1],153);
 const x=432-161+call(head,'left')[1]+1;assert(x>=432-161&&x<432,'the packet stays in the gap beside the card, never in the CLI');
});

test('an explicit remote share connects both computer headers and the shared card as one F topology',async()=>{
 const r=await renderer(false),view=viewFor(makePanelFixture({share:'space'})),feed=view.panelState.feed;
 r.renderPanelTracking(view,t,r.cx);const layout=r.panelLayout(feed,view.panelEvents);
 const tree=r.panelFlowLayer(feed,layout,view.panelEvents,()=>t.accent,t,false,340);
 const shared=feed.spaces.find(space=>space.share);
 assert(byId(tree,`panel-route-share-computers-${shared.id}`));assert(byId(tree,`panel-route-share-${shared.id}`));
 for(const i of [0,1])assert(byId(tree,`panel-share-end-${shared.id}-${i}`));
 assert.equal(all(tree).filter(n=>call(n,'loop')||call(n,'transition')).length,0);
});

test('a proposed memory at closing step3 gets a header badge without inventing a proposal count',async()=>{
 const r=await renderer(false),raw=makePanelFixture();raw.spaces[0].memory.proposals=0;
 raw.spaces[0].agents[0].closing={step:3,memory:{state:'proposed',proposals:0}};
 const tree=r.renderPanelTracking(viewFor(raw),t,r.cx),badge=byId(tree,`panel-memory-${raw.spaces[0].id}`);
 assert(badge);assert(!words(badge).some(word=>/0/.test(word)));
});

test('native working state stays working after the last task reached stage5',async()=>{
 const r=await renderer(false),view=viewFor(makePanelFixture()),space=view.panelState.feed.spaces[0];
 const agent={...space.agents[0],stage:5,status:'working',closing:null};
 const state={packets:[],connections:[],spawning:new Set(),active:[]};
 const row=r.agentRow(view,agent,space,null,state,t.accent,t,false);
 assert.equal(call(row,'opacity')[1],1);assert(words(byId(row,`panel-status-${agent.id}`)).includes('●'));
 assert.deepEqual(r.panelCounts({spaces:[{agents:[agent]}]}),{working:1,idle:0,blocked:0,done:0,total:1});
});

test('closing warnings do not replace the observed working marker or summary',async()=>{
 const r=await renderer(false),view=viewFor(makePanelFixture()),space=view.panelState.feed.spaces[0];
 const agent={...space.agents[0],stage:5,status:'working',closing:{step:3,blocked_reason:'Save needs confirmation'}};
 const state={packets:[],connections:[],spawning:new Set(),active:[]};
 const row=r.agentRow(view,agent,space,null,state,t.accent,t,false);
 assert.equal(call(row,'opacity')[1],1);
 assert(words(byId(row,'panel-status-'+agent.id)).includes(String.fromCodePoint(0x25cf)));
 assert(call(row,'tooltip')[1].includes(agent.closing.blocked_reason));
 assert.deepEqual(r.panelCounts({spaces:[{agents:[agent]}]}),{working:1,idle:0,blocked:0,done:0,total:1});
});

// Mockup 26: producer row state, keep reason and cleanup countdown.
const stateRow=async(fields,{motion=false,now=Date.parse('2026-11-09T05:00:00Z'),tag=null,brief=false}={})=>{
 const r=await renderer(motion),raw=makePanelFixture();Object.assign(raw.spaces[0].agents[0],{stage:2,status:'idle',closing:null},fields);
 const view=viewFor(raw);view.now=now;const space=view.panelState.feed.spaces[0],agent=space.agents[0];
 if(brief)view.animated=new Set([agent.id]);
 const state={packets:[],connections:[],spawning:new Set(),active:[]};
 return {r,view,space,agent,row:r.agentRow(view,agent,space,tag,state,t.accent,t,motion)};
};
// Compact rows (ROW 24): the reason lives in the row tooltip, never as a second line.
const reasonOf=(row,agent)=>{
 assert.equal(byId(row,`panel-reason-${agent.id}`),undefined,'no reason line');
 return (call(row,'tooltip')?.[1]||'').split('\n').filter(line=>line!==agent.title&&line!==agent.tooltip_addr).find(line=>line.includes(' · '))||'';
};

test('a seven-state row draws the packaged glyph and keeps its live countdown reason in the tooltip',async()=>{
 const cleanup={idle_since:'2026-11-09T04:42:00Z',limit_s:1800,due_at:'2026-11-09T05:12:00Z'};
 const {agent,row}=await stateRow({status:'idle',state:'cleanup_wait',cleanup},{motion:true,brief:true});
 const glyph=all(byId(row,`panel-status-${agent.id}`)).find(n=>n.kind==='image');
 assert.equal(glyph.value,'mods/sixfold-desk/icons/status/cleanup_wait-12-dark.webp','animated within the brief window');
 const still=(await stateRow({status:'idle',state:'cleanup_wait',cleanup},{motion:true})).row;
 assert(all(still).find(n=>n.kind==='image').value.endsWith('cleanup_wait-12-dark.png'),'outside it the still PNG');
 assert.equal(reasonOf(row,agent),'정리 대기 · 30분 쉬면 닫힘 (남은 12분)');
 assert.equal(call(row,'h')[1],24,'a reason never grows a compact row');
 assert(call(row,'tooltip')[1].includes('남은 12분'));
});

test('keep reasons are shown verbatim, needs_human maps to its asset and motion-off uses stills',async()=>{
 let {agent,row}=await stateRow({status:'blocked',state:'needs_human',keep_reason:'사람 확인 기다림 · 닫지 않음'});
 assert.equal(all(byId(row,`panel-status-${agent.id}`)).find(n=>n.kind==='image').value,'mods/sixfold-desk/icons/status/needs_input-12-dark.png');
 assert.equal(reasonOf(row,agent),'확인 필요 · 사람 확인 기다림 · 닫지 않음');
 ({agent,row}=await stateRow({status:'done',state:'unseen_result',keep_reason:'수락 대기라 유지'}));
 assert.equal(call(row,'opacity')[1],1,'an unseen result is not dimmed');assert.equal(reasonOf(row,agent),'결과 안 봄 · 수락 대기라 유지');
 ({agent,row}=await stateRow({status:'idle',state:'closed',closing:{step:4,blocked_reason:'',memory:{state:'saved',proposals:0}}}));
 assert.equal(call(row,'opacity')[1],0.52);assert.equal(reasonOf(row,agent),'닫힘 · 기억함에 저장됨');
 ({agent,row}=await stateRow({status:'idle',state:'closing',closing:{step:2,blocked_reason:''}}));
 assert.equal(reasonOf(row,agent),'닫는 중 · 경험·결정 저장');
});

test('an event tag freezes the glyph, and an expired timer says the next cleanup closes it',async()=>{
 const cleanup={idle_since:'2026-11-09T04:00:00Z',limit_s:1800,due_at:'2026-11-09T04:30:00Z'};
 const {agent,row}=await stateRow({state:'cleanup_wait',cleanup},{motion:true,brief:true,tag:{id:'x',label:'검수 요청'}});
 assert(all(row).find(n=>n.kind==='image').value.endsWith('cleanup_wait-12-dark.png'));
 assert.equal(reasonOf(row,agent),'정리 대기 · 다음 정리 때 닫힘');
});

test('a feed without state keeps the four-status mark, one-line height and no reason line',async()=>{
 const {agent,row}=await stateRow({status:'working'});
 assert(words(byId(row,`panel-status-${agent.id}`)).includes('●'));assert(!all(row).some(n=>n.kind==='image'));
 assert.equal(byId(row,`panel-reason-${agent.id}`),undefined);assert.equal(call(row,'h')[1],24);
 const unknown=await stateRow({status:'working',state:'paused',cleanup:{idle_since:'x',limit_s:-1,due_at:'y'}});
 assert(words(byId(unknown.row,`panel-status-${unknown.agent.id}`)).includes('●'));assert.equal(byId(unknown.row,`panel-reason-${unknown.agent.id}`),undefined);
 const kept=await stateRow({status:'working',keep_reason:'하위 작업 2개 있어 유지'});
 assert.equal(reasonOf(kept.row,kept.agent),'작업 중 · 하위 작업 2개 있어 유지','a keep reason without state uses the four-status label');
});

test('a reason never grows the compact card, routes stay centred on the row, and the countdown wakes once a minute',async()=>{
 const now=Date.now(),r=await renderer(false),raw=makePanelFixture();
 Object.assign(raw.spaces[0].agents[0],{status:'idle',state:'cleanup_wait',cleanup:{idle_since:new Date(now-60000).toISOString(),limit_s:1800,due_at:new Date(now+90500).toISOString()}});
 const view=viewFor(raw),plain=viewFor(makePanelFixture());
 const layout=r.panelLayout(view.panelState.feed,{tags:new Map()}),before=r.panelLayout(plain.panelState.feed,{tags:new Map()});
 const id=view.panelState.feed.spaces[0].agents[0].id,row=layout.cards[0].rows.find(item=>item.agent?.id===id);
 assert.equal(layout.cards[0].height,before.cards[0].height);
 assert.equal(layout.anchors.get(id).y,row.y+r.PANEL_GEOMETRY.row/2);
 r.renderPanelTracking(view,t,r.cx);
 const wake=r.timers.at(-1).ms;assert(wake>25000&&wake<=30600,`wakes at the next minute boundary, got ${wake}`);
});

test('a cleanup row shows its short label in the stage slot, one line high, beside the glyph',async()=>{
 const cleanup={idle_since:'2026-11-09T04:42:00Z',limit_s:1800,due_at:'2026-11-09T05:12:00Z'};
 const cases=[
  [{status:'done',stage:5,state:'cleanup_wait',cleanup,keep_reason:'30분 쉬면 정리'},'정리 대기 12분',t.muted],
  [{status:'idle',stage:2,state:'cleanup_wait',cleanup},'정리 대기 12분',t.muted],
  [{status:'idle',stage:5,state:'closing',closing:{step:1,blocked_reason:''}},'보관 중',t.ansi6],
  [{status:'idle',stage:5,state:'closing',closing:{step:2,blocked_reason:''}},'닫는 중',t.ansi6],
  [{status:'done',stage:5,state:'closed',closing:{step:4,blocked_reason:''}},'닫힘',t.dim],
 ];
 for(const [fields,label,tone] of cases){
  const {agent,row}=await stateRow(fields);
  const chip=byId(row,`panel-cleanup-${agent.id}`);
  assert(chip,label);assert.deepEqual(words(chip),[label]);
  assert.equal(call(chip,'text_color')[1],tone);assert(call(chip,'truncate'),'a long label truncates inside the slot');
  assert.equal(all(row).filter(n=>call(n,'id')?.[1]?.startsWith(`panel-stage-${agent.id}-`)).length,0,'the label replaces the segments');
  const slot=all(row).find(n=>n.nodes?.includes(chip));
  assert.equal(call(slot,'w')[1],64);assert.equal(call(slot,'h')[1],18);
  assert.equal(call(row,'h')[1],24,'one line');
  assert(byId(row,`panel-status-${agent.id}`),'the glyph stays');
 }
});

test('an event tag still wins the slot; working, idle and blocked closing rows get no cleanup label',async()=>{
 const cleanup={idle_since:'2026-11-09T04:42:00Z',limit_s:1800,due_at:'2026-11-09T05:12:00Z'};
 let {agent,row}=await stateRow({state:'cleanup_wait',cleanup},{tag:{id:'x',label:'검수 요청'}});
 assert.equal(byId(row,`panel-cleanup-${agent.id}`),undefined);assert(words(row).includes('검수 요청'));
 for(const fields of [{status:'working',state:'working'},{status:'idle',state:'idle',keep_reason:'30분 쉬면 정리'},
  {status:'blocked',state:'needs_human',closing:{step:1,blocked_reason:'정리를 완료하지 못했습니다'}},{status:'done',stage:5,closing:{step:1,blocked_reason:''}}]){
  ({agent,row}=await stateRow(fields));
  assert.equal(byId(row,`panel-cleanup-${agent.id}`),undefined,JSON.stringify(fields));
 }
});

test('the cleanup label counts down on the row wake: a new minute gives new text',async()=>{
 const cleanup={idle_since:'2026-11-09T04:42:00Z',limit_s:1800,due_at:'2026-11-09T05:12:00Z'};
 const first=await stateRow({state:'cleanup_wait',cleanup},{now:Date.parse('2026-11-09T05:00:00Z')});
 const later=await stateRow({state:'cleanup_wait',cleanup},{now:Date.parse('2026-11-09T05:01:00Z')});
 const done=await stateRow({state:'cleanup_wait',cleanup},{now:Date.parse('2026-11-09T05:12:00Z')});
 assert.deepEqual(words(byId(first.row,`panel-cleanup-${first.agent.id}`)),['정리 대기 12분']);
 assert.deepEqual(words(byId(later.row,`panel-cleanup-${later.agent.id}`)),['정리 대기 11분']);
 assert.deepEqual(words(byId(done.row,`panel-cleanup-${done.agent.id}`)),['정리 대기']);
});

test('producer wait categories remain readable in a 24px row even when native status is done',async()=>{
 for(const [wait_kind,label] of [
  ['review_pending','검수 대기'],['report_delivery','보고전달대기'],['acceptance','수락 대기'],
  ['input','입력 확인'],['identity','신원 확인'],['cleanup','정리 확인'],
  ['conversation','대화 보호'],['last_pane','마지막 칸'],['pinned','고정 유지'],
  ['in_use','사용 중'],['status','상태 확인'],['review','검수 확인'],['report','보고 확인'],
 ]) {
  const keep_reason='Producer detail retained in the tooltip';
  const {agent,row}=await stateRow({status:'done',stage:5,state:'idle',keep_reason,wait_kind});
  assert.deepEqual(words(byId(row,`panel-wait-${agent.id}`)),[label]);
  assert.equal(call(row,'h')[1],24);
  assert.equal(byId(row,`panel-reason-${agent.id}`),undefined);
  assert(call(row,'tooltip')[1].includes(keep_reason));
  assert.equal(all(row).filter(n=>call(n,'w')?.[1]===64&&call(n,'h')?.[1]===18).length,1);
 }
});
test('a pane blocked on the person reads 권한 확인 before any closing category',async()=>{
 for(const wait_kind of ['cleanup','review_pending',undefined]){
  const keep_reason='Closing detail retained in the tooltip';
  const {agent,row}=await stateRow({status:'blocked',state:'idle',keep_reason,wait_kind});
  assert.deepEqual(words(byId(row,`panel-wait-${agent.id}`)),['권한 확인'],String(wait_kind));
 }
 const {agent,row}=await stateRow({status:'done',stage:5,state:'idle',keep_reason:'x',wait_kind:'cleanup'});
 assert.deepEqual(words(byId(row,`panel-wait-${agent.id}`)),['정리 확인'],'not blocked: the category as before');
});
test('wait labels require producer evidence and preserve progress and cleanup without hiding blockers',async()=>{
 let item=await stateRow({status:'working',stage:2});
 assert.equal(byId(item.row,`panel-wait-${item.agent.id}`),undefined);
 assert(byId(item.row,`panel-stage-${item.agent.id}-0`));
 item=await stateRow({status:'done',stage:5});
 assert.equal(byId(item.row,`panel-wait-${item.agent.id}`),undefined);
 for(const [state,label] of [['needs_human','입력 필요'],['unseen_result','결과 확인']]){
  item=await stateRow({status:'done',stage:5,state});
  assert.deepEqual(words(byId(item.row,`panel-wait-${item.agent.id}`)),[label]);
 }
 item=await stateRow({state:'closing',wait_kind:'identity',closing:{step:2,blocked_reason:'Identity detail'}});
 assert.deepEqual(words(byId(item.row,`panel-wait-${item.agent.id}`)),['신원 확인']);
 item=await stateRow({state:'cleanup_wait',keep_reason:'보고 완료'});
 assert(byId(item.row,`panel-cleanup-${item.agent.id}`));
 assert.equal(byId(item.row,`panel-wait-${item.agent.id}`),undefined);
 item=await stateRow({state:'idle',wait_kind:'review_pending',keep_reason:'Review detail'},{tag:{label:'검수 요청'}});
 assert.deepEqual(words(byId(item.row,`panel-wait-${item.agent.id}`)),['검수 대기']);
 assert(all(item.row).some(n=>call(n,'tooltip')?.[1].includes('검수 요청')));
});

test('only the explicit active category preserves progress; text never overrides a category',async()=>{
 const active=await stateRow({status:'working',state:'working',stage:2,wait_kind:'active',keep_reason:'Producer activity detail'});
 assert.equal(byId(active.row,`panel-wait-${active.agent.id}`),undefined);
 assert(byId(active.row,`panel-stage-${active.agent.id}-1`));
 assert(call(active.row,'tooltip')[1].includes('Producer activity detail'));
 // A working row draws its live stage bar whatever keeps it from closing; the
 // category shows once it rests and the reason stays in the tooltip meanwhile.
 for(const wait_kind of ['review_pending','identity','input']){
  const working=await stateRow({status:'working',state:'working',stage:2,wait_kind,keep_reason:'Producer activity detail'});
  assert.equal(byId(working.row,`panel-wait-${working.agent.id}`),undefined);
  assert(byId(working.row,`panel-stage-${working.agent.id}-1`));
  assert(call(working.row,'tooltip')[1].includes('Producer activity detail'));
 }
 const resting=await stateRow({status:'idle',state:'idle',stage:2,wait_kind:'review_pending',keep_reason:'Producer activity detail'});
 assert.deepEqual(words(byId(resting.row,`panel-wait-${resting.agent.id}`)),['검수 대기']);
 for(const wait_kind of [undefined,'future_category','constructor']){
  const unknown=await stateRow({state:'idle',wait_kind,keep_reason:'Review, acceptance or identity words are only text'});
  assert.deepEqual(words(byId(unknown.row,`panel-wait-${unknown.agent.id}`)),['상태 확인']);
 }
});

test('a status image animates for the brief window after a state change, then the panel wakes to the still PNG',async()=>{
 const r=await renderer(true),raw=makePanelFixture();
 const realNow=Date.now;let now=Date.parse('2026-11-09T05:00:00Z');
 try{
  Date.now=()=>now;
  Object.assign(raw.spaces[0].agents[0],{state:'idle',status:'idle'});
  const view=viewFor(raw),agent=view.panelState.feed.spaces[0].agents[0];
  assert.equal(r.briefRows(view,view.panelState.feed,true,now),null,'first sight: still');
  now+=5000;agent.state='needs_human';
  const at=r.briefRows(view,view.panelState.feed,true,now);
  assert(view.animated.has(agent.id));assert.equal(at,now+8000);
  assert.equal(r.briefRows(view,view.panelState.feed,false,now),null,'motion off: never animated');
  now+=8000;
  assert.equal(r.briefRows(view,view.panelState.feed,true,now),null);assert(!view.animated.has(agent.id));
  // Working, too, moves only for the brief window: a spinner that runs while the agent
  // works redraws the whole window on every frame.
  agent.state='working';agent.status='working';
  r.briefRows(view,view.panelState.feed,true,now);assert(view.animated.has(agent.id));
  now+=8000;
  assert.equal(r.briefRows(view,view.panelState.feed,true,now),null,'still working: holds the still image');
  assert(!view.animated.has(agent.id));
  assert.equal(r.briefRows(view,view.panelState.feed,false,now),null,'motion off: never animated');
 }finally{Date.now=realNow;}
});

test('field case renders role chips, held-issue chips, issue labels and the folded 오늘 마무리 row',async()=>{
  const r=await renderer(false),{feed,ids}=makeLedgerFieldFeed({now:Date.now()}),view=viewFor(feed);
  const space=view.panelState.feed.spaces[0];view.panelWidth=540;
  const tree=r.renderPanelTracking(view,t,r.cx);
  assert.deepEqual(words(byId(tree,`panel-role-${ids[12]}`)),['구현']);
  assert.deepEqual(words(byId(tree,`panel-role-${ids[13]}`)),['검수'],'a review row with the original title still reads 검수');
  assert.deepEqual(words(byId(tree,`panel-role-${ids[3]}`)),['통합']);
  assert.equal(byId(tree,`panel-role-${ids[16]}`),undefined,'no role, no chip');
  const held=byId(tree,`panel-issues-${ids[13]}`);
  assert.deepEqual(words(held),['+1 이슈']);assert.match(call(held,'tooltip')[1],/DEMO-411/);
  assert.deepEqual(words(byId(tree,`panel-issues-${ids[3]}`)),['+3 이슈']);
  assert.equal(byId(tree,`panel-issues-${ids[12]}`),undefined);
  assert(words(byId(tree,`panel-issue-${space.id}-DEMO-412`)).includes('쉬는 중'));
  assert(words(byId(tree,`panel-issue-${space.id}-DEMO-490`)).includes('작업 중 1'));
  assert.equal(byId(tree,`panel-issue-${space.id}-DEMO-502`),undefined);
  const done=byId(tree,`panel-done-${space.id}`);
  assert.deepEqual(words(done),['▸ 오늘 마무리 1']);
  assert.equal(byId(tree,`panel-issue-${space.id}-DEMO-417`),undefined,'folded by default');
  call(done,'on_click')[1]({}, {stop_propagation(){}});
  assert(view.expandedIssueSpaces.has(space.id));
  const open=r.renderPanelTracking(view,t,r.cx);
  assert.deepEqual(words(byId(open,`panel-done-${space.id}`)),['▾ 오늘 마무리 1']);
  assert(words(byId(open,`panel-issue-${space.id}-DEMO-417`)).includes('✓ 마무리'));
  const fold=byId(open,`panel-fold-${space.id}-${ids[3]}`);
  assert.deepEqual(words(fold),['+2 하위 작업 · 이슈 미확인']);
  const layout=r.panelLayout(view.panelState.feed,view.panelEvents,[],new Map([[space.id,(await import('../mods/sixfold-desk/panel-model.js')).agentGroups(space,{expandedIssueSpaces:view.expandedIssueSpaces})]]));
  const kinds=layout.cards[0].rows.map(row=>row.kind);
  assert.equal(kinds.filter(kind=>kind==='done-more').length,1);
  assert(kinds.indexOf('done-more')<kinds.lastIndexOf('issue'),'today\'s issues follow their fold row');
  for(const row of layout.cards[0].rows.filter(row=>row.kind==='agent'))assert.equal(layout.anchors.get(row.agent.id).y,row.y+row.height/2);
});

test('without the new fields no role, held-issue or 오늘 마무리 rows are drawn',async()=>{
  const r=await renderer(false),{feed,ids}=makeLedgerFieldFeed({now:Date.now(),ledger:false}),view=viewFor(feed);
  const tree=r.renderPanelTracking(view,t,r.cx),space=view.panelState.feed.spaces[0];
  for(let n=1;n<=16;n++){assert.equal(byId(tree,`panel-role-${ids[n]}`),undefined);assert.equal(byId(tree,`panel-issues-${ids[n]}`),undefined);}
  assert.equal(byId(tree,`panel-done-${space.id}`),undefined);
  for(const issue of space.issues)assert(byId(tree,`panel-issue-${space.id}-${issue.key}`),issue.key);
});

test('224px: role and held-issue count share one shrinkable chip and the title keeps its minimum width',async()=>{
  const r=await renderer(false),{feed,ids}=makeLedgerFieldFeed({now:Date.now()}),view=viewFor(feed);
  view.panelWidth=224;const tree=r.renderPanelTracking(view,t,r.cx);
  for(const n of [3,12,13]){
    assert.equal(byId(tree,`panel-role-${ids[n]}`),undefined);assert.equal(byId(tree,`panel-issues-${ids[n]}`),undefined);
    const title=byId(tree,`panel-title-${ids[n]}`);
    assert.equal(call(title,'flex_1')?.[0],'flex_1');
    assert.equal(title.calls.filter(c=>c[0]==='min_w').at(-1)[1],r.TITLE_MIN,`row ${n} title keeps ${r.TITLE_MIN}px`);
    const tags=byId(tree,`panel-tags-${ids[n]}`);
    assert(!call(tags,'flex_none'),'the chip shrinks first');assert(call(tags,'truncate'));
  }
  assert.deepEqual(words(byId(tree,`panel-tags-${ids[13]}`)),['검+1']);
  assert.deepEqual(words(byId(tree,`panel-tags-${ids[3]}`)),['통+3']);
  assert.deepEqual(words(byId(tree,`panel-tags-${ids[12]}`)),['구']);
  assert.match(call(byId(tree,`panel-tags-${ids[13]}`),'tooltip')[1],/역할 검수[\s\S]*DEMO-411/);
  assert.match(call(byId(tree,`panel-agent-${ids[13]}`),'tooltip')[1],/DEMO-411/,'the row tooltip keeps the full list');
  const plain=byId(tree,`panel-title-${ids[16]}`);
  assert.equal(plain.calls.filter(c=>c[0]==='min_w').at(-1)[1],0,'a row without chips keeps the old title');
  assert.equal(byId(tree,`panel-tags-${ids[16]}`),undefined);
  assert(r.TITLE_MIN>=28);
});
