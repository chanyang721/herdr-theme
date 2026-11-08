import test from 'node:test';
import assert from 'node:assert/strict';
import {issueScopeData,issueCacheLabel,issueRequest,saveIssueRequest} from '../mods/sixfold-desk/task-issue-state.js';
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
  assert.match(issueCacheLabel(unknown,'week').label,/이전 수집 결과.*2026-11-02/);
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
