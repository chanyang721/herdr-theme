import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {bridgeFrom, parseAsks, askFor, questionsOf, choose, complete, answerArgs, detailOf, touchesCards, tokenPath, cleanToken} from '../mods/sixfold-desk/ask-model.js';

const ID = '01M6NVK4NK0Y35XVKEPK05MSTJ';
const ID2 = '01M6NVFFPXYY2GBYE0H98XSVSY';
const TOK = 'a'.repeat(64);
const question = {schema: 1, id: ID, status: 'pending', kind: 'question', terminal: 't2j', tool_name: 'AskUserQuestion', reason: '질문: Which color?',
  tool_input: {questions: [{question: 'Which color?', header: 'Color', multiSelect: false, options: [{label: 'Red'}, {label: 'Blue'}]}]}};
const permission = {schema: 1, id: ID2, status: 'pending', kind: 'permission', terminal: 't2k', tool_name: 'Bash', reason: 'Bash: git push',
  tool_input: {command: 'git push origin main'}};

test('no bridge config hides the cards; a repo path names the CLI', () => {
  assert.equal(bridgeFrom(null), null);
  assert.equal(bridgeFrom('{broken'), null);
  assert.equal(bridgeFrom('{"python":"py"}'), null);
  assert.deepEqual(bridgeFrom('{"repo_path":"C:\\\\h\\\\herdr-harness\\\\","python":"C:/py.exe"}'),
    {python: 'C:/py.exe', script: 'C:\\h\\herdr-harness/runtime/harness.py'});
  assert.equal(bridgeFrom('{"repo_path":"/u/herdr-harness"}').python, 'python3');
  const parse=JSON.parse;JSON.parse=()=>{throw Error('UI file parsing');};
  try{assert.deepEqual(bridgeFrom({repo_path:'/demo/bridge',python:'demo-python'}),{python:'demo-python',script:'/demo/bridge/runtime/harness.py'});}finally{JSON.parse=parse;}
});

test('only well-formed pending cards are listed', () => {
  assert.equal(parseAsks('not json'), null);
  assert.equal(parseAsks('{"schema":2,"asks":[]}'), null);
  const parsed = parseAsks(JSON.stringify({schema: 1, dir: '/s/asks', asks: [question, permission,
    {...permission, id: '../x'}, {...permission, id: '01M6NVFFPXYY2GBYE0H98XSVSZ', status: 'answered'}, {...permission, id: '01M6NVFFPXYY2GBYE0H98XSVS1', kind: 'other'}]}));
  assert.deepEqual(parsed.asks.map(a => a.id), [ID, ID2]);
  assert.equal(parsed.dir, '/s/asks');
  assert.equal(askFor(parsed.asks, 't2k').id, ID2);
  assert.equal(askFor(parsed.asks, 'nope'), null);
});

test('allow, deny and a choice become the bridge CLI arguments with the card token', () => {
  assert.deepEqual(answerArgs('h.py', permission, 'allow', {}, TOK), ['h.py', 'asks', 'answer', ID2, '--allow', '--token', TOK]);
  assert.deepEqual(answerArgs('h.py', permission, 'deny', {}, `${TOK}\n`), ['h.py', 'asks', 'answer', ID2, '--deny', '--token', TOK]);
  const picked = choose({}, questionsOf(question)[0], 'Blue');
  assert.deepEqual(answerArgs('h.py', question, 'allow', picked, TOK), ['h.py', 'asks', 'answer', ID, '--allow', '--token', TOK, '--choice', 'Which color?=Blue']);
  assert.deepEqual(answerArgs('h.py', question, 'deny', {}, TOK), ['h.py', 'asks', 'answer', ID, '--deny', '--token', TOK]);
  assert.throws(() => answerArgs('h.py', question, 'allow', {}, TOK), /unanswered/);
  assert.throws(() => answerArgs('h.py', {...permission, id: 'x; rm -rf'}, 'allow', {}, TOK), /bad ask id/);
  assert.throws(() => answerArgs('h.py', permission, 'always', {}, TOK), /bad decision/);
  for (const bad of [null, '', 'xyz', 'A'.repeat(64), `${TOK} --allow`]) assert.throws(() => answerArgs('h.py', permission, 'allow', {}, bad), /token/);
});

test('the token path sits in token_dir and only a clean token is used', () => {
  assert.equal(tokenPath('C:\\s\\ask-tokens\\', permission), `C:\\s\\ask-tokens/${ID2}.token`);
  assert.equal(tokenPath(null, permission), null);
  assert.equal(tokenPath('/s/ask-tokens', {id: '../x'}), null);
  assert.equal(cleanToken(` ${TOK}\r\n`), TOK);
  assert.equal(cleanToken('nope'), null);
  assert.equal(parseAsks(JSON.stringify({schema: 1, dir: '/s/asks', token_dir: '/s/ask-tokens', asks: []})).tokenDir, '/s/ask-tokens');
});

test('multi-select toggles and joins labels in option order', () => {
  const q = {question: 'Pick', multi: true, options: ['A', 'B', 'C']};
  let s = choose({}, q, 'C'); s = choose(s, q, 'A');
  assert.deepEqual(s, {Pick: ['A', 'C']});
  s = choose(s, q, 'A'); s = choose(s, q, 'C');
  assert.deepEqual(s, {});
  const ask = {...question, tool_input: {questions: [{question: 'Pick', multiSelect: true, options: ['A', 'B', 'C']}]}};
  assert.equal(complete(ask, {}), false);
  assert.deepEqual(answerArgs('h.py', ask, 'allow', {Pick: ['A', 'C']}, TOK).slice(-2), ['--choice', 'Pick=A, C']);
});

test('detail and folder events', () => {
  assert.equal(detailOf(permission), 'git push origin main');
  assert.equal(detailOf({kind: 'plan', tool_input: {plan: '\n# Plan\n- step'}}), '# Plan');
  assert.equal(touchesCards(['C:\\s\\asks\\01M6NVK4NK0Y35XVKEPK05MSTJ.lease'], 'C:\\s\\asks'), false);
  assert.equal(touchesCards(['C:\\s\\asks\\.01M6NVK4NK0Y35XVKEPK05MSTJ.json.12.tmp'], 'C:\\s\\asks'), false);
  assert.equal(touchesCards(['C:\\s\\asks\\01M6NVK4NK0Y35XVKEPK05MSTJ.json'], 'C:\\s\\asks'), true);
  assert.equal(touchesCards(['C:/s/asks'], 'C:\\s\\asks'), true);
});

let loads = 0;
async function loadAsks(runtime) {
  globalThis.__asksRuntime = runtime;
  let source = (await readFile(new URL('../mods/sixfold-desk/asks.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  source = source.replace(/^import .* from 'gpui-kit';\n/m, '').replace(/^import .* from 'gpui-base';\n/m, '');
  source = source.replace(/^import .* from 'herdr';/m, 'const {run, exec, readTextFile, appHome} = globalThis.__asksRuntime;');
  source = source.replace(/^import .* from '.\/panel-io.js';/m,'const {subscribeJsonFile,subscribeFileChanges}=globalThis.__asksRuntime;');
  source = source.replace("from './ask-model.js'", `from ${JSON.stringify(new URL('../mods/sixfold-desk/ask-model.js', import.meta.url).href)}`);
  source += `
// load ${++loads}`;   // a fresh module per runtime
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function fakeCx() {
  const tasks = [],timers=new Set();
  const cx = {notified: 0, notify() { this.notified++; }, spawn(task) { const p = task(cx); tasks.push(p); return p; },
    timer:{after(ms,callback){assert.ok([20,5000].includes(ms));const timer={ms,callback,cancel(){timers.delete(timer);}};timers.add(timer);return timer;},every(){assert.fail('No idle CLI interval');}},tasks,timers,
    async flush(){for(let count=0;count<30;count++){for(const timer of [...timers].filter(timer=>timer.ms===20)){timers.delete(timer);timer.callback(cx);}await Promise.all(tasks.splice(0));await Promise.resolve();if(!tasks.length&&![...timers].some(timer=>timer.ms===20))return;}assert.fail('Ask updates did not settle');},
    async safety(){for(const timer of [...timers].filter(timer=>timer.ms===5000)){timers.delete(timer);timer.callback(cx);}await this.flush();},
  };
  return cx;
}

test('without the bridge nothing runs and the section stays hidden', async () => {
  const calls = [];
  const mod = await loadAsks({appHome: () => '/app', readTextFile: async () => null, exec: async (...a) => { calls.push(a); return {code: 0, stdout: ''}; },
    subscribeJsonFile:(_cx,_path,callback)=>{callback({status:'missing',hash:null,value:null});return()=>{};},subscribeFileChanges:()=>()=>{},run() {}});
  const view = {}; const cx = fakeCx();
  mod.watchAsks(view, cx);
  await cx.flush();
  assert.equal(view.asks, null);
  assert.equal(mod.hasAsks(view), false);
  assert.deepEqual(calls, []);
  assert.equal(cx.timers.size,0);
});

test('with the bridge the cards come from asks --json', async () => {
  const calls = [];
  const mod = await loadAsks({appHome: () => '/app', readTextFile: async () => '{"repo_path":"/h","python":"py"}',
    exec: async (cmd, args) => { calls.push([cmd, ...args]); return {code: 0, stdout: JSON.stringify({schema: 1, dir: '/s/asks', asks: [permission]})}; },
    subscribeJsonFile:(_cx,_path,callback)=>{callback({status:'ready',hash:'config',value:{repo_path:'/h',python:'py'}});return()=>{};},subscribeFileChanges:()=>()=>{},run() {}});
  const view = {}; const cx = fakeCx();
  mod.watchAsks(view, cx);
  await cx.flush();
  assert.deepEqual(calls, [['py', '/h/runtime/harness.py', 'asks', '--json']]);
  assert.deepEqual(view.asks.map(a => a.id), [ID2]);
  assert.equal(mod.hasAsks(view), true);
  assert.equal(view.askWatchOutsideAppHome,true,'the fixture folder needs an explicit external root');
  assert.equal(view.askExternalWatchActive,true,'the shared service registers the external root');
  view.stopAsks();
  assert.equal(view.askExternalWatchActive,false);
});

async function askHarness({dir='/app/data/sixfold/cards',asks=[],active=false}={}){
  let config,unsubscribed=0;const changes=new Map(),calls=[];
  const runtime={appHome:()=>'/app',run(){},readTextFile:async()=>{throw Error('Config must use native typed reads');},
    exec:async(command,args)=>{calls.push([command,...args]);return {code:0,stdout:JSON.stringify({schema:1,dir,token_dir:'/app/data/sixfold/tokens',asks})};},
    subscribeJsonFile:(_cx,path,callback)=>{assert.equal(path,'/app/data/sixfold/harness-local/config.json');config=callback;return()=>{unsubscribed++;};},
    subscribeFileChanges:(_cx,path,callback)=>{changes.set(path,callback);return()=>changes.delete(path);},
  };
  const module=await loadAsks(runtime),view={panelTrackingActive:active},cx=fakeCx(),stop=module.watchAsks(view,cx);
  return {view,cx,module,calls,changes,stop,config:snapshot=>config(snapshot),setAsks:value=>{asks=value;},emit:paths=>changes.get(dir)?.(paths),unsubscribed:()=>unsubscribed};
}

test('ask directory changes coalesce; empty cards never create a periodic CLI poll',async()=>{
  const h=await askHarness();
  try{
    h.config({status:'ready',hash:'one',value:{repo_path:'/demo/bridge',python:'demo-python'}});await h.cx.flush();
    assert.equal(h.calls.length,1);assert.equal(h.cx.timers.size,0);assert.equal(h.view.askWatchOutsideAppHome,false);
    h.config({status:'ready',hash:'one',value:{repo_path:'/demo/bridge',python:'demo-python'}});await h.cx.flush();assert.equal(h.calls.length,1);
    h.config({status:'ready',hash:'unrelated-setting',value:{repo_path:'/demo/bridge',python:'demo-python',unrelated:true}});await h.cx.flush();assert.equal(h.calls.length,1);
    h.emit(['/app/data/sixfold/cards/not-a-card.tmp',`/app/data/sixfold/cards/${ID}.lease`]);await h.cx.flush();assert.equal(h.calls.length,1);
    h.setAsks([permission]);for(let index=0;index<20;index++)h.emit([`/app/data/sixfold/cards/${ID2}.json`]);await h.cx.flush();
    assert.equal(h.calls.length,2);assert.equal(h.view.asks.length,1);assert.equal([...h.cx.timers].filter(timer=>timer.ms===5000).length,1);
    await h.cx.safety();assert.equal(h.calls.length,3);assert.equal([...h.cx.timers].filter(timer=>timer.ms===5000).length,1);
    h.setAsks([]);h.emit([`/app/data/sixfold/cards/${ID2}.json`]);await h.cx.flush();assert.equal(h.calls.length,4);assert.equal(h.cx.timers.size,0);
    await h.cx.safety();assert.equal(h.calls.length,4);
    h.setAsks([permission]);h.emit([`/app/data/sixfold/cards/${ID2}.json`]);await h.cx.flush();assert.equal(h.calls.length,5,'a later card is discovered after the empty interval');
    assert.equal(h.view.fileSubscriptions[0],h.stop);const notification=h.cx.notified;h.stop();h.stop();assert.equal(h.unsubscribed(),1);assert.equal(h.changes.size,0);assert.equal(h.cx.timers.size,0);
    h.config({status:'ready',hash:'after-stop',value:{repo_path:'/another/bridge'}});await h.cx.flush();assert.equal(h.cx.notified,notification);assert.equal(h.calls.length,5);
  }finally{h.stop();}
});

test('tracking caches typed bridge configuration and classic activation refreshes once',async()=>{
  const h=await askHarness({asks:[permission],active:true});
  try{
    h.config({status:'ready',hash:'one',value:{repo_path:'/demo/bridge',python:'demo-python'}});await h.cx.flush();
    assert.equal(h.calls.length,0);assert.equal(h.cx.timers.size,0);assert.equal(h.view.askConfig.repo_path,'/demo/bridge');
    h.view.panelTrackingActive=false;h.view.refreshAsks(h.cx);await h.cx.flush();assert.equal(h.calls.length,1);assert.equal(h.view.asks[0].id,ID2);
    h.config({status:'invalid',hash:'partial',value:null});await h.cx.flush();assert.equal(h.view.asks[0].id,ID2,'partial config keeps last valid cards');
    h.config({status:'missing',hash:null,value:null});await h.cx.flush();assert.equal(h.view.asks,null);assert.equal(h.cx.timers.size,0);assert.equal(h.changes.size,0);
    h.config({status:'ready',hash:'one',value:{repo_path:'/demo/bridge',python:'demo-python'}});await h.cx.flush();assert.equal(h.calls.length,2);assert.equal(h.view.asks[0].id,ID2,'byte-identical restored config is not hidden by its prior hash or cards signature');
  }finally{h.stop();}
});
