import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseStartConfig,startArgv,lastJson,startResult,startAllowed,startPick,startSignature,cleanText,START_GUARD_MS}
  from '../mods/sixfold-desk/issue-start-model.js';

const CONFIG={v:1,command:'/opt/demo/bin/start',args:['send','{space}','{issue} {title}','--agent','{provider}','--level','{level}'],
  providers:[{id:'claude',label:'Claude'},{id:'codex',label:'Codex'}],
  levels:[{id:'low',label:'낮음'},{id:'mid',label:'중간'},{id:'high',label:'높음'},{id:'max',label:'최고'}],
  default:{provider:'claude',level:'high'},timeout_ms:300000};
const config=parseStartConfig(JSON.stringify(CONFIG));
// The result line's text (the guard release flag is checked on its own).
const shown=r=>r&&{ok:r.ok,text:r.text};
const params={space:'Demo',issue:'DEMO-12',title:'Fix the  login\tpage',provider:'codex',level:'mid'};

test('a valid setting parses with its defaults; anything off gives no setting',()=>{
  assert.equal(config.command,'/opt/demo/bin/start');assert.equal(config.timeout,300000);
  assert.deepEqual(config.defaults,{provider:'claude',level:'high'});
  assert.deepEqual(config.providers.map(p=>p.label),['Claude','Codex']);
  assert.equal(parseStartConfig({...CONFIG,timeout_ms:undefined}).timeout,300000,'timeout is optional');
  assert.deepEqual(parseStartConfig({...CONFIG,default:undefined}).defaults,{provider:'claude',level:'low'},'no default: the first of each list');
  const bad=[null,'','{not json',[],{...CONFIG,v:2},{...CONFIG,command:'start'},{...CONFIG,command:'./bin/start'},{...CONFIG,command:42},
    {...CONFIG,args:'send {issue}'},{...CONFIG,args:[1]},{...CONFIG,args:Array(41).fill('x')},{...CONFIG,args:['a\nb']},
    {...CONFIG,providers:[]},{...CONFIG,providers:[{id:'has space'}]},{...CONFIG,providers:[{id:'a'},{id:'a'}]},{...CONFIG,levels:undefined},
    {...CONFIG,default:{provider:'other',level:'high'}},{...CONFIG,default:{provider:'claude',level:'huge'}},
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
  const tricky=startArgv(config,{...params,title:'{level} "$(rm -rf ~)"; `x` | y'});
  assert.equal(tricky.args[2],'DEMO-12 {level} "$(rm -rf ~)"; `x` | y');assert.equal(tricky.args.length,7);
  // Title: control characters removed, whitespace folded, cut at 80 characters.
  const long=startArgv(config,{...params,title:`a\u0000b\r\n${'가'.repeat(200)}`});
  assert.equal(long.args[2],`DEMO-12 ${cleanText(`a b ${'가'.repeat(200)}`,80)}`);assert.equal([...long.args[2].slice(8)].length,80);
  assert.equal(startArgv(config,{...params,space:'De\u0007mo\n'}).args[1],'Demo','space name loses control characters');
  for(const bad of [{issue:'demo-12'},{issue:'DEMO-12; rm'},{issue:'DEMO'},{issue:'TOOLONGTEAM1-1'},{issue:'DEMO-12345678'},{issue:undefined},
    {provider:'gpt'},{provider:undefined},{level:'ultra'},{space:''},{space:'\u0001'},{space:7}])
    assert.equal(startArgv(config,{...params,...bad}),null,JSON.stringify(bad));
  assert.equal(startArgv(null,params),null);
});

test('the result line reads the last JSON line of stdout',()=>{
  const out=lines=>({code:0,stdout:lines.join('\n')});
  assert.deepEqual(lastJson('log\n{"a":1}\nnot json\n{"b":2}\n\n'),{b:2});
  assert.equal(lastJson('no json here'),null);assert.equal(lastJson('[1,2]'),null);assert.equal(lastJson(undefined),null);
  assert.deepEqual(shown(startResult(out(['working…','{"outcome":"sent","task":"t-1","target":"Demo session","model":"opus"}']))),{ok:true,text:'보냄 · Demo session · opus'});
  assert.deepEqual(shown(startResult(out(['{"outcome":"pending","task":"t-2","target":"Demo"}']))),{ok:true,text:'보냄 · Demo'});
  assert.deepEqual(shown(startResult(out(['{"outcome":"unconfirmed","task":"t-3"}']))),{ok:true,text:'보냄'});
  assert.deepEqual(shown(startResult(out(['{"outcome":"sent"}']))),{ok:false,text:'안 보냄 · sent'},'no task id: not counted as sent');
  assert.deepEqual(shown(startResult(out(['{"outcome":"sent","job":"j-1"}']),undefined,'job')),{ok:true,text:'보냄'},'a configured task field');
  assert.equal(parseStartConfig({...CONFIG,task_field:'job'}).taskField,'job');
  assert.equal(parseStartConfig(CONFIG).taskField,'task');
  assert.equal(parseStartConfig({...CONFIG,task_field:'Bad-Name'}),null);
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
  assert.deepEqual(startPick(config,null),{provider:'claude',level:'high'});
  assert.deepEqual(startPick(config,{provider:'codex',level:'bogus'}),{provider:'codex',level:'high'});
  assert.equal(startPick(null,{provider:'codex'}),null);
  const a=startSignature({detail:'DEMO-1',startPick:{provider:'codex',level:'low'},starts:new Map()});
  const b=startSignature({detail:'DEMO-1',startPick:{provider:'codex',level:'low'},starts:new Map([['DEMO-1',{running:true}]])});
  const c=startSignature({detail:'DEMO-1',startPick:{provider:'codex',level:'low'},starts:new Map([['DEMO-1',{running:false,text:'보냄'}]])});
  assert.equal(new Set([a,b,c,startSignature({detail:'DEMO-2'}),startSignature({detail:'DEMO-1',startPick:{provider:'claude',level:'low'}})]).size,5,
    'the open detail, picking and each result change the redraw key');
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

test('the guard is released only for outcomes on the allow list (setting or the default)',()=>{
  const out=(outcome,release)=>startResult({code:0,stdout:JSON.stringify(outcome===undefined?{}:{outcome})},release).release;
  assert.deepEqual(config.release,['blocked','plan'],'default allow list');
  for(const kept of ['unknown','queued','weird','failed','already_sent','awaiting_ack','deferred','running','intent','unclear','incomplete','planned','',undefined])
    assert.equal(out(kept),false,`kept: ${kept}`);
  for(const freed of ['blocked','plan'])assert.equal(out(freed),true,freed);
  const own=parseStartConfig({...CONFIG,release_outcomes:['blocked','declined']});
  assert.deepEqual(own.release,['blocked','declined']);
  assert.equal(out('declined',own.release),true);assert.equal(out('plan',own.release),false,'the setting replaces the default');
  assert.deepEqual(parseStartConfig({...CONFIG,release_outcomes:[]}).release,[],'an empty list never releases');
  for(const bad of [['sent'],['pending'],['unconfirmed'],'blocked',[1],['Has Caps'],Array(21).fill('x')])
    assert.equal(parseStartConfig({...CONFIG,release_outcomes:bad}),null,JSON.stringify(bad));
});

test('only a surely-unsent answer releases the guard',()=>{
  const out=stdout=>startResult({code:0,stdout});
  assert.equal(out('{"outcome":"blocked","reason":"busy"}').release,true);
  assert.equal(out('{"outcome":"failed"}').release,false,'failed may come after a try: kept');
  assert.equal(out('{"outcome":"plan","reason":"dry run"}').release,true);
  for(const kept of ['{"outcome":"sent","task":"t"}','{"outcome":"pending","task":"t"}','{"outcome":"unconfirmed"}','{"outcome":"sent"}','{}','no json'])
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
  assert.deepEqual((await (await startIo({[path]:JSON.stringify(CONFIG)})).loadStartConfig()).defaults,{provider:'claude',level:'high'});
  assert.equal(await (await startIo({})).loadStartConfig(),null);
  assert.equal(await (await startIo({[path]:'{"v":1}'})).loadStartConfig(),null);
  assert.deepEqual(await (await startIo({[path]:'{"v":1}'})).loadStartConfigStatus(),{config:null,invalid:true},'a bad file is reported');
  assert.deepEqual(await (await startIo({})).loadStartConfigStatus(),{config:null,invalid:false},'no file is not an error');
});

test('a setting file in the previous format (tiers, {tier}, task_id) keeps working',()=>{
  const old={...CONFIG,levels:undefined,tiers:CONFIG.levels,default:{provider:'claude',tier:'mid'},
    args:CONFIG.args.map(arg=>arg==='{level}'?'{tier}':arg)};
  const parsed=parseStartConfig(JSON.stringify(old));
  assert.deepEqual(parsed.defaults,{provider:'claude',level:'mid'});
  assert.equal(parsed.taskField,'task_id');
  assert.equal(startArgv(parsed,{space:'Demo',issue:'DEMO-1',title:'t',provider:'codex',level:'low'}).args.at(-1),'low');
  assert.equal(startResult({code:0,stdout:'{"outcome":"sent","task_id":"t-9"}'},undefined,parsed.taskField).ok,true);
});

test('runStart execs the argv once and ignores a second press while running or within the guard',async()=>{
  const io=await startIo(),calls=[];let clock=5_000_000,release;
  const run=(command,args,options)=>{calls.push([command,args,options]);return new Promise(resolve=>{release=resolve;});};
  const first=io.runStart(config,params,{run,now:()=>clock});
  assert.equal(await io.runStart(config,params,{run,now:()=>clock}),null,'a press while running sends nothing');
  assert.equal(io.startGuarded('Demo','DEMO-12',clock),true);
  release({code:0,stdout:'{"outcome":"sent","task":"t-9","target":"Demo","model":"sonnet"}\n'});
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

test('a maybe-sent answer keeps the guard, and the space lists its guarded issues',async()=>{
  const io=await startIo(),clock=12_000_000;let runs=0;
  for(const outcome of ['unknown','queued','weird',''])
    await io.runStart(config,{...params,issue:`DEMO-${20+runs}`},{run:async()=>{runs++;return {code:2,stdout:JSON.stringify({outcome})};},now:()=>clock});
  for(let i=0;i<4;i++)assert.equal(io.startGuarded('Demo',`DEMO-${20+i}`,clock),true,`DEMO-${20+i}`);
  assert.deepEqual(io.startGuardsOf('Demo',clock+1000).map(([key,left])=>[key,left]).sort(),
    ['DEMO-20','DEMO-21','DEMO-22','DEMO-23'].map(key=>[key,START_GUARD_MS-1000]));
  assert.deepEqual(io.startGuardsOf('Other',clock),[]);
  assert.deepEqual(io.startGuardsOf('Demo',clock+START_GUARD_MS),[]);
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

const detailOf=key=>({key,title:`Title of ${key}`,status:null,fields:[],alerts:[],description:'',loaded:true,error:null,comments:[],agents:[],url:''});
const popoverWith=async extra=>{const {issuePopover}=await view();return issuePopover({id:'d',open:true,trigger:element(),scope:'week',rows,...extra},theme);};

test('a row press opens the detail as before; the list has no start area or › button',async()=>{
  const details=[];
  const tree=await popoverWith({onDetail:key=>details.push(key),onStart(){},onStartPick(){}});
  click(byId(tree,'task-issue-d-DEMO-1'));assert.deepEqual(details,['DEMO-1']);
  assert(!byId(tree,'task-issue-open-d-DEMO-1'));assert(!byId(tree,'task-issue-start-d-DEMO-1'));
  assert(!walk(tree).some(node=>String(call(node,'id')?.[1]||'').startsWith('task-issue-wrap-')));
});

test('the detail shows the start area right under its title, the rest below',async()=>{
  const calls=[];
  const tree=await popoverWith({detail:detailOf('DEMO-1'),onDetail(){},
    start:{config,pick:{provider:'claude',level:'high'},entry:null,blocked:false},
    onStartPick:(kind,id)=>calls.push(['pick',kind,id]),onStart:key=>calls.push(['start',key])});
  const body=byId(tree,'task-issue-detail-d'),area=byId(tree,'task-issue-start-d-DEMO-1');
  assert(area,'start area in the detail');assert(!byId(tree,'task-issues-list-d'),'the detail replaces the list');
  const order=body.nodes.filter(node=>typeof node==='object');
  const title=order.findIndex(node=>node.nodes.includes('Title of DEMO-1'));
  assert(title>=0);assert.equal(order[title+1],area,'right under the title');
  assert(order.findIndex(node=>Boolean(byId(node,'task-issue-detail-open-d')))>title+1,'the detail buttons stay below');
  for(const word of ['Claude','Codex','낮음','중간','높음','최고','작업 시작'])assert(words(area).includes(word),word);
  const picked=byId(area,'task-issue-start-provider-d-DEMO-1-claude'),other=byId(area,'task-issue-start-provider-d-DEMO-1-codex');
  assert.equal(call(picked,'border_color')[1],theme.accent);assert.equal(call(other,'border_color')[1],theme.border);
  click(other);click(byId(area,'task-issue-start-level-d-DEMO-1-max'));click(byId(area,'task-issue-start-go-d-DEMO-1'));
  assert.deepEqual(calls,[['pick','provider','codex'],['pick','level','max'],['start','DEMO-1']]);
  const plain=await popoverWith({detail:detailOf('DEMO-1'),onDetail(){}});
  assert(!byId(plain,'task-issue-start-d-DEMO-1'),'no start wiring: no area');
});

test('the detail start area shows sending, the result, the guard, and a missing setting',async()=>{
  let starts=0;
  const at=async start=>byId(await popoverWith({detail:detailOf('DEMO-2'),onDetail(){},onStart:()=>starts++,onStartPick(){},start}),'task-issue-start-d-DEMO-2');
  const go=area=>byId(area,'task-issue-start-go-d-DEMO-2');
  const sending=await at({config,pick:config.defaults,entry:{running:true},blocked:true});
  assert(words(sending).includes('보내는 중…'));click(go(sending));
  assert(!call(byId(sending,'task-issue-start-provider-d-DEMO-2-codex'),'on_click'),'no change while sending');
  const sent=await at({config,pick:config.defaults,entry:{running:false,ok:true,text:'보냄 · Demo · opus'},blocked:true});
  assert.deepEqual(words(byId(sent,'task-issue-start-result-d-DEMO-2')),['보냄 · Demo · opus']);
  assert.equal(call(go(sent),'tooltip')?.[1],'방금 시작 요청한 이슈입니다 · 3분 뒤 다시 누를 수 있습니다');click(go(sent));
  const free=await at({config,pick:config.defaults,entry:{running:false,ok:false,text:'안 보냄 · busy'},blocked:false});
  assert(words(free).includes('안 보냄 · busy'));assert.equal(call(go(free),'tooltip'),undefined);click(go(free));
  assert.equal(starts,1,'only the unguarded press starts');
  const none=await at({config:null,pick:null,entry:null,blocked:false});
  assert.deepEqual(words(none),['작업 시작 설정 없음']);assert(!go(none));
  const bad=await at({config:null,invalid:true,pick:null,entry:null,blocked:false});
  assert.deepEqual(words(bad),['작업 시작 설정을 읽지 못했습니다 · issue-start.json 확인']);assert(!go(bad));
});
