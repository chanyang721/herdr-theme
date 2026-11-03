import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('alerts recover after cold install and partial writes without a folder watcher', async () => {
  let text;
  let notifications = 0;
  let refresh;
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
      if (!path.endsWith('/alerts.json')) throw new Error('optional file missing');
      if (text === undefined) throw new Error('folder does not exist');
      return text;
    },
  };
  let source = await readFile(new URL('../mods/sixfold-desk/alerts.js', import.meta.url), 'utf8');
  source = source.replace(/\r\n/g, '\n');
  source = source.replace(/^import .* from 'gpui-kit';\n/m, '');
  source = source.replace(/^import .* from 'gpui-base';\n/m, '');
  source = source.replace(/^import .* from 'herdr';/m,
    'const {appHome, readTextFile, setShared, notify} = globalThis.__alertsRuntime;');
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

test('new mentions and finished reviews reopen the popup once; cold history does not',async()=>{
  const files=new Map([['alerts.json','{"items":[]}'],['project-alerts.json','{"items":[],"projects":["Medihomes"]}'],['slack-alerts-read.json','{}'],['slack-mentions.json','{"items":[{"id":"old"}]}'],['slack-workflows.json','{"jobs":{}}']]);
  const tasks=[],opens=[];let refresh;
  const cx={notify(){},spawn(fn){const task=fn(cx);tasks.push(task);return task;},timer:{every(_ms,fn){refresh=fn;}}};
  globalThis.__popupRuntime={appHome:()=>'/test',readTextFile:async path=>files.get(path.split('/').at(-1)) || '{}',setShared(){},openOverlay:x=>opens.push(x)};
  let source=await readFile(new URL('../mods/sixfold-desk/alerts.js',import.meta.url),'utf8');
  source=source.replace(/^import .* from 'gpui-kit';\n/m,'').replace(/^import .* from 'gpui-base';\n/m,'')
    .replace(/^import .* from 'herdr';/m,'const {appHome,readTextFile,setShared,openOverlay}=globalThis.__popupRuntime;');
  try{
    const {watchAlerts}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64')+'#popup');
    watchAlerts({alerts:[]},cx);await tasks.at(-1);assert.equal(opens.length,0);
    files.set('slack-mentions.json','{"items":[{"id":"old"},{"id":"new"}]}');refresh(cx);await tasks.at(-1);assert.equal(opens.length,1);
    refresh(cx);await tasks.at(-1);assert.equal(opens.length,1);
    files.set('slack-workflows.json','{"jobs":{"job":{"id":"job","state":"needs_decision","finished_at":"now"}}}');refresh(cx);await tasks.at(-1);assert.equal(opens.length,2);
    assert.equal(opens[0].props.review,false);assert.equal(opens[1].props.review,true);
    assert.equal(opens[0].kind,'window');assert.equal(opens[0].key,opens[1].key);
  }finally{delete globalThis.__popupRuntime;}
});
