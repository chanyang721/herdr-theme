// Diagram figures in the document body and the zoom viewer over the 문서 pane. Pure
// description: handlers come from the view, geometry from zoom.js; theme tokens only.
import { div, image } from 'gpui-kit';
import { v_flex, h_flex, TextView } from 'gpui-base';
import { percent, SHARP_SCALE } from './zoom.js';

// Where on an element an event landed, as fractions of its size (unit-free, so the app's UI
// zoom does not matter). Falls back to the centre.
export function fraction(event) {
  const b = event?.bounds, p = event?.local_position;
  if (!b?.width || !b?.height || !p) return { u: 0.5, v: 0.5 };
  return { u: Math.min(1, Math.max(0, p.x / b.width)), v: Math.min(1, Math.max(0, p.y / b.height)) };
}

// An event's point inside its element, in layout pixels (`unit` divides out the UI zoom).
export function localPoint(event, unit = 1) {
  const p = event?.local_position || (event?.position && event?.bounds ? { x: event.position.x - event.bounds.x, y: event.position.y - event.bounds.y } : null);
  return p ? { x: p.x / unit, y: p.y / unit } : null;
}

const chip = (id, label, t, action, { accent = false, tip = null } = {}) => div().id(id).flex_none().px(8).py(2).rounded(4)
  .cursor_pointer().text_size(11).text_color(accent ? t.foreground : t.muted).bg(accent ? t.selected : t.canvas)
  .border(1).border_color(accent ? t.accent : t.border).hover(s => s.bg(t.hover))
  .accessibility_label(tip || label).when(Boolean(tip), el => el.tooltip(tip)).on_click((_e, cx) => action(cx)).child(label);

// A picture in the body at most `width` wide, with a caption that always shows how to enlarge
// it (keyboard and VoiceOver users never depend on hovering). Double-click or a pinch over the
// picture opens the viewer; diagrams can show their Mermaid source as selectable text.
export function figure({ id, block, width, t, codeOpen = false, onOpen, onPinch, onToggleCode }) {
  const media = block.media;
  const shown = Math.min(media.width, Math.max(1, width));
  const scale = shown / media.width;
  const shrunk = scale < 0.98;
  const zoomable = shrunk || Boolean(block.code);
  const root = v_flex().id(id).flex_none().w(shown).min_w(0).gap(4);
  root.child(div().id(`${id}-picture`).flex_none().w(shown).h(shown * media.height / media.width)
    .when(zoomable, el => el.tooltip('더블클릭·핀치로 크게 보기')
      .on_mouse_down('left', (event, cx) => { if (event.click_count === 2) { cx.stop_propagation(); onOpen(fraction(event), null, cx); } })
      .on_pinch((event, cx) => onPinch(event, scale, cx)))
    .child(image(media.path).size_full()));
  if (!zoomable) return root;
  root.child(h_flex().id(`${id}-caption`).flex_none().flex_wrap().gap(6).items_center().text_size(11).text_color(t.muted)
    .when(shrunk, el => el.child(div().flex_none().child(`축소 표시 ${percent(scale)}`)))
    .child(chip(`${id}-zoom`, '⤢ 크게 보기', t, cx => onOpen({ u: 0.5, v: 0.5 }, null, cx), { accent: shrunk && scale < 0.5, tip: '크게 보기 (더블클릭·핀치)' }))
    .when(Boolean(block.code), el => el.child(chip(`${id}-code-toggle`, codeOpen ? '코드 숨기기' : '코드 보기', t, cx => onToggleCode(cx),
      { tip: 'Mermaid 원문 — 노드 이름 복사·찾기' }))));
  if (codeOpen && block.code) root.child(TextView.markdown(`${id}-code`, '```mermaid\n' + block.code + '\n```').selectable(true).scrollable(false)
    .w_full().flex_none().text_size(12).text_color(t.foreground));
  return root;
}

// The viewer that covers the 문서 pane: a toolbar, the picture in a clipped viewport and a hint
// line. Every pointer event it handles stops there, so the body underneath neither scrolls
// nor selects; the body stays mounted, keeping its scroll position for when the viewer closes.
export function viewer({ zoom, t, title, focus, unit = 1, onKey, onCommand, onClose, onPreview, onViewport, onWheel, onPinch, onDrag, onDouble }) {
  const view = zoom.view, media = zoom.media;
  const stop = (_e, cx) => cx.stop_propagation();
  const tool = (id, label, tip, action) => div().id(id).flex_none().px(8).py(4).rounded(5).cursor_pointer().text_size(12)
    .hover(s => s.bg(t.hover)).tooltip(tip).accessibility_label(tip).on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(label);
  const soft = view && view.scale > SHARP_SCALE + 0.005;
  const root = v_flex().id('docs-zoom').absolute().inset_0().bg(t.canvas).text_color(t.foreground)
    .when(Boolean(focus), el => el.track_focus(focus))
    .on_key_down((event, cx) => onKey(event, cx))
    .on_mouse_down('left', stop).on_mouse_up('left', stop).on_scroll_wheel(stop)
    .child(h_flex().id('docs-zoom-bar').h(36).flex_none().px(8).gap(2).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().tooltip(title).child(title))
      .child(tool('docs-zoom-out', '−', '축소 (⌘−)', cx => onCommand('out', cx)))
      .child(div().id('docs-zoom-scale').flex_none().min_w(44).text_size(12).text_color(soft ? t.muted : t.foreground)
        .tooltip(soft ? '원본 해상도보다 크게 표시 중이라 흐릴 수 있습니다' : '현재 배율').child(view ? `${percent(view.scale)}${soft ? ' · 흐림' : ''}` : '…'))
      .child(tool('docs-zoom-in', '+', '확대 (⌘+)', cx => onCommand('in', cx)))
      .child(tool('docs-zoom-fit', '맞춤', '화면에 맞춤 (⌘9)', cx => onCommand('fit', cx)))
      .child(tool('docs-zoom-actual', '100%', '실제 크기 (⌘0)', cx => onCommand('actual', cx)))
      .when(Boolean(onPreview), el => el.child(tool('docs-zoom-preview', '미리보기', '미리보기 앱에서 열기', cx => onPreview(cx))))
      .child(tool('docs-zoom-close', '✕', '닫기 (Esc)', cx => onClose(cx))));
  const port = div().id('docs-zoom-viewport').relative().flex_1().min_h(0).w_full().overflow_hidden()
    .when(Boolean(zoom.drag), el => el.cursor_grabbing()).when(!zoom.drag, el => el.cursor_grab())
    .on_size_change((size, cx) => onViewport({ width: size.width / unit, height: size.height / unit }, cx))
    .on_scroll_wheel((event, cx) => { cx.stop_propagation(); onWheel(event, localPoint(event, unit), cx); })
    .on_pinch((event, cx) => { cx.stop_propagation(); onPinch(event, localPoint(event, unit), cx); })
    .on_mouse_down('left', (event, cx) => {
      cx.stop_propagation(); focus?.focus?.();
      if (event.click_count === 2) onDouble(localPoint(event, unit), cx);
      else onDrag('start', { x: event.position.x / unit, y: event.position.y / unit }, cx);
    })
    .on_mouse_move((event, cx) => { if (zoom.drag) onDrag('move', { x: event.position.x / unit, y: event.position.y / unit }, cx); })
    .on_mouse_up('left', (_event, cx) => { cx.stop_propagation(); onDrag('end', null, cx); })
    .on_hover((hovered, cx) => { if (!hovered && zoom.drag) onDrag('end', null, cx); });
  if (view) port.child(image(media.path).absolute().left(view.x).top(view.y).w(media.width * view.scale).h(media.height * view.scale));
  return root.child(port)
    .child(div().flex_none().px(12).py(4).border_t(1).border_color(t.border).bg(t.chrome).text_size(11).text_color(t.muted).truncate()
      .child('핀치·⌘스크롤로 확대 · 드래그·스크롤로 이동 · 더블클릭 맞춤↔100% · ⌘9 맞춤 · ⌘0 실제 크기 · Esc 닫기'));
}
