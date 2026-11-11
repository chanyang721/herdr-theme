import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

async function load(){
 const texts=[],tips=[],subscriptions=[];
 function element(){const target={};let proxy;proxy=new Proxy(target,{get(t,key){
  if(key==='then')return undefined;
  if(key==='child')return value=>{if(typeof value==='string')texts.push(value);return proxy;};
  if(key==='when')return (condition,fn)=>{if(condition)fn(proxy);return proxy;};
  if(key==='tooltip')return value=>{tips.push(value);return proxy;};
  return ()=>proxy;
 }});return proxy;}
 globalThis.__micRuntime={div:element,h_flex:element,subscribeJsonFile:(cx,path,callback)=>{subscriptions.push({path,callback});return ()=>{};}};
 const source=(await readFile(new URL('../mods/sixfold-desk/mic.js',import.meta.url),'utf8'))
  .replace("import {div} from 'gpui-kit';",'const {div}=globalThis.__micRuntime;')
  .replace("import {h_flex} from 'gpui-base';",'const {h_flex}=globalThis.__micRuntime;')
  .replace("import {subscribeJsonFile} from './panel-io.js';",'const {subscribeJsonFile}=globalThis.__micRuntime;');
 return {module:await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64')+`#${Math.random()}`),texts,tips,subscriptions};
}
const theme={surface:'#111',border:'#222',foreground:'#eee',muted:'#999',dim:'#666',accent:'#0af',working:'#f80',blocked:'#e33'};
const record={schema:1,panes:{
 'app:t1':{agent:'claude',state:'recording',since:1},
 'app:t2':{agent:'claude',state:'paused',reason:'headset',since:1},
 'w1:p3':{agent:'codex',state:'paused',reason:'muted',since:1},
 'app:t4':{agent:'claude',state:'off',reason:'key_ignored',since:1},
},dropped:{pane:'app:t1',cause:'other',chars:12,at:2}};

test('a recording shows everywhere, paused and off only where you are looking',async()=>{
 const {module}=await load();
 const facts=[{address:'t3',labels:{'sixfold.source-pane':'w1:p3'}}];
 assert.deepEqual(module.paneMic({terminal:'t1',focused:false},facts,record),
  {state:'recording',reason:null,agent:'claude',dropped:record.dropped},'a second listening pane is the fault to see');
 assert.equal(module.paneMic({terminal:'t2',focused:false},facts,record),null,'paused elsewhere is normal, not shown');
 assert.equal(module.paneMic({terminal:'t2',focused:true},facts,record).reason,'headset');
 assert.equal(module.paneMic({terminal:'t3',focused:true},facts,record).agent,'codex','a TUI pane bridged into the app');
 assert.equal(module.paneMic({terminal:'t9',focused:true},facts,record),null,'no watcher, nothing drawn');
 assert.equal(module.paneMic({terminal:'t1',focused:true},facts,null),null);
});

test('Korean labels shorten in narrow panes and the tooltip says why',async()=>{
 const {module,texts,tips}=await load();
 const mic=module.paneMic({terminal:'t1',focused:true},[],record);
 module.paneMicChip({pane:'p1'},theme,mic,700);
 assert.deepEqual(texts,['마이크 듣는 중','다른 목소리 · 버림']);
 assert.equal(tips[0],'Claude 받아쓰기가 이 칸에서 듣고 있습니다.\n12자 받아쓰기를 다른 사람 목소리로 판단해 보내지 않고 지웠습니다.\n음성 플러그인 기준, 상태가 바뀔 때만 갱신');
 texts.length=0;module.paneMicChip({pane:'p1'},theme,mic,400);
 assert.deepEqual(texts,['듣는 중','버림']);
 texts.length=0;module.paneMicChip({pane:'p2'},theme,module.paneMic({terminal:'t2',focused:true},[],record),700);
 assert.deepEqual(texts,['마이크 멈춤 · 헤드셋 아님']);
 texts.length=0;module.paneMicChip({pane:'p4'},theme,module.paneMic({terminal:'t4',focused:true},[],record),700);
 assert.deepEqual(texts,['마이크 꺼짐 · F8 무시됨']);
});

test('the sidebar shares the record only when it changes',async()=>{
 const {module,subscriptions}=await load();
 const shared=[];const view={};
 module.watchMic(view,{},'/app/data/sixfold',(key,value)=>shared.push([key,value]));
 assert.equal(subscriptions[0].path,'/app/data/sixfold/voice-mic.json');
 const send=subscriptions[0].callback;
 send({status:'ready',value:record});send({status:'ready',value:JSON.parse(JSON.stringify(record))});
 send({status:'error'});send({status:'missing'});
 assert.deepEqual(shared,[[module.MIC_KEY,record],[module.MIC_KEY,null]],'same content and read errors share nothing');
 assert.equal(view.fileSubscriptions.length,1);
 const main=await readFile(new URL('../mods/sixfold-desk/main.js',import.meta.url),'utf8');
 assert.match(main,/\.when\(Boolean\(mic\), el => el\.child\(paneMicChip\(p, t, mic, this\.headWidth\)\)\)/);
 assert.match(main,/watchMic\(this,cx,`\$\{appHome\(\)\}\/data\/sixfold`,setShared\)/);
});
