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
 assert.equal(tips[0],'할 일 2/5 완료 · 진행 중 1 · 대기 2\n지금: Rendering the chip\n서브에이전트 2개 실행 중\n· Map the collector\n· Write the tests\nClaude 할 일 목록·서브에이전트 기록 기준 (2분마다 갱신, 6분 넘게 갱신이 없으면 숨김)');
 texts.length=0;module.paneWorkChip({pane:'p2'},theme,work,450);
 assert.deepEqual(texts,['2/5','서브 2'],'medium and narrow keep the numbers');
 texts.length=0;module.paneWorkChip({pane:'p3'},theme,{tasks:null,agents:{running:1,names:[]}},300);
 assert.deepEqual(texts,['서브 1'],'only running sub-agents');
 assert.equal(module.workParts({tasks:{...tasks,completed:5,pending:0,in_progress:0},agents:null},700)[0].done,true);
});

test('only the pane\'s own confirmed session with something to show gets a chip',async()=>{
 const {module}=await load();
 const shares={updated:Date.now(),terminals:{
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

test('an old or unavailable snapshot shows no work, judged by the terminal\'s own computer',async()=>{
 const {module}=await load();
 const now=Date.UTC(2026,10,11,4,0,0),fresh=now-60*1000,old=now-60*60*1000;
 const running={work:{subagents:{running:1,names:['Done an hour ago']}}};
 // Reviewer case: the last successful refresh was an hour ago and the collector failed since.
 let store={[module.SHARES_KEY]:{updated:old,terminals:{t1:running}}};
 let shared=key=>store[key];
 assert.equal(module.paneWork('t1',shared,now),null,'an hour-old running count is not shown');
 store={[module.SHARES_KEY]:{updated:fresh,terminals:{t1:running}}};
 assert.deepEqual(module.paneWork('t1',shared,now),{tasks:null,agents:running.work.subagents},'a fresh snapshot still shows');
 assert.equal(module.paneWork('t1',shared,fresh+module.WORK_STALE_MS+1),null,'past the stale limit it hides');
 assert.equal(module.paneWork('t1',key=>({...store,[module.SHARES_KEY]:{terminals:{t1:running}}})[key],now),null,'no refresh time, nothing shown');
 // The aggregate's time is the newest computer's: a stale remote must not borrow the fresh local's time.
 store={[module.SHARES_KEY]:{updated:fresh,terminals:{t1:running,'home/t2':running}},
  [module.COMPUTERS_KEY]:{local:{updated:fresh,available:true,terminals:{t1:running}},'remote:home':{updated:old,available:true,terminals:{'home/t2':running}}}};
 assert.ok(module.paneWork('t1',shared,now));
 assert.equal(module.paneWork('home/t2',shared,now),null,'the stale remote computer shows no work');
 store[module.COMPUTERS_KEY].local.available=false;
 assert.equal(module.paneWork('t1',shared,now),null,'a computer marked unavailable shows no work');
});
