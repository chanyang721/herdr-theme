import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('alerts recover after cold install and partial writes without a folder watcher', async () => {
  let text;
  let notifications = 0;
  let refresh;
  let ledgerText = null;
  const tasks = [];
  const view = {alerts: []};
  const cx = {
    notify() { notifications++; },
    spawn(task) { const promise = task(cx); tasks.push(promise); return promise; },
    timer: {every(ms, callback) { assert.equal(ms, 2000); refresh = callback; }},
  };
  globalThis.__alertsRuntime = {
    appHome: () => '/fresh-install',
    setShared() {},
    readTextFile: async path => {
      if (path.endsWith('/slack-popup-events.json')) {
        if (ledgerText === null) throw new Error('ledger missing');
        return ledgerText;
      }
      if (!path.endsWith('/alerts.json')) throw new Error('optional file missing');
      if (text === undefined) throw new Error('folder does not exist');
      return text;
    },
    writeTextFile: async (_path, value, expected) => {
      if (ledgerText !== expected) throw new Error('compare-and-swap conflict');
      ledgerText = value;
      return null;
    },
  };
  let source = await readFile(new URL('../mods/sixfold-desk/alerts.js', import.meta.url), 'utf8');
  source = source.replace(/\r\n/g, '\n');
  source = source.replace(/^import .* from 'gpui-kit';\n/m, '');
  source = source.replace(/^import .* from 'gpui-base';\n/m, '');
  source = source.replace(/^import .* from 'herdr';/m,
    'const {appHome, readTextFile, writeTextFile, setShared, notify} = globalThis.__alertsRuntime;');
  try {
    const {watchAlerts} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    watchAlerts(view, cx);
    await tasks.at(-1);
    assert.deepEqual(view.alerts, []);
    text = JSON.stringify({items: [{id: 'late', status: 'needs-you'}]});
    refresh(cx);
    await tasks.at(-1);
    assert.equal(view.alerts[0].id, 'late');
    assert.equal(notifications, 2);
    refresh(cx);
    await tasks.at(-1);
    assert.equal(notifications, 2);
    text = '{partial';
    refresh(cx);
    await tasks.at(-1);
    assert.equal(view.alerts[0].id, 'late');
    text = JSON.stringify({items: []});
    refresh(cx);
    await tasks.at(-1);
    assert.deepEqual(view.alerts, []);
    assert.equal(notifications, 3);
  } finally {
    delete globalThis.__alertsRuntime;
  }
});

for (const lineEnding of ['\n', '\r\n']) {
test(`workflow updates never auto-open; new mentions open once across health ticks, omissions and restart (${lineEnding === '\n' ? 'LF' : 'CRLF'})`,async()=>{
  const files=new Map([
    ['alerts.json','{"items":[]}'],['project-alerts.json','{"items":[],"projects":["Medihomes"]}'],
    ['slack-alerts-read.json','{}'],['slack-mentions.json','{"items":[{"id":"old"}]}'],
    ['slack-live-health.json','{"state":"ok","checked":1}'],
    ['slack-workflows.json','{"jobs":{"job":{"id":"job","version":"source-v1","state":"needs_decision","summary":"Review ready","artifacts":["/report.md"],"finished_at":"first"},"legacy":{"id":"legacy","state":"ready","summary":"Old wording","sources":[{"id":"slack:C1:legacy"}],"artifacts":[],"finished_at":"first"}}}'],
  ]);
  const opens=[];
  async function startWatcher(){
    const tasks=[];let refresh;
    const cx={notify(){},spawn(fn){const task=fn(cx);tasks.push(task);return task;},timer:{every(_ms,fn){refresh=fn;}}};
    globalThis.__popupRuntime={
      appHome:()=>'/test',setShared(){},openOverlay:x=>opens.push(x),
      readTextFile:async path=>{const name=path.split('/').at(-1);if(!files.has(name))throw new Error('missing');return files.get(name);},
      writeTextFile:async(_path,value,expected)=>{const name=_path.split('/').at(-1);const old=files.has(name)?files.get(name):null;if(old!==expected)throw new Error('compare-and-swap conflict');files.set(name,value);return null;},
    };
    let source=await readFile(new URL('../mods/sixfold-desk/alerts.js',import.meta.url),'utf8');
    source=source.replace(/\r?\n/g,lineEnding);
    source=source.replace(/^import .* from 'gpui-kit';\r?\n/m,'').replace(/^import .* from 'gpui-base';\r?\n/m,'')
      .replace(/^import .* from 'herdr';/m,'const {appHome,readTextFile,writeTextFile,setShared,openOverlay}=globalThis.__popupRuntime;');
    const {watchAlerts}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64')+'#'+Math.random());
    watchAlerts({alerts:[]},cx);await tasks.at(-1);
    return async()=>{refresh(cx);await tasks.at(-1);};
  }
  try{
    let refresh=await startWatcher();
    assert.equal(opens.length,0,'existing messages/results are seeded silently');
    const saved=JSON.parse(files.get('slack-popup-events.json'));
    assert.equal(saved.schema,1);assert.deepEqual(saved.seen,['mention:old']);

    files.set('slack-live-health.json','{"state":"ok","checked":2}');
    files.set('slack-workflows.json','{"jobs":{"job":{"id":"job","version":"source-v1","state":"needs_decision","summary":"Reworded review summary","artifacts":["/report.md"],"finished_at":"second"},"legacy":{"id":"legacy","state":"ready","summary":"Reworded legacy summary","sources":[{"id":"slack:C1:legacy"}],"artifacts":[],"finished_at":"second"}}}');
    await refresh();assert.equal(opens.length,0,'health ticks, workflow versions, summaries and finished_at do not auto-open');

    files.set('slack-mentions.json','{"items":[]}');await refresh();
    files.set('slack-mentions.json','{"items":[{"id":"old"}]}');await refresh();
    assert.equal(opens.length,0,'an old source returning after a transient omission stays suppressed');
    files.set('slack-mentions.json','{"items":[{"id":"old"},{"id":"new"}]}');await refresh();
    assert.equal(opens.length,1,'a genuinely new mention opens once');
    assert.equal(opens[0].props.review,false);
    await refresh();assert.equal(opens.length,1);

    files.set('slack-workflows.json','{"jobs":{"job":{"id":"job","version":"source-v2","state":"needs_decision","summary":"Updated source review","artifacts":["/report.md"],"finished_at":"third"}}}');
    await refresh();assert.equal(opens.length,1,'a changed workflow result remains available without auto-opening');
    files.set('slack-workflows.json','{"jobs":{"job":{"id":"job","version":"source-v2","state":"needs_decision","summary":"Updated source review","artifacts":["/report.md"],"finished_at":"fourth"}}}');
    await refresh();assert.equal(opens.length,1,'a second workflow timestamp change remains quiet');

    refresh=await startWatcher();
    assert.equal(opens.length,1,'a fresh watcher/restart honors the persistent mention ledger');
    assert.equal(opens[0].kind,'window');
  }finally{delete globalThis.__popupRuntime;}
});

test(`an empty first run seeds the ledger before later new source arrives (${lineEnding === '\n' ? 'LF' : 'CRLF'})`,async()=>{
  const files=new Map([
    ['alerts.json','{"items":[]}'],['project-alerts.json','{"items":[]}'],['slack-alerts-read.json','{}'],
    ['slack-mentions.json','{"items":[]}'],['slack-live-health.json','{}'],['slack-workflows.json','{"jobs":{}}'],
  ]);
  const tasks=[],opens=[];let refresh;
  const cx={notify(){},spawn(fn){const task=fn(cx);tasks.push(task);return task;},timer:{every(_ms,fn){refresh=fn;}}};
  globalThis.__popupRuntime={appHome:()=>'/test',setShared(){},openOverlay:x=>opens.push(x),
    readTextFile:async path=>{const name=path.split('/').at(-1);if(!files.has(name))throw new Error('missing');return files.get(name);},
    writeTextFile:async(_path,value,expected)=>{const name=_path.split('/').at(-1);const old=files.has(name)?files.get(name):null;if(old!==expected)throw new Error('compare-and-swap conflict');files.set(name,value);return null;}};
  let source=await readFile(new URL('../mods/sixfold-desk/alerts.js',import.meta.url),'utf8');
  source=source.replace(/\r?\n/g,lineEnding);
  source=source.replace(/^import .* from 'gpui-kit';\r?\n/m,'').replace(/^import .* from 'gpui-base';\r?\n/m,'')
    .replace(/^import .* from 'herdr';/m,'const {appHome,readTextFile,writeTextFile,setShared,openOverlay}=globalThis.__popupRuntime;');
  try{
    const {watchAlerts}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64')+'#empty-first-run');
    watchAlerts({alerts:[]},cx);await tasks.at(-1);
    assert.deepEqual(JSON.parse(files.get('slack-popup-events.json')),{schema:1,seen:[]});
    files.set('slack-mentions.json','{"items":[{"id":"later"}]}');refresh(cx);await tasks.at(-1);
    assert.equal(opens.length,1,'the first post-install source still opens');
  }finally{delete globalThis.__popupRuntime;}
});
}
