import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// alert-inbox.js with stubbed native modules: the card key it produces and the one alerts popover per card.
function element(){let proxy;const data={nodes:[],calls:[]};proxy=new Proxy(data,{get(t,k){if(k==='then')return undefined;if(k in t)return t[k];
  if(['child','trigger','content'].includes(k))return n=>{t.calls.push([k,n]);if(n!=null)t.nodes.push(n);return proxy;};
  if(k==='children')return ns=>{t.nodes.push(...ns.filter(Boolean));return proxy;};
  if(k==='when')return (b,f)=>{if(b)f(proxy);return proxy;};
  return (...a)=>{t.calls.push([k,...a]);return proxy;};}});return proxy;}
async function inbox(arrivalList=[]){
  const store=new Map([['sixfold.alertProjects',['Alpha']],['sixfold.linearSpaces',['Alpha']],['sixfold.alertItems',[]],['sixfold.linearItems',[]]]);
  globalThis.__alertInbox={div:element,image:element,h_flex:element,v_flex:element,Popover:{new:element},shared:k=>store.get(k),setShared:(k,v)=>store.set(k,v),openOverlay:o=>store.set('opened',[...(store.get('opened')??[]),o]),arrivals:()=>arrivalList};
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

test('the card head unread number opens the same space issue popover on alerts without changing read state',async()=>{
  const {store,workspaceUnreadBadge,workspaceNotifications,workspaceUnreadCounts}=await inbox();
  const alerts={unread:2,sources:['slack','github'],items:[
    {id:'s',source:'slack',ref:'#demo',sender:'Kim',summary:'안녕',read:false,at:'2026-11-20T00:00:00Z'},
    {id:'g',source:'github',ref:'demo/api#1',sender:'Lee',summary:'리뷰 요청',read:false,at:'2026-11-19T00:00:00Z'}]};
  const before=JSON.stringify(alerts),calls=[],context={stop_propagation(){calls.push('stop');}},space={id:'a',name:'Alpha',alerts};
  const badge=workspaceUnreadBadge(space,{accent:'#aabbcc'},{onOpen:(...args)=>calls.push(args)});
  assert.equal(badge.calls.find(c=>c[0]==='id')[1],'sf-unread-a');assert(badge.nodes.includes('2'));
  badge.calls.find(c=>c[0]==='on_click')[1]({},context);
  assert.deepEqual(calls,['stop',[space,'alerts',context]]);
  assert.equal(workspaceNotifications('Alpha',{alerts}).rows.length,2);
  assert.deepEqual(workspaceUnreadCounts('Alpha',{alerts}),{slack:1,linear:0,github:1,total:2});
  assert.equal(JSON.stringify(alerts),before);assert.equal(store.get('sixfold.alertRead'),undefined);
  assert(!workspaceUnreadBadge({...space,alerts:{items:[],unread:0}},{accent:'#aabbcc'}).calls.some(c=>c[0]==='on_click'));
});

test('the notification adapter deduplicates mentions and excludes other spaces from the new card count',async()=>{
  const {store,popover,workspaceNotifications,workspaceUnreadCounts}=await inbox();
  store.set('sixfold.alertItems',[{id:'same',project:'Alpha',text:'hi'},{id:'other',project:'Beta',text:'elsewhere'}]);
  popover.setSpaceMentions([{id:'same',project:'Alpha',text:'hi'},{id:'moved',project:'Beta'}],['Alpha','Hub']);
  store.set('sixfold.githubItems',[{id:'g',workspace:'Hub',workspace_raw:'Gone',unread:true}]);
  assert.equal(workspaceUnreadCounts('Alpha').total,1);
  assert.equal(workspaceUnreadCounts('Hub').total,2,'the moved mention and GitHub item belong to their assigned card');
  assert.deepEqual(workspaceNotifications('Alpha').rows.map(i=>i.id),['same']);
  assert.deepEqual(workspaceNotifications('Hub').rows.map(i=>i.id).sort(),['g','moved']);
});

test('new counts and notification rows preserve fallback Slack and Linear badge placement',async()=>{
  const {store,popover,workspaceUnreadCounts,workspaceNotifications,cardAlertCounts}=await inbox();
  const {placeItems}=await import('../mods/sixfold-desk/alert-model.js');
  popover.setSpaceMentions([{id:'dm',project:''},{id:'unmapped',project:'미연결'},{id:'closed',project:'Gone'}],['Alpha','Hub']);
  store.set('sixfold.linearItems',placeItems([{id:'linear-closed',workspace:'Gone',read:false}],['Alpha','Hub']));
  store.set('sixfold.linearSpaces',['Hub']);
  const old=cardAlertCounts('Hub'),counts=workspaceUnreadCounts('Hub',{connections:{slack:[],linear:[]}});
  assert.equal(counts.slack,old.slack);assert.equal(counts.linear,old.linear);assert.equal(counts.total,4);
  assert.deepEqual(workspaceNotifications('Hub').rows.map(i=>i.id).sort(),['closed','dm','linear-closed','unmapped']);
});

test('the native head count waits for landing like source badges, while the list and authoritative DTO remain intact',async()=>{
  const {ARRIVAL}=await import('../mods/sixfold-desk/arrival-model.js');
  const arrivalList=['slack','linear','github'].map(source=>({id:source,key:source,source,space:'Alpha',at:Date.now()}));
  const {store,popover,workspaceUnreadCounts,workspaceUnreadBadge,workspaceNotifications,cardAlertCounts}=await inbox(arrivalList);
  store.set('sixfold.alertItems',[{id:'slack',project:'Alpha'}]);popover.setSpaceMentions([]);
  store.set('sixfold.linearItems',[{id:'linear',workspace:'Alpha',read:false}]);
  store.set('sixfold.githubItems',[{id:'github',workspace:'Alpha',unread:true}]);
  const t={accent:'#aabbcc'};
  assert.equal(workspaceUnreadCounts('Alpha').total,0);
  assert.equal(cardAlertCounts('Alpha').slack,0);assert.equal(cardAlertCounts('Alpha').linear,0);
  assert(!workspaceUnreadBadge({id:'a',name:'Alpha'},t).nodes.includes('3'));
  assert.equal(workspaceUnreadCounts('Alpha',{motion:false}).total,3);
  assert(workspaceUnreadBadge({id:'a',name:'Alpha'},t,{motion:false}).nodes.includes('3'));
  assert.equal(workspaceNotifications('Alpha').rows.length,3,'flight only delays the badge; it never removes notification rows');
  const alerts={items:[{id:'dto',source:'slack',read:false}],unread:7};
  assert.equal(workspaceUnreadCounts('Alpha',{alerts}).total,7,'a supplied aggregate is authoritative');
  for(const arrival of arrivalList)arrival.at=Date.now()-ARRIVAL.showMs-ARRIVAL.flyMs-1;
  assert.equal(workspaceUnreadCounts('Alpha').total,3);
  assert.equal(workspaceUnreadCounts('Alpha').slack,cardAlertCounts('Alpha').slack);
  assert.equal(workspaceUnreadCounts('Alpha').linear,cardAlertCounts('Alpha').linear);
});

test('folded messages never count on the card, also when they come back through the mentions feed',async()=>{
  const {store,popover,cardAlertCounts,workspaceNotifications}=await inbox();
  // A tagged message the watcher folded: its tracked row and its copy in slack-mentions.json.
  store.set('sixfold.alertItems',[{id:'tagged',project:'Alpha',status:'handled'},{id:'old',project:'Alpha',status:'stale'},{id:'fresh',project:'Alpha',status:'new'}]);
  popover.setSpaceMentions([{id:'tagged',project:'Alpha',status:'handled'},{id:'dm',project:'Alpha',status:'handled'},{id:'old',project:'Alpha'}],['Alpha','Hub']);
  assert.equal(cardAlertCounts('Alpha').slack,1,'only the new message');
  assert.deepEqual(workspaceNotifications('Alpha').rows.map(i=>i.id),['fresh']);
  assert.deepEqual(popover.spaceMentions('Alpha').map(i=>i.id),['old'],'a folded mention is not kept; an unfolded copy of a folded row is deduped by it');
});

test('requests that need the person sit on their own space card, unmapped ones on the fallback space',async()=>{
  const {hasNeeds,hasWorkspaceAlerts,alertsOnMetaLine,alertSignature}=await inbox();
  const needs=await import(new URL('../mods/sixfold-desk/alert-mentions.js',import.meta.url).href);
  const model=await import(new URL('../mods/sixfold-desk/alert-model.js',import.meta.url).href);
  model.setFallbackSpace('Hub');
  try{
    const before=alertSignature('Hub');
    needs.setNeedsNames(['Alpha','Hub']);
    needs.setSpaceNeeds([{id:'a',project:'Alpha',status:'needs-you'},{id:'none',project:'',status:'needs-you'},
      {id:'gone',project:'Closed',status:'needs-you'},{id:'seen',project:'Alpha',status:'new'}]);
    assert.deepEqual(needs.spaceNeeds('Alpha').map(i=>i.id),['a'],'only needs-you, on its own space');
    assert.deepEqual(needs.spaceNeeds('Hub').map(i=>i.id),['none','gone'],'no space or one not shown: the fallback space');
    assert.ok(hasNeeds('Hub')&&hasWorkspaceAlerts('Hub'),'the fallback space gets an alerts row for them');
    assert.equal(alertsOnMetaLine({slack:true},'Hub'),false,'the meta line has no room for them: the alerts row stays');
    assert.notEqual(alertSignature('Hub'),before,'the card redraws when they change');
    const sig=alertSignature('Hub');
    needs.setSpaceNeeds([{id:'none',project:'',status:'needs-you',title:'new title'},{id:'gone',project:'Closed',status:'needs-you'}]);
    assert.notEqual(alertSignature('Hub'),sig,'a changed title or target redraws the card, not only a new id');
    needs.setNeedsNames(['Alpha','Hub','Closed']);
    assert.deepEqual(needs.spaceNeeds('Hub').map(i=>i.id),['none'],'a space opened on the sidebar takes its requests back');
    assert.deepEqual(needs.spaceNeeds('Closed').map(i=>i.id),['gone']);
    needs.setNeedsNames(['Alpha']);
    assert.deepEqual(needs.spaceNeeds('Alpha').map(i=>i.id),['none','gone'],'fallback not drawn: the first card shown');
    needs.setNeedsNames(['Alpha','Hub']);
    const dropped=needs.dropSpaceNeed('none');
    assert.deepEqual(needs.spaceNeeds('Hub').map(i=>i.id),['gone'],'a dismissed one leaves at once');
    needs.restoreSpaceNeed(dropped);
    assert.deepEqual(needs.spaceNeeds('Hub').map(i=>i.id).sort(),['gone','none'],'a failed dismissal puts it back');
  }finally{needs.setSpaceNeeds([]);}
});

test('an open alert popover of a card whose row went away is released, others are kept',async()=>{
  const {store,releaseAlertPopover,popover}=await inbox();
  popover.showPopover('Alpha','slack');
  releaseAlertPopover('Beta');
  assert.equal(store.get('sixfold.alertPopover').space,'Alpha','another card keeps its popover');
  releaseAlertPopover('alpha');
  assert.deepEqual(store.get('sixfold.alertPopover'),{},'released');
  assert.equal(popover.alertPopoverOpen(),false,'no longer holds back arrival peeks');
});
