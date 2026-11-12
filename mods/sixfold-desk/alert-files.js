import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { readTextFile, appHome } from 'herdr';
import { attachments, fileTextPath, fileTextShown } from './alert-slack.js';

// The attachments of a Slack alert, one chip each under its text: kind mark, name, kind · size, and
// two buttons. 본문 보기 shows the collector's local text copy (data/sixfold/slack-files/<id>.txt) or
// '본문 준비 중' while there is none; 다운로드 hands the Slack link to the default browser. Both act
// only on a press. Nothing here writes to Slack.
const texts = new Map();   // file id -> {state: 'loading'|'ready'|'pending', text}
export const fileText = id => texts.get(id) ?? null;
export async function loadFileText(id, {read = readTextFile, home = appHome()} = {}) {
  const path = fileTextPath(home, id);
  if (!path) { texts.set(id, {state: 'pending'}); return texts.get(id); }
  if (!texts.has(id)) texts.set(id, {state: 'loading'});
  const text = await read(path).catch(() => null);
  texts.set(id, typeof text === 'string' && text.trim() ? {state: 'ready', text: fileTextShown(text)} : {state: 'pending'});
  return texts.get(id);
}
const tone = (kind, t) => ({PDF: t.blocked, 이미지: t.ansi5, 동영상: t.ansi5, 표: t.ansi2, 슬라이드: t.ansi3, 문서: t.ansi4, 압축: t.dim, 코드: t.ansi6, 텍스트: t.muted}[kind] || t.muted) || t.accent;

// `open`: the key (`<alert id>|<file id>`) of the chip whose text is showing. `onView(key, file)` and
// `onDownload(file)` are left out where the surface is read-only (the arrival peek).
export const fileKey = (item, file) => `${item?.id}|${file.id}`;
export function fileChips(item, t, {id, open = null, onView = null, onDownload = null} = {}) {
  const files = attachments(item);
  if (!files.length) return null;
  const stop = (_e, cx) => cx.stop_propagation();
  const button = (key, label, action) => div().id(key).flex_none().px(6).py(2).rounded(4).text_size(10).font_semibold()
    .bg(t.chrome).text_color(t.accent).hover(s => s.bg(t.hover)).cursor_pointer()
    .on_mouse_down('left', stop).on_click((e, cx) => { cx.stop_propagation(); action(e, cx); }).child(label);
  return v_flex().id(`${id}-files`).gap(4).children(files.map((file, i) => {
    const key = fileKey(item, file), shown = open === key, text = shown ? fileText(file.id) : null;
    return v_flex().id(`${id}-file-${i}`).gap(4)
      .child(h_flex().id(`${id}-file-chip-${i}`).h(26).px(6).gap(6).items_center().rounded(5).border(1).border_color(shown ? t.accent : t.border).bg(t.surface)
        .child(div().flex_none().w(30).h(16).rounded(3).bg(tone(file.kind, t)).text_color(t.accent_foreground || t.background)
          .text_size(9).font_bold().flex().items_center().justify_center().child(file.ext))
        .child(div().id(`${id}-file-name-${i}`).min_w(0).flex_1().truncate().text_size(11).text_color(t.foreground).tooltip(file.name).child(file.name))
        .child(div().flex_none().text_size(10).text_color(t.dim).child([file.kind, file.size].filter(Boolean).join(' · ')))
        .when(Boolean(onView), e => e.child(button(`${id}-file-view-${i}`, shown ? '본문 닫기' : '본문 보기', (_e, cx) => onView(shown ? null : key, file, cx))))
        .when(Boolean(onDownload && file.link), e => e.child(button(`${id}-file-download-${i}`, '다운로드', (_e, cx) => onDownload(file, cx)))))
      .when(shown, e => e.child(v_flex().id(`${id}-file-text-${i}`).max_h(220).overflow_y_scroll().p(8).gap(4).rounded(6)
        .border(1).border_color(t.border).bg(t.popover || t.chrome)
        .child(div().min_w(0).truncate().text_size(10).text_color(t.dim).child(`${file.name} · 본문`))
        .child(div().text_size(11).text_color(text?.state === 'ready' ? t.foreground : t.muted)
          .child(text?.state === 'ready' ? text.text : text?.state === 'loading' ? '본문 읽는 중' : '본문 준비 중'))));
  }));
}
