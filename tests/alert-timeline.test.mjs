import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceAlertRows,workspaceAlertCounts,workspaceAlertTimeline,alertPeriod,RECENT_ALERT_MS,placeItems,linearUnread,scopedAlerts,setFallbackSpace,currentFallbackSpace} from '../mods/sixfold-desk/alert-model.js';
import {setSpaceMentions,spaceMentions} from '../mods/sixfold-desk/alert-mentions.js';

const now=new Date(2026,10,20,12,0).getTime();
const at=(days=0,hour=12,minute=0)=>new Date(2026,10,20+days,hour,minute).toISOString();
const feeds={space:'Alpha',
  slack:[{id:'s1',project:'Alpha',channel:'C1',channel_name:'alpha',author_id:'U1DEMO',author_name:'Kim',text:'<@U2DEMO|Lee>\n확인 부탁',at:at(0,11,59),link:'https://demo.slack.com/archives/C1/p1'},
    {id:'other-s',project:'Beta',channel:'C2',text:'다른 공간',at:at()}],
  linear:[{id:'l1',workspace:'Alpha',project:'Demo',issue:'DEMO-1',author_name:'Lee',subtitle:'검토했습니다',at:at(0,10),read:false,url:'https://linear.app/demo/issue/DEMO-1/title'},
    {id:'other-l',workspace:'Beta',project:'Other',issue:'OTHER-1',subtitle:'다른 공간',at:at()}],
  github:[{id:'g1',workspace:'Alpha',repo:'demo/alpha',number:4,kind:'review',author:'kim',title:'캐시 정리',at:at(-1),unread:true,url:'https://github.com/demo/alpha/pull/4'},
    {id:'other-g',workspace:'Beta',repo:'demo/beta',number:2,kind:'mention',at:at(),unread:true}],
};
const dto={items:[
  {id:'1',source:'slack',ref:'#alpha',sender:'Kim',summary:'최근 메시지',at:at(0,11,59),read:false},
  {id:'2',source:'linear',ref:'DEMO-1',sender:'Lee',summary:'이슈 변경',at:at(0,10),read:true},
  {id:'3',source:'github',ref:'demo/alpha#4',sender:'kim',summary:'리뷰 요청',at:at(-1),read:false},
  {id:'4',source:'slack',ref:'#alpha',sender:'Kim',summary:'지난 메시지',at:at(-3),read:true},
],unread:2,sources:['slack','linear','github']};

test('one space combines all three feeds, readable Slack names, refs, senders and one-line summaries',()=>{
  const data=workspaceAlertTimeline({...feeds,now});
  assert.deepEqual(data.rows.map(i=>i.id),['s1','l1','g1']);
  assert.deepEqual(data.rows.map(i=>[i.source,i.ref,i.sender]),[['slack','#alpha','Kim'],['linear','DEMO-1','Lee'],['github','demo/alpha#4','kim']]);
  assert.equal(data.rows[0].summary,'@Lee 확인 부탁');
  assert.equal(data.rows[2].summary,'캐시 정리 · kim 님이 리뷰 요청');
  assert.deepEqual(workspaceAlertCounts(feeds),{slack:1,linear:1,github:1,total:3});
  assert.equal(workspaceAlertTimeline({...feeds,space:'Unknown'}).total,0);
  assert.equal(workspaceAlertRows({...feeds,space:''}).length,0);
});

test('fallback placement keeps mentions and closed-space work in the same counts and timeline as existing badges',()=>{
  const names=['Alpha','Home'];
  const fallback=currentFallbackSpace();setFallbackSpace('Home');
  setSpaceMentions([
    {id:'dm',project:'',channel:'D1',text:'direct'},
    {id:'unmapped',project:'미연결',channel:'C2',text:'mention'},
    {id:'closed',project:'Gone',channel:'C3',text:'closed'},
    feeds.slack[0],
  ],names);
  try{
    const slack=spaceMentions('Home');
    const linear=placeItems([{id:'closed-linear',workspace:'Gone',project:'Other',read:false},feeds.linear[0]],names,'Home');
    const github=placeItems([{id:'unmapped-github',workspace:'',repo:'demo/other',unread:true},feeds.github[0]],names,'Home');
    const input={space:'Home',slack,linear,github,connections:{slack:[],linear:[],github:[]}};
    const counts=workspaceAlertCounts(input),timeline=workspaceAlertTimeline(input);
    assert.equal(counts.slack,scopedAlerts(slack,{project:'Home',unread:true}).length);
    assert.equal(counts.linear,linearUnread(linear,'Home'));
    assert.deepEqual(counts,{slack:3,linear:1,github:1,total:5});
    assert.deepEqual(timeline.rows.map(row=>row.id).sort(),['closed','closed-linear','dm','unmapped','unmapped-github']);
    assert.equal(timeline.unread,5);
    assert.equal(workspaceAlertRows({...input,space:'Gone'}).length,0,'the old space does not also list remapped items');
    assert.equal(workspaceAlertRows({...input,space:'Alpha'}).length,0,'shown-space items still obey explicit connection lists');
  }finally{setSpaceMentions([]);setFallbackSpace(fallback);}
});

test('an explicit connection list excludes other channels, projects and repositories even with a matching space label',()=>{
  assert.deepEqual(workspaceAlertRows({...feeds,connections:{slack:['C1'],linear:['Demo'],github:['DEMO/ALPHA']}}).map(i=>i.id),['s1','l1','g1']);
  assert.deepEqual(workspaceAlertRows({...feeds,connections:{slack:[],linear:['Other'],github:['demo/beta']}}),[]);
});

test('the space alerts DTO replaces older feeds, preserves its aggregate unread and does not guess absent data',()=>{
  const before=JSON.stringify(dto);
  const data=workspaceAlertTimeline({...feeds,alerts:dto,now});
  assert.deepEqual(data.rows.map(i=>i.id),['1','2','3','4']);
  assert.equal(data.unread,2);
  assert.deepEqual(data.groups.map(i=>[i.label,i.rows.length]),[['방금',1],['오늘',1],['어제',1],['이전',1]]);
  assert.equal(JSON.stringify(dto),before,'render projection cannot mark read or mutate the feed');
  assert.equal(workspaceAlertCounts({...feeds,alerts:{items:[],unread:8}}).total,8,'collector aggregate can include items beyond a capped list');
  assert.deepEqual(workspaceAlertRows({...feeds,alerts:{items:[]}}),[],'empty DTO does not fall back to stale native feeds');
});

test('latest first remains chronological across read state; search does not clear the space unread count',()=>{
  const alerts={items:dto.items.map((item,i)=>({...item,read:i!==1})),unread:1};
  const all=workspaceAlertTimeline({alerts,now});
  assert.deepEqual(all.rows.map(i=>i.id),['1','2','3','4'],'a read recent item stays ahead of an unread older item');
  const found=workspaceAlertTimeline({alerts,now,query:'DEMO-1'});
  assert.deepEqual(found.rows.map(i=>i.id),['2']);assert.equal(found.unread,1);assert.equal(found.total,4);
  assert.equal(workspaceAlertTimeline({alerts,query:'no match'}).unread,1);
});

test('local calendar boundaries cover midnight, month changes, exact recent threshold and invalid timestamps',()=>{
  const midnight=new Date(2026,11,1,0,2).getTime();
  assert.equal(alertPeriod(new Date(2026,10,30,23,59).toISOString(),midnight),'recent');
  assert.equal(alertPeriod(new Date(2026,10,30,23,0).toISOString(),midnight),'yesterday');
  assert.equal(alertPeriod(new Date(2026,10,29,23,0).toISOString(),midnight),'earlier');
  assert.equal(alertPeriod(new Date(now-RECENT_ALERT_MS).toISOString(),now),'today');
  assert.equal(alertPeriod('broken',now),'earlier');
  assert.equal(alertPeriod(at(1),now),'earlier','a future timestamp is not just received');
});

test('small clock skew stays recent, including across midnight, while distant future dates stay earlier',()=>{
  const midnight=new Date(2026,10,20,23,59,59).getTime();
  for(const clock of [now,midnight]){
    assert.equal(alertPeriod(new Date(clock+2000).toISOString(),clock),'recent');
    assert.equal(alertPeriod(new Date(clock+RECENT_ALERT_MS-1).toISOString(),clock),'recent');
    assert.equal(alertPeriod(new Date(clock+RECENT_ALERT_MS).toISOString(),clock),'earlier');
    const alerts={items:[
      {id:'future',source:'slack',at:new Date(clock+2000).toISOString(),read:false},
      {id:'current',source:'linear',at:new Date(clock).toISOString(),read:false},
    ]};
    const timeline=workspaceAlertTimeline({alerts,now:clock});
    assert.deepEqual(timeline.groups.map(group=>group.id),['recent']);
    assert.deepEqual(timeline.groups[0].rows.map(row=>row.id),['future','current']);
  }
});

test('source/id deduplication counts a tracked message and its mention once but preserves cross-service ids',()=>{
  const rows=workspaceAlertRows({space:'Alpha',slack:[feeds.slack[0],{...feeds.slack[0],text:'edited'}],
    linear:[{...feeds.linear[0],id:'s1'}],read:{s1:'s1'}});
  assert.equal(rows.length,2);assert.equal(rows.find(i=>i.source==='slack').summary,'edited');
  assert.deepEqual(rows.map(i=>i.read),[true,false]);
});

test('malformed DTO entries are ignored and unsupported links cannot become open actions',()=>{
  const rows=workspaceAlertRows({alerts:{items:[null,{},...['slack','linear','github'].map(source=>({id:'x',source,read:false,url:'javascript:alert(1)'})),
    {id:'unknown',source:'other',read:false},{id:'no-read',source:'slack'}]}});
  assert.equal(rows.length,3);assert(rows.every(i=>i.url===''));
  assert(rows.every(i=>i.sender==='보낸 사람 미확인'));
  assert.equal(workspaceAlertTimeline({alerts:{items:null}}).total,0);
});
