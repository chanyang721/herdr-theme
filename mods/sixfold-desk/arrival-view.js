import { div, image } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { PACKET_PIXELS, centred, pixelBlock, pixelLanding } from './pixel.js';
import { ARRIVAL, arrivalPhase, visibleArrivals, justLanded, flightPath, flightStep } from './arrival-model.js';
import { projectKey, linearCategory } from './alert-model.js';

// New-alert arrivals drawn over the workspace list (absolutely placed, so the
// cards never move): a small popup on the card's own spot for ARRIVAL.showMs,
// then a 3x3 pixel block steps from the popup into the card's alert badge in
// ARRIVAL.steps integer moves (one finite native transition each, like the
// message packets) and the badge blinks once as it lands. Pressing the popup
// opens that space's inbox. Nothing here takes focus or opens a window by itself.
export const POPUP = Object.freeze({h: 50, gap: 4});

// `anchors(space)` -> {top, badgeX, badgeY, left, right} in the list's
// coordinates, or null when that card is not on screen.
export function arrivalLayer({list, now, motion, anchors, t, u = 1, onOpen}) {
  const layer = [];
  if (!motion) return layer;
  const stack = new Map();
  for (const a of visibleArrivals(list, now, motion)) {
    const anchor = anchors(a.space, a.source);
    const key = projectKey(a.space), index = stack.get(key) ?? 0;
    stack.set(key, index + 1);
    const phase = arrivalPhase(a, now, motion);
    const top = Math.max(0, (anchor ? anchor.badgeY - 13 : 0) - (index + 1) * (POPUP.h + POPUP.gap));
    const left = anchor?.left ?? 11, right = anchor?.right ?? 11;
    const tone = a.source === 'linear' ? (t.ansi4 || t.accent) : (t.ansi5 || t.accent);
    layer.push(v_flex().id(`sf-arrival-${a.key}`).absolute().top(top).left(left).right(right).h(POPUP.h).px(8).py(6).gap(2)
      .rounded(6).border(1).border_color(tone).bg(t.popover || t.surface).cursor_pointer()
      .opacity(phase === 'show' ? 1 : 0).transition('opacity', {duration: 160, easing: 'ease-out'})
      .tooltip('누르면 이 공간 알림함을 엽니다')
      .on_mouse_down('left', (_e, cx) => cx.stop_propagation()).on_mouse_up('left', (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onOpen(a); })
      .child(h_flex().gap(5).items_center()
        .child(image(`mods/sixfold-desk/icons/${a.source === 'linear' ? 'linear' : 'slack'}.svg`).size(12).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_size(11).font_bold().text_color(t.foreground)
          .child(`${a.space} · ${a.source === 'linear' ? 'Linear' : 'Slack'}${a.source === 'linear' ? ` ${linearCategory(a)}` : ' 멘션'}`)))
      .child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(`${a.issue ? `${a.issue} ` : ''}${a.title || ''}`)));
    if (!anchor) continue;
    // The block waits invisibly on the popup, then steps in; keyed for the whole flight.
    const from = {x: left + 12, y: top + POPUP.h - 6}, to = {x: anchor.badgeX, y: anchor.badgeY};
    const path = flightPath(from, to), side = PACKET_PIXELS * u, offset = centred(PACKET_PIXELS, u);
    const at = phase === 'fly' ? path[Math.min(path.length - 1, flightStep(a, now))] : from;
    const ms = ARRIVAL.flyMs / ARRIVAL.steps;
    layer.push(pixelBlock(at.x - offset, at.y - offset, side, side, tone, `sf-arrival-block-${a.key}`).opacity(phase === 'fly' ? 1 : 0)
      .transition('left', {duration: ms, easing: 'linear'}).transition('top', {duration: ms, easing: 'linear'}));
    layer.push(pixelLanding(`sf-arrival-land-${a.key}`, to.x, to.y, false, tone, u));
  }
  for (const a of justLanded(list, now, motion)) {
    const anchor = anchors(a.space, a.source);
    if (!anchor) continue;
    const tone = a.source === 'linear' ? (t.ansi4 || t.accent) : (t.ansi5 || t.accent);
    layer.push(pixelLanding(`sf-arrival-land-${a.key}`, anchor.badgeX, anchor.badgeY, true, tone, u));
  }
  return layer;
}
