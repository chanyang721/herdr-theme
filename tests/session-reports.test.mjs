import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

async function reports(readTextFile) {
  let source = await readFile(new URL('../mods/sixfold-desk/session-reports.js', import.meta.url), 'utf8');
  source = source.replace(/^import[^\n]*\n/gm, '');
  return new Function('readTextFile', 'appHome', `${source.replace(/export /g, '')}; return {parseReports,watchReports};`)(readTextFile, () => '/demo/app');
}
test('session reports read only a neutral display envelope', async () => {
  const m = await reports(async () => null);
  const row = {id:'demo',title:'Local check',summary:'Ready',terminal:'demo-terminal',state:'ready'};
  assert.deepEqual(m.parseReports(JSON.stringify({schema:1,reports:[row,row,{id:'bad'}]})), [row]);
  for (const text of [null,'broken','{}','{"schema":2,"reports":[]}']) assert.deepEqual(m.parseReports(text), []);
});
test('absent or malformed reports quietly disappear and timer refreshes changes', async () => {
  let text = null, notifications=0, timer;
  const paths=[], tasks=[],view={};
  const m=await reports(async path => {paths.push(path);return text;});
  const cx={notify:()=>notifications++,spawn:fn=>tasks.push(fn(cx)),timer:{every:(ms,fn)=>{assert.equal(ms,5000);timer=fn;}}};
  m.watchReports(view,cx);await Promise.all(tasks.splice(0));
  assert.deepEqual(view.sessionReports,[]);
  text=JSON.stringify({schema:1,reports:[{id:'one',title:'Demo',summary:'Done'}]});
  timer(cx);await Promise.all(tasks.splice(0));assert.equal(view.sessionReports[0].title,'Demo');
  text='invalid';timer(cx);await Promise.all(tasks.splice(0));assert.deepEqual(view.sessionReports,[]);
  assert.ok(paths.every(p=>p==='/demo/app/data/sixfold/session-reports.json'));assert.equal(notifications,3);
});
