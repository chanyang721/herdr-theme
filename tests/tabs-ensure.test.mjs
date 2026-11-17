import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = (await readFile(new URL('../mods/sixfold-tabs/main.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace('export function missingDocumentTabs', 'function missingDocumentTabs')
  .replace('export default class Tabs', 'class Tabs');
const space = (id, tabs = []) => ({id, machine: null, tabs: tabs.map(id => ({id}))});
const documentPane = tab => ({tab, mod: 'project-docs-tabs'});
function runtime({spaces = [space('local', ['docs'])], panes = [documentPane('docs')]} = {}) {
  const state = {spaces, panes, at: 0, calls: [], tasks: [], timers: [], result: {code: 0}, rejectSpawn: false};
  const bindings = {View: class {}, spaces: () => state.spaces, panes: () => state.panes,
    appHome: () => 'C:/app', window: () => ({platform: 'windows'}),
    localStorage: {getItem: () => null}, globalThis: {}, Date: {now: () => state.at},
    exec: async (program, args) => {state.calls.push({program, args}); if (state.result instanceof Error) throw state.result; return state.result;}};
  const {Tabs, missingDocumentTabs} = new Function(...Object.keys(bindings), `${source}\nreturn {Tabs, missingDocumentTabs};`)(...Object.values(bindings));
  const cx = {spawn: task => {if (state.rejectSpawn) throw new Error('host rejected spawn'); state.tasks.push(task);},
    timer: {every: (ms, callback) => {assert.equal(ms, 5000); state.timers.push(callback);}}};
  const create = () => {const view = new Tabs(); view.init({}, cx); return view;};
  const settle = async () => {while (state.tasks.length) await state.tasks.shift()(cx);};
  const tick = async at => {state.at = at; for (const callback of state.timers) callback(cx); await settle();};
  return {state, create, settle, tick, missingDocumentTabs};
}

test('healthy document tabs start no installer across a minute of repair checks', async () => {
  const h = runtime(); h.create(); await h.settle();
  for (let at = 5000; at <= 60000; at += 5000) await h.tick(at);
  assert.deepEqual(h.state.calls, []);
});

test('missing tabs are repaired once across view copies, new spaces and removed document panes are repaired', async () => {
  const h = runtime({spaces: [space('local', ['terminal'])], panes: []});
  h.create(); h.create(); await h.settle();
  assert.equal(h.state.calls.length, 1, 'copies share one in-flight repair');
  assert.deepEqual(h.state.calls[0], {program: 'C:/app/scripts/sixfold/herdr-theme.exe', args: ['install_doc_tabs', '--ensure-tabs', '--home', 'C:/app']});
  h.state.spaces[0].tabs.push({id: 'docs'}); h.state.panes.push(documentPane('docs'));
  await h.tick(5000); assert.equal(h.state.calls.length, 1);
  h.state.spaces.push(space('new', ['new-terminal']));
  await h.tick(10000); assert.equal(h.state.calls.length, 2, 'a new local workspace is repaired on the next check');
  h.state.spaces[1].tabs.push({id: 'new-docs'}); h.state.panes.push(documentPane('new-docs'));
  await h.tick(15000); assert.equal(h.state.calls.length, 2);
  h.state.panes = h.state.panes.filter(pane => pane.tab !== 'docs');
  await h.tick(20000); assert.equal(h.state.calls.length, 3, 'a tab whose document mod was removed is repaired');
});

test('repair eligibility matches the native local-space rules and uses document panes in inactive tabs', () => {
  const h = runtime();
  assert.deepEqual(h.missingDocumentTabs([
    space('healthy', ['inactive-docs', 'terminal']),
    space('missing', ['renamed-docs']),
    {...space('remote', []), machine: 'other'},
    space('other/mirrored', []),
  ], [documentPane('inactive-docs'), {tab: 'renamed-docs', mod: 'terminal'}]), ['missing']);
});

test('failed installs back off, a newly missing space retries immediately, and a repair not yet reflected backs off', async () => {
  const h = runtime({spaces: [space('local')], panes: []});
  h.state.result = {code: 1}; h.create(); await h.settle();
  for (let at = 5000; at < 30000; at += 5000) await h.tick(at);
  assert.equal(h.state.calls.length, 1);
  await h.tick(30000); assert.equal(h.state.calls.length, 2);
  h.state.spaces.push(space('new')); h.state.result = {code: 0};
  await h.tick(35000); assert.equal(h.state.calls.length, 3, 'changed missing-space set bypasses a prior failure backoff');
  await h.tick(40000); assert.equal(h.state.calls.length, 3, 'an unreflected successful repair waits at least 30 s');
  await h.tick(65000); assert.equal(h.state.calls.length, 4, 'and is retried');
  await h.tick(120000); assert.equal(h.state.calls.length, 4, 'the same missing set waits twice as long');
  await h.tick(125000); assert.equal(h.state.calls.length, 5);
});

test('a rejected spawn and thrown helper both release shared repair state', async () => {
  const h = runtime({spaces: [space('local')], panes: []});
  h.state.rejectSpawn = true; h.create();
  h.state.rejectSpawn = false; h.state.result = new Error('helper unavailable');
  await h.tick(30000); assert.equal(h.state.calls.length, 1);
  await h.tick(35000); assert.equal(h.state.calls.length, 1);
  h.state.result = {code: 0};
  await h.tick(60000); assert.equal(h.state.calls.length, 2);
});
