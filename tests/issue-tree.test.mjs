import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {issueLedger,issueTree,statusFilters,filterRows,foldedCount,milestoneList,TREE_MAX_DEPTH} from '../mods/sixfold-desk/issue-model.js';
import {issueScopeData,parseTimelineFeed,spaceWithTimeline} from '../mods/sixfold-desk/task-issue-state.js';
import {cleanPanelFeed,projectPanelFeed} from '../mods/sixfold-desk/panel-model.js';

// The issue search draws its lists as a parent/child tree: a row under its parent, a parent the list does
// not show as a dimmed header (never counted), loops cut, depth capped; without any parent, flat as before.
const row=(key,extra={})=>({key,title:`Title ${key}`,state:'waiting',...extra});
const shape=entries=>entries.map(e=>`${'  '.repeat(e.depth)}${e.ghost?(e.known?'~':'?'):''}${e.issue.key}`);

test('children sit under their parent; groups keep the list order, rows inside a group keep theirs',()=>{
  const rows=[row('DEMO-11',{parent:'DEMO-10'}),row('DEMO-20'),row('DEMO-12',{parent:'DEMO-10'}),row('DEMO-10'),row('DEMO-13',{parent:'DEMO-11'})];
  assert.deepEqual(shape(issueTree(rows,issueLedger(rows))),['DEMO-10','  DEMO-11','    DEMO-13','  DEMO-12','DEMO-20']);
});

test('without any parent the list is unchanged and flat',()=>{
  const rows=[row('DEMO-3'),row('DEMO-1'),row('DEMO-2')];
  const entries=issueTree(rows,issueLedger(rows));
  assert.deepEqual(entries.map(e=>e.issue),rows);assert(entries.every(e=>e.depth===0&&!e.ghost));
  assert.deepEqual(issueTree(rows,null).map(e=>e.issue.key),['DEMO-3','DEMO-1','DEMO-2']);
});

test('a parent the list does not show is a dimmed header: the ledger row when known, else its key only',()=>{
  const ledger=issueLedger([row('DEMO-1',{parent:'DEMO-9'}),row('DEMO-2',{parent:'DEMO-9'}),row('DEMO-9',{title:'Epic'}),row('DEMO-5',{parent:'DEMO-77'})]);
  const entries=issueTree([row('DEMO-1',{parent:'DEMO-9'}),row('DEMO-5',{parent:'DEMO-77'}),row('DEMO-2',{parent:'DEMO-9'})],ledger);
  assert.deepEqual(shape(entries),['~DEMO-9','  DEMO-1','  DEMO-2','?DEMO-77','  DEMO-5']);
  assert.equal(entries[0].issue.title,'Epic');assert.equal(entries[3].issue.title,'');
});

test('a parent loop is cut where it closes: every row once, nothing hangs',()=>{
  const rows=[row('DEMO-1',{parent:'DEMO-2'}),row('DEMO-2',{parent:'DEMO-3'}),row('DEMO-3',{parent:'DEMO-1'})];
  const entries=issueTree(rows,issueLedger(rows));
  assert.deepEqual(entries.map(e=>e.issue.key).sort(),['DEMO-1','DEMO-2','DEMO-3']);
  assert.equal(entries.filter(e=>e.depth===0).length,1);
  // A loop through rows the list does not show still ends, with the shown row once.
  const ledger=issueLedger([row('DEMO-4',{parent:'DEMO-5'}),row('DEMO-5',{parent:'DEMO-6'}),row('DEMO-6',{parent:'DEMO-5'})]);
  const ghostLoop=issueTree([row('DEMO-4',{parent:'DEMO-5'})],ledger);
  assert.equal(ghostLoop.filter(e=>!e.ghost).length,1);assert.equal(new Set(ghostLoop.map(e=>e.issue.key)).size,ghostLoop.length);
  // Self parents never come in.
  assert.equal(issueLedger([row('DEMO-7',{parent:'DEMO-7'})]).parents.size,0);
});

test('depth stops growing at the cap',()=>{
  const rows=[0,1,2,3,4,5].map(n=>row(`DEMO-${n}`,n?{parent:`DEMO-${n-1}`}:{}));
  assert.deepEqual(issueTree(rows,issueLedger(rows)).map(e=>e.depth),[0,1,2,3,3,3]);assert.equal(TREE_MAX_DEPTH,3);
});

const STATUS={'DEMO-10':{name:'Todo',type:'unstarted'},'DEMO-11':{name:'In Progress',type:'started'},'DEMO-12':{name:'Todo',type:'unstarted'},'DEMO-20':{name:'Done',type:'completed'}};
const statusOf=key=>STATUS[key]||null;
const catalogRows=[row('DEMO-10',{title:'Parent'}),row('DEMO-11',{title:'Child running',parent:'DEMO-10'}),row('DEMO-12',{title:'Child todo',parent:'DEMO-10'}),row('DEMO-20',{title:'Finished'})];

test('a status filter: a matching child brings its parent as a header; a matching parent comes alone',()=>{
  const ledger=issueLedger(catalogRows);
  assert.deepEqual(shape(issueTree(filterRows(catalogRows,statusOf,'In Progress'),ledger)),['~DEMO-10','  DEMO-11']);
  const parentOnly=[row('DEMO-30'),row('DEMO-31',{parent:'DEMO-30'})],only=issueLedger(parentOnly);
  assert.deepEqual(shape(issueTree(filterRows(parentOnly,key=>key==='DEMO-30'?{name:'Todo'}:{name:'Done',type:'completed'}),only)),['DEMO-30']);
  // Folded (done) parent: its open children still show under a header.
  const doneParent=[row('DEMO-40'),row('DEMO-41',{parent:'DEMO-40'})];
  assert.deepEqual(shape(issueTree(filterRows(doneParent,key=>key==='DEMO-40'?{name:'Done',type:'completed'}:{name:'Todo'}),issueLedger(doneParent))),['~DEMO-40','  DEMO-41']);
});

test('search: a matching child brings its parent as a header; counts are the real rows only',()=>{
  const space={id:'s',name:'Demo',issues:[],issue_catalog:{week:catalogRows,milestone:[],all:catalogRows}};
  const data=issueScopeData(space,'all','running');
  assert.deepEqual(data.rows.map(r=>r.key),['DEMO-11']);
  const entries=issueTree(data.rows,issueLedger(catalogRows));
  assert.deepEqual(shape(entries),['~DEMO-10','  DEMO-11']);
  // Tab counts, filter chips and the folded count are the rows', never the headers'.
  assert.deepEqual(data.scopeCounts,{week:4,milestone:0,all:4});
  assert.equal(statusFilters(data.rows,statusOf)[0].count,1);
  const all=issueScopeData(space,'all','').rows;
  assert.equal(statusFilters(all,statusOf)[0].count,4);assert.equal(foldedCount(all,statusOf),1);
  assert.equal(issueTree(all,issueLedger(catalogRows)).filter(e=>!e.ghost).length,all.length);
});

test('milestone tab: a tree inside each milestone; a parent in another milestone is a header there',()=>{
  // The project cache names no parent; the catalog's rows give it.
  const catalog={all:[row('DEMO-1',{milestone_id:'m1'}),row('DEMO-2',{milestone_id:'m2',parent:'DEMO-1'}),row('DEMO-3',{milestone_id:'m2',parent:'DEMO-2'}),row('DEMO-4',{milestone_id:'m1',parent:'DEMO-1'})],
    milestones:[{id:'m1',name:'One'},{id:'m2',name:'Two'}]};
  const project={milestones:[{id:'m1',name:'One'},{id:'m2',name:'Two'}],issues:catalog.all.map(({parent:_p,...i})=>i)};
  const ledger=issueLedger(catalog.all,project.issues);
  const [one,two]=milestoneList(project,catalog);
  assert.deepEqual(shape(issueTree(one.items,ledger)),['DEMO-1','  DEMO-4']);
  assert.deepEqual(shape(issueTree(two.items,ledger)),['~DEMO-1','  DEMO-2','    DEMO-3']);
  assert.equal(two.issues,null,'the milestone count stays Linear\'s own (unknown here), headers never add to it');
  // The fallback groups of issueScopeData tree the same way.
  const data=issueScopeData({id:'s',name:'Demo',issues:[],issue_catalog:{week:[],milestone:catalog.all,all:catalog.all,milestones:catalog.milestones}},'milestone');
  assert.deepEqual(data.groups.map(g=>shape(issueTree(g.items,ledger))),[['DEMO-1','  DEMO-4'],['~DEMO-1','  DEMO-2','    DEMO-3']]);
});

test('parents survive both sources: week-timeline.json and a feed catalog that sends them',()=>{
  const feed=parseTimelineFeed({v:2,updated:'2026-11-17T00:00:00Z',week:{start:'2026-11-16'},projects:[{workspace:'Demo',issues:[
    {key:'DEMO-1',title:'Parent',state:'todo'},{key:'DEMO-2',title:'Child',state:'started',parent:'DEMO-1'},{key:'DEMO-3',title:'Self',state:'todo',parent:'DEMO-3'}]}]});
  const issues=feed.projects[0].issues;
  assert.equal(issues.find(i=>i.key==='DEMO-2').parent,'DEMO-1');
  assert(!('parent' in issues.find(i=>i.key==='DEMO-1')));assert(!('parent' in issues.find(i=>i.key==='DEMO-3')));
  const space=spaceWithTimeline({id:'s',name:'Demo',issues:[],issue_catalog:null},feed);
  assert.equal(space.issue_catalog.all.find(i=>i.key==='DEMO-2').parent,'DEMO-1');
  const cleaned=cleanPanelFeed({v:1,at:'2026-11-17T00:00:00.000Z',computers:[{id:'studio',name:'Studio',local:true}],links:[],events:[],
    spaces:[{id:'one',name:'Demo',computer:'studio',bundle:'violet',share:null,slack:null,work:null,issues:[],memory:{proposals:0},agents:[],
      issue_catalog:{week:[],milestone:[],all:[{key:'DEMO-1',title:'P',state:'waiting'},{key:'DEMO-2',title:'C',state:'waiting',parent:'DEMO-1'},
        {key:'DEMO-3',title:'Bad',state:'waiting',parent:'not a key'},{key:'DEMO-4',title:'Self',state:'waiting',parent:'DEMO-4'}]}}]});
  const all=cleaned.spaces[0].issue_catalog.all;
  assert.deepEqual(all.map(i=>i.parent??null),[null,'DEMO-1',null,null]);
  assert.deepEqual(projectPanelFeed(cleaned).feed.spaces[0].issue_catalog.all.map(i=>i.parent??null),[null,'DEMO-1',null,null]);
});

// --- The popover draws it -------------------------------------------------------------------------
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
const ids=tree=>walk(tree).map(node=>call(node,'id')?.[1]).filter(Boolean);
const theme={surface:'#151a22',chrome:'#10151e',popover:'#1c2330',foreground:'#e5edf5',muted:'#a6b0bf',dim:'#788594',accent:'#a9b8ff',border:'#39434f',selected:'#253249',hover:'#253249',background:'#101318',blocked:'#edac67'};
let serial=0;
async function views(){
  globalThis.__issueView={div:()=>element(),svg:value=>element('svg',value),h_flex:()=>element('row'),v_flex:()=>element('column'),Popover:{new:id=>element('popover',id)}};
  const local=async name=>(await readFile(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url),'utf8'))
    .replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base)';/g,'const {$1}=globalThis.__issueView;')
    .replace("'./alert-model.js'",JSON.stringify(new URL('../mods/sixfold-desk/alert-model.js',import.meta.url).href))
    .replace("'./issue-model.js'",JSON.stringify(new URL('../mods/sixfold-desk/issue-model.js',import.meta.url).href));
  const detailView=`data:text/javascript;base64,${Buffer.from(await local('issue-detail-view')).toString('base64')}#${serial++}`;
  const source=(await local('task-issues-view')).replace("'./issue-detail-view.js'",JSON.stringify(detailView));
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${serial++}`);
}

test('the list indents children with a guide; a known header opens its detail, an unknown one does not',async()=>{
  const {issuePopover}=await views(),opened=[];
  const ledger=issueLedger([...catalogRows,row('DEMO-50',{parent:'DEMO-99'})]);
  const rows=[catalogRows[1],catalogRows[2],row('DEMO-50',{parent:'DEMO-99'}),catalogRows[3]];
  const tree=issuePopover({id:'d',open:true,trigger:element(),scope:'all',rows,statusOf,onDetail:key=>opened.push(key),
    filters:statusFilters(rows,statusOf),treeOf:items=>issueTree(items,ledger)},theme);
  const list=ids(byId(tree,'task-issues-list-d')).filter(id=>/^task-issue-(head-)?d-[A-Z]+-\d+$/.test(id));
  assert.deepEqual(list,['task-issue-head-d-DEMO-10','task-issue-d-DEMO-11','task-issue-d-DEMO-12','task-issue-head-d-DEMO-99','task-issue-d-DEMO-50','task-issue-d-DEMO-20']);
  const child=byId(tree,'task-issue-d-DEMO-11');
  assert.equal(call(child,'pl')[1],8+12);assert(byId(child,'task-issue-branch-d-DEMO-11'),'a child has its left guide');
  assert.equal(call(byId(tree,'task-issue-d-DEMO-20'),'pl')[1],8);assert(!byId(tree,'task-issue-branch-d-DEMO-20'));
  const head=byId(tree,'task-issue-head-d-DEMO-10');
  assert.equal(call(head,'opacity')[1],0.55);
  call(head,'on_click')[1]({},{stop_propagation(){}});assert.deepEqual(opened,['DEMO-10']);
  assert(!call(byId(tree,'task-issue-head-d-DEMO-99'),'on_click'),'a parent no list knows has nothing to open');
  // The filter chip counts the 4 real rows, not the headers.
  const chip=byId(tree,'task-issues-filter-d-0');
  assert(walk(chip).some(node=>node.nodes.includes('4')),'전체 4: the headers are not counted');
  // No treeOf (no parent known anywhere): flat, ids as before.
  const flat=issuePopover({id:'d',open:true,trigger:element(),scope:'all',rows,statusOf},theme);
  assert(!ids(flat).some(id=>id.startsWith('task-issue-head-')));
});

test('milestone tab: unfolded milestones and fallback groups draw the same tree, header ids per milestone',async()=>{
  const {issuePopover}=await views(),opened=[];
  const all=[row('DEMO-1',{milestone_id:'m1'}),row('DEMO-2',{milestone_id:'m2',parent:'DEMO-1'}),row('DEMO-3',{milestone_id:'m3',parent:'DEMO-1'})];
  const ledger=issueLedger(all),treeOf=items=>issueTree(items,ledger);
  const milestones=milestoneList(null,{all,milestones:[{id:'m1',name:'One'},{id:'m2',name:'Two'},{id:'m3',name:'Three'}]});
  const tree=issuePopover({id:'d',open:true,trigger:element(),scope:'milestone',rows:[],groups:[],milestones,expanded:new Set(['m1','m2','m3']),
    statusOf:()=>null,onDetail:key=>opened.push(key),treeOf},theme);
  for(const m of ['m2','m3'])assert(byId(tree,`task-issues-milestone-head-d-${m}-DEMO-1`),`${m} heads its child with the parent from m1`);
  assert(byId(tree,'task-issues-milestone-issue-d-DEMO-1'),'m1 has the parent itself');
  assert.equal(call(byId(tree,'task-issues-milestone-issue-d-DEMO-2'),'pl')[1],28+12);
  call(byId(tree,'task-issues-milestone-head-d-m2-DEMO-1'),'on_click')[1]({},{stop_propagation(){}});assert.deepEqual(opened,['DEMO-1']);
  const groups=issueScopeData({id:'s',name:'Demo',issues:[],issue_catalog:{week:[],milestone:all,all}},'milestone').groups;
  const fallback=issuePopover({id:'d',open:true,trigger:element(),scope:'milestone',rows:[],groups,statusOf:()=>null,treeOf},theme);
  assert(byId(fallback,'task-issue-head-d-m2-DEMO-1'));assert(byId(fallback,'task-issue-head-d-m3-DEMO-1'));
  assert.equal(new Set(ids(fallback)).size,ids(fallback).length,'no id twice');
});
