import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { run, exec, readTextFile, appHome } from 'herdr';
import {subscribeJsonFile,subscribeFileChanges} from './panel-io.js';
import { KIND_WORDS, bridgeFrom, parseAsks, questionsOf, choose, complete, answerArgs, detailOf, touchesCards, tokenPath } from './ask-model.js';

// Cards for prompts an agent is waiting on (permission, question, plan), from the optional
// local bridge. Without the bridge (no harness-local config) the section never appears.
const CONFIG = '/data/sixfold/harness-local/config.json';
const SAFETY_MS = 5000;     // a card the bridge closed on its own (time-out, answered in the terminal)

export function watchAsks(view, cx) {
  view.stopAsks?.();
  view.asks = null;          // null: no bridge → nothing shown
  view.askChoices = {};
  view.askBusy = {};
  view.askErrors = {};
  view.askDir = null;
  view.askWatchOutsideAppHome = false;
  view.askExternalWatchActive = false;
  let loading=false,previous,disposed=false,scheduled=null,safety=null,stopDirectory=null,bridgeKey,configHash,configLoaded=false,generation=0,dirty=false;
  const allowed=()=>!disposed&&!view.panelTrackingActive;
  const cancelSafety=()=>{safety?.cancel?.();safety=null;};
  const scheduleSafety=()=>{
    cancelSafety();
    if(allowed()&&view.askBridge&&view.asks?.length)safety=cx.timer.after(SAFETY_MS,()=>{safety=null;refresh(cx);});
  };
  const observeDirectory=dir=>{
    if(view.askDir===dir)return;
    stopDirectory?.();stopDirectory=null;view.askDir=dir;view.askExternalWatchActive=false;
    const normalized=value=>String(value??'').replace(/\\/g,'/').replace(/\/+$/,'');
    const home=normalized(appHome()),folder=normalized(dir);
    const windows=/^(?:[A-Za-z]:\/|\/\/)/.test(home);
    const root=windows?home.toLowerCase():home,path=windows?folder.toLowerCase():folder;
    view.askWatchOutsideAppHome=Boolean(dir&&path!==root&&!path.startsWith(root+'/'));
    // The shared service multiplexes explicitly configured external roots;
    // sidebar copies reuse the same root watcher and receive owned delivery.
    if(dir){stopDirectory=subscribeFileChanges(cx,dir,paths=>{if(!disposed&&touchesCards(paths,dir))refresh(cx);});view.askExternalWatchActive=view.askWatchOutsideAppHome;}
  };
  const refreshNow = context => {
    if(!allowed()){dirty=true;return;}
    if(!view.askBridge)return;
    if(loading){dirty=true;return;}
    dirty=false;cancelSafety();
    loading = true;
    const bridge=view.askBridge,version=generation;
    (context??cx).spawn(async cx => {
      try {
        const result = await exec(bridge.python, [bridge.script, 'asks', '--json']);
        if(version!==generation||!allowed()){dirty=true;return;}
        const parsed = result.code === 0 ? parseAsks(result.stdout) : null;
        if (!parsed) return;                       // keep what is shown; retried on the next change
        observeDirectory(parsed.dir);
        view.askTokenDir = parsed.tokenDir;
        const text = JSON.stringify(parsed.asks);
        if (text === previous) return;
        previous = text;
        const live = new Set(parsed.asks.map(a => a.id));
        for (const key of ['askChoices', 'askBusy', 'askErrors']) {
          for (const id of Object.keys(view[key])) if (!live.has(id)) delete view[key][id];
        }
        view.asks = parsed.asks;
        cx.notify();
      } catch { /* A file change or live-card safety refresh retries a busy bridge. */ }
      finally { loading=false;scheduleSafety();if(dirty&&allowed())refresh(cx); }
    });
  };
  const refresh=context=>{
    dirty=true;
    if(!allowed()||!view.askBridge||loading||scheduled)return;
    scheduled=cx.timer.after(20,()=>{scheduled=null;refreshNow(context??cx);});
  };
  const stopConfig=subscribeJsonFile(cx,`${appHome()}${CONFIG}`,snapshot=>{
    if(disposed||snapshot.status==='invalid')return;
    if(snapshot.status==='ready'){
      if(configLoaded&&snapshot.hash===configHash)return;
      configLoaded=true;configHash=snapshot.hash;view.askConfig=snapshot.value;
    }else if(snapshot.status==='missing'){configLoaded=false;configHash=undefined;view.askConfig=null;}
    else return;
    const bridge=snapshot.status==='ready'?bridgeFrom(snapshot.value):null;
    const key=bridge?JSON.stringify([bridge.python,bridge.script]):null;
    if(key===bridgeKey)return;
    bridgeKey=key;generation++;previous=undefined;view.askBridge=bridge;
    if(!bridge){
      scheduled?.cancel?.();scheduled=null;cancelSafety();observeDirectory(null);view.askTokenDir=null;
      if(view.asks!==null){view.asks=null;if(!view.panelTrackingActive)cx.notify();}
      return;
    }
    refresh(cx);
  });
  const stop=()=>{if(disposed)return;disposed=true;generation++;scheduled?.cancel?.();scheduled=null;cancelSafety();stopConfig();stopDirectory?.();stopDirectory=null;view.askExternalWatchActive=false;};
  view.stopAsks=stop;(view.fileSubscriptions??=[]).push(stop);
  view.refreshAsks = refresh;
  return stop;
}

function answer(view, ask, decision, cx) {
  const bridge = view.askBridge;
  if (!bridge || view.askBusy[ask.id]) return;
  view.askBusy[ask.id] = true;
  delete view.askErrors[ask.id];
  cx.notify();
  cx.spawn(async cx => {
    try {
      // The one-time token sits beside the cards; this UI reads it only when answering.
      const path = tokenPath(view.askTokenDir, ask);
      const token = path ? await readTextFile(path).catch(() => null) : null;
      const args = answerArgs(bridge.script, ask, decision, view.askChoices[ask.id], token);
      const result = await exec(bridge.python, args);
      if (result.code !== 0) view.askErrors[ask.id] = (result.stderr || result.stdout || `exit ${result.code}`).trim().split(/\r?\n/).pop();
      else view.asks = (view.asks ?? []).filter(a => a.id !== ask.id);
    } catch (e) { view.askErrors[ask.id] = String(e?.message || e); }
    finally { delete view.askBusy[ask.id]; cx.notify(); view.refreshAsks?.(cx); }
  });
}

const stop = el => el.on_mouse_down('left', (_e, cx) => cx.stop_propagation()).on_mouse_up('left', (_e, cx) => cx.stop_propagation());

function button(id, text, color, t, action, enabled = true) {
  return stop(div().id(id).px(7).py(2).rounded(3).border(1).border_color(enabled ? color : t.border)
    .text_size(10).text_color(enabled ? color : t.dim).cursor_pointer()
    .on_click((_e, cx) => { cx.stop_propagation(); if (enabled) action(cx); })
    .child(text));
}

export function hasAsks(view) {
  return Array.isArray(view.asks) && view.asks.length > 0;
}

export function askSection(view, t, lang, nameOf) {
  const w = KIND_WORDS[lang] ?? KIND_WORDS.en;
  const asks = view.asks ?? [];
  return v_flex().id('sf-asks').flex_none().px(10).py(9).gap(5).bg(t.surface).border_t(1).border_color(t.border)
    .child(h_flex().gap(5).items_center()
      .child(div().flex_1().text_size(10).font_bold().text_color(t.muted).child(w.title))
      .child(div().text_size(10).text_color(t.blocked).child(String(asks.length))))
    .children(asks.slice(0, 4).map(ask => {
      const busy = Boolean(view.askBusy[ask.id]);
      const detail = detailOf(ask);
      const questions = ask.kind === 'question' ? questionsOf(ask) : [];
      const selected = view.askChoices[ask.id] ?? {};
      return v_flex().id(`sf-ask-${ask.id}`).gap(4).px(7).py(6).rounded(4).bg(t.chrome).border(1).border_color(t.blocked)
        .tooltip(`${nameOf(ask.terminal)} · ${ask.tool_name}\n${detail || ask.reason}`)
        .on_click(() => { if (ask.terminal) run('agent.focus', { terminal: ask.terminal }); })
        .child(h_flex().gap(5).items_center()
          .child(div().flex_none().px(4).rounded(3).bg(t.blocked).text_color(t.background).text_size(9).child(w[ask.kind]))
          .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.muted).child(nameOf(ask.terminal))))
        .child(div().text_size(11).text_color(t.foreground).child(ask.reason))
        .when(Boolean(detail) && ask.kind !== 'question', e => e.child(div().truncate().text_size(10).text_color(t.dim).child(detail)))
        .children(questions.map((q, qi) => v_flex().gap(3)
          .when(questions.length > 1 || q.header, e => e.child(div().text_size(10).text_color(t.muted).child(q.header || q.question)))
          .child(h_flex().flex_wrap().gap(4).children(q.options.map((label, oi) => {
            const on = (selected[q.question] ?? []).includes(label);
            return button(`sf-ask-${ask.id}-q${qi}-o${oi}`, `${on ? '● ' : ''}${label}`, on ? t.accent : t.foreground, t, cx => {
              view.askChoices[ask.id] = choose(selected, q, label);
              // One single-select question is answered by its option itself.
              if (questions.length === 1 && !q.multi) answer(view, ask, 'allow', cx); else cx.notify();
            }, !busy);
          })))))
        .child(h_flex().gap(5).items_center()
          .when(ask.kind !== 'question', e => e.child(button(`sf-ask-${ask.id}-allow`, w.allow, t.working, t, cx => answer(view, ask, 'allow', cx), !busy)))
          .when(ask.kind === 'question' && (questions.length > 1 || questions.some(q => q.multi)), e =>
            e.child(button(`sf-ask-${ask.id}-send`, w.send, t.working, t, cx => answer(view, ask, 'allow', cx), !busy && complete(ask, selected))))
          .child(button(`sf-ask-${ask.id}-deny`, w.deny, t.blocked, t, cx => answer(view, ask, 'deny', cx), !busy))
          .when(busy, e => e.child(div().text_size(10).text_color(t.dim).child('…'))))
        .when(Boolean(view.askErrors[ask.id]), e => e.child(div().text_size(10).text_color(t.blocked)
          .child(`${w.failed}: ${view.askErrors[ask.id]}`)));
    }))
    .when(asks.length > 4, e => e.child(div().text_size(9).text_color(t.muted).child(`+${asks.length - 4}`)));
}
