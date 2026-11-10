import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { exec, readTextFile, writeTextFile, appHome, shared, setShared, openOverlay, closeOverlay, props } from 'herdr';
import { KIND_WORDS, ASK_WORDS, SUMMARY_KEY, bridgeFrom, parseAsks, questionsOf, actionsOf, choose, complete, actionRequest, requestPath, acceptedReceipt, detailOf, selectionOf,
  askSummary, summaryFor, groupAsks, cardsFor, clampPage, reconcile, popupHeight, errorText } from './ask-model.js';

import {subscribeJsonFile,readJsonSnapshot} from './panel-io.js';

const ROOT = '/data/sixfold';
let sequence = 0;
export function watchAsks(view, cx) {
  view.stopAsks?.();
  view.asks = null; view.askChoices = Object.create(null); view.askBusy = Object.create(null); view.askErrors = Object.create(null); view.askBridge = null;
  const directory=`${appHome()}${ROOT}`,inputs=[['bridge',bridgeFrom],['cards',parseAsks]];
  const cached=new Map(),seen=new Set(),subscriptions=[];
  let stopped=false,active=true,previous,pendingNotify=false,loading=null,version=0;
  const apply=()=>{
    if(stopped||seen.size!==inputs.length)return;
    const bridge=cached.get('bridge')??null,cards=bridge?(cached.get('cards')?.cards??null):null;
    const signature=JSON.stringify([bridge,cards]);
    if(signature!==previous){
      previous=signature;view.askBridge=bridge;
      const live=new Set((cards??[]).map(card=>`${card.id}:${card.revision}`));
      for(const old of view.asks??[])if(!live.has(`${old.id}:${old.revision}`)){
        delete view.askChoices[old.id];delete view.askErrors[old.id];
      }
      view.asks=cards;pendingNotify=true;
      publishSummary(cards);
    }
    if(pendingNotify&&active&&view.sidebarVisible!==false){pendingNotify=false;cx.notify();}
  };
  const accept=(key,parse,snapshot)=>{
    if(stopped)return;
    seen.add(key);version++;
    if(snapshot.status==='missing')cached.set(key,null);
    else if(snapshot.status==='ready'&&Object.hasOwn(snapshot,'value')){
      const value=parse(snapshot.value);
      if(value!==null)cached.set(key,value);
    }
    // Invalid or failed reads keep the last valid display. Only a confirmed
    // missing bridge disables actions; sendAction rechecks its current bytes.
    apply();
  };
  for(const [key,parse] of inputs)subscriptions.push(subscribeJsonFile(cx,`${directory}/${key==='cards'?'cards':'bridge'}.json`,snapshot=>accept(key,parse,snapshot)));
  const refresh=(context=cx)=>{
    apply();if(stopped||loading)return loading;
    const observed=version;
    loading=(context??cx).spawn(async()=>{
      try{
        const values=await Promise.all(inputs.map(([key])=>readJsonSnapshot(`${directory}/${key}.json`).catch(()=>({status:'invalid'}))));
        if(stopped||version!==observed)return;
        // Commit both refreshed inputs together, rather than briefly mixing
        // the newly configured command with the previous cards envelope.
        for(let i=0;i<inputs.length;i++){
          const [key,parse]=inputs[i],snapshot=values[i];seen.add(key);
          if(snapshot.status==='missing')cached.set(key,null);
          else if(snapshot.status==='ready'&&Object.hasOwn(snapshot,'value')){
            const value=parse(snapshot.value);if(value!==null)cached.set(key,value);
          }
        }
        version++;apply();
      }finally{loading=null;}
    });return loading;
  };
  const stop=()=>{if(stopped)return;stopped=true;for(const release of subscriptions.splice(0))release();};
  view.stopAsks=stop;view.refreshAsks=refresh;
  view.setAsksActive=value=>{active=value!==false;apply();};
  return stop;
}
// Pane headers and the popup are other copies of this mod: they learn about
// cards only through this summary (counts per terminal and a version), never
// through the sidebar's objects. An unchanged summary is not rewritten.
function publishSummary(cards) {
  try {
    const next = askSummary(cards);
    if (JSON.stringify(shared(SUMMARY_KEY) ?? null) !== JSON.stringify(next)) setShared(SUMMARY_KEY, next);
  } catch { /* Display-only signal; the cards file stays authoritative. */ }
}
class ActionError extends Error { constructor(code) { super(code); this.code = code; } }
// Error codes, not messages: command output never reaches the card.
export function sendAction(view, card, action, cx) {
  const bridge = view.askBridge;
  if (!bridge || view.askBusy[card.id]) return;
  view.askBusy[card.id] = true; delete view.askErrors[card.id]; cx.notify();
  cx.spawn(async cx => {
    try {
      const current = bridgeFrom(await readTextFile(`${appHome()}${ROOT}/bridge.json`).catch(() => null));
      if (JSON.stringify(current) !== JSON.stringify(bridge)) throw new ActionError('changed');
      // The bridge validates the revision too; this only avoids sending an
      // answer to a card that is already gone or was revised on disk.
      const live = parseAsks(await readTextFile(`${appHome()}${ROOT}/cards.json`).catch(() => null));
      if (!live?.cards.some(item => item.id === card.id && item.revision === card.revision)) throw new ActionError('stale');
      const id = `${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      let request;
      try { request = actionRequest(card, action, view.askChoices[card.id], id, new Date().toISOString()); } catch { throw new ActionError('incomplete'); }
      const path = requestPath(appHome(), id);
      await writeTextFile(path, JSON.stringify(request), null);
      const result = await exec(bridge.python, [bridge.script, ...bridge.args, path]);
      if (result.code !== 0 || !acceptedReceipt(result.stdout, id)) throw new ActionError('failed');
      view.asks = (view.asks ?? []).filter(item => item.id !== card.id || item.revision !== card.revision);
      view.askSent?.add(card.id);
    } catch (error) { view.askErrors[card.id] = error instanceof ActionError ? error.code : 'failed'; }
    finally { delete view.askBusy[card.id]; cx.notify(); view.refreshAsks?.(cx); }
  });
}
const stop = el => el.on_mouse_down('left', (_e, cx) => cx.stop_propagation()).on_mouse_up('left', (_e, cx) => cx.stop_propagation());
function button(id, text, color, t, action, enabled = true) {
  return stop(div().id(id).px(10).py(4).rounded(4).border(1).border_color(enabled ? color : t.border)
    .text_size(11).text_color(enabled ? color : t.dim).cursor_pointer()
    .on_click((_e, cx) => { cx.stop_propagation(); if (enabled) action(cx); }).child(text));
}
const kindLabel = (lang, kind) => (KIND_WORDS[lang] ?? KIND_WORDS.en)[kind] ?? kind;
export const hasAsks = view => Array.isArray(view.asks) && view.asks.length > 0;

// Opens one pane's cards in a popup at the pointer. Only a click opens it:
// nothing here moves pane focus, and closing it answers nothing.
export function openAskPopup(terminal, name, cards) {
  return openOverlay({mod: 'sixfold-desk', kind: 'popup', width: 560, height: popupHeight(cards?.[0]),
    props: {role: 'ask', terminal: terminal ?? null, name: name ?? ''}});
}

// The pane header's decision button: clearly coloured, with the kind and count.
export function paneAskButton(p, t, lang, name) {
  const pane = summaryFor(shared(SUMMARY_KEY), p.terminal);
  if (!pane) return null;
  const label = `${kindLabel(lang, pane.kind)}${pane.n > 1 ? ` ${pane.n}` : ''}`;
  return stop(h_flex().id(`sf-pane-ask-${p.pane}`).flex_none().h(22).px(9).rounded(4).bg(t.blocked).text_color(t.background)
    .text_size(11).font_bold().items_center().cursor_pointer()
    .tooltip(lang === 'ko' ? '이 페인의 확인 요청 열기' : 'Open this pane\'s requests')
    .on_click((_e, cx) => { cx.stop_propagation(); openAskPopup(p.terminal, name, null); })
    .child(`▲ ${label}`));
}

// Sidebar: a compact per-pane summary only. Each row opens that pane's popup,
// so every card stays reachable even when its pane is not on screen.
const GROUP_ROWS = 6;
export function askSection(view, t, lang, nameOf) {
  const words = KIND_WORDS[lang] ?? KIND_WORDS.en, more = ASK_WORDS[lang] ?? ASK_WORDS.en;
  const groups = groupAsks(view.asks), total = (view.asks ?? []).length;
  return v_flex().id('sf-asks').flex_none().px(10).py(7).gap(4).bg(t.surface).border_t(1).border_color(t.border)
    .child(h_flex().gap(5).items_center().child(div().flex_1().text_size(10).font_bold().text_color(t.muted).child(words.title))
      .child(div().text_size(10).text_color(t.blocked).child(String(total))))
    // Every group is listed in a bounded area that scrolls (about six rows
    // tall), so the sidebar stays small and no group is ever out of reach.
    .child(v_flex().id('sf-ask-groups').gap(4).max_h(GROUP_ROWS * 30).overflow_y_scrollbar().children(groups.map((group, gi) => {
      const first = group.cards[0], name = group.terminal ? nameOf(group.terminal) : more.unassigned;
      const failed = group.cards.some(card => view.askErrors?.[card.id]);
      return stop(h_flex().id(`sf-ask-group-${gi}`).flex_none().gap(5).items_center().px(6).py(3).rounded(4).bg(t.chrome).border(1)
        .border_color(failed ? t.blocked : t.border).cursor_pointer()
        .tooltip(group.cards.map(card => `${kindLabel(lang, card.kind)} · ${card.title}`).join('\n'))
        .on_click((_e, cx) => { cx.stop_propagation(); openAskPopup(group.terminal, name, group.cards); })
        .child(div().flex_none().px(4).rounded(3).bg(t.blocked).text_color(t.background).text_size(9).child(kindLabel(lang, first.kind)))
        .child(div().flex_none().max_w(110).truncate().text_size(10).text_color(t.foreground).child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(first.title))
        .when(group.cards.length > 1, e => e.child(div().flex_none().text_size(10).text_color(t.blocked).child(more.count(group.cards.length)))));
    })))
    .when(groups.length > GROUP_ROWS, e => e.child(div().text_size(9).text_color(t.muted).child(more.more(groups.length))));
}

// The popup copy reads the neutral files itself (no subscription of its own);
// the sidebar's summary version tells it when to read again.
function loadPopup(view, cx) {
  if (view.askLoading) { view.askReload = true; return; }
  const terminal = props()?.terminal ?? null;
  view.askLoading = true;
  cx.spawn(async cx => {
    try {
      do {
        view.askReload = false;
        // Recorded first, so a failed read is retried on the next summary
        // change or explicit retry, never by every render.
        view.askLoadedV = shared(SUMMARY_KEY)?.v ?? '';
        const [bridgeText, cardsText] = await Promise.all([`${appHome()}${ROOT}/bridge.json`, `${appHome()}${ROOT}/cards.json`]
          .map(path => readTextFile(path).catch(() => undefined)));
        if (bridgeText === undefined || cardsText === undefined) { view.askLoadFailed = true; continue; }
        const bridge = bridgeFrom(bridgeText), parsed = bridge ? parseAsks(cardsText) : null;
        // Only a missing bridge file hides cards. Unreadable or half-written
        // bridge or cards bytes are a failed read: keep the last valid display.
        if ((bridgeText !== null && bridge === null) || (bridge && cardsText !== null && parsed === null)) { view.askLoadFailed = true; continue; }
        const next = bridge ? cardsFor(parsed?.cards, terminal) : [];
        const result = reconcile(view.asks, next, view.askChoices, view.askSent);
        // Sticky until the person chooses again: a later re-read must not hide it.
        view.askChoices = result.choices; view.askRevised = Boolean(view.askRevised) || (view.asks !== null && result.revised);
        view.askExpired = (view.askExpired ?? 0) + (view.asks !== null ? result.expired : 0);
        for (const id of Object.keys(view.askErrors)) if (!next.some(card => card.id === id)) delete view.askErrors[id];
        view.asks = next; view.askBridge = bridge; view.askLoadFailed = false;
        view.askPage = clampPage(view.askPage, next.length);
      } while (view.askReload);
    } finally { view.askLoading = false; cx.notify(); }
  });
}
export function askPopup(view, t, lang, cx) {
  if (!view.askPopupReady) {
    view.askPopupReady = true; view.asks = null; view.askChoices = Object.create(null); view.askBusy = Object.create(null);
    view.askErrors = Object.create(null); view.askSent = new Set(); view.askPage = 0; view.askExpired = 0;
    view.refreshAsks = context => loadPopup(view, context ?? cx);
    loadPopup(view, cx);
  } else if ((shared(SUMMARY_KEY)?.v ?? '') !== view.askLoadedV && !view.askLoading) loadPopup(view, cx);
  const words = KIND_WORDS[lang] ?? KIND_WORDS.en, more = ASK_WORDS[lang] ?? ASK_WORDS.en;
  const cards = view.asks ?? [], page = clampPage(view.askPage, cards.length), card = cards[page] ?? null;
  const name = props()?.name || props()?.terminal || more.unassigned, overlay = props()?.overlay;
  const close = () => { if (overlay) closeOverlay(overlay); };
  const header = h_flex().gap(8).items_center().px(14).py(10).border_b(1).border_color(t.border)
    .when(Boolean(card), e => e.child(div().flex_none().px(6).py(1).rounded(3).bg(t.blocked).text_color(t.background).text_size(11).font_bold()
      .child(kindLabel(lang, card.kind))))
    .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(name))
    .when(cards.length > 1, e => e.child(h_flex().gap(4).items_center()
      .child(button('sf-ask-prev', '‹', t.foreground, t, cx => { view.askPage = page - 1; cx.notify(); }, page > 0))
      .child(div().text_size(11).text_color(t.muted).child(`${page + 1}/${cards.length}`))
      .child(button('sf-ask-next', '›', t.foreground, t, cx => { view.askPage = page + 1; cx.notify(); }, page < cards.length - 1))))
    .child(button('sf-ask-close', more.close, t.muted, t, () => close()));
  const notices = v_flex().gap(3).px(14)
    .when(Boolean(view.askRevised), e => e.child(div().text_size(11).text_color(t.blocked).child(more.revised)))
    .when(view.askExpired > 0, e => e.child(div().text_size(11).text_color(t.muted).child(`${more.expired}: ${view.askExpired}`)))
    .when(view.askSent.size > 0 && !card, e => e.child(div().text_size(11).text_color(t.done ?? t.accent).child(more.sent)))
    // A failed re-read keeps the last cards on screen but says so, with a retry.
    .when(view.asks !== null && Boolean(view.askLoadFailed), e => e.child(h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).text_size(11).text_color(t.blocked).child(more.refreshFailed))
      .child(button('sf-ask-reload', more.retry, t.foreground, t, cx => loadPopup(view, cx)))));
  let body;
  if (view.asks === null) body = view.askLoadFailed
    ? h_flex().gap(8).items_center().px(14).py(12).child(div().text_size(12).text_color(t.blocked).child(more.loadFailed))
      .child(button('sf-ask-retry', more.retry, t.foreground, t, cx => loadPopup(view, cx)))
    : div().px(14).py(12).text_size(12).text_color(t.muted).child(more.loading);
  else if (!card) body = div().px(14).py(12).text_size(12).text_color(t.muted).child(more.none);
  else {
    const busy = Boolean(view.askBusy[card.id]), selected = view.askChoices[card.id] ?? {}, questions = questionsOf(card), actions = actionsOf(card);
    const error = view.askErrors[card.id];
    body = v_flex().id(`sf-ask-body-${card.id}`).flex_1().min_h(0).overflow_y_scrollbar().gap(10).px(14).py(10)
      .child(div().text_size(14).text_color(t.foreground).font_bold().child(card.title))
      .when(Boolean(detailOf(card)), e => e.child(div().px(10).py(8).rounded(4).bg(t.surface).border(1).border_color(t.border)
        .text_size(12).text_color(t.foreground).child(detailOf(card))))
      .children(questions.map((q, qi) => v_flex().gap(4)
        .child(div().text_size(12).text_color(t.muted).child(q.multi ? `${q.title} (${lang === 'ko' ? '여러 개 선택' : 'choose any'})` : q.title))
        .children(q.options.map((option, oi) => {
          const on = selectionOf(selected, q.id).includes(option.id);
          return stop(h_flex().id(`sf-ask-${card.id}-q${qi}-o${oi}`).gap(8).items_start().px(10).py(6).rounded(4).border(1)
            .border_color(on ? t.accent : t.border).bg(on ? t.selected : t.background).cursor_pointer()
            .on_click((_e, cx) => {
              cx.stop_propagation(); if (busy) return;
              const choices = choose(view.askChoices[card.id], q, option.id); view.askChoices[card.id] = choices; view.askRevised = false;
              const submit = questions.length === 1 && !q.multi && complete(card, choices) && actions.find(a => a.autoSubmit);
              if (submit) sendAction(view, card, submit.id, cx); else cx.notify();
            })
            .child(div().flex_none().text_size(12).text_color(on ? t.accent : t.dim).child(q.multi ? (on ? '☑' : '☐') : (on ? '●' : '○')))
            .child(div().flex_1().min_w(0).text_size(12).text_color(busy ? t.dim : t.foreground).child(option.label)));
        }))))
      .child(h_flex().flex_wrap().gap(6).items_center().pt(2).children(actions.map((action, i) => button(`sf-ask-${card.id}-action-${i}`, action.label,
        action.primary ? t.working : t.foreground, t, cx => sendAction(view, card, action.id, cx), !busy && (!action.requiresAnswers || complete(card, selected)))))
        .when(busy, e => e.child(div().text_size(11).text_color(t.muted).child(more.sending))))
      .when(Boolean(error), e => e.child(div().px(10).py(6).rounded(4).border(1).border_color(t.blocked)
        .text_size(11).text_color(t.blocked).child(`${words.failed}: ${errorText(lang, error)}`)));
  }
  return v_flex().id('sf-ask-popup').size_full().bg(t.popover ?? t.chrome).text_color(t.foreground)
    .child(header).child(notices).child(body)
    .child(div().px(14).py(8).border_t(1).border_color(t.border).text_size(10).text_color(t.dim).child(more.closeHint));
}
