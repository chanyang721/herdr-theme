import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {bridgeFrom, parseAsks, askFor, questionsOf, actionsOf, choose, complete, actionRequest, requestPath, acceptedReceipt, touchesCards,
  receiptError, receiptCode, replyText, needsText, errorText, popupHeight, TEXT_LIMIT} from '../mods/sixfold-desk/ask-model.js';

const bridge = {python: 'python3', script: '/demo/bridge/provider.py', args: ['--local']};
const question = {id: 'demo-question', revision: 'rev-1', kind: 'question', terminal: 'demo-terminal', title: 'Which color?',
  questions: [{id: 'color', title: 'Color', multi: false, options: [{id: 'red', label: 'Red'}, {id: 'blue', label: 'Blue'}]}],
  actions: [{id: 'submit', label: 'Send', requiresAnswers: true, autoSubmit: true, primary: true}, {id: 'cancel', label: 'Cancel'}]};
const permission = {id: 'demo-permission', revision: 'rev-2', kind: 'permission', title: 'Run a local check?', detail: 'Demo tool',
  actions: [{id: 'approve', label: 'Allow', primary: true}, {id: 'cancel', label: 'Deny'}]};

test('local command prefix is explicit and preserves configured arguments', () => {
  assert.deepEqual(bridgeFrom(JSON.stringify(bridge)), bridge);
  assert.deepEqual(bridgeFrom(Object.freeze({...bridge,args:Object.freeze([...bridge.args])})),bridge);
  assert.deepEqual(bridgeFrom(JSON.stringify({...bridge, script: 'C:\\demo folder\\provider.py', args: ['a b', '']})).args, ['a b', '']);
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
test('question and option text may span lines; blank or NUL text is dropped', () => {
  const long = {...question, questions: [{id: 'fix', title: 'Fix the line?\n\n[before] a\n[after] b', multi: false,
    options: [{id: 'yes', label: 'Approve\nas written'}, {id: 'blank', label: ' \n '}, {id: 'nul', label: 'x\0y'}]}]};
  const [q] = questionsOf(long);
  assert.equal(q.title, 'Fix the line?\n\n[before] a\n[after] b');
  assert.deepEqual(q.options.map(o => o.id), ['yes']);
  assert.equal(questionsOf({...long, questions: [{id: 'empty', title: '\n', options: []}]}).length, 0);
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
test('a question card as the producer writes it keeps every question as buttons and sends the picks', () => {
  // Producer shape: q<i>/o<i> ids, question text with line breaks, two questions, one multiSelect.
  const card = {id: 'demo-ask', revision: 'rev-9', kind: 'question', terminal: 'demo-terminal', title: 'Question: proceed?',
    answerable: true, detail: '', createdAt: '2026-01-01T00:00:00Z',
    questions: [
      {id: 'q0', title: 'Proceed with the merge?\n\n[comment]\nposted after merge', multi: false,
        options: [{id: 'o0', label: 'All of it'}, {id: 'o1', label: 'Merge only'}, {id: 'o2', label: 'Hold'}]},
      {id: 'q1', title: 'Which checks?', multi: true, options: [{id: 'o0', label: 'Unit'}, {id: 'o1', label: 'Lint'}]}],
    actions: [{id: 'submit', label: 'Send', requiresAnswers: true, primary: true, autoSubmit: false}, {id: 'cancel', label: 'Cancel'}]};
  const [parsed] = parseAsks(JSON.stringify({schema: 1, cards: [card]})).cards;
  assert.deepEqual(parsed.questions.map(q => [q.id, q.multi, q.options.map(o => o.label)]),
    [['q0', false, ['All of it', 'Merge only', 'Hold']], ['q1', true, ['Unit', 'Lint']]]);
  let picks = choose({}, parsed.questions[0], 'o1');
  assert.equal(complete(parsed, picks), false);
  picks = choose(choose(picks, parsed.questions[1], 'o1'), parsed.questions[1], 'o0');
  assert.equal(complete(parsed, picks), true);
  assert.deepEqual(actionRequest(parsed, 'submit', picks, 'demo-request', 'now').answers, {q0: ['o1'], q1: ['o0', 'o1']});
  assert.throws(() => actionRequest(parsed, 'submit', {q0: ['o1']}, 'demo-request', 'now'), /Complete/);
});
test('only a matching accepted or duplicate receipt completes a request', () => {
  for (const status of ['accepted', 'duplicate']) assert.equal(acceptedReceipt(JSON.stringify({schema: 1, id: 'demo-request', status}), 'demo-request'), true);
  for (const output of ['', '{}', JSON.stringify({schema: 1, id: 'other', status: 'accepted'}), JSON.stringify({schema: 1, id: 'demo-request', status: 'stale'})]) {
    assert.equal(acceptedReceipt(output, 'demo-request'), false);
  }
  assert.equal(touchesCards(['C:\\demo\\cards.json'], 'C:/demo'), true);
  assert.equal(touchesCards(['/demo/card.tmp'], '/demo'), false);
});

// A card whose answer is typed: one question that only says what to type, and a text action.
const reply = {id: `n-${'0123456789abcdef'.repeat(2)}`, revision: 'rev-3', kind: 'question', terminal: 'demo-terminal', title: 'Waiting for an answer',
  questions: [{id: 'q0', title: 'Type what to send to that pane'}],
  actions: [{id: 'reply', label: 'Send', requiresText: true, primary: true}]};
test('a reply card parses with an option-less question and keeps requiresText on its action', () => {
  const [parsed] = parseAsks(JSON.stringify({schema: 1, cards: [reply]})).cards;
  assert.equal(parsed.id, reply.id, 'n-<32 hex> is a valid card id');
  assert.deepEqual(parsed.questions, [{id: 'q0', title: 'Type what to send to that pane', multi: false, options: []}]);
  assert.deepEqual(parsed.actions, [{id: 'reply', label: 'Send', requiresAnswers: false, autoSubmit: false, primary: true, requiresText: true}]);
  assert.equal(actionsOf(question)[0].requiresText, false, 'other actions default to false');
  assert.equal(actionsOf({actions: [{id: 'a', label: 'A', requiresText: 'yes'}]})[0].requiresText, false, 'only true counts');
  assert.equal(needsText(parsed), true); assert.equal(needsText(question), false);
  assert.equal(needsText(parseAsks({schema: 1, cards: [{...reply, answerable: false}]}).cards[0]), false, 'display-only cards take no text');
  assert.ok(popupHeight(parsed) > popupHeight({...parsed, actions: []}), 'room for the text box');
  // The option-less question never gates: nothing to choose, and it does not block other questions.
  assert.equal(complete(parsed, {}), false);
  assert.equal(actionRequest(parsed, 'reply', {}, 'demo-request', 'now', 'hi').action, 'reply');
  const mixed = {...question, questions: [...question.questions, {id: 'note', title: 'Anything else?'}]};
  assert.equal(complete(mixed, {color: ['red']}), true);
});
test('only a text action carries the typed text, trimmed at the end and bounded', () => {
  const [parsed] = parseAsks({schema: 1, cards: [reply]}).cards;
  assert.deepEqual(actionRequest(parsed, 'reply', {}, 'demo-request', '2026-01-01T00:00:00Z', '  keep the lead\nline two \n\t '),
    {schema: 1, id: 'demo-request', cardId: reply.id, revision: 'rev-3', action: 'reply', answers: {}, text: '  keep the lead\nline two', createdAt: '2026-01-01T00:00:00Z'});
  for (const bad of [undefined, null, '', ' \n\t', 'a\0b', 'x'.repeat(TEXT_LIMIT + 1), 7]) {
    assert.throws(() => actionRequest(parsed, 'reply', {}, 'demo-request', 'now', bad), /Invalid text/);
  }
  assert.equal(actionRequest(parsed, 'reply', {}, 'demo-request', 'now', 'x'.repeat(TEXT_LIMIT)).text.length, TEXT_LIMIT);
  assert.equal(actionRequest(parsed, 'reply', {}, 'demo-request', 'now', `${'x'.repeat(TEXT_LIMIT)}   `).text.length, TEXT_LIMIT, 'trailing space does not count');
  assert.equal(replyText('😀'.repeat(TEXT_LIMIT)), '😀'.repeat(TEXT_LIMIT), 'the limit counts characters, not UTF-16 units');
  const plain = actionRequest(permission, 'approve', {}, 'demo-request', 'now', 'ignored');
  assert.equal(Object.hasOwn(plain, 'text'), false, 'no text on other actions');
  assert.equal(Object.hasOwn(actionRequest(question, 'submit', {color: ['red']}, 'demo-request', 'now'), 'text'), false);
});
test('a failed receipt names its error code; only known codes get their own message', () => {
  const receipt = value => JSON.stringify({schema: 1, id: 'demo-request', ...value});
  assert.equal(receiptError(receipt({status: 'rejected', error: 'pane_busy'}), 'demo-request'), 'pane_busy');
  assert.equal(receiptError(`log line\n${receipt({status: 'rejected', error: 'unconfirmed'})}\n`, 'demo-request'), 'unconfirmed');
  for (const output of ['', 'not json', receipt({status: 'accepted', error: 'pane_busy'}), receipt({status: 'duplicate'}), receipt({status: 'rejected'}),
    receipt({status: 'rejected', error: 'Not A Code'}), receipt({status: 'rejected', error: 3}),
    JSON.stringify({schema: 1, id: 'other', status: 'rejected', error: 'pane_busy'}), JSON.stringify({schema: 2, id: 'demo-request', status: 'rejected', error: 'pane_busy'})]) {
    assert.equal(receiptError(output, 'demo-request'), null, output);
  }
  assert.deepEqual(['pane_busy', 'pane_moved', 'card_closed', 'card_changed', 'unconfirmed', 'invalid_text', 'pane_unavailable', 'command_text', 'duplicate_text', 'not_checked', 'constructor', 'other', null].map(receiptCode),
    ['pane_busy', 'pane_moved', 'stale', 'stale', 'unconfirmed', 'invalid_text', 'pane_unavailable', 'command_text', 'duplicate_text', 'not_checked', 'failed', 'failed', 'failed']);
  assert.match(errorText('ko', 'command_text'), /명령으로 실행/);
  assert.match(errorText('ko', 'duplicate_text'), /똑같아/);
  assert.match(errorText('ko', 'pane_moved'), /질문한 세션이 아니라/);
  assert.match(errorText('ko', 'pane_busy'), /쓰던 글이 있거나 선택창이 열려/);
  assert.match(errorText('ko', 'unconfirmed'), /다시 보내지 마세요/);
  assert.match(errorText('ko', 'invalid_text'), /4000자까지/);
  assert.match(errorText('ko', 'pane_unavailable'), /그 칸을 찾지 못했습니다/);
  for (const code of ['pane_busy', 'unconfirmed', 'invalid_text', 'pane_unavailable', 'pane_moved', 'command_text', 'duplicate_text', 'not_checked']) assert.notEqual(errorText('en', code), errorText('en', 'failed'));
  assert.equal(errorText('ko', 'failed'), errorText('ko', 'unknown'));
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
