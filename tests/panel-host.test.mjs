import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeTaskSpace,hostedTaskLayout,taskComputerAnchors,panelFlowAnchor,PANEL_FLOW,taskComputerRecord} from '../mods/sixfold-desk/panel-host.js';

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
