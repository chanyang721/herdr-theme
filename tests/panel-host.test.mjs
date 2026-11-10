import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeTaskSpace,hostedTaskLayout,taskComputerAnchors,panelFlowAnchor,PANEL_FLOW,taskComputerRecord,messageFlowGeometry,PANEL_BREAKPOINTS,panelWidthClass} from '../mods/sixfold-desk/panel-host.js';

test('task rows join the selected computer by explicit identity, never by workspace name',()=>{
  const local={id:'local',name:'Demo',nav:{space_id:'sp1',machine:null}};
  const remote={id:'remote',name:'Demo',nav:{space_id:'sp1',machine:'worker'}};
  const unbound={id:'unbound',name:'Demo',nav:null};
  const feed={spaces:[remote,local,unbound]};
  assert.equal(nativeTaskSpace(feed,{id:'sp1',machine:null}),local);
  assert.equal(nativeTaskSpace(feed,{id:'worker/sp1',machine:'worker'}),remote);
  assert.equal(nativeTaskSpace(feed,{id:'sp2',name:'Demo',machine:null}),null);
  assert.equal(nativeTaskSpace({spaces:[local,{...local,id:'ambiguous'}]},{id:'sp1'}),null);
});

test('computer endpoints stay available when the selected workspace list changes',()=>{
  const feed={computers:[{id:'local'},{id:'remote'},{id:'ambiguous'}],spaces:[
    {computer:'local',nav:{machine:null}},{computer:'remote',nav:{machine:'worker'}},
    {computer:'ambiguous',nav:{machine:null}},{computer:'ambiguous',nav:{machine:'worker'}}]};
  const computers=taskComputerAnchors(feed,[{name:null},{name:'worker'}],81,31);
  assert.deepEqual(computers.map(([id])=>id),['local','remote']);
  const layout=hostedTaskLayout({cards:[],anchors:new Map()},[],computers);
  assert.equal(layout.anchors.get('local').y,-94);
  assert.equal(layout.anchors.get('remote').y,-55);
});

test('hosted routes use selected native order and measured document/card heights',()=>{
  const a={id:'a'},b={id:'b'},remote={id:'remote'};
  const card=(space,top)=>({space,top,rows:[{kind:'agent',agent:{id:space.id+'-row'},y:top+61,height:28}]});
  const layout={cards:[card(remote,0),card(b,100),card(a,200)],anchors:new Map(['a','b','remote'].flatMap(id=>[[id,{kind:'space',space:id}],[id+'-row',{kind:'agent',space:id}]]))};
  const host=hostedTaskLayout(layout,[{task:a,height:200,alertHeight:26},{task:null,height:90},{task:b,height:110}]);
  assert.deepEqual(host.cards.map(card=>card.space.id),['a','b']);
  assert.equal(host.anchors.has('remote'),false);
  assert.equal(host.anchors.get('a-row').y,107);
  assert.equal(host.anchors.get('b').y,332);
  assert.equal(host.height,436);
});

test('hosted routes keep each row anchor on its title line, also for two-line reason rows',()=>{
  const space={id:'a'},top=100,y=top+61;
  // panelLayout puts root anchors at row+14 (title line) and child anchors at the middle of a 20px row.
  const rows=[{kind:'agent',agent:{id:'reason'},y,height:42},{kind:'agent',agent:{id:'child'},y:y+42,height:20}];
  const layout={cards:[{space,top,rows}],anchors:new Map([['a',{kind:'space',space:'a',y:top+18}],['reason',{kind:'agent',space:'a',y:y+14}],['child',{kind:'agent',space:'a',y:y+42+10}]])};
  const host=hostedTaskLayout(layout,[{task:space,height:200,alertHeight:0}]);
  const [reason,child]=host.cards[0].rows;
  assert.equal(host.anchors.get('reason').y,reason.y+14);
  assert.equal(host.anchors.get('child').y,child.y+10);
});


test('flow lanes stay outside cards in ordered bands; only proven remote endpoints use computer anchors',()=>{
 const feed={computers:[{id:'local'},{id:'remote'}],spaces:[{id:'one',computer:'local',nav:{machine:null},agents:[{id:'a'}]},{id:'two',computer:'remote',nav:{machine:'worker'},agents:[{id:'b'}]}]};
 const remote={kind:'computer',computer:'remote',y:10},local={kind:'agent',computer:'local',y:50};
 const layout={cards:[{space:feed.spaces[0]}],anchors:new Map([['remote',remote],['a',local]])};
 assert.equal(panelFlowAnchor(feed,layout,'a'),local);assert.equal(panelFlowAnchor(feed,layout,'b'),remote);
 assert.equal(panelFlowAnchor(feed,layout,'two'),remote);assert.equal(panelFlowAnchor(feed,layout,'unknown'),null);
 layout.anchors.delete('a');assert.equal(panelFlowAnchor(feed,layout,'a'),null);
 assert.equal(PANEL_FLOW.endpoint,0);assert(PANEL_FLOW.message<PANEL_FLOW.messageNext);assert(PANEL_FLOW.messageNext<PANEL_FLOW.collaboration);assert(PANEL_FLOW.collaboration<PANEL_FLOW.computer);
 assert.equal(taskComputerRecord(feed,'worker').id,'remote');assert.equal(taskComputerRecord(feed,null).id,'local');
 assert.equal(taskComputerRecord(feed,'name-only'),null);
});


test('the fixed gutter contains message curves, collaboration and outer computer lanes',()=>{
 // One gutter for every sidebar width: nothing in it depends on the width.
 const flow=messageFlowGeometry(PANEL_FLOW.gutter);
 assert.equal(PANEL_FLOW.gutter,48);
 assert.equal(flow.collaboration,22);assert.equal(flow.computer,28);
 assert(flow.messageNext<flow.collaboration);assert(flow.collaboration<flow.computer);
 assert.equal(flow.width+flow.right,PANEL_FLOW.gutter);
});

test('the sidebar width only matters at the layout breakpoints',()=>{
 assert.deepEqual([...PANEL_BREAKPOINTS],[260,300,420]);
 assert.deepEqual([224,259,260,299,300,419,420,680].map(panelWidthClass),[0,0,1,1,2,2,3,3]);
});

test('each of four remote computers has its own outer lane',async()=>{
 const {computerFlow}=await import('../mods/sixfold-desk/panel-host.js');
 const feed={computers:['local','a','b','c','d'].map(id=>({id})),spaces:[]};
 assert.deepEqual(['a','b','c','d'].map(id=>computerFlow(feed,id).computer),[28,32,36,40]);
});
