import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

async function load(){
 const texts=[];
 function element(){const target={};let proxy;proxy=new Proxy(target,{get(t,key){
  if(key==='then')return undefined;
  if(key==='child')return value=>{if(typeof value==='string')texts.push(value);return proxy;};
  if(key==='when')return (condition,fn)=>{if(condition)fn(proxy);return proxy;};
  return ()=>proxy;
 }});return proxy;}
 globalThis.__paneUsageRuntime={div:element,h_flex:element};
 const source=(await readFile(new URL('../mods/sixfold-desk/session-usage.js',import.meta.url),'utf8'))
  .replace("import {div} from 'gpui-kit';",'const {div}=globalThis.__paneUsageRuntime;')
  .replace("import {h_flex} from 'gpui-base';",'const {h_flex}=globalThis.__paneUsageRuntime;');
 const module=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 return {module,texts};
}

test('pane header shows the session share of the weekly window, or a quiet unknown',async()=>{
 const {module,texts}=await load();
 const theme={surface:'#111',border:'#222',dim:'#666',accent:'#0af'};
 const shares={terminals:{
  t1:{agent:'claude',known:true,share:9.6,limitPart:1.25,limitWeek:13,model:'claude-opus-5-5',since:'2026-10-31'},
  t7:{agent:'codex',known:false,reason:'session_unconfirmed'},
 }};
 const shared=key=>key===module.SHARES_KEY?shares:undefined;
 module.paneUsage({pane:'p1',terminal:'t1'},theme,shared);
 assert.ok(texts.includes('9.6%'));
 assert.ok(texts.includes('이번 주'));
 texts.length=0;
 module.paneUsage({pane:'p7',terminal:'t7'},theme,shared);
 assert.deepEqual(texts,['사용량 —']);
 texts.length=0;
 module.paneUsage({pane:'p9',terminal:'t9'},theme,shared);
 assert.deepEqual(texts,[],'a pane with no agent session shows nothing');
 assert.match(module.paneUsageTip(shares.terminals.t1,'t1'),/현재 주간 한도 기간\(2026-10-31~\) Claude 사용량 중 9\.6%\n주간 한도 13% 중 약 1\.3%p/);
 assert.match(module.paneUsageTip(shares.terminals.t7,'t7'),/세션 미확인/);
 assert.equal(module.sharePercent(0.04),'<0.1%');
 assert.equal(module.sharePercent(23.4),'23%');
});

test('the sidebar publishes the computer it shows for the CPU/RAM strip',async()=>{
 const main=await readFile(new URL('../mods/sixfold-desk/main.js',import.meta.url),'utf8');
 assert.match(main,/setShared\('sixfold\.computing\.shown', \{ key: selectedComputer, label \}\)/);
 assert.match(main,/if \(role === 'sidebar'\) \{\s*\/\/ Publish the computer/);
});
