import test from 'node:test';
import {weekSummary} from '../mods/week-timeline/summary.js';
import {parseFeed} from '../mods/week-timeline/model.js';
import assert from 'node:assert/strict';
import {issueScopeData,issueCacheLabel,issueRequest,saveIssueRequest,parseTimelineFeed,spaceWithTimeline,rowStatus,weekMembers} from '../mods/sixfold-desk/task-issue-state.js';
const a={key:'DEMO-1',title:'Build panel',state:'working'},b={key:'DEMO-2',title:'Search é',state:'done',pinned:true,milestone_id:'m1'};
const space={id:'s-demo',work:{tool:'linear'},issues:[a,b],issue_catalog:{week:[a],milestone:[b],all:[a,b],milestones:[{id:'m1',name:'Release',due:'2026-11-13',progress:0}],import_request:{path:'panel-issue-requests',space:'s-demo'}}};
test('scopes preserve natural week and explicit pins; search remains local',()=>{
  const all=issueScopeData(space,'all');assert.equal(all.rows[0].week,true);assert.equal(all.rows[1].pinned,true);
  assert.deepEqual(all.scopeCounts,{week:1,milestone:1,all:2});
  assert.equal(issueScopeData(space,'all','e\u0301').rows[0].key,'DEMO-2');
  const group=issueScopeData(space,'milestone').groups[0];assert.equal(group.name,'Release');assert.equal(group.progress,'0%');
});
test('missing milestone and cache details are not invented or treated as live service health',()=>{
  const unknown={...space,issue_catalog:{...space.issue_catalog,milestones:[],cache:{state:'stale',at:null,scopes:{all:{state:'missing',at:null},week:{state:'stale',at:'2026-11-02T00:00:00Z'}}}}};
  const group=issueScopeData(unknown,'milestone').groups[0];assert.equal(group.progress,'');assert.equal(group.due,'');assert.equal(group.name,'마일스톤 정보 없음');
  assert.match(issueCacheLabel(unknown,'all').label,/미수집/);assert.match(issueCacheLabel(unknown,'all').emptyLabel,/아직 수집/);
  const at=new Date('2026-11-02T00:00:00Z'),p=n=>String(n).padStart(2,'0'),hm=`${p(at.getHours())}:${p(at.getMinutes())}`;
  assert.equal(issueCacheLabel(unknown,'week',new Date(at.getTime()+60000)).label,`Linear · 이전 수집 결과 · ${hm} 갱신`,'local time, not the raw ISO stamp');
  assert.equal(issueCacheLabel(unknown,'week',new Date(at.getTime()+3*86400000)).label,`Linear · 이전 수집 결과 · ${at.getMonth()+1}/${at.getDate()} ${hm} 갱신`,'another day shows its date');
  assert(!issueCacheLabel({...unknown,issue_catalog:{...unknown.issue_catalog,cache:{state:'ready',at:'bad'}}},'week').label.includes('bad'),'an unreadable time stays out');
  unknown.issue_catalog.cache.scopes.all={state:'ready',at:'2026-11-07T00:00:00Z'};
  assert(!issueCacheLabel(unknown,'all').label.includes('이전 수집 결과'),'a fresh scope is not made stale by another scope');
});
test('explicit false pin state is respected while old v1 selections retain their fallback',()=>{
  const item={...b,pinned:false};
  const explicit={...space,issues:[a,item],issue_catalog:{...space.issue_catalog,all:[a,item]}};
  assert.equal(issueScopeData(explicit,'all').rows[1].pinned,false);
  const {pinned,...legacy}=b;
  const old={...space,issues:[a,legacy],issue_catalog:{...space.issue_catalog,all:[a,legacy]}};
  assert.equal(issueScopeData(old,'all').rows[1].pinned,true);
});
test('request publication reserves a unique filename then replaces only the reservation',async()=>{
  const request=issueRequest('/demo/task-feed.json',space,'DEMO-2',true,'request-demo-001'),calls=[];
  assert.equal(await saveIssueRequest(request,async(...args)=>calls.push(args)),request.value.id);
  assert.deepEqual(calls,[[request.path,'',null],[request.path,JSON.stringify(request.value),'']]);
  let callsMade=0;await assert.rejects(saveIssueRequest(request,async()=>{callsMade++;throw new Error('exists');}));
  assert.equal(callsMade,1,'collision never overwrites a previous request');
});
test('outbox is fixed beneath selected feed with one explicit import/remove',()=>{
  const request=issueRequest('/demo/task-feed.json',space,'DEMO-2',false,'request-demo-001');
  assert.equal(request.path,'/demo/panel-issue-requests/request-demo-001.json');
  assert.deepEqual(request.value,{v:1,id:'request-demo-001',space:'s-demo',tool:'linear',keys:['DEMO-2'],action:'remove'});
  assert.equal(issueRequest('/demo/task-feed.json',space,'unknown',true,'request-demo-001'),null);
  assert.equal(issueRequest('/demo/task-feed.json',space,'DEMO-1',false,'request-demo-001'),null,'a natural week item cannot be removed');
  assert.equal(issueRequest('/demo/task-feed.json',space,'DEMO-2',true,'../escape'),null);
  assert.equal(issueRequest('/demo/task-feed.json',{...space,issue_catalog:{...space.issue_catalog,import_request:{path:'../escape',space:space.id}}},'DEMO-2',true,'request-demo-001'),null);
  for(const tool of ['linear','jira'])assert.equal(issueRequest('/demo/task-feed.json',{...space,work:{tool}},'DEMO-2',true,`request-${tool}-001`).value.tool,tool);
  assert.equal(issueRequest('/demo/task-feed.json',{...space,work:{tool:'unknown'}},'DEMO-2',true,'request-demo-001'),null);
});

const feedText=updated=>JSON.stringify({v:2,updated,week:{start:'2026-11-09',end:'2026-11-15'},projects:[
  {key:'DEM',name:'Demo',workspace:'Demo',milestones:[{id:'m9',name:'Launch',target:'2026-11-20',progress:40}],issues:[
    {key:'DEMO-7',title:'Fresh work',status:'In Progress',state:'started',blocked:false,due:'2026-11-12',milestone:'m9',url:'https://linear.app/demo/issue/DEMO-7'},
    {key:'DEMO-8',title:'Blocked thing',state:'todo',blocked:true,due:'2026-12-30',milestone:'m9'},
    {key:'DEMO-9',title:'Later',state:'todo',due:'2026-12-30'},
    {key:'DEMO-6',title:'Done this week',state:'done',done_at:'2026-11-10'},
    {key:'bad',title:'ignored',state:'started'}]},
  {key:'OTH',name:'Other',workspace:'Other',milestones:[],issues:[{key:'OTH-1',title:'x',state:'started'}]}]});
const named={...space,name:'Demo',issue_catalog:{...space.issue_catalog,updated_at:'2026-11-10T10:02:00+09:00'}};
test('a newer week-timeline replaces the old catalog for the same-named project only',()=>{
  const feed=parseTimelineFeed(feedText('2026-11-12T15:30:00+09:00'));
  const out=spaceWithTimeline(named,feed),rows=issueScopeData(out,'all').rows;
  assert.deepEqual(rows.map(r=>r.key),['DEMO-7','DEMO-8','DEMO-9','DEMO-6']);
  assert.deepEqual(issueScopeData(out,'week').rows.map(r=>r.key),['DEMO-7'],'week = the band rule: not done, due this week or in progress');
  assert.deepEqual(issueScopeData(out,'milestone').rows.map(r=>r.key),['DEMO-7','DEMO-8']);
  assert.equal(rows[1].state,'blocked');
  const group=issueScopeData(out,'milestone').groups[0];assert.equal(group.name,'Launch');assert.equal(group.progress,'40%');
  assert.match(issueCacheLabel(out,'week',new Date('2026-11-12T16:00:00+09:00')).label,/갱신/);
  assert.equal(out.issue_catalog.import_request,named.issue_catalog.import_request);
  const other={...named,name:'Nobody'};
  assert.equal(spaceWithTimeline(other,feed),other);
});
test('pins survive and an older or unreadable timeline never replaces the catalog',()=>{
  const pinned={...named,issues:[{key:'DEMO-9',title:'Later',state:'waiting'}]};
  const out=spaceWithTimeline(pinned,parseTimelineFeed(feedText('2026-11-12T15:30:00+09:00')));
  assert.equal(issueScopeData(out,'all').rows.find(r=>r.key==='DEMO-9').pinned,true);
  assert.equal(spaceWithTimeline(named,parseTimelineFeed(feedText('2026-11-09T00:00:00+09:00'))),named);
  assert.equal(parseTimelineFeed('{bad'),null);assert.equal(parseTimelineFeed('{"v":1,"projects":[]}'),null);
  assert.equal(spaceWithTimeline(named,null),named);
});

test('this week is exactly what the top weekday band lists, with no done, later or dateless group parents',()=>{
  const issue=(key,state,extra={})=>({key,title:key,status:state==='done'?'Done':state==='started'?'In Progress':state==='review'?'In Review':'Todo',state,blocked:false,due:'',start:'',done_at:'',parent:'',milestone:'',url:'',...extra});
  const issues=[issue('DEMO-1','started',{due:'2026-11-12'}),issue('DEMO-2','todo',{due:'2026-11-14'}),issue('DEMO-3','todo',{due:'2026-12-09'}),
    issue('DEMO-4','review',{due:'2027-01-08'}),issue('DEMO-5','done',{due:'2026-11-10',done_at:'2026-11-10'}),issue('DEMO-6','todo',{due:'2026-11-02'}),
    issue('DEMO-10','todo'),issue('DEMO-11','started',{parent:'DEMO-10',due:'2026-11-13'}),issue('DEMO-12','todo',{parent:'DEMO-10',due:'2026-12-20'}),
    issue('DEMO-13','started'),issue('DEMO-14','done',{parent:'DEMO-10',done_at:'2026-11-11'})];
  const text=JSON.stringify({v:2,updated:'2026-11-12T10:00:00+09:00',week:{start:'2026-11-09',end:'2026-11-15'},projects:[{key:'DEM',name:'Demo',workspace:'Demo',milestones:[],issues}]});
  const band=weekSummary(parseFeed(text),{today:'2026-11-12'}).items.map(i=>i.key).sort();
  const space=spaceWithTimeline({...named,issue_catalog:{...named.issue_catalog,updated_at:'2020-01-01T00:00:00Z'}},parseTimelineFeed(text));
  assert.deepEqual(issueScopeData(space,'week').rows.map(r=>r.key).sort(),band);
  assert.deepEqual(band,['DEMO-1','DEMO-11','DEMO-2','DEMO-4','DEMO-6'],'due this week, late, or in progress/review (a child shows, its parent header does not)');
  for(const out of ['DEMO-3','DEMO-5','DEMO-10','DEMO-12','DEMO-13','DEMO-14'])assert(!band.includes(out),`${out} is not on the band`);
  assert.equal(issueScopeData(space,'all').rows.length,issues.length,'all tab keeps every issue');
  assert.deepEqual([...weekMembers([{key:'A-1',state:'done',due:'2026-11-10'},{key:'A-2',state:'started',due:''},{key:'A-3',state:'started',due:'2026-11-11'}],'2026-11-15')],['A-3']);
});
test('Linear status names from the timeline become the window status mark',()=>{
  assert.deepEqual(rowStatus({status:'In Progress'}),{name:'In Progress',type:'started',color:''});
  assert.equal(rowStatus({status:'Done'}).type,'completed');assert.equal(rowStatus({status:'Canceled'}).type,'canceled');
  assert.equal(rowStatus({status:'Backlog'}).type,'backlog');assert.equal(rowStatus({status:'Todo'}).type,'unstarted');
  assert.equal(rowStatus({status:'In Review'}).type,'started');assert.equal(rowStatus({}),null);
  const out=spaceWithTimeline(named,parseTimelineFeed(feedText('2026-11-12T15:30:00+09:00')));
  assert.equal(out.issue_catalog.all.find(i=>i.key==='DEMO-7').status,'In Progress');
});
