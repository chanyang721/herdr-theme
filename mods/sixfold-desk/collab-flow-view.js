import { div, PathBuilder } from 'gpui-kit';
import { FLOW, BREATH, borderPath, cometTarget } from './collab-flow.js';

// ⑪ The collaborating box's border, drawn over the box (absolute: nothing moves or reflows).
// Removing these layers from the render stops their loop/transition natively.

// D: the group-coloured 2px border breathing (native opacity loop). Static without motion.
export function breathingBorder({ id, color, period, motion, dim }) {
  const ring = div().id(`sf-breath-${id}`).absolute().top(-1).left(-1).right(-1).bottom(-1).rounded(7).border(2).border_color(color);
  if (dim) return ring.opacity(FLOW.track);             // a comet runs on it: the faint track
  return motion ? ring.loop('opacity', { from: BREATH.from, to: BREATH.to, period, easing: 'ease-in-out' }) : ring;
}

// F: a comet around the border, like pipeline.js — each stage is a small clipping window that
// slides to the next corner with a native linear transition while its child path moves by the
// inverse offset, so the bright piece stays on the border and rounds the corners. The tail is
// the same window delayed and fainter. JavaScript only moves it on at each corner.
export function borderComet({ id, w, h, color, step, motion }) {
  if (!motion || !(w > 0) || !(h > 0)) return null;
  const path = borderPath(PathBuilder, w, h, FLOW.radius, FLOW.stroke);
  const at = cometTarget(step, w, h);
  return div().id(`sf-comet-${id}`).absolute().top(0).left(0).w(w).h(h)
    .children(FLOW.tail.map(([delay, opacity], k) => {
      const move = { duration: FLOW.edgeMs - 40, delay, easing: 'linear' };
      return div().id(`sf-comet-${id}-${k}`).absolute().left(at.left).top(at.top).w(FLOW.window).h(FLOW.window)
        .overflow_hidden().opacity(opacity).transition('left', move).transition('top', move)
        .child(window.paint_path(path, color).absolute().left(-at.left).top(-at.top).w(w).h(h)
          .transition('left', move).transition('top', move));
    }));
}
