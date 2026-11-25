import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { exec, writeTextFile, appHome, shared, setShared, openOverlay, closeOverlay, props, panes, spaces, focused, run } from 'herdr';
import { KIND_WORDS, ASK_WORDS, SUMMARY_KEY, bridgeFrom, parseAsks, questionsOf, actionsOf, choose, complete, actionRequest, requestPath, acceptedReceipt, detailOf, selectionOf,
  askSummary, summaryFor, unverifiedFor, summaryFromSnapshots, groupAsks, cardsFor, queueFor, pageAfter, spaceAsks, spaceAskLayout, clampPage, reconcile, popupHeight, errorText, autoPopupTarget, prunedOpened } from './ask-model.js';

import {subscribeJsonFile,readJsonSnapshot} from './panel-io.js';

const ROOT = '/data/sixfold';
let sequence = 0;
// Space tabs share these cards; their placement does not change automatic popups.
export function watchAsks(view, cx) {
  view.stopAsks?.();
  view.asks = null; view.askChoices = Object.create(null); view.askBusy = Object.create(null); view.askErrors = Object.create(null); view.askBridge = null;
  const directory=`${appHome()}${ROOT}`,inputs=[['bridge',bridgeFrom],['cards',parseAsks]];
  // failed: inputs whose latest read was not a valid file (or a confirmed absence).
  const cached=new Map(),seen=new Set(),failed=new Set(),subscriptions=[];
  let stopped=false,active=true,previous,pendingNotify=false,loading=null,version=0;
  const apply=()=>{
    if(stopped||seen.size!==inputs.length)return;
    const bridge=cached.get('bridge')??null,cards=bridge?(cached.get('cards')?.cards??null):null;
    // The pane summary says what the files say now: an unreadable input is
    // published as such rather than as the last valid counts.
    const status=failed.has('bridge')||(bridge&&failed.has('cards'))?'unreadable':cards?'ready':'missing';
    const signature=JSON.stringify([bridge,cards,status]);
    if(signature!==previous){
      previous=signature;view.askBridge=bridge;
      const live=new Set((cards??[]).map(card=>`${card.id}:${card.revision}`));
      for(const old of view.asks??[])if(!live.has(`${old.id}:${old.revision}`)){
        delete view.askChoices[old.id];delete view.askErrors[old.id];
      }
      view.asks=cards;pendingNotify=true;
      publishSummary(cards,status);
      popupElsewhere(cards,view.askNameOf);
    }
    if(pendingNotify&&active&&view.sidebarVisible!==false){pendingNotify=false;cx.notify();}
  };
  const take=(key,parse,snapshot)=>{
    if(snapshot.status==='missing'){cached.set(key,null);failed.delete(key);}
    else if(snapshot.status==='ready'&&Object.hasOwn(snapshot,'value')){
      const value=parse(snapshot.value);
      if(value!==null){cached.set(key,value);failed.delete(key);}else failed.add(key);
    }
    // A ready snapshot without a value is an unchanged file: it keeps its state.
    else if(snapshot.status!=='ready')failed.add(key);
  };
  const accept=(key,parse,snapshot)=>{
    if(stopped)return;
    seen.add(key);version++;
    take(key,parse,snapshot);
    // Invalid or failed reads keep the last valid sidebar list. Only a confirmed
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
          take(key,parse,snapshot);
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
// A card from another space opens its pane's popup right away instead of
// waiting in the sidebar list. The shown keys live in shared state so every
// sidebar copy agrees and a closed popup stays closed.
const OPENED_KEY = 'sixfold.asks.autoOpened';
function spaceOfTerminal(terminal) {
  const pane = panes().find(p => p.terminal === terminal);
  return pane ? spaces().find(space => space.tabs.some(tab => tab.id === pane.tab))?.id ?? null : null;
}
function popupElsewhere(cards, nameOf) {
  try {
    const opened = prunedOpened(shared(OPENED_KEY), cards);
    const target = autoPopupTarget(cards, opened, spaceOfTerminal, focused()?.space);
    if (!target) {
      if (JSON.stringify(opened) !== JSON.stringify(shared(OPENED_KEY) ?? [])) setShared(OPENED_KEY, opened);
      return;
    }
    setShared(OPENED_KEY, [...new Set([...opened, ...target.keys])]);
    openAskPopup(target.terminal, nameOf?.(target.terminal) ?? target.terminal, target.cards);
  } catch { /* Display-only; the sidebar list still holds every card. */ }
}

// Pane headers and the popup are other copies of this mod: they learn about
// cards only through this summary (counts per terminal and a version), never
// through the sidebar's objects. An unchanged summary is not rewritten.
function publishSummary(cards, status = 'ready') {
  try {
    const current = shared(SUMMARY_KEY) ?? null, next = askSummary(cards, status, current);
    if (JSON.stringify(current) !== JSON.stringify(next)) setShared(SUMMARY_KEY, next);
  } catch { /* Display-only signal; the cards file stays authoritative. */ }
}
// The summary is only a copy, rewritten by the sidebar watcher when a file
// change reaches it. If that delivery stalls (a hidden or reloaded sidebar
// copy) or the summary outlived its cards (shared.json persists), a header
// would keep an answered request. So a header that shows a request re-reads
// the files itself, at most every SUMMARY_CHECK_MS and only from a render,
// and corrects the shared summary when the files disagree. The write is
// compare-and-set: a summary the watcher published meanwhile wins.
const SUMMARY_CHECK_MS = 5000;
const summaryCheck = {at: 0, busy: false};
export function checkSummary(cx, now = Date.now()) {
  if (!cx?.spawn || summaryCheck.busy || now - summaryCheck.at < SUMMARY_CHECK_MS) return false;
  summaryCheck.busy = true; summaryCheck.at = now;
  const seen = JSON.stringify(shared(SUMMARY_KEY) ?? null);
  try {
    cx.spawn(async () => {
      try {
        const [b, c] = await Promise.all([snapshot('bridge'), snapshot('cards')]);
        const current = shared(SUMMARY_KEY) ?? null;
        if (JSON.stringify(current) !== seen) return;
        const next = summaryFromSnapshots(b, c, current);
        if (JSON.stringify(next) !== seen) setShared(SUMMARY_KEY, next);
      } catch { /* Display-only; the next render checks again. */ }
      finally { summaryCheck.busy = false; }
    });
  } catch { summaryCheck.busy = false; }
  return true;
}
// Every read here goes through the same typed reader (and size bound) as the
// sidebar watcher, so a card the sidebar shows is never too big to open.
const snapshot = name => readJsonSnapshot(`${appHome()}${ROOT}/${name}.json`).catch(() => ({status: 'invalid'}));
const valueOf = snap => snap?.status === 'ready' && Object.hasOwn(snap, 'value') ? snap.value : null;
class ActionError extends Error { constructor(code) { super(code); this.code = code; } }
// Error codes, not messages: command output never reaches the card.
export function sendAction(view, card, action, cx) {
  const bridge = view.askBridge;
  if (!bridge || view.askBusy[card.id]) return;
  view.askBusy[card.id] = true; delete view.askErrors[card.id]; cx.notify();
  cx.spawn(async cx => {
    try {
      const current = bridgeFrom(valueOf(await snapshot('bridge')));
      if (JSON.stringify(current) !== JSON.stringify(bridge)) throw new ActionError('changed');
      // The bridge validates the revision too; this only avoids sending an
      // answer to a card that is already gone or was revised on disk.
      const live = parseAsks(valueOf(await snapshot('cards')));
      if (!live?.cards.some(item => item.id === card.id && item.revision === card.revision
        && (item.terminal ?? null) === (card.terminal ?? null))) throw new ActionError('stale');
      const id = `${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      let request;
      try { request = actionRequest(card, action, view.askChoices[card.id], id, new Date().toISOString()); } catch { throw new ActionError('incomplete'); }
      const path = requestPath(appHome(), id);
      await writeTextFile(path, JSON.stringify(request), null);
      const result = await exec(bridge.python, [bridge.script, ...bridge.args, path]);
      if (result.code !== 0 || !acceptedReceipt(result.stdout, id)) throw new ActionError('failed');
      view.asks = (view.asks ?? []).filter(item => item.id !== card.id || item.revision !== card.revision);
      view.askPage = 0;   // one answer, then the oldest request left
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

// Opens one pane's cards in a popup at the pointer, or with `queue` {terminals, names}
// every card of those panes, oldest first (a space tab). Only a click opens it:
// nothing here moves pane focus, and closing it answers nothing.
export function openAskPopup(terminal, name, cards, queue = null) {
  const own = {role: 'ask', terminal: terminal ?? null, name: name ?? ''};
  if (queue && Array.isArray(queue.terminals)) {
    own.terminals = queue.terminals.map(t => t ?? null);
    own.names = Object.fromEntries(Object.entries(queue.names ?? {}).filter(([, v]) => typeof v === 'string'));
  }
  return openOverlay({mod: 'sixfold-desk', kind: 'popup', width: 560, height: popupHeight(cards?.[0]), props: own});
}
// Only on the person's click: select the pane's tab, then the pane. Returns false when the pane is gone.
export function goToPane(terminal) {
  const pane = terminal ? panes().find(p => p.terminal === terminal) : null;
  if (!pane) return false;
  if (pane.tab) run('tab.select', {id: pane.tab});
  run('pane.focus', {pane: pane.pane});
  return true;
}

// The pane header's decision button: clearly coloured, with the kind and count.
// `cx` (the header's render context) lets a shown button confirm itself
// against the cards file; without it the shared summary is drawn as is.
export function paneAskButton(p, t, lang, name, cx = null) {
  const summary = shared(SUMMARY_KEY), pane = summaryFor(summary, p.terminal);
  const unknown = !pane && unverifiedFor(summary, p.terminal);
  if (!pane && !unknown) return null;
  checkSummary(cx);
  // The cards file could not be read: say so, never the last count.
  if (unknown) return stop(h_flex().id(`sf-pane-ask-${p.pane}`).flex_none().h(22).px(9).rounded(4).border(1).border_color(t.blocked)
    .bg(t.chrome).text_color(t.muted).text_size(11).items_center().cursor_pointer()
    .tooltip(lang === 'ko' ? '확인 요청 파일을 읽지 못했습니다 — 눌러서 다시 읽기' : 'Could not read the requests file — click to read again')
    .on_click((_e, cx) => { cx.stop_propagation(); openAskPopup(p.terminal, name, null); })
    .child(lang === 'ko' ? '▲ 확인 불가' : '▲ Unconfirmed'));
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
        .tooltip(group.cards.map(card => `${kindLabel(lang, card.kind)} · ${card.title}${card.answerable === false ? ` (${more.paneOnly})` : ''}`).join('\n'))
        .on_click((_e, cx) => { cx.stop_propagation(); openAskPopup(group.terminal, name, group.cards); })
        .child(div().flex_none().px(4).rounded(3).bg(t.blocked).text_color(t.background).text_size(9).child(kindLabel(lang, first.kind)))
        .child(div().flex_none().max_w(110).truncate().text_size(10).text_color(t.foreground).child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(first.title))
        .when(group.cards.length > 1, e => e.child(div().flex_none().text_size(10).text_color(t.blocked).child(more.count(group.cards.length)))));
    })))
    .when(groups.length > GROUP_ROWS, e => e.child(div().text_size(9).text_color(t.muted).child(more.more(groups.length))));
}

// Mount beside a measured space card in a parent that contains its right
// gutter. Feed IDs are comparison keys only. onOpen receives display metadata;
// the caller resolves a verified target and opens the existing response UI.
// No click, dismissal or disappearance here sends a response.
export function spaceAskView(requests, space, t, lang, {bounds, onOpen, panes = 1} = {}) {
  const cards = spaceAsks(requests, space), layout = spaceAskLayout(bounds);
  if (!cards.length || !layout) return null;
  const ko = lang === 'ko', canOpen = typeof onOpen === 'function';
  const label = ko ? '확인 대기' : 'Waiting';
  const kind = cards[0].kind && cards.every(card => card.kind === cards[0].kind) ? kindLabel(lang, cards[0].kind) : (ko ? '요청' : 'Ask');
  const preview = cards.slice(0, 8).map(card => (card.title || kindLabel(lang, card.kind) || label) + (card.answerable === false ? (ko ? ' · 페인에서' : ' · in pane') : ''));
  if (cards.length > 8) preview.push(ko ? `외 ${cards.length - 8}건` : `+${cards.length - 8} more`);
  if (panes > 1) preview.push(ko ? `${panes}개 페인 · 오래된 요청부터 하나씩` : `${panes} panes · oldest request first, one at a time`);
  const inPane = cards.filter(card => card.answerable === false).length;
  if (inPane) preview.push(ko ? `${inPane}건은 페인에서 직접 답하기` : `${inPane} to answer in the pane`);
  let tab = stop(v_flex().id(`sf-space-ask-${space}`).absolute().left(layout.left).top(layout.top)
    .w(layout.width).h(layout.height).overflow_hidden().items_center().justify_center().gap(5)
    .px(2).border(1).border_l(3).border_color(t.blocked).rounded(5).bg(t.chrome).text_color(t.blocked)
    .tooltip(`${label} · ${cards.length}\n${preview.join('\n')}`)
    .child(div().flex_none().text_size(12).font_bold().child('◆'))
    .child(div().flex_none().max_w(37).truncate().text_size(9).font_bold().child(kind))
    .child(div().flex_none().text_size(10).font_bold().child(ko ? '확인' : 'Wait'))
    .when(ko, el => el.child(div().flex_none().text_size(10).font_bold().child('대기')))
    .child(div().flex_none().text_size(11).font_bold().child(String(cards.length))))
    .on_click((_event, cx) => { cx.stop_propagation(); if (canOpen) onOpen(cards, cx); });
  if (canOpen) tab = tab.cursor_pointer();
  return tab;
}

// The popup copy reads the neutral files itself (no subscription of its own);
// the sidebar's summary version tells it when to read again.
function loadPopup(view, cx) {
  if (view.askLoading) { view.askReload = true; return; }
  const terminal = props()?.terminal ?? null, terminals = Array.isArray(props()?.terminals) ? props().terminals : null;
  view.askLoading = true;
  cx.spawn(async cx => {
    try {
      do {
        view.askReload = false;
        // Recorded first, so a failed read is retried on the next summary
        // change or explicit retry, never by every render.
        view.askLoadedV = shared(SUMMARY_KEY)?.v ?? '';
        const [b, c] = await Promise.all([snapshot('bridge'), snapshot('cards')]);
        const bridge = b.status === 'ready' ? bridgeFrom(valueOf(b)) : null;
        const parsed = bridge && c.status === 'ready' ? parseAsks(valueOf(c)) : null;
        // Only a missing bridge file hides cards. Unreadable, oversized or
        // half-written bridge or cards files are a failed read: keep the last
        // valid display and offer a retry.
        if (![b, c].every(x => x.status === 'missing' || x.status === 'ready') || (b.status === 'ready' && !bridge)
          || (bridge && c.status === 'ready' && parsed === null)) { view.askLoadFailed = true; continue; }
        const next = bridge ? (terminals ? queueFor(parsed?.cards, terminals) : cardsFor(parsed?.cards, terminal)) : [];
        // A card that vanished after a send we could not confirm is not an
        // expiry: keep saying the outcome is unconfirmed.
        const unconfirmed = Object.keys(view.askErrors).filter(id => !next.some(card => card.id === id));
        for (const id of unconfirmed) view.askUnconfirmed.push((view.asks ?? []).find(card => card.id === id)?.title ?? id);
        const result = reconcile(view.asks, next, view.askChoices, new Set([...view.askSent, ...unconfirmed]));
        // Sticky until the person chooses again: a later re-read must not hide it.
        view.askChoices = result.choices; view.askRevised = Boolean(view.askRevised) || (view.asks !== null && result.revised);
        view.askExpired = (view.askExpired ?? 0) + (view.asks !== null ? result.expired : 0);
        for (const id of Object.keys(view.askErrors)) if (!next.some(card => card.id === id)) delete view.askErrors[id];
        // The card on screen stays while it is open; once it is gone the oldest one shows.
        view.askPage = view.asks === null ? 0 : pageAfter(view.asks, view.askPage, next);
        view.asks = next; view.askBridge = bridge; view.askLoadFailed = false;
        view.askPage = clampPage(view.askPage, next.length);
      } while (view.askReload);
    } finally { view.askLoading = false; cx.notify(); }
  });
}
export function askPopup(view, t, lang, cx) {
  if (!view.askPopupReady) {
    view.askPopupReady = true; view.asks = null; view.askChoices = Object.create(null); view.askBusy = Object.create(null);
    view.askErrors = Object.create(null); view.askSent = new Set(); view.askUnconfirmed = []; view.askPage = 0; view.askExpired = 0;
    view.refreshAsks = context => loadPopup(view, context ?? cx);
    loadPopup(view, cx);
  } else if ((shared(SUMMARY_KEY)?.v ?? '') !== view.askLoadedV && !view.askLoading) loadPopup(view, cx);
  const words = KIND_WORDS[lang] ?? KIND_WORDS.en, more = ASK_WORDS[lang] ?? ASK_WORDS.en;
  const cards = view.asks ?? [], page = clampPage(view.askPage, cards.length), card = cards[page] ?? null;
  const names = props()?.names ?? {}, queued = Array.isArray(props()?.terminals);
  const paneName = card && queued ? (names[card.terminal ?? ''] || card.terminal || more.unassigned) : null;
  const name = [props()?.name || props()?.terminal || more.unassigned, paneName].filter(Boolean).join(' · '), overlay = props()?.overlay;
  const close = () => { if (overlay) closeOverlay(overlay); };
  const header = h_flex().gap(8).items_center().px(14).py(10).border_b(1).border_color(t.border)
    .when(Boolean(card), e => e.child(div().flex_none().px(6).py(1).rounded(3).bg(t.blocked).text_color(t.background).text_size(11).font_bold()
      .child(kindLabel(lang, card.kind))))
    .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(name))
    .when(cards.length > 1, e => e.child(h_flex().gap(4).items_center()
      .child(button('sf-ask-prev', '‹', t.foreground, t, cx => { view.askPage = page - 1; cx.notify(); }, page > 0))
      .child(div().text_size(11).text_color(t.muted).child(more.queue ? more.queue(page + 1, cards.length) : `${page + 1}/${cards.length}`))
      .child(button('sf-ask-next', '›', t.foreground, t, cx => { view.askPage = page + 1; cx.notify(); }, page < cards.length - 1))))
    .child(button('sf-ask-close', more.close, t.muted, t, () => close()));
  const notices = v_flex().gap(3).px(14)
    .when(Boolean(view.askRevised), e => e.child(div().text_size(11).text_color(t.blocked).child(more.revised)))
    .when(view.askExpired > 0, e => e.child(div().text_size(11).text_color(t.muted).child(`${more.expired}: ${view.askExpired}`)))
    .children(view.askUnconfirmed.map((title, i) => div().id(`sf-ask-unconfirmed-${i}`).text_size(11).text_color(t.blocked).child(`${more.unconfirmed}: ${title}`)))
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
    // overflow_y_scroll, not ..._scrollbar: the popup sizes to its content, and the
    // scrollbar variant collapses this body to zero height there (seen in a real render).
    body = v_flex().id(`sf-ask-body-${card.id}`).flex_1().min_h(0).overflow_y_scroll().gap(10).px(14).py(10)
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
      // Display only: the request waits in its own pane. The person may go there; nothing answers here.
      .when(card.answerable === false, e => e.child(v_flex().id(`sf-ask-in-pane-${card.id}`).gap(6).px(10).py(8).rounded(4).border(1).border_color(t.blocked)
        .child(div().text_size(12).text_color(t.blocked).child(more.inPane))
        .when(Boolean(card.terminal && panes().some(p => p.terminal === card.terminal)), row => row.child(h_flex().child(
          button(`sf-ask-go-${card.id}`, more.goPane, t.working, t, () => { if (goToPane(card.terminal)) close(); }))))))
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
