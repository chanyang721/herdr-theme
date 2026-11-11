import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

async function load(){
 const texts=[],tips=[];
 function element(){const target={};let proxy;proxy=new Proxy(target,{get(t,key){
  if(key==='then')return undefined;
  if(key==='child')return value=>{if(typeof value==='string')texts.push(value);return proxy;};
  if(key==='when')return (condition,fn)=>{if(condition)fn(proxy);return proxy;};
  if(key==='tooltip')return value=>{tips.push(value);return proxy;};
  return ()=>proxy;
 }});return proxy;}
 globalThis.__paneWorkRuntime={div:element,h_flex:element};
 const source=(await readFile(new URL('../mods/sixfold-desk/pane-work.js',import.meta.url),'utf8'))
  .replace("import {div} from 'gpui-kit';",'const {div}=globalThis.__paneWorkRuntime;')
  .replace("import {h_flex} from 'gpui-base';",'const {h_flex}=globalThis.__paneWorkRuntime;');
 return {module:await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64')),texts,tips};
}
const theme={surface:'#111',border:'#222',foreground:'#eee',muted:'#999',dim:'#666',accent:'#0af',working:'#f80'};
const tasks={pending:2,in_progress:1,completed:2,total:5,current:'Rendering the chip'};
const agents={running:2,names:['Map the collector','Write the tests']};

test('a confirmed session shows task progress and running sub-agents, shorter in narrow panes',async()=>{
 const {module,texts,tips}=await load();
 const work={tasks,agents};
 module.paneWorkChip({pane:'p1'},theme,work,700);
 assert.deepEqual(texts,['할 일 2/5','서브에이전트 2 실행 중']);
 assert.equal(tips[0],'할 일 2/5 완료 · 진행 중 1 · 대기 2\n지금: Rendering the chip\n서브에이전트 2개 실행 중\n· Map the collector\n· Write the tests\nClaude 할 일 목록·서브에이전트 기록 기준 (최대 2분 늦음)');
 texts.length=0;module.paneWorkChip({pane:'p2'},theme,work,450);
 assert.deepEqual(texts,['2/5','서브 2'],'medium and narrow keep the numbers');
 texts.length=0;module.paneWorkChip({pane:'p3'},theme,{tasks:null,agents:{running:1,names:[]}},300);
 assert.deepEqual(texts,['서브 1'],'only running sub-agents');
 assert.equal(module.workParts({tasks:{...tasks,completed:5,pending:0,in_progress:0},agents:null},700)[0].done,true);
});

test('only the pane\'s own confirmed session with something to show gets a chip',async()=>{
 const {module}=await load();
 const shares={terminals:{
  t1:{agent:'claude',known:true,work:{tasks,subagents:agents}},
  t2:{agent:'claude',known:true},
  t3:{agent:'claude',known:true,work:{tasks:{total:0},subagents:{running:0}}},
  t4:{agent:'claude',known:false,reason:'session_not_indexed',work:{subagents:{running:1,names:[]}}},
 }};
 const shared=key=>key===module.SHARES_KEY?shares:undefined;
 assert.deepEqual(module.paneWork('t1',shared),{tasks,agents});
 assert.equal(module.paneWork('t2',shared),null,'no work field, nothing shown');
 assert.equal(module.paneWork('t3',shared),null,'empty list and no running sub-agent');
 assert.deepEqual(module.paneWork('t4',shared),{tasks:null,agents:{running:1,names:[]}},'a confirmed but unindexed session still shows its work');
 assert.equal(module.paneWork('t9',()=>undefined),null);
 const main=await readFile(new URL('../mods/sixfold-desk/main.js',import.meta.url),'utf8');
 assert.match(main,/\.when\(Boolean\(work\), el => el\.child\(paneWorkChip\(p, t, work, this\.headWidth\)\)\)/,'the header draws the chip only when there is work');
});
