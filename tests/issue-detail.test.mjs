import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {statusLook,statusIndex,statusFilters,filterRows,foldedCount,milestoneList,detailData,teamStatuses,UNKNOWN_STATUS} from '../mods/sixfold-desk/issue-model.js';

// A small element tree like the other view tests: calls and children are recorded.
function element(kind='div',value=null){
  const data={kind,value,nodes:[],calls:[]};let proxy;
  proxy=new Proxy(data,{get(target,key){
    if(key==='then')return undefined;if(key in target)return target[key];
    if(['child','trigger','content'].includes(key))return node=>{data.calls.push([key,node]);if(node!=null)data.nodes.push(node);return proxy;};
    if(key==='children')return nodes=>{data.nodes.push(...nodes.filter(Boolean));return proxy;};
    if(key==='when')return (condition,fn)=>{if(condition)fn(proxy);return proxy;};
    return (...args)=>{data.calls.push([key,...args]);return proxy;};
  }});return proxy;
}
const walk=tree=>[tree,...(tree.nodes||[]).filter(node=>typeof node==='object').flatMap(walk)];
const call=(node,name)=>node.calls.find(item=>item[0]===name);
const byId=(tree,id)=>walk(tree).find(node=>call(node,'id')?.[1]===id);
const words=tree=>walk(tree).flatMap(node=>node.nodes.filter(value=>typeof value==='string'));
const click=(node,cx={stop_propagation(){}})=>call(node,'on_click')[1]({},cx);
const theme={surface:'#151a22',popover:'#1c2330',foreground:'#e5edf5',muted:'#a6b0bf',dim:'#788594',accent:'#a9b8ff',border:'#39434f',selected:'#253249',background:'#101318',blocked:'#edac67',ansi2:'#8fd18f',ansi3:'#e5c07b',ansi4:'#7aa2f7'};
let serial=0;
async function views(){
  globalThis.__issueView={div:()=>element(),svg:value=>element('svg',value),h_flex:()=>element('row'),v_flex:()=>element('column'),Popover:{new:id=>element('popover',id)}};
  const local=async name=>(await readFile(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url),'utf8'))
    .replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base)';/g,'const {$1}=globalThis.__issueView;')
    .replace("'./alert-model.js'",JSON.stringify(new URL('../mods/sixfold-desk/alert-model.js',import.meta.url).href))
    .replace("'./issue-model.js'",JSON.stringify(new URL('../mods/sixfold-desk/issue-model.js',import.meta.url).href));
  const detail=`data:text/javascript;base64,${Buffer.from(await local('issue-detail-view')).toString('base64')}#${serial++}`;
  const source=(await local('task-issues-view')).replace("'./issue-detail-view.js'",JSON.stringify(detail));
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${serial++}`);
}
async function cacheModule(stub){
  globalThis.__linearCache=stub;
  const source=(await readFile(new URL('../mods/sixfold-desk/linear-cache.js',import.meta.url),'utf8'))
    .replace(/import \{([^}]+)\} from 'herdr';/,(_m,names)=>`const {${names}}=globalThis.__linearCache;`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${serial++}`);
}

const PROJECT={schema:1,space:'Alpha',at:'2026-11-10T08:00:00Z',state:'ok',
  statuses:{Team:[{name:'Backlog',type:'backlog',color:'#bec2c8'},{name:'Todo',type:'unstarted',color:'#e2e2e2'},
    {name:'In Progress',type:'started',color:'#f2c94c'},{name:'In Review',type:'started',color:'#0f783c'},{name:'Blocked',type:'started',color:'#eb5757'},
    {name:'Done',type:'completed',color:'#5e6ad2'},{name:'Canceled',type:'canceled',color:'#95a2b3'}]},
  milestones:[{id:'m2',name:'② 둘째',target:'2026-11-20',progress:40,issues:5,counted:false,status:'started'},
    {id:'m1',name:'① 첫째',target:'2026-11-12',progress:100,issues:2,counted:false,status:'done'},
    {id:'m3',name:'③ 셋째',target:'',progress:null,issues:null,counted:true,status:'planned'}],
  issues:[{key:'DEMO-1',title:'One',status:'In Progress',team:'Team',milestone_id:'m2'},{key:'DEMO-2',title:'Two',status:'Blocked',team:'Team',milestone_id:'m2'},
    {key:'DEMO-3',title:'Three',status:'Done',team:'Team',milestone_id:'m1'},{key:'DEMO-4',title:'Four',status:'In Review',team:'Team',milestone_id:'m3'}]};

test('Linear statuses: real names with Linear-like icons; review and blocked told apart; nothing read is 상태 미확인',()=>{
  const index=statusIndex(PROJECT);
  assert.deepEqual(index.get('DEMO-2'),{name:'Blocked',type:'started',color:'#eb5757'});
  assert.equal(statusLook(index.get('DEMO-1')).icon,'◐');assert.equal(statusLook(index.get('DEMO-2')).kind,'blocked');
  assert.equal(statusLook(index.get('DEMO-4')).kind,'review');assert.equal(statusLook(index.get('DEMO-3')).icon,'✔');
  assert.equal(statusLook(null).label,UNKNOWN_STATUS);
  assert.deepEqual(teamStatuses(PROJECT,'Team').map(s=>s.name),['Backlog','Todo','In Progress','In Review','Blocked','Done','Canceled']);
});

test('status filter chips count each status; 전체 folds done and canceled until asked',()=>{
  const index=statusIndex(PROJECT),of=key=>index.get(key)||null;
  const rows=['DEMO-1','DEMO-2','DEMO-3','DEMO-4','DEMO-9'].map(key=>({key}));
  const chips=statusFilters(rows,of);
  assert.deepEqual(chips.map(c=>[c.name,c.count]),[['전체',5],['Blocked',1],['In Progress',1],['In Review',1],['Done',1],[UNKNOWN_STATUS,1]]);
  assert.deepEqual(filterRows(rows,of).map(r=>r.key),['DEMO-1','DEMO-2','DEMO-4','DEMO-9']);
  assert.equal(foldedCount(rows,of),1);
  assert.deepEqual(filterRows(rows,of,'전체',true).length,5);
  assert.deepEqual(filterRows(rows,of,'Blocked').map(r=>r.key),['DEMO-2']);
  assert.deepEqual(filterRows(rows,of,UNKNOWN_STATUS).map(r=>r.key),['DEMO-9']);
});

test('milestones: every one in Linear order with its own counts; computed ones marked; unread alerts counted',()=>{
  const list=milestoneList(PROJECT,null,new Set(['DEMO-2']));
  const untitled={...PROJECT,issues:PROJECT.issues.map(({title,...rest})=>rest)};
  assert.equal(milestoneList(untitled,{all:[{key:'DEMO-1',title:'From the list'}]})[0].items[0].title,'From the list','compact rows take the list title');
  assert.deepEqual(list.map(m=>m.id),['m2','m1','m3']);                       // Linear's order, not sorted
  assert.deepEqual(list.map(m=>[m.issues,m.progress,m.status,m.counted]),[[5,40,'started',false],[2,100,'done',false],[1,null,'planned',true]]);
  assert.equal(list[0].unread,1);assert.deepEqual(list[0].items.map(i=>i.key),['DEMO-1','DEMO-2']);
  // No project read yet: the catalog's milestones, counts computed from its rows.
  const catalog={milestones:[{id:'x',name:'X',due:'2026-11-30',progress:3}],milestone:[{key:'K-1',milestone_id:'x'}],all:[{key:'K-1',milestone_id:'x'},{key:'K-2',milestone_id:'x'}]};
  const fallback=milestoneList(null,catalog);
  assert.deepEqual(fallback.map(m=>[m.name,m.target,m.issues,m.progress,m.counted]),[['X','2026-11-30',2,3,true]]);
});

test('issue detail: fields, description, newest comments, bound agent work and the alerts that changed it',()=>{
  const cache={schema:1,key:'DEMO-1',at:'2026-11-10T08:00:00Z',state:'ok',
    issue:{key:'DEMO-1',title:'One',status:'In Progress',team:'Team',assignee:'Kim',due:'2026-11-20',milestone:'② 둘째',labels:['a','b'],url:'https://linear.app/demo/issue/DEMO-1/one',description:'x'.repeat(600)},
    comments:Array.from({length:7},(_,i)=>({author:`A${i}`,at:'2026-11-10T07:00:00Z',body:`body ${i}`}))};
  const d=detailData('DEMO-1',{issueCache:cache,agents:[{id:'a1',issue:'DEMO-1',title:'Work',status:'working'},{id:'a2',issue:'OTHER-1'}],alerts:[{id:'n1',category:'댓글',text:'Kim commented: hi'}]});
  assert.equal(d.title,'One');assert.equal(d.status.name,'In Progress');assert.equal(d.comments.length,5);
  assert(d.description.length<=420);assert.deepEqual(d.agents.map(a=>a.id),['a1']);
  assert.deepEqual(d.fields.map(f=>f[0]),['담당','마감','마일스톤','라벨']);
  const none=detailData('DEMO-5',{row:{key:'DEMO-5',title:'From the list'}});
  assert.equal(none.loaded,false);assert.equal(none.title,'From the list');assert.equal(none.status,null);
});

test('rows show the real status (상태 미확인 when unread), the filter chips filter, a row opens the detail',async()=>{
  const {issuePopover}=await views(),index=statusIndex(PROJECT),picked=[],details=[];
  const rows=[{key:'DEMO-1',title:'One',state:'working'},{key:'DEMO-9',title:'Nine',state:'waiting'}];
  const tree=issuePopover({id:'d',open:true,trigger:element(),scope:'all',rows,statusOf:key=>index.get(key)||null,
    filters:[{name:'전체',count:2},{name:'In Progress',count:1,status:index.get('DEMO-1')},{name:UNKNOWN_STATUS,count:1}],
    onFilter:name=>picked.push(name),onDetail:key=>details.push(key)},theme);
  assert(words(tree).includes('In Progress'));assert(words(tree).includes(UNKNOWN_STATUS));
  assert(!words(tree).includes('진행 중'),'Herdr’s own three states are not shown once Linear statuses are known');
  click(byId(tree,'task-issues-filter-d-1'));assert.deepEqual(picked,['In Progress']);
  click(byId(tree,'task-issue-d-DEMO-1'));assert.deepEqual(details,['DEMO-1']);
  const folded=issuePopover({id:'d',open:true,trigger:element(),scope:'all',rows,statusOf:()=>null,foldedCount:3,showFolded:false,onShowFolded(){}},theme);
  assert(words(folded).includes('완료·취소 3건 보기'));
});

test('the detail replaces the list: back, comments, buttons; writes only where this computer allows them',async()=>{
  const {issuePopover}=await views(),calls=[];
  const detail=detailData('DEMO-1',{issueCache:{schema:1,state:'ok',at:'2026-11-10T08:00:00Z',issue:{key:'DEMO-1',title:'One',status:'Todo',url:'https://linear.app/demo/issue/DEMO-1/x'},
    comments:[{author:'Kim',at:'2026-11-10T07:00:00Z',body:'Looks good'}]},alerts:[{id:'n1',category:'댓글',kind:'comment',text:'Kim commented: Looks good',at:'2026-11-10T07:00:00Z'}]});
  const base={id:'d',open:true,trigger:element(),rows:[],detail,readable:true,writes:['mark_read','set_state'],
    onDetail:key=>calls.push(['detail',key]),onRead:alerts=>calls.push(['read',alerts.length]),onMenu:menu=>calls.push(['menu',menu]),
    onLink:url=>calls.push(['link',url]),onSetState:name=>calls.push(['state',name])};
  const tree=issuePopover(base,theme);
  assert(!byId(tree,'task-issues-list-d'),'the list is replaced');
  assert(words(tree).includes('Looks good'));assert(words(tree).includes('새 알림 1건'));
  click(byId(tree,'task-issue-detail-back-d'));click(byId(tree,'task-issue-detail-read-d'));
  click(byId(tree,'task-issue-detail-state-d'));click(byId(tree,'task-issue-detail-open-d'));
  assert(!call(byId(tree,'task-issue-detail-comment-d'),'on_click'),'comment writes are off here');
  const menu=issuePopover({...base,menu:'state',statuses:teamStatuses(PROJECT,'Team')},theme);
  click(byId(menu,'task-issue-detail-state-d-2'));
  assert(!call(byId(menu,'task-issue-detail-state-d-1'),'on_click'),'the current status is not a choice');
  assert.deepEqual(calls,[['detail',null],['read',1],['menu','state'],['link','https://linear.app/demo/issue/DEMO-1/x'],['state','In Progress']]);
});

test('milestone tab: every milestone with icon, target, count and progress; a row unfolds its issues; an issue opens its detail',async()=>{
  const {issuePopover}=await views(),index=statusIndex(PROJECT),opened=[],details=[];
  const milestones=milestoneList(PROJECT,null,new Set(['DEMO-2']));
  const at=expanded=>issuePopover({id:'d',open:true,trigger:element(),scope:'milestone',rows:[],groups:[],milestones,expanded,
    statusOf:key=>index.get(key)||null,onMilestone:id=>opened.push(id),onDetail:key=>details.push(key),milestonesCounted:true},theme);
  const closed=at(new Set());
  assert(words(closed).includes('② 둘째'));assert(words(closed).includes('40%'));assert(words(closed).includes('5건'));assert(words(closed).includes('미확인 1'));
  assert(!byId(closed,'task-issues-milestone-issue-d-DEMO-1'));
  click(byId(closed,'task-issues-milestone-d-m2'));assert.deepEqual(opened,['m2']);
  const open=at(new Set(['m2']));
  click(byId(open,'task-issues-milestone-issue-d-DEMO-2'));assert.deepEqual(details,['DEMO-2']);
  assert(words(open).includes('Blocked'));
});

test('read requests only when missing or old; force at most every 30 s; answered caches stop the wait; bounded',async()=>{
  const files=new Map(),written=[];
  const stub={appHome:()=>'/home',readTextFile:async path=>{if(!files.has(path))throw new Error('missing');return files.get(path);},
    writeTextFile:async(path,text)=>{written.push([path,JSON.parse(text)]);}};
  const cache=await cacheModule(stub);
  const now=Date.parse('2026-11-10T08:00:00Z'),io={read:stub.readTextFile,write:stub.writeTextFile,home:'/home'};
  await cache.ensure('issue','DEMO-1',{now,...io});
  assert.equal(written.length,1);assert.match(written[0][0],/^\/home\/data\/sixfold\/linear-reads\/[a-z0-9]+-[a-z0-9]{8}\.json$/);
  assert.deepEqual({kind:written[0][1].kind,key:written[0][1].key},{kind:'issue',key:'DEMO-1'});
  await cache.ensure('issue','DEMO-1',{now:now+1000,...io});assert.equal(written.length,1,'asked a moment ago');
  assert(cache.waiting('issue','DEMO-1',now+1000));
  files.set('/home/data/sixfold/linear-cache/issue-DEMO-1.json',JSON.stringify({schema:1,key:'DEMO-1',at:new Date(now+5000).toISOString(),state:'ok',issue:{key:'DEMO-1'}}));
  assert.equal(await cache.checkCaches({read:stub.readTextFile,home:'/home',now:now+6000}),true);
  assert(!cache.waiting('issue','DEMO-1',now+6000));assert.equal(cache.cached('issue','DEMO-1').issue.key,'DEMO-1');
  await cache.ensure('issue','DEMO-1',{now:now+2*60*1000,...io});assert.equal(written.length,1,'fresh for 5 minutes');
  await cache.ensure('issue','DEMO-1',{now:now+6*60*1000,...io});assert.equal(written.length,2,'old: read again');
  await cache.ensure('issue','DEMO-1',{now:now+6*60*1000+1000,force:true,...io});assert.equal(written.at(-1)[1].force,true);
  await cache.ensure('issue','DEMO-1',{now:now+6*60*1000+5000,force:true,...io});assert.equal(written.length,3,'force at most every 30 s');
  await cache.ensure('issue','../etc',{now,...io});await cache.ensure('project','',{now,...io});assert.equal(written.length,3,'invalid targets ask nothing');
  for(let i=0;i<40;i++)await cache.ensure('issue',`DEMO-${100+i}`,{now:now+i,...io});
  assert.equal(cache.cached('issue','DEMO-100'),null);
  await cache.ensure('project','Alpha',{now,...io});assert.equal(written.at(-1)[1].space,'Alpha');
  assert.equal(cache.projectSlug('Peace Minus/One'),'peace-minus-one');
});
