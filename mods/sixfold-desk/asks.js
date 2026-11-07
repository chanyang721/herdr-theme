import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { run, exec, readTextFile, writeTextFile, appHome, watchFolder } from 'herdr';
import { KIND_WORDS, bridgeFrom, parseAsks, questionsOf, actionsOf, choose, complete, actionRequest, requestPath, acceptedReceipt, detailOf, touchesCards, selectionOf } from './ask-model.js';

const ROOT = '/data/sixfold';
const SAFETY_MS = 5000;
let sequence = 0;
export function watchAsks(view, cx) {
  view.asks = null; view.askChoices = Object.create(null); view.askBusy = Object.create(null); view.askErrors = Object.create(null); view.askBridge = null;
  let loading = false, previous;
  const refresh = cx => {
    if (loading) return;
    loading = true;
    cx.spawn(async cx => {
      try {
        const directory = `${appHome()}${ROOT}`;
        const bridge = bridgeFrom(await readTextFile(`${directory}/bridge.json`).catch(() => null));
        const parsed = bridge ? parseAsks(await readTextFile(`${directory}/cards.json`).catch(() => null)) : null;
        const cards = parsed?.cards ?? null;
        view.askBridge = bridge;
        const signature = JSON.stringify([bridge, cards]);
        if (signature === previous) return;
        previous = signature;
        const live = new Set((cards ?? []).map(card => `${card.id}:${card.revision}`));
        for (const old of view.asks ?? []) if (!live.has(`${old.id}:${old.revision}`)) {
          delete view.askChoices[old.id]; delete view.askErrors[old.id];
        }
        view.asks = cards;
        cx.notify();
      } finally { loading = false; }
    });
  };
  refresh(cx); cx.timer.every(SAFETY_MS, refresh);
  cx.spawn(async cx => {
    for (;;) {
      const directory = `${appHome()}${ROOT}`;
      try { if (touchesCards(await watchFolder(directory), directory)) refresh(cx); }
      catch { await cx.sleep(2000); }
    }
  });
  view.refreshAsks = refresh;
}
export function sendAction(view, card, action, cx) {
  const bridge = view.askBridge;
  if (!bridge || view.askBusy[card.id]) return;
  view.askBusy[card.id] = true; delete view.askErrors[card.id]; cx.notify();
  cx.spawn(async cx => {
    try {
      const current = bridgeFrom(await readTextFile(`${appHome()}${ROOT}/bridge.json`).catch(() => null));
      if (JSON.stringify(current) !== JSON.stringify(bridge)) throw Error('Local connection changed; refresh the card');
      const id = `${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      const request = actionRequest(card, action, view.askChoices[card.id], id, new Date().toISOString());
      const path = requestPath(appHome(), id);
      await writeTextFile(path, JSON.stringify(request), null);
      const result = await exec(bridge.python, [bridge.script, ...bridge.args, path]);
      if (result.code !== 0 || !acceptedReceipt(result.stdout, id)) throw Error('Local action failed; refresh and try again');
      view.asks = (view.asks ?? []).filter(item => item.id !== card.id || item.revision !== card.revision);
    } catch { view.askErrors[card.id] = 'Local action failed; refresh and try again'; }
    finally { delete view.askBusy[card.id]; cx.notify(); view.refreshAsks?.(cx); }
  });
}
const stop = el => el.on_mouse_down('left', (_e, cx) => cx.stop_propagation()).on_mouse_up('left', (_e, cx) => cx.stop_propagation());
function button(id, text, color, t, action, enabled = true) {
  return stop(div().id(id).px(7).py(2).rounded(3).border(1).border_color(enabled ? color : t.border)
    .text_size(10).text_color(enabled ? color : t.dim).cursor_pointer()
    .on_click((_e, cx) => { cx.stop_propagation(); if (enabled) action(cx); }).child(text));
}
export const hasAsks = view => Array.isArray(view.asks) && view.asks.length > 0;
export function askSection(view, t, lang, nameOf) {
  const words = KIND_WORDS[lang] ?? KIND_WORDS.en, cards = view.asks ?? [];
  return v_flex().id('sf-asks').flex_none().px(10).py(9).gap(5).bg(t.surface).border_t(1).border_color(t.border)
    .child(h_flex().gap(5).items_center().child(div().flex_1().text_size(10).font_bold().text_color(t.muted).child(words.title))
      .child(div().text_size(10).text_color(t.blocked).child(String(cards.length))))
    .children(cards.slice(0, 4).map(card => {
      const busy = Boolean(view.askBusy[card.id]), selected = view.askChoices[card.id] ?? {}, questions = questionsOf(card), actions = actionsOf(card);
      return v_flex().id(`sf-ask-${card.id}`).gap(4).px(7).py(6).rounded(4).bg(t.chrome).border(1).border_color(t.blocked)
        .tooltip(`${nameOf(card.terminal)} · ${card.title}\n${detailOf(card)}`)
        .on_click(() => { if (card.terminal) run('agent.focus', {terminal: card.terminal}); })
        .child(h_flex().gap(5).items_center().child(div().flex_none().px(4).rounded(3).bg(t.blocked).text_color(t.background).text_size(9).child(words[card.kind]))
          .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.muted).child(nameOf(card.terminal))))
        .child(div().text_size(11).text_color(t.foreground).child(card.title))
        .when(Boolean(card.detail), e => e.child(div().truncate().text_size(10).text_color(t.dim).child(card.detail)))
        .children(questions.map((q, qi) => v_flex().gap(3).child(div().text_size(10).text_color(t.muted).child(q.title))
          .child(h_flex().flex_wrap().gap(4).children(q.options.map((option, oi) => {
            const on = selectionOf(selected, q.id).includes(option.id);
            return button(`sf-ask-${card.id}-q${qi}-o${oi}`, `${on ? '● ' : ''}${option.label}`, on ? t.accent : t.foreground, t, cx => {
              const choices = choose(view.askChoices[card.id], q, option.id); view.askChoices[card.id] = choices;
              const submit = questions.length === 1 && !q.multi && complete(card, choices) && actions.find(a => a.autoSubmit);
              if (submit) sendAction(view, card, submit.id, cx); else cx.notify();
            }, !busy);
          })))))
        .child(h_flex().gap(5).items_center().children(actions.map((action, i) => button(`sf-ask-${card.id}-action-${i}`, action.label,
          action.primary ? t.working : t.foreground, t, cx => sendAction(view, card, action.id, cx), !busy && (!action.requiresAnswers || complete(card, selected))))))
        .when(Boolean(view.askErrors[card.id]), e => e.child(div().text_size(10).text_color(t.blocked).child(`${words.failed}: ${view.askErrors[card.id]}`)));
    })).when(cards.length > 4, e => e.child(div().text_size(9).text_color(t.muted).child(`+${cards.length - 4}`)));
}
