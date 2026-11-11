import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// alert-inbox.js with stubbed native modules: the card key it produces and the one alerts popover per card.
function element(){let proxy;const data={nodes:[],calls:[]};proxy=new Proxy(data,{get(t,k){if(k==='then')return undefined;if(k in t)return t[k];
  if(['child','trigger','content'].includes(k))return n=>{t.calls.push([k,n]);if(n!=null)t.nodes.push(n);return proxy;};
  if(k==='children')return ns=>{t.nodes.push(...ns.filter(Boolean));return proxy;};
  if(k==='when')return (b,f)=>{if(b)f(proxy);return proxy;};
  return (...a)=>{t.calls.push([k,...a]);return proxy;};}});return proxy;}
async function inbox(){
  const store=new Map([['sixfold.alertProjects',['Alpha']],['sixfold.linearSpaces',['Alpha']],['sixfold.alertItems',[]],['sixfold.linearItems',[]]]);
  globalThis.__alertInbox={div:element,image:element,h_flex:element,v_flex:element,Popover:{new:element},shared:k=>store.get(k),setShared:(k,v)=>store.set(k,v),openOverlay(){},arrivals:()=>[]};
  const base=new URL('../mods/sixfold-desk/',import.meta.url);
  const transform=s=>s.replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base|herdr)';/g,'const {$1}=globalThis.__alertInbox;');
  const asUrl=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
  const popUrl=asUrl(transform(await readFile(new URL('alert-popover.js',base),'utf8')).replace("'./alert-model.js'",JSON.stringify(new URL('alert-model.js',base).href)));
  const src=transform(await readFile(new URL('alert-inbox.js',base),'utf8')).replace("'./alert-model.js'",JSON.stringify(new URL('alert-model.js',base).href))
    .replace("'./alert-popover.js'",JSON.stringify(popUrl)).replace("import { arrivals } from './arrival-store.js';",'const {arrivals}=globalThis.__alertInbox;')
    .replace("'./arrival-model.js'",JSON.stringify(new URL('arrival-model.js',base).href));
  return {store,...await import(asUrl(src)+`#${Math.random()}`),popover:await import(popUrl)};
}

test('the alerts-row card key changes when the Slack copy delay starts, moves or ends',async()=>{
  const {store,alertSignature}=await inbox();
  store.set('sixfold.slackHealth',{mirror_latest_at:new Date(Date.now()-3600_000).toISOString()});
  const fresh=alertSignature('Alpha');
  store.set('sixfold.slackHealth',{mirror_latest_at:'2026-11-07T01:16:11Z'});
  const stale=alertSignature('Alpha');
  assert.notEqual(stale,fresh,'fresh → stale');
  store.set('sixfold.slackHealth',{mirror_latest_at:'2026-11-07T02:16:11Z'});
  assert.notEqual(alertSignature('Alpha'),stale,'the copy moved, still stale');
  store.set('sixfold.slackHealth',{mirror_latest_at:new Date(Date.now()-600_000).toISOString()});
  assert.equal(alertSignature('Alpha'),fresh,'stale → fresh');
});

test('a card has one alerts popover: the meta-line Slack chip only when the meta line carries the alerts',async()=>{
  const {slackAlertsChip,alertsOnMetaLine,popover}=await inbox();
  popover.showPopover('Alpha','slack');
  const trigger=element();
  assert.equal(alertsOnMetaLine({work:{tool:'jira'},slack:{channel:'c'}},'Alpha'),false);   // Linear alerts but no Linear chip
  assert.equal(slackAlertsChip({id:'a',name:'Alpha',work:{tool:'jira'},slack:{channel:'c'}},trigger,{}),trigger);
  assert.equal(alertsOnMetaLine({work:{tool:'linear'}},'Alpha'),true);
  assert.notEqual(slackAlertsChip({id:'a',name:'Alpha',work:{tool:'linear'}},trigger,{}),trigger);
});
