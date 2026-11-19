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
  globalThis.__alertInbox={div:element,image:element,h_flex:element,v_flex:element,Popover:{new:element},shared:k=>store.get(k),setShared:(k,v)=>store.set(k,v),openOverlay:o=>store.set('opened',[...(store.get('opened')??[]),o]),arrivals:()=>[]};
  const base=new URL('../mods/sixfold-desk/',import.meta.url);
  const transform=s=>s.replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base|herdr)';/g,'const {$1}=globalThis.__alertInbox;');
  const asUrl=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
  globalThis.__alertInbox.readTextFile=async()=>null;globalThis.__alertInbox.appHome=()=>'/test';
  const slackUrl=JSON.stringify(new URL('alert-slack.js',base).href);
  const filesUrl=asUrl(transform(await readFile(new URL('alert-files.js',base),'utf8')).replace("'./alert-slack.js'",slackUrl));
  const popUrl=asUrl(transform(await readFile(new URL('alert-popover.js',base),'utf8')).replace("'./alert-model.js'",JSON.stringify(new URL('alert-model.js',base).href))
    .replace("'./alert-slack.js'",slackUrl).replace("'./alert-files.js'",JSON.stringify(filesUrl)).replace("'./alert-mentions.js'",JSON.stringify(new URL('alert-mentions.js',base).href))+`//${Math.random()}`);   // a fresh module per call: it reads this call's store
  const src=transform(await readFile(new URL('alert-inbox.js',base),'utf8')).replace("'./alert-model.js'",JSON.stringify(new URL('alert-model.js',base).href))
    .replace("'./alert-popover.js'",JSON.stringify(popUrl)).replace("'./alert-mentions.js'",JSON.stringify(new URL('alert-mentions.js',base).href)).replace("import { arrivals } from './arrival-store.js';",'const {arrivals}=globalThis.__alertInbox;')
    .replace("'./arrival-model.js'",JSON.stringify(new URL('arrival-model.js',base).href));
  const popover=await import(popUrl);popover.setSpaceMentions([]);   // module state outlives one test
  return {store,...await import(asUrl(src)+`#${Math.random()}`),popover};
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

// 2026-11-16: Hub only receives mentions (slack-mentions.json), never tracked-feed items, so its card
// had no Slack badge and 전체 보기 opened the empty channel-message list.
test('mentions routed to a space give it a Slack badge, an unread count and a mention inbox',async()=>{
  const {store,hasSlackAlerts,cardAlertCounts,openInbox,popover}=await inbox();
  assert.equal(hasSlackAlerts('Hub'),false,'no mentions, no badge');
  popover.setSpaceMentions([{id:'slack:D0TEST01:1.1',project:'Hub'},{id:'slack:D0TEST01:2.1',project:'Hub'},{id:'slack:C0TEST01:3.1',project:'Alpha'}]);
  store.set('sixfold.alertRead',{'slack:D0TEST01:1.1':'slack:D0TEST01:1.1'});
  store.set('sixfold.alertItems',[{id:'slack:C0TEST01:3.1',project:'Alpha'}]);
  assert.equal(hasSlackAlerts('Hub'),true);
  assert.equal(cardAlertCounts('Hub').slack,1,'the unread mention only');
  assert.equal(cardAlertCounts('Alpha').slack,1,'a mention also in the tracked feed counts once');
  openInbox({project:'Hub'});openInbox({project:'Alpha'});
  assert.deepEqual(store.get('opened').map(o=>o.props.newMessages),[false,true],'Hub opens its mentions; a tracked space its channel messages');
});

// 2026-11-16 review: an arrival for a space that is not on the sidebar ('미연결') lands on Hub, but the
// grouping kept its own space, so once the peek folded Hub's badge, unread count and popover lost it.
test('mentions of a space not on the sidebar count on Hub, as their arrival does',async()=>{
  const {cardAlertCounts,hasSlackAlerts,popover}=await inbox();
  const items=[{id:'slack:C0TEST09:1.1',project:'미연결'},{id:'slack:D0TEST01:2.1',project:'Hub'},{id:'slack:C0TEST01:3.1',project:'Alpha'},{id:'slack:C0TEST02:4.1',project:'Gone'}];
  popover.setSpaceMentions(items,['Alpha','Hub']);
  assert.equal(cardAlertCounts('Hub').slack,3,'Hub + 미연결 + a space no longer on the sidebar');
  assert.deepEqual(popover.spaceMentions('Hub').map(i=>i.id),['slack:C0TEST09:1.1','slack:D0TEST01:2.1','slack:C0TEST02:4.1']);
  assert.deepEqual(popover.spaceMentions('Alpha').map(i=>i.id),['slack:C0TEST01:3.1'],'a sidebar space keeps its own');
  assert.equal(hasSlackAlerts('미연결'),false,'no group under the unmapped name');
  popover.setSpaceMentions(items);
  assert.deepEqual(popover.spaceMentions('미연결').map(i=>i.id),['slack:C0TEST09:1.1'],'no sidebar names yet: each keeps its own space');
});

// shared() copies the whole value per read; the tracked feed is read once per load, not per card.
test('the tracked feed is read once per alert load and again after the next load',async()=>{
  const {store,cardAlertCounts,popover}=await inbox();
  let reads=0;const get=store.get.bind(store);
  store.set('sixfold.alertItems',[{id:'a1',project:'Alpha'}]);
  store.get=k=>{if(k==='sixfold.alertItems')reads++;return get(k);};
  try{
    popover.setSpaceMentions([]);
    for(let i=0;i<5;i++)assert.equal(cardAlertCounts('Alpha').slack,1);
    assert.equal(reads,1,'one copy for every card and every count');
    store.set('sixfold.alertItems',[{id:'a1',project:'Alpha'},{id:'a2',project:'Alpha'}]);
    popover.setSpaceMentions([]);   // alerts.js publishes the feed and the mentions together
    assert.equal(cardAlertCounts('Alpha').slack,2);
    assert.equal(reads,2);
  }finally{store.get=get;}
});
