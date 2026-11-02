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
    readTextFile: async () => {
      if (text === undefined) throw new Error('folder does not exist');
      return text;
    },
  };
  let source = await readFile(new URL('../mods/sixfold-desk/alerts.js', import.meta.url), 'utf8');
  source = source.replace(/^import .* from 'gpui-kit';\n/m, '');
  source = source.replace(/^import .* from 'gpui-base';\n/m, '');
  source = source.replace(/^import .* from 'herdr';/m,
    'const {appHome, readTextFile} = globalThis.__alertsRuntime;');
  try {
    const {watchAlerts} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    watchAlerts(view, cx);
    await tasks.at(-1);
    assert.deepEqual(view.alerts, []);
    text = JSON.stringify({items: [{id: 'late', status: 'needs-you'}]});
    refresh(cx);
    await tasks.at(-1);
    assert.equal(view.alerts[0].id, 'late');
    assert.equal(notifications, 1);
    refresh(cx);
    await tasks.at(-1);
    assert.equal(notifications, 1);
    text = '{partial';
    refresh(cx);
    await tasks.at(-1);
    assert.equal(view.alerts[0].id, 'late');
    text = JSON.stringify({items: []});
    refresh(cx);
    await tasks.at(-1);
    assert.deepEqual(view.alerts, []);
    assert.equal(notifications, 2);
  } finally {
    delete globalThis.__alertsRuntime;
  }
});
