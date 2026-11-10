import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

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
const theme={surface:'#151a22',chrome:'#10151e',popover:'#1c2330',foreground:'#e5edf5',muted:'#a6b0bf',dim:'#788594',accent:'#a9b8ff',border:'#39434f',selected:'#253249',hover:'#253249',background:'#101318',blocked:'#edac67'};
const rows=Array.from({length:3},(_,i)=>({key:`DEMO-${i+1}`,title:`Demo issue ${i+1}`,state:['working','review','blocked'][i]}));
let serial=0;
async function renderer(){
  globalThis.__issueView={div:()=>element(),svg:value=>element('svg',value),h_flex:()=>element('row'),v_flex:()=>element('column'),Popover:{new:id=>element('popover',id)}};
  const source=(await readFile(new URL('../mods/sixfold-desk/task-issues-view.js',import.meta.url),'utf8'))
    .replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base)';/g,'const {$1}=globalThis.__issueView;')
    .replace("'./alert-model.js'",JSON.stringify(new URL('../mods/sixfold-desk/alert-model.js',import.meta.url).href));
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${serial++}`);
}
const model=overrides=>({id:'demo',open:true,trigger:element('icon'),rows,selected:new Set(),scope:'week',...overrides});
const click=(node,cx)=>call(node,'on_click')?.[1]({},cx);

test('closed catalog retains only its right-side native trigger and does not build issue rows',async()=>{
  const {issuePopover}=await renderer(),tree=issuePopover(model({open:false}),theme);
  assert.equal(tree.kind,'popover');assert.equal(call(tree,'anchor')[1],'left_center');
  assert.equal(call(tree,'open')[1],false);assert(!call(tree,'content'));
  assert.equal(walk(tree).filter(node=>call(node,'id')).length,0);
});

test('three scopes update local state and milestone groups retain due/progress labels',async()=>{
  const {issuePopover}=await renderer(),seen=[],cx={stop_propagation(){seen.push('stop');}};
  const tree=issuePopover(model({scope:'milestone',groups:[{id:'launch',name:'Demo launch',due:'이번 달',progress:'1/3 완료',items:rows}],onScope:(scope,context)=>{assert.equal(context,cx);seen.push(scope);}}),theme);
  for(const scope of ['week','milestone','all'])click(byId(tree,`task-issues-scope-demo-${scope}`),cx);
  assert.deepEqual(seen,['stop','week','stop','milestone','stop','all']);
  assert(words(tree).includes('이번 주'));assert(words(tree).includes('마일스톤'));assert(words(tree).includes('전체'));
  const group=byId(tree,'task-issues-group-demo-launch');assert(group);
  assert(words(group).includes('이번 달'));assert(words(group).includes('1/3 완료'));
});

test('only explicit per-issue pull controls import or remove manual picks; natural week rows stay included',async()=>{
  const {issuePopover}=await renderer(),actions=[],cx={stop_propagation(){}};
  const items=rows.map((row,i)=>({...row,week:i===0,pinned:i===2}));
  const tree=issuePopover(model({rows:items,canImport:true,onPull:(...args)=>actions.push(args)}),theme);
  assert(!call(byId(tree,'task-issue-demo-DEMO-2'),'on_click'),'reading a row cannot post an import');
  assert(!call(byId(tree,'task-issues-pull-demo-DEMO-1'),'on_click'),'natural week inclusion is not removable');
  click(byId(tree,'task-issues-pull-demo-DEMO-2'),cx);click(byId(tree,'task-issues-pull-demo-DEMO-3'),cx);
  assert.deepEqual(actions,[['DEMO-2',true,cx],['DEMO-3',false,cx]]);
  assert(words(tree).includes('가져오기'));assert(words(tree).includes('가져옴 ✓'));
});

test('pending, unavailable and empty views cannot emit a pull request',async()=>{
  const {issuePopover}=await renderer();let imports=0;
  for(const state of [{busyKeys:new Set(['DEMO-1']),canImport:true},{canImport:false}]){
    const tree=issuePopover(model({...state,onPull:()=>imports++}),theme);
    assert(!call(byId(tree,'task-issues-pull-demo-DEMO-1'),'on_click'));
  }
  const empty=issuePopover(model({rows:[],toolLabel:'연결 없음',error:'이슈를 불러오지 못했습니다'}),theme);
  assert(words(empty).includes('이 범위에 표시할 이슈가 없습니다'));
  assert(words(empty).includes('이슈를 불러오지 못했습니다'));assert.equal(imports,0);
});

test('open and dismiss state is reported through the native popover callback',async()=>{
  const {issuePopover}=await renderer(),changes=[],cx={stop_propagation(){}};
  const search=element('input');search.id('query');
  const tree=issuePopover(model({search,onOpen:(open,context)=>changes.push([open,context])}),theme);
  const callback=call(tree,'on_open_change')[1];callback(false,cx);callback(true,cx);
  click(byId(tree,'task-issues-close-demo'),cx);
  assert.deepEqual(changes,[[false,cx],[true,cx],[false,cx]]);
  assert.equal(byId(tree,'query'),search);
});

test('issues with new alerts show in one group above the tabs; a tab row only gets a small count; a line opens its comment',async()=>{
  const opened=[],cx={stop_propagation(){}};
  const link='https://linear.app/demo/issue/DEMO-9/x#comment-4e5f6a7b';
  const counts={'DEMO-2':{unread:1,more:0,lines:[]}};
  const alerted=[
    {key:'DEMO-9',title:'Made after the list',at:'2026-11-10T04:45:00Z',alerts:{unread:3,more:1,lines:[
      {id:'n2',category:'댓글',text:'Kim replied: second',at:'2026-11-10T04:45:00Z',url:link},
      {id:'n1',category:'댓글',text:'Kim commented: first',at:'2026-11-10T04:24:00Z',url:''}]}},
    {key:'DEMO-2',title:'Demo issue 2',at:'2026-11-10T03:00:00Z',alerts:{unread:1,more:0,lines:[{id:'n5',category:'배정',text:'Lee assigned you',at:'2026-11-10T03:00:00Z',url:''}]}}];
  for(const scope of ['week','milestone','all']){
    const {issuePopover}=await renderer();
    const tree=issuePopover(model({scope,groups:[{id:'g',name:'G',items:rows}],alerted,alertsFor:key=>counts[key]||null,
      onLink:(url,context)=>{assert.equal(context,cx);opened.push(url);}}),theme);
    const body=byId(tree,'task-issues-body-demo'),ids=body.nodes.map(node=>call(node,'id')?.[1]).filter(Boolean);
    assert(ids.indexOf('task-issues-alerted-demo')>=0&&ids.indexOf('task-issues-alerted-demo')<ids.indexOf('task-issues-list-demo'),scope);   // above the tab list, every tab
    const group=words(byId(tree,'task-issues-alerted-demo'));
    for(const word of ['알림 온 이슈','미확인 4','DEMO-9','Made after the list','Kim replied: second','Kim commented: first','외 1건','3건','배정','Lee assigned you'])assert(group.includes(word),`${scope}: ${word}`);
    assert.deepEqual(words(byId(tree,'task-issue-alerts-demo-DEMO-2')),['새 1']);          // the tab row: a count only
    assert(!words(byId(tree,'task-issue-demo-DEMO-2')).includes('Lee assigned you'));
    click(byId(tree,'task-issues-alerted-line-demo-DEMO-9-0'),cx);
    assert(!call(byId(tree,'task-issues-alerted-line-demo-DEMO-9-1'),'on_click'));     // no trusted link: not a button
  }
  assert.deepEqual(opened,[link,link,link]);
  const {issuePopover}=await renderer();
  assert(!byId(issuePopover(model({alerted:[]}),theme),'task-issues-alerted-demo'));   // no unread: no group
});

test('[읽음] on each alert line and [모두 읽음] on the group head; opening a row passes what it confirms; pending rows dim, errors show',async()=>{
  const {issuePopover}=await renderer(),reads=[],opened=[],cx={stop_propagation(){}};
  const link='https://linear.app/demo/issue/DEMO-9/x#comment-4e5f6a7b';
  const lines=[{id:'n2',category:'댓글',text:'Kim replied: second',at:'2026-11-10T04:45:00Z',url:link},
    {id:'comment:0a1b2c3d-0000-4000-8000-000000000000',local:true,category:'댓글',text:'Lee commented: here',at:'2026-11-10T04:24:00Z',url:link}];
  const alerted=[{key:'DEMO-9',title:'T',at:lines[0].at,alerts:{unread:2,more:0,lines}}];
  const base={alerted,readable:true,onRead:(alerts,context)=>{assert.equal(context,cx);reads.push(alerts.map(a=>a.id));},
    onReadAll:context=>{assert.equal(context,cx);reads.push('all');},onLink:(url,context,alerts)=>{assert.equal(context,cx);opened.push([url,alerts.map(a=>a.id)]);},
    issueTargets:()=>[{id:'n2'},{id:'n3'}],doneKeys:new Set(['DEMO-9'])};
  let tree=issuePopover(model(base),theme);
  assert.deepEqual(words(byId(tree,'task-issues-read-demo-DEMO-9-0')),['읽음']);
  assert.deepEqual(words(byId(tree,'task-issues-read-demo-DEMO-9-1')),['확인']);          // linked-issue comment: this computer only
  assert.deepEqual(words(byId(tree,'task-issues-read-all-demo')),['모두 읽음']);
  assert.deepEqual(words(byId(tree,'task-issues-alerted-done-demo-DEMO-9')),['처리됨']);
  click(byId(tree,'task-issues-read-demo-DEMO-9-0'),cx);click(byId(tree,'task-issues-read-all-demo'),cx);
  click(byId(tree,'task-issues-alerted-line-demo-DEMO-9-0'),cx);click(byId(tree,'task-issues-alerted-head-demo-DEMO-9'),cx);
  assert.deepEqual(reads,[['n2'],'all']);
  assert.deepEqual(opened,[[link,['n2']],[link,['n2','n3']]]);                            // a head opens the issue: all its alerts
  // Pending: dimmed, '처리 중', no second press; a failure line shows.
  tree=issuePopover(model({...base,readPending:new Set(['n2']),readError:'읽음 처리 실패: busy'}),theme);
  const row=byId(tree,'task-issues-alerted-line-demo-DEMO-9-0');
  assert.equal(call(row,'opacity')[1],0.45);assert(!call(row,'on_click'));
  assert.deepEqual(words(byId(tree,'task-issues-read-demo-DEMO-9-0')),['처리 중']);assert(!call(byId(tree,'task-issues-read-demo-DEMO-9-0'),'on_click'));
  assert(words(byId(tree,'task-issues-alerted-demo')).includes('읽음 처리 실패: busy'));
  // Linear writes off: no Linear [읽음] and no [모두 읽음]; the local [확인] stays.
  tree=issuePopover(model({...base,readable:false}),theme);
  assert(!byId(tree,'task-issues-read-demo-DEMO-9-0'));assert(byId(tree,'task-issues-read-demo-DEMO-9-1'));
  assert(!byId(tree,'task-issues-read-all-demo'));assert(words(tree).includes('읽음은 Linear 기준'));
});

test('each alert line carries its own kind badge, colored by kind',async()=>{
  const {issuePopover}=await renderer();
  const lines=[{id:'n1',kind:'status',category:'상태 변경',text:'상태 Todo → In Progress',at:'2026-11-10T04:45:00Z',url:''},
    {id:'n2',kind:'assign',category:'배정',text:'Kim 님이 배정',at:'2026-11-10T04:24:00Z',url:''}];
  const tree=issuePopover(model({alerted:[{key:'DEMO-9',title:'T',at:lines[0].at,alerts:{unread:2,more:0,lines}}]}),{...theme,ansi3:'#ffd75f',ansi4:'#5fafff'});
  assert.deepEqual(words(byId(tree,'task-issues-alerted-kind-demo-DEMO-9-0')),['상태 변경']);
  assert.deepEqual(words(byId(tree,'task-issues-alerted-kind-demo-DEMO-9-1')),['배정']);
  assert.equal(call(byId(tree,'task-issues-alerted-kind-demo-DEMO-9-0'),'bg')[1],'#5fafff');
  assert.equal(call(byId(tree,'task-issues-alerted-kind-demo-DEMO-9-1'),'bg')[1],'#ffd75f');
  assert(words(byId(tree,'task-issues-alerted-demo')).includes('상태 Todo → In Progress'));
});
