import { div, PathBuilder } from 'gpui-kit';
import { FLOW, borderPath, cometTarget } from './collab-flow.js';

// ⑪ The collaborating box's border, drawn over the box (absolute: nothing moves or reflows).
// Removing these layers from the render stops their loop/transition natively.

// D: the group-coloured 2px border, drawn still: a forever opacity loop kept GPUI
// redrawing the window every frame. `period` and `motion` stay for the caller's grouping.
export function breathingBorder({ id, color, dim }) {
  const ring = div().id(`sf-breath-${id}`).absolute().top(-1).left(-1).right(-1).bottom(-1).rounded(7).border(2).border_color(color);
  return dim ? ring.opacity(FLOW.track) : ring;         // dim: a comet runs on it, the faint track
}

// F: a comet around the border, like pipeline.js — each stage is a small clipping window that
// slides to the next corner with a native linear transition while its child path moves by the
// inverse offset, so the bright piece stays on the border and rounds the corners. The tail is
// the same window delayed and fainter. JavaScript only moves it on at each corner.
export function borderComet({ id, start = 0, w, h, color, step, motion }) {
  if (!motion || !(w > 0) || !(h > 0)) return null;
  const path = borderPath(PathBuilder, w, h, FLOW.radius, FLOW.stroke);
  const at = cometTarget(step, w, h);
  const key = `${id}-${start}`;
  return div().id(`sf-comet-${key}`).absolute().top(0).left(0).w(w).h(h).opacity(step === 0 ? 0 : 1)
    .children(FLOW.tail.map(([delay, opacity], k) => {
      const move = { duration: FLOW.edgeMs - 40, delay, easing: 'linear' };
      return div().id(`sf-comet-${key}-${k}`).absolute().left(at.left).top(at.top).w(FLOW.window).h(FLOW.window)
        .overflow_hidden().opacity(opacity).transition('left', move).transition('top', move)
        .child(window.paint_path(path, color).absolute().left(-at.left).top(-at.top).w(w).h(h)
          .transition('left', move).transition('top', move));
    }));
}
