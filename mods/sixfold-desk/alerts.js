import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { run, readTextFile, writeTextFile, appHome, setShared, openOverlay, spaces } from 'herdr';
import {createHash} from 'crypto';
import {readJsonSnapshot,subscribeJsonFile,subscribeFileChanges} from './panel-io.js';
import {addArrival,hasArrivalHost} from './arrival-store.js';
import {arrivalTarget,ARRIVAL} from './arrival-model.js';

const SHOWN = new Set(['needs-you']);  // Only what a person must decide; the rest stays in the project.
const MARKS = { 'needs-you': '!', info: '✓', processing: '●' };

function popupEvents(mentions, read) {
  const events = [];
  for (const item of mentions ?? []) {
    if (typeof item?.id === 'string' && item.id) {
      events.push({key: `mention:${item.id}`, id: item.id, popup: read[item.id] !== item.id, project: item.project ?? '', title: item.text || item.title || '', author: item.author || ''});
    }
  }
  return events;
}

async function ledgerSnapshot(path,empty){
  const typed=await readJsonSnapshot(path);
  const raw=await readTextFile(path).catch(()=>null);
  if(typed.status==='missing'&&raw===null)return {value:empty,raw:null,firstRun:true};
  if(typed.status!=='ready'||typeof raw!=='string'||createHash('sha256').update(raw).digest('hex')!==typed.hash)throw new Error('File changed while reading its typed snapshot');
  return {value:typed.value,raw,firstRun:false};
}

async function notifyNewPopupEvents(events,allowed=()=>true) {
  const path = `${appHome()}/data/sixfold/slack-popup-events.json`;
  const {value:ledger,raw:text,firstRun}=await ledgerSnapshot(path,{schema:1,seen:[]});
  if (ledger?.schema !== 1 || !Array.isArray(ledger.seen) || !ledger.seen.every(key => typeof key === 'string')) {
    throw new Error('Invalid Slack popup event ledger');
  }
  const seen = new Set(ledger.seen);
  const fresh = events.filter(event => !seen.has(event.key));
  if (!fresh.length && !firstRun) return [];

  // Seed existing history silently on first run. Later writes use the exact
  // previous contents as a compare-and-swap guard across multiple views.
  const next = {schema: 1, seen: [...ledger.seen, ...fresh.map(event => event.key)]};
  if(!allowed())throw new Error('View no longer displays alerts');
  await writeTextFile(path, JSON.stringify(next), text);
  return firstRun ? [] : fresh.filter(event => event.popup);
}

// A new mention arrives into its space card when a sidebar draws arrivals;
// otherwise the Slack window opens as before, so it is never dropped.
function announceSlack(events){
  if(!events.length)return;
  if(!hasArrivalHost())return openOverlay({mod:'sixfold-slack-inbox',kind:'window',key:'slack-mentions',keep:true,width:1040,height:800,props:{window:true,review:Boolean(events[0].review)}});
  const names=(spaces()??[]).map(s=>s.name);
  // Mentions are newest first: the newest few, oldest of them first so the newest lands last.
  for(const event of events.slice(0,ARRIVAL.visible).reverse())addArrival({key:event.key,id:event.id,source:'slack',space:arrivalTarget(event.project,names),title:event.title,issue:event.author});
}

// Tracked Slack, GitHub and pane requests, ordered by the watcher: needs-you first.
export function visibleAlerts(items, limit = 6) {
  return (items ?? []).filter(item => SHOWN.has(item.status)).slice(0, limit);
}

export function watchAlerts(view, cx) {
  view.stopAlerts?.();
  const base=`${appHome()}/data/sixfold`;
  const inputs=[['legacy','alerts.json',()=>({items:[]})],['tracked','project-alerts.json',()=>({items:[]})],['read','slack-alerts-read.json',()=>({})],['mentions','slack-mentions.json',()=>({items:[]})],['health','slack-live-health.json',()=>({})],['workflows','slack-workflows.json',()=>({jobs:{}})]];
  const cached=new Map(),subscriptions=[];
  let loading=false,previous,disposed=false,scheduled=null,dirty=false,version=0;
  const allowed=()=>!disposed&&view.sidebarVisible!==false;
  const schedule=()=>{
    dirty=true;
    if(!allowed()||loading||scheduled||cached.size!==inputs.length)return;
    scheduled=cx.timer.after(20,()=>{scheduled=null;refresh(cx);});
  };
  const refresh = context => {
    if(!allowed()||cached.size!==inputs.length)return;
    if(loading){dirty=true;return;}
    dirty=false;
    const signature=JSON.stringify(inputs.map(([key])=>cached.get(key).token));
    if(signature===previous)return;
    loading = true;
    (context??cx).spawn(async cx => {
      try {
        const get=key=>cached.get(key).value;
        const legacy=get('legacy'),feed=get('tracked'),read=get('read'),mentions=get('mentions'),health=get('health'),workflows=get('workflows');
        const items = feed.items ?? [];
        const tagged=mentions.items ?? [];
        const states=workflows.jobs ?? {};
        const events=await notifyNewPopupEvents(popupEvents(tagged,read),allowed);
        if(!allowed())return;
        setShared('sixfold.slackHealth',health);
        setShared('sixfold.slackWorkflows',states);
        announceSlack(events);
        setShared('sixfold.alertItems',items);
        setShared('sixfold.alertRead',read);
        setShared('sixfold.alertProjects',feed.projects ?? []);
        view.alerts = legacy.items ?? [];
        previous = signature;
        cx.notify();
      } catch { /* Retry after the next input/ledger change or classic-view activation. */ }
      finally { loading = false;if(dirty)schedule(); }
    });
  };
  for(const [key,name,fallback] of inputs){
    subscriptions.push(subscribeJsonFile(cx,`${base}/${name}`,snapshot=>{
      if(disposed)return;
      const last=cached.get(key);
      if(snapshot.status==='missing'){
        if(!last){cached.set(key,{value:fallback(),hash:null,token:'missing'});schedule();}
        return;
      }
      if(snapshot.status!=='ready'||!snapshot.value||typeof snapshot.value!=='object'||Array.isArray(snapshot.value))return;
      const hash=typeof snapshot.hash==='string'?snapshot.hash:null;
      if(last&&((hash!==null&&hash===last.hash)||(hash===null&&snapshot.value===last.value)))return;
      cached.set(key,{value:snapshot.value,hash,token:hash??`value-${++version}`});schedule();
    }));
  }
  subscriptions.push(subscribeFileChanges(cx,`${base}/slack-popup-events.json`,()=>{if(!disposed)schedule();}));
  const stop=()=>{if(disposed)return;disposed=true;scheduled?.cancel?.();scheduled=null;subscriptions.forEach(unsubscribe=>unsubscribe());};
  view.refreshAlerts=refresh;view.stopAlerts=stop;(view.fileSubscriptions??=[]).push(stop);
  return stop;
}

async function dismiss(id) {
  const path = `${appHome()}/data/sixfold/alerts-dismissed.json`;
  const {value:ids,raw:old}=await ledgerSnapshot(path,[]);
  if(!Array.isArray(ids)||!ids.every(value=>typeof value==='string'))throw new Error('Invalid dismissed alerts ledger');
  await writeTextFile(path, JSON.stringify([...ids, id]), old);
}

export function alertSection(view, t) {
  const alerts = visibleAlerts(view.alerts);
  const waiting = alerts.filter(item => item.status === 'needs-you').length;
  return v_flex().id('sf-alerts').flex_none().px(10).py(9).gap(4).bg(t.surface).border_t(1).border_color(t.border)
    .child(h_flex().gap(5).items_center()
      .child(div().flex_1().text_size(10).font_bold().text_color(t.muted).child('Share 알림'))
      .child(div().text_size(10).text_color(t.accent).child(`확인 ${waiting}건`)))
    .children(alerts.map(item => h_flex().id(`sf-alert-${item.id}`).gap(5).items_center().px(6).py(4).rounded(4).bg(t.chrome)
      .tooltip(item.summary || item.text || item.title)
      .on_click(() => { if (item.terminal) run('agent.focus', { terminal: item.terminal }); })
      .child(div().text_size(10).text_color(t.accent).child(MARKS[item.status]))
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.foreground)
        .child(`${item.project} · ${item.summary || item.title}`))
      .child(div().id(`sf-alert-close-${item.id}`).px(3).text_size(11).text_color(t.muted)
        .on_mouse_down('left', (_event, cx) => cx.stop_propagation())
        .on_mouse_up('left', (_event, cx) => cx.stop_propagation())
        .on_click((_event, cx) => {
          cx.stop_propagation();
          view.alerts = view.alerts.filter(other => other.id !== item.id);
          cx.spawn(async () => { await dismiss(item.id); });
          cx.notify();
        }).child('×'))));
}
