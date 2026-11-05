import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {bridgeFrom, parseAsks, askFor, questionsOf, choose, complete, answerArgs, detailOf, touchesCards} from '../mods/sixfold-desk/ask-model.js';

const ID = '01M6NVK4NK0Y35XVKEPK05MSTJ';
const ID2 = '01M6NVFFPXYY2GBYE0H98XSVSY';
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

test('allow, deny and a choice become the bridge CLI arguments', () => {
  assert.deepEqual(answerArgs('h.py', permission, 'allow'), ['h.py', 'asks', 'answer', ID2, '--allow']);
  assert.deepEqual(answerArgs('h.py', permission, 'deny'), ['h.py', 'asks', 'answer', ID2, '--deny']);
  const picked = choose({}, questionsOf(question)[0], 'Blue');
  assert.deepEqual(answerArgs('h.py', question, 'allow', picked), ['h.py', 'asks', 'answer', ID, '--allow', '--choice', 'Which color?=Blue']);
  assert.deepEqual(answerArgs('h.py', question, 'deny'), ['h.py', 'asks', 'answer', ID, '--deny']);
  assert.throws(() => answerArgs('h.py', question, 'allow', {}), /unanswered/);
  assert.throws(() => answerArgs('h.py', {...permission, id: 'x; rm -rf'}, 'allow'), /bad ask id/);
  assert.throws(() => answerArgs('h.py', permission, 'always'), /bad decision/);
});

test('multi-select toggles and joins labels in option order', () => {
  const q = {question: 'Pick', multi: true, options: ['A', 'B', 'C']};
  let s = choose({}, q, 'C'); s = choose(s, q, 'A');
  assert.deepEqual(s, {Pick: ['A', 'C']});
  s = choose(s, q, 'A'); s = choose(s, q, 'C');
  assert.deepEqual(s, {});
  const ask = {...question, tool_input: {questions: [{question: 'Pick', multiSelect: true, options: ['A', 'B', 'C']}]}};
  assert.equal(complete(ask, {}), false);
  assert.deepEqual(answerArgs('h.py', ask, 'allow', {Pick: ['A', 'C']}).slice(-2), ['--choice', 'Pick=A, C']);
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
  source = source.replace(/^import .* from 'herdr';/m, 'const {run, exec, readTextFile, appHome, watchFolder} = globalThis.__asksRuntime;');
  source = source.replace("from './ask-model.js'", `from ${JSON.stringify(new URL('../mods/sixfold-desk/ask-model.js', import.meta.url).href)}`);
  source += `
// load ${++loads}`;   // a fresh module per runtime
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function fakeCx() {
  const tasks = [];
  const cx = {notified: 0, notify() { this.notified++; }, spawn(task) { const p = task(cx); tasks.push(p); return p; },
    timer: {every(ms, cb) { cx.tick = cb; }}, sleep: () => new Promise(() => {}), tasks};
  return cx;
}

test('without the bridge nothing runs and the section stays hidden', async () => {
  const calls = [];
  const mod = await loadAsks({appHome: () => '/app', readTextFile: async () => null, exec: async (...a) => { calls.push(a); return {code: 0, stdout: ''}; },
    watchFolder: () => new Promise(() => {}), run() {}});
  const view = {}; const cx = fakeCx();
  mod.watchAsks(view, cx);
  await Promise.all(cx.tasks.slice(0, 1));
  assert.equal(view.asks, null);
  assert.equal(mod.hasAsks(view), false);
  assert.deepEqual(calls, []);
});

test('with the bridge the cards come from asks --json', async () => {
  const calls = [];
  const mod = await loadAsks({appHome: () => '/app', readTextFile: async () => '{"repo_path":"/h","python":"py"}',
    exec: async (cmd, args) => { calls.push([cmd, ...args]); return {code: 0, stdout: JSON.stringify({schema: 1, dir: '/s/asks', asks: [permission]})}; },
    watchFolder: () => new Promise(() => {}), run() {}});
  const view = {}; const cx = fakeCx();
  mod.watchAsks(view, cx);
  await Promise.all(cx.tasks.slice(0, 1));
  assert.deepEqual(calls, [['py', '/h/runtime/harness.py', 'asks', '--json']]);
  assert.deepEqual(view.asks.map(a => a.id), [ID2]);
  assert.equal(mod.hasAsks(view), true);
});
