import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {bridgeFrom, parseAsks, askFor, questionsOf, actionsOf, choose, complete, actionRequest, requestPath, acceptedReceipt, touchesCards} from '../mods/sixfold-desk/ask-model.js';

const bridge = {python: 'python3', script: '/demo/bridge/dispatch.py', args: ['--local']};
const question = {id: 'demo-question', revision: 'rev-1', kind: 'question', terminal: 'demo-terminal', title: 'Which color?',
  questions: [{id: 'color', title: 'Color', multi: false, options: [{id: 'red', label: 'Red'}, {id: 'blue', label: 'Blue'}]}],
  actions: [{id: 'submit', label: 'Send', requiresAnswers: true, autoSubmit: true, primary: true}, {id: 'cancel', label: 'Cancel'}]};
const permission = {id: 'demo-permission', revision: 'rev-2', kind: 'permission', title: 'Run a local check?', detail: 'Demo tool',
  actions: [{id: 'approve', label: 'Allow', primary: true}, {id: 'cancel', label: 'Deny'}]};

test('local command prefix is explicit and preserves configured arguments', () => {
  assert.deepEqual(bridgeFrom(JSON.stringify(bridge)), bridge);
  assert.deepEqual(bridgeFrom(Object.freeze({...bridge,args:Object.freeze([...bridge.args])})),bridge);
  assert.deepEqual(bridgeFrom(JSON.stringify({...bridge, script: 'C:\\demo folder\\dispatch.py', args: ['a b', '']})).args, ['a b', '']);
  for (const value of [null, '{broken', '{}', {python: 'python3'}, {...bridge, script: 'relative.py'}, {...bridge, args: [1]}, {...bridge, python: 'x\nrun'}]) {
    assert.equal(bridgeFrom(typeof value === 'object' && value ? JSON.stringify(value) : value), null);
  }
});
test('cards use opaque ids, revisions and generic display fields', () => {
  assert.equal(parseAsks('no'), null);
  assert.deepEqual(parseAsks(Object.freeze({schema:1,cards:Object.freeze([Object.freeze(question)])})).cards[0].id,question.id);
  assert.equal(parseAsks('{"schema":2,"cards":[]}'), null);
  const parsed = parseAsks(JSON.stringify({schema: 1, cards: [question, permission, permission, {...permission, id: '../bad'}, {...permission, id: 'missing-revision', revision: ''}]}));
  assert.deepEqual(parsed.cards.map(c => c.id), [question.id, permission.id]);
  assert.equal(askFor(parsed.cards, 'demo-terminal').title, question.title);
  assert.equal(askFor(parsed.cards, 'other'), null);
  assert.equal(actionsOf(parsed.cards[0])[0].autoSubmit, true);
  assert.equal(parseAsks(JSON.stringify({schema:1,cards:[{...question,id:undefined}]})).cards.length,0);
});
test('single and multiple selections preserve option ids and provider order', () => {
  const one = questionsOf(question)[0];
  assert.deepEqual(choose({color: ['red']}, one, 'blue'), {color: ['blue']});
  assert.deepEqual(choose({}, one, 'unknown'), {});
  const multi = {...one, multi: true};
  let selected = choose(choose({}, multi, 'blue'), multi, 'red');
  assert.deepEqual(selected.color, ['red', 'blue']);
  selected = choose(selected, multi, 'blue');
  assert.deepEqual(selected.color, ['red']);
  assert.equal(complete(question, {color: ['unknown']}), false);
  assert.equal(complete(question, {color: ['red', 'blue']}), false);
  assert.equal(complete(question, {color: ['blue']}), true);
});
test('action envelope binds the displayed revision and selected option ids', () => {
  assert.deepEqual(actionRequest(question, 'submit', {color: ['blue']}, 'demo-request', '2026-01-01T00:00:00Z'),
    {schema: 1, id: 'demo-request', cardId: question.id, revision: 'rev-1', action: 'submit', answers: {color: ['blue']}, createdAt: '2026-01-01T00:00:00Z'});
  assert.throws(() => actionRequest(question, 'submit', {}, 'demo-request', 'now'), /Complete/);
  assert.throws(() => actionRequest(question, 'unknown', {}, 'demo-request', 'now'), /Complete/);
  assert.throws(() => actionRequest(question, 'cancel', {color: ['unknown']}, 'demo-request', 'now'), /Invalid option/);
  assert.equal(actionRequest(question, 'cancel', {}, 'demo-request', 'now').action, 'cancel');
  assert.throws(() => requestPath('/demo', '../escape'), /Invalid/);
});
test('only a matching accepted or duplicate receipt completes a request', () => {
  for (const status of ['accepted', 'duplicate']) assert.equal(acceptedReceipt(JSON.stringify({schema: 1, id: 'demo-request', status}), 'demo-request'), true);
  for (const output of ['', '{}', JSON.stringify({schema: 1, id: 'other', status: 'accepted'}), JSON.stringify({schema: 1, id: 'demo-request', status: 'stale'})]) {
    assert.equal(acceptedReceipt(output, 'demo-request'), false);
  }
  assert.equal(touchesCards(['C:\\demo\\cards.json'], 'C:/demo'), true);
  assert.equal(touchesCards(['/demo/card.tmp'], '/demo'), false);
});

let loads = 0;
async function loadCards(runtime) {
  globalThis.__cardRuntime = runtime;
  let source = (await readFile(new URL('../mods/sixfold-desk/asks.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  source = source.replace(/^import .* from 'gpui-kit';\n/m, 'const {div} = globalThis.__cardRuntime;\n').replace(/^import .* from 'gpui-base';\n/m, 'const {h_flex,v_flex} = globalThis.__cardRuntime;\n');
  source = source.replace(/^import \{(.*)\} from 'herdr';/m, (_m, names) => `const {${names}} = globalThis.__cardRuntime;`);
  source = source.replace(/^import .* from '.\/panel-io.js';/m,'const {subscribeJsonFile,readJsonSnapshot}=globalThis.__cardRuntime;');
  source = source.replace("from './ask-model.js'", `from ${JSON.stringify(new URL('../mods/sixfold-desk/ask-model.js', import.meta.url).href)}`);
  return import(`data:text/javascript;base64,${Buffer.from(source + `\n// ${++loads}`).toString('base64')}`);
}
function context() {
  const tasks = [];
  const cx = {notifications:0,notify() {this.notifications++;}, spawn(fn) { const p = fn(cx); tasks.push(p); return p; }, timer: {every() {throw Error('No private polling timer');}}, tasks};
  return cx;
}
function runtime() {
  const files = new Map([['/demo/data/sixfold/bridge.json', JSON.stringify(bridge)], ['/demo/data/sixfold/cards.json', JSON.stringify({schema: 1, cards: [permission]})]]);
  const calls = [],listeners=new Map(),reads=[];
  const snapshot=path=>{const raw=files.get(path);if(raw===undefined)return {status:'missing'};try{return {status:'ready',value:JSON.parse(raw)};}catch{return {status:'invalid'};}};
  const emit=(path,value=snapshot(path))=>{for(const callback of listeners.get(path)??[])callback(value);};
  const host = {appHome: () => '/demo', run() {}, watchFolder() {throw Error('Only the shared service may watch');},
    subscribeJsonFile(_cx,path,callback){const set=listeners.get(path)??new Set();set.add(callback);listeners.set(path,set);Promise.resolve().then(()=>{if(set.has(callback))callback(snapshot(path));});return ()=>set.delete(callback);},
    readJsonSnapshot:async path=>{reads.push(path);return snapshot(path);},
    readTextFile: async path => files.get(path) ?? null,
    writeTextFile: async (path, value, expected) => {calls.push(['write', path, expected]); if ((files.get(path) ?? null) !== expected) throw Error('File changed'); files.set(path, value);},
    exec: async (program, args) => {calls.push(['exec', program, args]); const request = JSON.parse(files.get(args.at(-1))); return {code: 0, stdout: JSON.stringify({schema: 1, id: request.id, status: 'accepted'})};}};
  return {files, calls, host,emit,listeners,reads};
}
test('missing config or cards hides the feature and never runs a command', async () => {
  const {files, calls, host} = runtime(); files.delete('/demo/data/sixfold/bridge.json');
  const mod = await loadCards(host), view = {}, cx = context(); mod.watchAsks(view, cx); await cx.tasks[0];
  assert.equal(view.asks, null); assert.equal(mod.hasAsks(view), false); assert.deepEqual(calls, []);
});
test('refresh reads only neutral input files, and removal hides old cards', async () => {
  const {files, calls, host,emit} = runtime();
  const mod = await loadCards(host), view = {}, cx = context(); mod.watchAsks(view, cx); await cx.tasks[0];
  assert.equal(view.asks[0].id, permission.id); assert.deepEqual(calls, []);
  files.delete('/demo/data/sixfold/cards.json');emit('/demo/data/sixfold/cards.json');
  assert.equal(view.asks, null);
});
test('changed card revision discards stale choices', async () => {
  const {files, host,emit} = runtime(); files.set('/demo/data/sixfold/cards.json', JSON.stringify({schema: 1, cards: [question]}));
  const mod = await loadCards(host), view = {}, cx = context(); mod.watchAsks(view, cx); await cx.tasks[0];
  view.askChoices[question.id] = {color: ['blue']};
  files.set('/demo/data/sixfold/cards.json', JSON.stringify({schema: 1, cards: [{...question, revision: 'rev-next'}]}));
  emit('/demo/data/sixfold/cards.json');assert.equal(view.askChoices[question.id], undefined);
});
test('an action CAS-creates a request and invokes only the configured prefix plus path', async () => {
  const {files, calls, host} = runtime(), mod = await loadCards(host), cx = context();
  const view = {asks: [permission], askBridge: bridge, askChoices: {}, askBusy: {}, askErrors: {}};
  mod.sendAction(view, permission, 'approve', cx); await cx.tasks[0];
  assert.equal(calls[0][0], 'write'); assert.equal(calls[0][2], null);
  const [, program, args] = calls[1]; assert.equal(program, bridge.python);
  assert.deepEqual(args.slice(0, -1), [bridge.script, ...bridge.args]); assert.match(args.at(-1), /^\/demo\/data\/sixfold\/bridge-actions\/[a-z0-9-]+\.json$/);
  assert.equal(JSON.parse(files.get(args.at(-1))).revision, permission.revision); assert.deepEqual(view.asks, []);
});
test('CAS failure performs no command and keeps the pending card', async () => {
  const {calls, host} = runtime(); host.writeTextFile = async () => {throw Error('File changed');};
  const mod = await loadCards(host), cx = context(), view = {asks: [permission], askBridge: bridge, askChoices: {}, askBusy: {}, askErrors: {}};
  mod.sendAction(view, permission, 'approve', cx); await cx.tasks[0];
  assert.equal(calls.length, 0); assert.equal(view.asks.length, 1); assert.ok(view.askErrors[permission.id]);
});
test('connection changes and failed receipts keep cards without exposing command output', async () => {
  for (const changed of [true, false]) {
    const {files, calls, host} = runtime();
    if (changed) files.set('/demo/data/sixfold/bridge.json', JSON.stringify({...bridge, args: ['--different']}));
    else host.exec = async () => ({code: 1, stdout: 'private-output', stderr: 'private-output'});
    const mod = await loadCards(host), cx = context(), view = {asks: [permission], askBridge: bridge, askChoices: {}, askBusy: {}, askErrors: {}};
    mod.sendAction(view, permission, 'approve', cx); await cx.tasks[0];
    assert.equal(view.asks.length, 1); assert.doesNotMatch(view.askErrors[permission.id], /private-output/);
    if (changed) assert.equal(calls.length, 0);
  }
});

test('opaque keys cannot inherit state and thrown process errors stay generic', async () => {
  const card={...permission,id:'constructor'};
  const {files,calls,host}=runtime();
  files.set('/demo/data/sixfold/cards.json',JSON.stringify({schema:1,cards:[card]}));
  host.exec=async()=>{throw Error('sensitive child output');};
  const mod=await loadCards(host),cx=context(),view={};
  mod.watchAsks(view,cx);await cx.tasks[0];
  mod.sendAction(view,card,'approve',cx);await cx.tasks.at(-1);
  assert.equal(calls[0][0],'write');assert.equal(view.asks[0].id,'constructor');
  assert.doesNotMatch(view.askErrors.constructor,/sensitive/);
  const q={...questionsOf(question)[0],id:'constructor',multi:true};
  assert.deepEqual(choose({},q,'blue'),{constructor:['blue']});
});

test('shared typed subscriptions update only changed cards and preserve failures until confirmed removal',async()=>{
  const f=runtime(),mod=await loadCards(f.host),view={},cx=context();const stop=mod.watchAsks(view,cx);
  await Promise.resolve();assert.equal(view.asks[0].id,permission.id);assert.equal(cx.notifications,1);
  assert.deepEqual([...f.listeners.keys()].sort(),['/demo/data/sixfold/bridge.json','/demo/data/sixfold/cards.json']);
  assert.deepEqual(f.reads,[],'subscribing has no separate initial read or polling');
  f.emit('/demo/data/sixfold/cards.json');assert.equal(cx.notifications,1);
  f.emit('/demo/data/sixfold/bridge.json',{status:'invalid',nativeStatus:'read_error'});
  f.emit('/demo/data/sixfold/cards.json',{status:'invalid'});assert.equal(view.asks[0].id,permission.id);
  f.emit('/demo/data/sixfold/cards.json',{status:'ready',value:{schema:2,cards:[]}});assert.equal(view.asks[0].id,permission.id);
  f.emit('/demo/data/sixfold/bridge.json',{status:'missing'});assert.equal(view.asks,null);assert.equal(view.askBridge,null);
  f.emit('/demo/data/sixfold/bridge.json',{status:'ready',value:bridge});assert.equal(view.asks[0].id,permission.id);
  const before=cx.notifications;stop();stop();
  f.emit('/demo/data/sixfold/cards.json',{status:'missing'});assert.equal(cx.notifications,before);
  assert([...f.listeners.values()].every(set=>set.size===0));
});

test('hidden typed card snapshots cache without notifying or parsing and resume once',async()=>{
  const f=runtime(),mod=await loadCards(f.host),view={panelTrackingActive:true,sidebarVisible:false},cx=context();
  mod.watchAsks(view,cx);await Promise.resolve();assert.equal(cx.notifications,0);
  const parse=JSON.parse;JSON.parse=()=>{throw Error('Typed cards must not parse on the UI thread');};
  try{f.emit('/demo/data/sixfold/cards.json',{status:'ready',value:{schema:1,cards:[question]}});}finally{JSON.parse=parse;}
  assert.equal(view.asks[0].id,question.id);assert.equal(cx.notifications,0);
  view.sidebarVisible=true;view.setAsksActive(true);assert.equal(cx.notifications,1);
  view.setAsksActive(true);assert.equal(cx.notifications,1);view.stopAsks();
});

test('explicit refresh is coalesced and disposal ignores pending input snapshots',async()=>{
  const f=runtime(),mod=await loadCards(f.host),view={},cx=context();mod.watchAsks(view,cx);await Promise.resolve();
  let resolve;const pending=new Promise(done=>{resolve=done;});f.host.readJsonSnapshot=()=>pending;
  // The imported reader was captured at module initialization; a second module
  // uses the delayed adapter to exercise disposal during a manual refresh.
  const delayed=await loadCards(f.host),other={},otherCx=context();delayed.watchAsks(other,otherCx);await Promise.resolve();
  const first=other.refreshAsks(otherCx);assert.equal(other.refreshAsks(otherCx),first);
  const before=otherCx.notifications;other.stopAsks();resolve({status:'missing'});await first;
  assert.equal(otherCx.notifications,before);assert.equal(other.asks[0].id,permission.id);view.stopAsks();
});
