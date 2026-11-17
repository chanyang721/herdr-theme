import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseStartConfig,startArgv,lastJson,startResult,startAllowed,startPick,startSignature,cleanText,START_GUARD_MS}
  from '../mods/sixfold-desk/issue-start-model.js';

const CONFIG={v:1,command:'/opt/demo/bin/start',args:['send','{space}','{issue} {title}','--agent','{provider}','--level','{tier}'],
  providers:[{id:'claude',label:'Claude'},{id:'codex',label:'Codex'}],
  tiers:[{id:'low',label:'낮음'},{id:'mid',label:'중간'},{id:'high',label:'높음'},{id:'max',label:'최고'}],
  default:{provider:'claude',tier:'high'},timeout_ms:300000};
const config=parseStartConfig(JSON.stringify(CONFIG));
// The result line's text (the guard release flag is checked on its own).
const shown=r=>r&&{ok:r.ok,text:r.text};
const params={space:'Demo',issue:'DEMO-12',title:'Fix the  login\tpage',provider:'codex',tier:'mid'};

test('a valid setting parses with its defaults; anything off gives no setting',()=>{
  assert.equal(config.command,'/opt/demo/bin/start');assert.equal(config.timeout,300000);
  assert.deepEqual(config.defaults,{provider:'claude',tier:'high'});
  assert.deepEqual(config.providers.map(p=>p.label),['Claude','Codex']);
  assert.equal(parseStartConfig({...CONFIG,timeout_ms:undefined}).timeout,300000,'timeout is optional');
  assert.deepEqual(parseStartConfig({...CONFIG,default:undefined}).defaults,{provider:'claude',tier:'low'},'no default: the first of each list');
  const bad=[null,'','{not json',[],{...CONFIG,v:2},{...CONFIG,command:'start'},{...CONFIG,command:'./bin/start'},{...CONFIG,command:42},
    {...CONFIG,args:'send {issue}'},{...CONFIG,args:[1]},{...CONFIG,args:Array(41).fill('x')},{...CONFIG,args:['a\nb']},
    {...CONFIG,providers:[]},{...CONFIG,providers:[{id:'has space'}]},{...CONFIG,providers:[{id:'a'},{id:'a'}]},{...CONFIG,tiers:undefined},
    {...CONFIG,default:{provider:'other',tier:'high'}},{...CONFIG,default:{provider:'claude',tier:'huge'}},
    {...CONFIG,timeout_ms:10},{...CONFIG,timeout_ms:'300000'},{...CONFIG,timeout_ms:10_000_000}];
  for(const value of bad)assert.equal(parseStartConfig(typeof value==='string'||value===null?value:JSON.stringify(value)),null,JSON.stringify(value)?.slice(0,80));
  assert(parseStartConfig({...CONFIG,command:'C:\\tools\\start.exe'}),'a Windows absolute path is accepted');
  assert.equal(parseStartConfig({...CONFIG,args:Array(40).fill('x')}).args.length,40);
});

test('placeholders are replaced inside each argument once, without a shell; bad values run nothing',()=>{
  const argv=startArgv(config,params);
  assert.deepEqual(argv,{command:'/opt/demo/bin/start',timeout:300000,
    args:['send','Demo','DEMO-12 Fix the login page','--agent','codex','--level','mid']});
  // A title holding a placeholder, quotes or a shell sequence stays literal text in its one argument.
  const tricky=startArgv(config,{...params,title:'{tier} "$(rm -rf ~)"; `x` | y'});
  assert.equal(tricky.args[2],'DEMO-12 {tier} "$(rm -rf ~)"; `x` | y');assert.equal(tricky.args.length,7);
  // Title: control characters removed, whitespace folded, cut at 80 characters.
  const long=startArgv(config,{...params,title:`a\u0000b\r\n${'가'.repeat(200)}`});
  assert.equal(long.args[2],`DEMO-12 ${cleanText(`a b ${'가'.repeat(200)}`,80)}`);assert.equal([...long.args[2].slice(8)].length,80);
  assert.equal(startArgv(config,{...params,space:'De\u0007mo\n'}).args[1],'Demo','space name loses control characters');
  for(const bad of [{issue:'demo-12'},{issue:'DEMO-12; rm'},{issue:'DEMO'},{issue:'TOOLONGTEAM1-1'},{issue:'DEMO-12345678'},{issue:undefined},
    {provider:'gpt'},{provider:undefined},{tier:'ultra'},{space:''},{space:'\u0001'},{space:7}])
    assert.equal(startArgv(config,{...params,...bad}),null,JSON.stringify(bad));
  assert.equal(startArgv(null,params),null);
});

test('the result line reads the last JSON line of stdout',()=>{
  const out=lines=>({code:0,stdout:lines.join('\n')});
  assert.deepEqual(lastJson('log\n{"a":1}\nnot json\n{"b":2}\n\n'),{b:2});
  assert.equal(lastJson('no json here'),null);assert.equal(lastJson('[1,2]'),null);assert.equal(lastJson(undefined),null);
  assert.deepEqual(shown(startResult(out(['working…','{"outcome":"sent","task_id":"t-1","target":"Demo session","model":"opus"}']))),{ok:true,text:'보냄 · Demo session · opus'});
  assert.deepEqual(shown(startResult(out(['{"outcome":"pending","task_id":"t-2","target":"Demo"}']))),{ok:true,text:'보냄 · Demo'});
  assert.deepEqual(shown(startResult(out(['{"outcome":"unconfirmed","task_id":"t-3"}']))),{ok:true,text:'보냄'});
  assert.deepEqual(shown(startResult(out(['{"outcome":"sent"}']))),{ok:false,text:'안 보냄 · sent'},'no task id: not counted as sent');
  const reason='x'.repeat(300);
  assert.deepEqual(shown(startResult(out([`{"outcome":"blocked","reason":"${reason}"}`]))),{ok:false,text:`안 보냄 · ${'x'.repeat(120)}`});
  assert.deepEqual(shown(startResult(out(['{"outcome":"failed","reason":"no idle session"}']))),{ok:false,text:'안 보냄 · no idle session'});
  assert.deepEqual(shown(startResult(out(['{"outcome":"weird"}']))),{ok:false,text:'안 보냄 · weird'});
  assert.deepEqual(shown(startResult(out(['{}']))),{ok:false,text:'안 보냄'});
  assert.deepEqual(shown(startResult({code:2,stdout:'boom'})),{ok:false,text:'실행 실패(코드 2)'});
  assert.deepEqual(shown(startResult(null)),{ok:false,text:'실행 실패(코드 ?)'},'exec itself failed');
  assert.deepEqual(shown(startResult({code:1,stdout:'{"outcome":"blocked","reason":"busy"}'})),{ok:false,text:'안 보냄 · busy'},'a JSON answer is read whatever the exit code');
});

test('one start per issue: none while running, none within three minutes',()=>{
  const now=1_000_000;
  assert.equal(startAllowed(null,now),true);
  assert.equal(startAllowed({running:true,at:now-START_GUARD_MS*2},now),false);
  assert.equal(startAllowed({running:false,at:now-1000},now),false);
  assert.equal(startAllowed({running:false,at:now-START_GUARD_MS},now),true);
  assert.deepEqual(startPick(config,null),{provider:'claude',tier:'high'});
  assert.deepEqual(startPick(config,{provider:'codex',tier:'bogus'}),{provider:'codex',tier:'high'});
  assert.equal(startPick(null,{provider:'codex'}),null);
  const a=startSignature({startKey:'DEMO-1',startPick:{provider:'codex',tier:'low'},starts:new Map()});
  const b=startSignature({startKey:'DEMO-1',startPick:{provider:'codex',tier:'low'},starts:new Map([['DEMO-1',{running:true}]])});
  const c=startSignature({startKey:'DEMO-1',startPick:{provider:'codex',tier:'low'},starts:new Map([['DEMO-1',{running:false,text:'보냄'}]])});
  assert.equal(new Set([a,b,c,startSignature({startKey:'DEMO-2'}),startSignature({startKey:'DEMO-1',startPick:{provider:'claude',tier:'low'}})]).size,5,
    'unfolding, picking and each result change the redraw key');
});

test('a value cannot become an option, a long space is cut, and a grown argument is checked again',()=>{
  // '{title}' alone (a template without '-'): a title starting with '-' would read as an option.
  const alone=parseStartConfig({...CONFIG,args:['{space}','{title}','--agent','{provider}']});
  assert.equal(startArgv(alone,{...params,title:'--force everything'}),null);
  assert.equal(startArgv(alone,{...params,title:'  -x'}),null,'leading spaces are folded first');
  assert.equal(startArgv(alone,{...params,space:'-rf'}),null,'the space name too');
  assert.deepEqual(startArgv(alone,params).args,['Demo','Fix the login page','--agent','codex']);
  // A template argument that is an option itself may carry a value: '--title={title}'.
  const own=parseStartConfig({...CONFIG,args:['--title={title}']});
  assert.deepEqual(startArgv(own,{...params,title:'-dash'}).args,['--title=-dash']);
  // In '{issue} {title}' a dashed title is harmless: the argument starts with the issue key.
  assert.equal(startArgv(config,{...params,title:'--force'}).args[2],'DEMO-12 --force');
  assert.equal(startArgv(config,{...params,space:'가'.repeat(200)}).args[1],'가'.repeat(80));
  const near=parseStartConfig({...CONFIG,args:['x'.repeat(1990)+'{title}']});
  assert(near,'the template itself is within the limit');
  assert.equal(startArgv(near,{...params,title:'short'}).args[0].length,1995);
  assert.equal(startArgv(near,{...params,title:'y'.repeat(80)}),null,'over the limit after substitution');
});

test('only a surely-unsent answer releases the guard',()=>{
  const out=stdout=>startResult({code:0,stdout});
  assert.equal(out('{"outcome":"blocked","reason":"busy"}').release,true);
  assert.equal(out('{"outcome":"failed"}').release,true);
  assert.equal(out('{"outcome":"plan","reason":"dry run"}').release,true);
  for(const kept of ['{"outcome":"sent","task_id":"t"}','{"outcome":"pending","task_id":"t"}','{"outcome":"unconfirmed"}','{"outcome":"sent"}','{}','no json'])
    assert.equal(out(kept).release,false,kept);
  assert.equal(startResult(null).release,false,'exec failed or timed out: maybe sent');
});

let loads=0;
async function startIo(files={}){
  globalThis.__issueStartHost={appHome:()=>'/home/demo',exec:async()=>{throw new Error('use run');},
    readTextFile:async path=>{if(!(path in files))throw new Error('missing');return files[path];}};
  const source=(await readFile(new URL('../mods/sixfold-desk/issue-start.js',import.meta.url),'utf8'))
    .replace(/import \{([^}]+)\} from 'herdr';/,'const {$1}=globalThis.__issueStartHost;')
    .replace("'./issue-start-model.js'",JSON.stringify(new URL('../mods/sixfold-desk/issue-start-model.js',import.meta.url).href));
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${loads++}`);
}

test('the setting file is read from the app data folder; a missing or bad one gives none',async()=>{
  const path='/home/demo/data/sixfold/issue-start.json';
  assert.deepEqual((await (await startIo({[path]:JSON.stringify(CONFIG)})).loadStartConfig()).defaults,{provider:'claude',tier:'high'});
  assert.equal(await (await startIo({})).loadStartConfig(),null);
  assert.equal(await (await startIo({[path]:'{"v":1}'})).loadStartConfig(),null);
});

test('runStart execs the argv once and ignores a second press while running or within the guard',async()=>{
  const io=await startIo(),calls=[];let clock=5_000_000,release;
  const run=(command,args,options)=>{calls.push([command,args,options]);return new Promise(resolve=>{release=resolve;});};
  const first=io.runStart(config,params,{run,now:()=>clock});
  assert.equal(await io.runStart(config,params,{run,now:()=>clock}),null,'a press while running sends nothing');
  assert.equal(io.startGuarded('Demo','DEMO-12',clock),true);
  release({code:0,stdout:'{"outcome":"sent","task_id":"t-9","target":"Demo","model":"sonnet"}\n'});
  assert.deepEqual(shown(await first),{ok:true,text:'보냄 · Demo · sonnet'});
  assert.deepEqual(calls,[['/opt/demo/bin/start',['send','Demo','DEMO-12 Fix the login page','--agent','codex','--level','mid'],{timeout:300000}]]);
  clock+=60_000;
  assert.equal(await io.runStart(config,params,{run,now:()=>clock}),null,'within three minutes: ignored');
  // Another issue is its own guard.
  const other=io.runStart(config,{...params,issue:'DEMO-13'},{run:async()=>({code:3,stdout:''}),now:()=>clock});
  assert.deepEqual(shown(await other),{ok:false,text:'실행 실패(코드 3)'});
  clock+=START_GUARD_MS;
  assert.equal(io.startGuarded('Demo','DEMO-12',clock),false);
  assert.deepEqual(shown(await io.runStart(config,params,{run:async()=>{throw new Error('spawn failed');},now:()=>clock})),{ok:false,text:'실행 실패(코드 ?)'});
  // Bad values: nothing runs and no guard is taken.
  let ran=0;
  assert.deepEqual(shown(await io.runStart(config,{...params,issue:'bad'},{run:async()=>{ran++;},now:()=>clock})),{ok:false,text:'안 보냄 · 작업 시작 값 확인 실패'});
  assert.equal(ran,0);assert.equal(io.startGuarded('Demo','bad',clock),false);
  io.resetStartGuards();
});

test('a blocked answer frees the issue at once; a timeout keeps it for three minutes',async()=>{
  const io=await startIo(),clock=9_000_000;let runs=0;
  const blocked=async()=>{runs++;return {code:1,stdout:'{"outcome":"blocked","reason":"no idle session"}'};};
  assert.deepEqual(shown(await io.runStart(config,params,{run:blocked,now:()=>clock})),{ok:false,text:'안 보냄 · no idle session'});
  assert.equal(io.startGuarded('Demo','DEMO-12',clock),false);assert.equal(io.startGuardLeft('Demo','DEMO-12',clock),0);
  await io.runStart(config,params,{run:blocked,now:()=>clock});assert.equal(runs,2,'pressed again at once');
  await io.runStart(config,params,{run:async()=>{throw new Error('timed out');},now:()=>clock});
  assert.equal(io.startGuarded('Demo','DEMO-12',clock+START_GUARD_MS-1),true);
  assert.equal(io.startGuardLeft('Demo','DEMO-12',clock+1000),START_GUARD_MS-1000);
  assert.equal(await io.runStart(config,params,{run:blocked,now:()=>clock+1000}),null);assert.equal(runs,2);
  io.resetStartGuards();
});

// --- the popover view (same fixture as task-issues-view.test.mjs) ---
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
const click=(node,cx={stop_propagation(){}})=>call(node,'on_click')?.[1]({},cx);
const theme={surface:'#151a22',chrome:'#10151e',popover:'#1c2330',foreground:'#e5edf5',muted:'#a6b0bf',dim:'#788594',accent:'#a9b8ff',border:'#39434f',selected:'#253249',hover:'#253249',background:'#101318',blocked:'#edac67'};
const rows=[{key:'DEMO-1',title:'One',state:'working'},{key:'DEMO-2',title:'Two',state:'review'}];
async function view(){
  globalThis.__issueView={div:()=>element(),svg:value=>element('svg',value),h_flex:()=>element('row'),v_flex:()=>element('column'),Popover:{new:id=>element('popover',id)}};
  const local=async name=>(await readFile(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url),'utf8'))
    .replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base)';/g,'const {$1}=globalThis.__issueView;')
    .replace("'./alert-model.js'",JSON.stringify(new URL('../mods/sixfold-desk/alert-model.js',import.meta.url).href))
    .replace("'./issue-model.js'",JSON.stringify(new URL('../mods/sixfold-desk/issue-model.js',import.meta.url).href));
  const detailView=`data:text/javascript;base64,${Buffer.from(await local('issue-detail-view')).toString('base64')}#${loads++}`;
  const source=(await local('task-issues-view')).replace("'./issue-detail-view.js'",JSON.stringify(detailView));
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${loads++}`);
}

test('a row press unfolds its start strip; the detail stays one › press away',async()=>{
  const {issuePopover}=await view(),calls=[];
  const base={id:'d',open:true,trigger:element(),scope:'week',rows,
    onExpand:key=>calls.push(['expand',key]),onDetail:key=>calls.push(['detail',key]),
    onStartPick:(kind,id)=>calls.push(['pick',kind,id]),onStart:key=>calls.push(['start',key])};
  const closed=issuePopover(base,theme);
  assert(!byId(closed,'task-issue-start-d-DEMO-1'),'nothing unfolded');
  click(byId(closed,'task-issue-d-DEMO-1'));
  click(byId(closed,'task-issue-open-d-DEMO-2'));
  assert.deepEqual(calls,[['expand','DEMO-1'],['detail','DEMO-2']]);
  calls.length=0;
  const open=issuePopover({...base,startKey:'DEMO-1',start:{config,pick:{provider:'claude',tier:'high'},entry:null,blocked:false}},theme);
  const strip=byId(open,'task-issue-start-d-DEMO-1');assert(strip);
  assert(!byId(open,'task-issue-start-d-DEMO-2'),'one issue at a time');
  // The strip is right under its row, inside the same wrapper.
  const wrap=byId(open,'task-issue-wrap-d-DEMO-1');
  assert.deepEqual(wrap.nodes.map(node=>call(node,'id')?.[1]),['task-issue-d-DEMO-1','task-issue-start-d-DEMO-1']);
  for(const word of ['Claude','Codex','낮음','중간','높음','최고','작업 시작'])assert(words(strip).includes(word),word);
  const picked=byId(strip,'task-issue-start-provider-d-DEMO-1-claude'),other=byId(strip,'task-issue-start-provider-d-DEMO-1-codex');
  assert.equal(call(picked,'border_color')[1],theme.accent);assert.equal(call(other,'border_color')[1],theme.border);
  click(other);click(byId(strip,'task-issue-start-tier-d-DEMO-1-max'));click(byId(strip,'task-issue-start-go-d-DEMO-1'));
  click(byId(open,'task-issue-d-DEMO-1'));
  assert.deepEqual(calls,[['pick','provider','codex'],['pick','tier','max'],['start','DEMO-1'],['expand','DEMO-1']]);
});

test('the strip shows sending, the result, the guard, and a missing setting',async()=>{
  const {issuePopover}=await view();let starts=0;
  const tip=start=>call(byId(issuePopover({id:'d',open:true,trigger:element(),rows,onExpand(){},onStart(){},startKey:'DEMO-2',start},theme),'task-issue-start-go-d-DEMO-2'),'tooltip')?.[1];
  assert.equal(tip({config,pick:config.defaults,entry:{running:false,ok:true,text:'보냄'},blocked:true}),'방금 시작 요청한 이슈입니다 · 3분 뒤 다시 누를 수 있습니다');
  assert.equal(tip({config,pick:config.defaults,entry:null,blocked:false}),undefined);
  const at=start=>byId(issuePopover({id:'d',open:true,trigger:element(),rows,onExpand(){},onStart:()=>starts++,startKey:'DEMO-2',start},theme),'task-issue-start-d-DEMO-2');
  const sending=at({config,pick:config.defaults,entry:{running:true},blocked:true});
  assert(words(sending).includes('보내는 중…'));
  click(byId(sending,'task-issue-start-go-d-DEMO-2'));assert(!call(byId(sending,'task-issue-start-provider-d-DEMO-2-codex'),'on_click'),'no change while sending');
  const sent=at({config,pick:config.defaults,entry:{running:false,ok:true,text:'보냄 · Demo · opus'},blocked:true});
  assert.deepEqual(words(byId(sent,'task-issue-start-result-d-DEMO-2')),['보냄 · Demo · opus']);
  click(byId(sent,'task-issue-start-go-d-DEMO-2'));
  const free=at({config,pick:config.defaults,entry:{running:false,ok:false,text:'안 보냄 · busy'},blocked:false});
  assert(words(free).includes('안 보냄 · busy'));click(byId(free,'task-issue-start-go-d-DEMO-2'));
  assert.equal(starts,1,'only the unguarded press starts');
  const none=at({config:null,pick:null,entry:null,blocked:false});
  assert.deepEqual(words(none),['작업 시작 설정 없음']);assert(!byId(none,'task-issue-start-go-d-DEMO-2'));
});

test('without the start wiring a row still opens its detail, with no › button',async()=>{
  const {issuePopover}=await view(),details=[];
  const tree=issuePopover({id:'d',open:true,trigger:element(),rows,onDetail:key=>details.push(key)},theme);
  click(byId(tree,'task-issue-d-DEMO-1'));assert.deepEqual(details,['DEMO-1']);
  assert(!byId(tree,'task-issue-open-d-DEMO-1'));
});
