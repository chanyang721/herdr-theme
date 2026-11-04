import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

async function load(){
 const texts=[],icons=[];
 function element(){const target={};let proxy;proxy=new Proxy(target,{get(t,key){
  if(key==='then')return undefined;
  if(key==='child')return value=>{if(typeof value==='string')texts.push(value);return proxy;};
  if(key==='when')return (condition,fn)=>{if(condition)fn(proxy);return proxy;};
  return ()=>proxy;
 }});return proxy;}
 globalThis.__paneMetaRuntime={div:element,h_flex:element,svg:path=>{icons.push(path);return element();}};
 const source=(await readFile(new URL('../mods/sixfold-desk/pane-meta.js',import.meta.url),'utf8'))
  .replace("import {div, svg} from 'gpui-kit';",'const {div,svg}=globalThis.__paneMetaRuntime;')
  .replace("import {h_flex} from 'gpui-base';",'const {h_flex}=globalThis.__paneMetaRuntime;');
 return {module:await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64')),texts,icons};
}
const claude={agent:'claude',model:'Opus 5.5',modelId:'claude-opus-5-5',speed:'표준',effort:'medium',permission:'auto',level:'auto'};
const codex={agent:'codex',model:'GPT-6.1-Sol',modelId:'gpt-6.1-sol',speed:'표준',effort:'medium',permission:'YOLO',level:'full'};
const theme={muted:'#999',dim:'#666',working:'#f80',blocked:'#f00'};

test('the header shows the agent icon and session settings, shorter in narrow panes',async()=>{
 const {module,texts,icons}=await load();
 module.paneMetaChip({pane:'p1'},theme,claude,700);
 assert.deepEqual(icons,['mods/plan-usage/claude.svg'],'the agent is an icon, not its name');
 assert.deepEqual(texts,['Opus 5.5 · 표준 · medium','auto']);
 texts.length=0;module.paneMetaChip({pane:'p2'},theme,codex,450);
 assert.deepEqual(texts,['GPT-6.1-Sol','YOLO'],'medium width keeps model and permission');
 texts.length=0;module.paneMetaChip({pane:'p3'},theme,codex,300);
 assert.deepEqual(texts,[],'narrow: icon and the permission dot only');
 assert.equal(module.metaTip(codex),'Codex · gpt-6.1-sol\n속도 표준\neffort medium\n권한 YOLO (전체 권한 · 묻지 않음)\n세션 기록 기준');
});

test('permission risk colours and unmatched sessions',async()=>{
 const {module}=await load();
 assert.equal(module.levelColor('full',theme),'#f80');assert.equal(module.levelColor('auto',theme),'#999');assert.equal(module.levelColor('ask',theme),'#666');
 const shares={terminals:{t1:{agent:'claude',known:true,meta:claude},t2:{agent:'codex',known:false,reason:'session_unconfirmed'},t3:{meta:{agent:'other',model:'x'}}}};
 const shared=key=>key===module.SHARES_KEY?shares:undefined;
 assert.equal(module.paneMeta('t1',shared),claude);
 assert.equal(module.paneMeta('t2',shared),null,'no confirmed session, nothing shown');
 assert.equal(module.paneMeta('t3',shared),null);assert.equal(module.paneMeta('t9',()=>undefined),null);
 assert.equal(module.showTitle('Claude Code',claude),false,'the product name is replaced by the icon');
 assert.equal(module.showTitle('Herdr 문서탭',claude),true);assert.equal(module.showTitle('Claude Code',null),true);
});

test('the position number before the pane title is off unless the site turns it on',async()=>{
 const {module}=await load();
 assert.equal(module.showPaneIndex(undefined),false);
 assert.equal(module.showPaneIndex({}),false);
 assert.equal(module.showPaneIndex({pane_header_index:'yes'}),false,'only an explicit true restores it');
 assert.equal(module.showPaneIndex({pane_header_index:true}),true);
 const main=await readFile(new URL('../mods/sixfold-desk/main.js',import.meta.url),'utf8');
 assert.match(main,/\.when\(showPaneIndex\(this\.site\), el => el\.child\(div\(\)[^\n]*padStart\(2, '0'\)/,'the header number renders only behind the setting');
});
