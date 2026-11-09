import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanPanelFeed,projectPanelFeed,agentRowState,agentHasReason,agentReason,ROW_STATES} from '../mods/sixfold-desk/panel-model.js';

// docs/panel-feed.md: optional row state, keep_reason and cleanup countdown.
const feed=agents=>({v:1,at:'2026-11-09T05:00:00Z',computers:[{id:'c1',name:'Desk'}],spaces:[{id:'s1',name:'One',computer:'c1',agents}]});
const base=(id,fields={})=>({id,family:'claude',title:id,stage:2,status:'idle',closing:null,nav:null,...fields});
const at=value=>Date.parse(value);

test('the seven contract states survive cleaning and projection; anything else is dropped',()=>{
  assert.deepEqual(ROW_STATES,['working','idle','needs_human','unseen_result','cleanup_wait','closing','closed']);
  const clean=cleanPanelFeed(feed([...ROW_STATES.map(state=>base(state,{state})),base('bad',{state:'needs_input'}),base('old')]));
  const agents=clean.spaces[0].agents;
  for(const state of ROW_STATES)assert.equal(agentRowState(agents.find(a=>a.id===state)),state);
  assert.equal(Object.hasOwn(agents.find(a=>a.id==='bad'),'state'),false);
  assert.deepEqual(Object.keys(agents.find(a=>a.id==='old')).sort(),['closing','family','id','issue','nav','stage','status','title','tooltip_addr'].sort());
  assert.equal(projectPanelFeed(clean).agents.get('cleanup_wait').state,'cleanup_wait');
});

test('cleanup timers are absolute, bounded and copied; malformed timers become null',()=>{
  const good={idle_since:'2026-11-09T04:42:00Z',limit_s:1800,due_at:'2026-11-09T05:12:00Z'};
  const clean=cleanPanelFeed(feed([base('a',{state:'cleanup_wait',cleanup:good,keep_reason:'  30분 쉬면 정리\n'}),
    base('b',{state:'cleanup_wait',cleanup:{...good,limit_s:0}}),base('c',{state:'cleanup_wait',cleanup:{...good,due_at:'2026-11-09T04:00:00Z'}}),
    base('d',{state:'cleanup_wait',cleanup:'soon'}),base('e',{keep_reason:''})]));
  const [a,b,c,d,e]=clean.spaces[0].agents;
  assert.deepEqual(a.cleanup,{idle_since:at(good.idle_since),limit_s:1800,due_at:at(good.due_at)});assert.equal(a.keep_reason,'30분 쉬면 정리');
  for(const agent of [b,c,d])assert.equal(agent.cleanup,null);
  assert.equal(e.keep_reason,null);assert.equal(agentHasReason(e),false);
  const copy=projectPanelFeed(clean).agents.get('a');assert.deepEqual(copy.cleanup,a.cleanup);assert.notEqual(copy.cleanup,a.cleanup);
});

test('countdown text uses the producer limit and changes exactly at minute boundaries',()=>{
  const [agent]=cleanPanelFeed(feed([base('a',{state:'cleanup_wait',cleanup:{idle_since:'2026-11-09T04:42:00Z',limit_s:1800,due_at:'2026-11-09T05:12:00Z'}})])).spaces[0].agents;
  const now=at('2026-11-09T05:00:00Z');
  assert.deepEqual(agentReason(agent,now),{text:'30분 쉬면 닫힘 (남은 12분)',nextAt:at('2026-11-09T05:01:00Z')});
  assert.equal(agentReason(agent,now+30000).text,'30분 쉬면 닫힘 (남은 12분)');
  assert.equal(agentReason(agent,at('2026-11-09T05:01:00Z')).text,'30분 쉬면 닫힘 (남은 11분)');
  assert.deepEqual(agentReason(agent,at('2026-11-09T05:11:30Z')),{text:'30분 쉬면 닫힘 (남은 1분)',nextAt:at('2026-11-09T05:12:00Z')});
  assert.deepEqual(agentReason(agent,at('2026-11-09T05:12:00Z')),{text:'다음 정리 때 닫힘',nextAt:null});
  const accepted={...agent,cleanup:{...agent.cleanup,limit_s:300}};assert.match(agentReason(accepted,now).text,/^5분 쉬면 닫힘/);
});

test('timers only count on cleanup_wait and unseen_result rows; keep reasons stay verbatim',()=>{
  const cleanup={idle_since:'2026-11-09T04:42:00Z',limit_s:1800,due_at:'2026-11-09T05:12:00Z'},now=at('2026-11-09T05:00:00Z');
  const [working,unseen,kept]=cleanPanelFeed(feed([base('w',{state:'working',cleanup}),base('u',{state:'unseen_result',cleanup,keep_reason:'수락 대기라 유지'}),
    base('k',{state:'cleanup_wait',cleanup,keep_reason:'정리 대상 · 다음 정리 때 닫힘'})])).spaces[0].agents;
  assert.equal(agentHasReason(working),false);assert.deepEqual(agentReason(working,now),{text:'',nextAt:null});
  assert.equal(agentReason(unseen,now).text,'수락 대기라 유지 (남은 12분)');
  assert.equal(agentReason(kept,at('2026-11-09T06:00:00Z')).text,'정리 대상 · 다음 정리 때 닫힘');
});
