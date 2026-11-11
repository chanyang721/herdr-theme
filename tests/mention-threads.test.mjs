import test from 'node:test';
import assert from 'node:assert/strict';
import {threadGroups,threadKey,readable,freshness,collectLine} from '../mods/sixfold-slack-inbox/model.js';
const item={id:'slack:C1:100.1',channel:'C1',channel_name:'#project',project:'Project B',at:'2026-11-03T12:00:00+09:00',text:'<@U00000001>\n합계를 확인해 주세요',link:'https://example.slack.com/archives/C1/p1001?thread_ts=90.1&cid=C1'};
test('multiple tagged replies form one thread; identical ts in another channel stays separate',()=>{
 const newer={...item,id:'slack:C1:101.1',at:'2026-11-03T13:00:00+09:00'};
 const groups=threadGroups([item,item,newer,{...item,id:'slack:C2:100.1',channel:'C2'}]);
 assert.equal(groups.length,2);assert.equal(groups[0].items.length,2);
 assert.equal(groups[0].latest.id,newer.id);assert.equal(groups[0].unread,2);
 assert.equal(groups[0].title,'합계를 확인해 주세요');
});
test('confirming existing replies survives refresh, and a later reply reopens only that thread',()=>{
 const read={[item.id]:item.id};
 assert.equal(threadGroups([item],read)[0].unread,0);
 const reply={...item,id:'slack:C1:102.1',at:'2026-11-03T14:00:00+09:00'};
 assert.equal(threadGroups([item,reply],read)[0].unread,1);
 assert.equal(threadGroups([item],read)[0].items[0].text,item.text);
});
test('explicit parent is authoritative, and top-level messages have distinct thread identities',()=>{
 assert.equal(threadKey({...item,thread_ts:'80.1'}),'C1:80.1');
 assert.notEqual(threadKey({...item,link:''}),threadKey({...item,link:'',id:'slack:C1:101.1'}));
});
test('Slack display markup is readable without losing its content',()=>{
 assert.equal(readable('<@U1|홍길동> &amp; <https://example.com|자료>'),'@홍길동 & 자료');
 assert.equal(readable('<@U00000001> 확인',{U00000001:'나'}),'@나 확인');
 assert.equal(readable('<@U00000001> 확인'),'<@U00000001> 확인');
});

test('a stalled mirror and the Slack app badge are spelled out', () => {
  const now = Date.parse('2026-11-10T00:30:00Z');
  assert.match(freshness({mirror_latest_at: '2026-11-07T01:16:11Z', app_badge: '1'}, now), /미러 지연 가능 · Slack 앱 미확인 표시 1$/);
  assert.equal(freshness({mirror_latest_at: '2026-11-10T00:00:00Z', app_badge: ''}, now), '');
  assert.equal(freshness({app_badge: '•'}, now), 'Slack 앱 미확인 표시 있음');
  assert.equal(freshness({}, now), '');
});

test('collection line names the Slack connector, the trigger and a fixed error label only', () => {
  const at='2026-11-11T17:52:19+09:00',ok='2026-11-11T17:52:20+09:00';
  const line=collectLine({source:'claude-slack-connector',state:'ok',last_trigger:'badge',last_trigger_at:at,last_success:ok,catchup_minutes:30});
  assert.match(line,/^수집: Slack 커넥터 · 확인됨 · 마지막 수집 \d\d:\d\d 배지 변화 · 마지막 성공 \d\d:\d\d · 배지 변화 때와 평일 30분 따라잡기$/);
  assert.match(collectLine({source:'claude-slack-connector',state:'error',error_kind:'needs_auth_cache',last_trigger:'catchup',last_trigger_at:at}),/조회 실패 · 커넥터 인증 캐시 확인 필요 · 마지막 수집 \d\d:\d\d 따라잡기 · 마지막 성공 아직 없음/);
  assert.match(collectLine({source:'claude-slack-connector',state:'error',error_kind:'timeout'}),/조회 실패 · 시간 초과 · 마지막 성공/);
  assert.doesNotMatch(collectLine({source:'claude-slack-connector',state:'error',error_kind:'xoxb-SECRET',error:'xoxb-SECRET raw'}),/xoxb|SECRET|raw/);
  assert.equal(collectLine({state:'ok',last_success:'10:00'}),'수집: 확인됨 · 마지막 성공 10:00 · 60초마다 조회 시도');
  assert.match(collectLine(null),/^수집: 상태 확인 전/);
});
