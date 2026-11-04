import { div, PathBuilder } from 'gpui-kit';
import { FLOW, borderPath, flowTargets } from './collab-flow.js';

// ⑩ The flow around a collaborating workspace's border, drawn over the box (absolute, no
// layout). Like pipeline.js: each comet is a small clipping window that slides to the next
// corner with a native linear transition, its child path moving by the inverse offset so the
// bright border piece stays on the border and rounds the corners. JavaScript only moves it
// at each corner (the sidebar's flow step); nothing runs per frame.
export function collabFlow({ id, w, h, color, step, motion }) {
  if (!motion || !(w > 0) || !(h > 0)) return null;
  const path = borderPath(PathBuilder, w, h, FLOW.radius, FLOW.stroke);
  const move = { duration: FLOW.edgeMs - 60, easing: 'linear' };
  return div().id(`sf-flow-${id}`).absolute().top(0).left(0).w(w).h(h)
    .children(flowTargets(step, w, h).map((at, k) => div().id(`sf-flow-${id}-${k}`).absolute()
      .left(at.left).top(at.top).w(FLOW.window).h(FLOW.window).overflow_hidden()
      .transition('left', move).transition('top', move)
      .child(window.paint_path(path, color).absolute().left(-at.left).top(-at.top).w(w).h(h)
        .transition('left', move).transition('top', move))));
}
