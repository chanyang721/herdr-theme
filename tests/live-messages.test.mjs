import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercise the real sidebar lifecycle without a GUI. No filesystem change or
// focus event is emitted: only its reconciliation timer may update the badge.
for (const native of [false,true]) test(`background messages refresh through ${native?'native events':'legacy trace'} without focus or watcher events`, async () => {
  let log = JSON.stringify({events:[]});
  let notifications = 0;
  let malformedAuxiliary=false;
  const tasks = [];
  const timers = [];
  const cx = {
    notify() { notifications++; },
    spawn(task) { const promise=task(cx); tasks.push(promise); return promise; },
    timer: { every(ms, callback) { timers.push({ms,callback}); }, after() {} },
  };
  const runtime = {
    ...(native?{messageEvents:()=>JSON.parse(log).events}:{}),
    props:()=>({role:'sidebar'}), appHome:()=>'/app',
    terminals:()=>[{address:'source'},{address:'target'}],
    readTextFile:async path=>{
      if(path.endsWith('/messages.json')) {
        assert.equal(native,false,'native event mode must not poll the legacy message file');
        return log;
      }
      if(malformedAuxiliary && (path.endsWith('/workflow.json') || path.endsWith('/routing-queue.json')))return '{partial';
      throw new Error('file does not exist');
    },
    nextCommand:()=>new Promise(()=>{}),
  };
  globalThis.__sixfoldTest = runtime;
  let source = await readFile(new URL('../mods/sixfold-desk/main.js', import.meta.url),'utf8');
  source = source.replace(/import \{ View, div, svg, image \} from 'gpui-kit';/, 'class View {}');
  source = source.replace(/import \{ h_flex, v_flex \} from 'gpui-base';/, '');
  source = source.replace(/import \* as herdrNative from 'herdr';/, 'const herdrNative = globalThis.__sixfoldTest;');
  source = source.replace(/import \{([^}]+)\} from 'herdr';/, 'const {$1} = globalThis.__sixfoldTest;');
  for (const name of ['model','flow','workflow','sidebar-identity']) source = source.replace(`'./${name}.js'`,JSON.stringify(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url).href));
  source = source.replace(/import \{ watchDocs, currentDocs, docsSection, prepareDocsInput \} from '.\/docs.js';/, 'const watchDocs=()=>{};');
  source = source.replace(/import \{ pipeline \} from '.\/pipeline.js';/, '');
  source = source.replace(/import .* from '.\/alert-inbox.js';/,'const alertBadge=()=>null;');
  source = source.replace(/import \{ watchAlerts, alertSection, visibleAlerts \} from '.\/alerts.js';/,
    'const watchAlerts=()=>{};');
  const {default: Sidebar} = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64')+`#native=${native}`);
  const view = new Sidebar();
  view.init({},cx);
  // Ignore the forever-pending command listener; settle the finite reload task.
  await tasks[0];
  assert.deepEqual(view.messageEvents,[]);
  const refresh = timers.find(item=>item.ms===250).callback;
  log = JSON.stringify({events:[{id:'live',source:'source',target:'target',at:Date.now()}]});
  refresh(cx);
  await tasks.at(-1);
  assert.equal(view.messageEvents[0].id,'live');
  assert.equal(view.activeFlows[0].id,'live');
  const unchanged = notifications;
  refresh(cx);
  await tasks.at(-1);
  assert.equal(notifications,unchanged,'unchanged snapshot must not redraw');
  log = '{partial';
  refresh(cx);
  await tasks.at(-1);
  assert.equal(view.messageEvents[0].id,'live','partial writes must preserve the previous badges');
  // A partial unrelated writer must not stop message ingestion, and a burst
  // must begin together rather than waiting for the first four to arrive.
  malformedAuxiliary=true;
  const burst=Array.from({length:12},(_,index)=>({id:`burst-${index}`,source:'source',target:'target',at:Date.now()}));
  log=JSON.stringify({events:[{id:'live',source:'source',target:'target',at:Date.now()},...burst]});
  refresh(cx);
  await tasks.at(-1);
  assert.equal(view.activeFlows.length,13);
  assert.equal(view.pendingFlows.length,0);
  assert.equal(new Set(view.activeFlows.map(flow=>flow.id)).size,13);
  delete globalThis.__sixfoldTest;
});
