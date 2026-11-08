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
  globalThis.__issueView={div:()=>element(),h_flex:()=>element('row'),v_flex:()=>element('column'),Popover:{new:id=>element('popover',id)}};
  const source=(await readFile(new URL('../mods/sixfold-desk/task-issues-view.js',import.meta.url),'utf8'))
    .replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base)';/g,'const {$1}=globalThis.__issueView;');
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
