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

test('wait category survives cleaning and projection and changing only it updates the row',()=>{
  const raw=feed([base('a',{keep_reason:'Unchanged producer detail',wait_kind:'review_pending'}),base('b')]);
  const before=cleanPanelFeed(raw),first=projectPanelFeed(before);
  assert.equal(first.agents.get('a').wait_kind,'review_pending');
  raw.spaces[0].agents[0].wait_kind='report_delivery';
  const second=projectPanelFeed(cleanPanelFeed(raw),first);
  assert.equal(second.agents.get('a').wait_kind,'report_delivery');
  assert.notEqual(second.agents.get('a'),first.agents.get('a'));
  assert.equal(second.agents.get('b'),first.agents.get('b'));
  assert.equal(first.agents.get('a').wait_kind,'review_pending');
  raw.spaces[0].agents[0].wait_kind='future_category';
  assert.equal(Object.hasOwn(cleanPanelFeed(raw).spaces[0].agents[0],'wait_kind'),false);
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

test('the short cleanup label names waiting, saving, closing and closed from the producer state only',async()=>{
  const {agentCleanupLabel}=await import('../mods/sixfold-desk/panel-model.js');
  const cleanup={idle_since:'2026-11-09T04:42:00Z',limit_s:1800,due_at:'2026-11-09T05:12:00Z'},now=at('2026-11-09T05:00:00Z');
  const rows=cleanPanelFeed(feed([
    base('wait',{state:'cleanup_wait',cleanup}),base('late',{state:'cleanup_wait',cleanup:{...cleanup,due_at:'2026-11-09T04:59:00Z'}}),
    base('bare',{state:'cleanup_wait'}),base('long',{state:'cleanup_wait',cleanup:{idle_since:'2026-11-09T04:00:00Z',limit_s:3*3600,due_at:'2026-11-09T07:00:00Z'}}),
    base('save',{state:'closing',closing:{step:1,blocked_reason:''}}),base('report',{state:'closing',closing:{step:2,blocked_reason:''}}),
    base('memo',{state:'closing',closing:{step:3,blocked_reason:''}}),base('gone',{state:'closed',closing:{step:4,blocked_reason:''}}),
    base('stuck',{state:'needs_human',status:'blocked',closing:{step:1,blocked_reason:'정리를 완료하지 못했습니다'}}),
    base('unseen',{state:'unseen_result',cleanup}),base('idle',{state:'idle',keep_reason:'30분 쉬면 정리'}),base('old',{closing:{step:1,blocked_reason:''}}),
  ])).spaces[0].agents;
  const label=id=>agentCleanupLabel(rows.find(a=>a.id===id),now)?.text??null;
  assert.equal(label('wait'),'정리 대기 12분');
  assert.equal(agentCleanupLabel(rows[0],at('2026-11-09T05:11:01Z')).text,'정리 대기 1분','minutes round up like the reason line');
  assert.equal(label('late'),'정리 대기','an expired timer drops the time');
  assert.equal(label('bare'),'정리 대기');
  assert.equal(label('long'),'정리 대기 2시간');
  assert.equal(label('save'),'보관 중');assert.equal(label('report'),'닫는 중');assert.equal(label('memo'),'닫는 중');
  assert.equal(label('gone'),'닫힘');
  assert.equal(label('unseen'),'정리 대기 12분','an unseen result on a cleanup timer is waiting too');
  assert.equal(agentCleanupLabel({...rows.find(a=>a.id==='unseen'),cleanup:null},now),null);
  for(const id of ['stuck','idle','old'])assert.equal(label(id),null,id);
  assert.equal(agentCleanupLabel(null),null);
});
