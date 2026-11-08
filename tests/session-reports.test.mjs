import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

async function reports(){
  let callback,stops=0,snapshot={status:'missing'},reads=0;
  let source=await readFile(new URL('../mods/sixfold-desk/session-reports.js',import.meta.url),'utf8');
  source=source.replace(/^import[^\n]*\n/gm,'');
  const subscribeJsonFile=(_cx,path,fn)=>{assert.equal(path,'/demo/app/data/sixfold/session-reports.json');callback=fn;return ()=>{stops++;callback=null;};};
  const readJsonSnapshot=async()=>{reads++;return snapshot;};
  const mod=new Function('subscribeJsonFile','readJsonSnapshot','appHome',`${source.replace(/export /g,'')}; return {parseReports,watchReports};`)(subscribeJsonFile,readJsonSnapshot,()=>'/demo/app');
  return {...mod,emit:value=>callback?.(value),set:value=>{snapshot=value;},get stops(){return stops;},get reads(){return reads;}};
}
const row={id:'demo',title:'Local check',summary:'Ready',terminal:'demo-terminal',state:'ready'};
const context=()=>({notifications:0,notify(){this.notifications++;},spawn(fn){return fn(this);},timer:{every(){throw Error('No private polling timer');}}});

test('session reports parse neutral strings and frozen typed envelopes',async()=>{
  const m=await reports();
  assert.deepEqual(m.parseReports(JSON.stringify({schema:1,reports:[row,row,{id:'bad'}]})),[row]);
  assert.deepEqual(m.parseReports(Object.freeze({schema:1,reports:Object.freeze([Object.freeze(row)])})),[row]);
  for(const text of [null,'broken','{}','{"schema":2,"reports":[]}'])assert.deepEqual(m.parseReports(text),[]);
});

test('shared report subscriptions change only on valid updates or confirmed removal and stop cleanly',async()=>{
  const m=await reports(),cx=context(),view={},stop=m.watchReports(view,cx);
  m.emit({status:'missing'});assert.deepEqual(view.sessionReports,[]);assert.equal(cx.notifications,0);
  m.emit({status:'ready',value:{schema:1,reports:[row]}});assert.equal(cx.notifications,1);
  m.emit({status:'ready',value:{schema:1,reports:[row]}});assert.equal(cx.notifications,1);
  m.emit({status:'invalid'});m.emit({status:'ready',value:{schema:2,reports:[]}});
  assert.equal(view.sessionReports[0].title,row.title);assert.equal(cx.notifications,1);
  m.emit({status:'missing'});assert.deepEqual(view.sessionReports,[]);assert.equal(cx.notifications,2);
  assert.equal(m.reads,0);stop();stop();assert.equal(m.stops,1);
  m.emit({status:'ready',value:{schema:1,reports:[row]}});assert.equal(cx.notifications,2);
});

test('reports cache typed changes while inactive and flush one notification on return',async()=>{
  const m=await reports(),cx=context(),view={panelTrackingActive:true,sidebarVisible:false};m.watchReports(view,cx);
  const parse=JSON.parse;JSON.parse=()=>{throw Error('Typed reports must not parse');};
  try{m.emit({status:'ready',value:{schema:1,reports:[row]}});}finally{JSON.parse=parse;}
  assert.equal(view.sessionReports.length,1);assert.equal(cx.notifications,0);
  view.sidebarVisible=true;view.setReportsActive(true);view.setReportsActive(true);assert.equal(cx.notifications,1);
  m.set({status:'missing'});await view.refreshReports(cx);assert.equal(cx.notifications,2);assert.equal(m.reads,1);view.stopReports();
});
