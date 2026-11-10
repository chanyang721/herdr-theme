import { div } from 'gpui-kit';

// Event lines and packets are pixel art (2026-11-10): whole device pixels at any
// zoom, as win98's unit() does (n pixels = n / zoom layout px), square blocks only,
// stepped one-pixel corners and no tail, glow or rounding. `u` is one pixel.
export const PACKET_PIXELS = 3, RING_PIXELS = 15;
export const pixelUnitFor = zoom => 1 / (Number(zoom) || 1);
export const snap = (value, u) => Math.round(value / u) * u;
// A block or ring of n pixels centred on the 1px line at x starts this far before x.
export const centred = (n, u) => (n - 1) / 2 * u;

export function pixelBlock(x, y, w, h, color, id = null) {
  return (id ? div().id(id) : div()).absolute().left(x).top(y).w(w).h(h).bg(color);
}

// A 1px right-angle line out to `lane`, along it and back, whose corners are a
// two-step pixel staircase. Returned as one absolutely placed group of blocks.
export function pixelRoute(from, to, lane, startX, endX, color, u = 1) {
  [from, to, lane, startX, endX] = [from, to, lane, startX, endX].map(value => snap(value, u));
  const line = div().absolute().left(0).top(0);
  const across = (x1, x2, y) => line.child(pixelBlock(Math.min(x1, x2), y, Math.abs(x2 - x1) + u, u, color));
  if (Math.abs(to - from) < 4 * u) { across(startX, endX, from); return line; }
  const sign = to > from ? 1 : -1;
  across(startX, lane - 2 * u, from);
  line.child(pixelBlock(lane - u, from + sign * u, u, u, color));
  const y1 = from + sign * 2 * u, y2 = to - sign * 2 * u;
  line.child(pixelBlock(lane, Math.min(y1, y2), u, Math.abs(y2 - y1) + u, color));
  line.child(pixelBlock(lane - u, to - sign * u, u, u, color));
  across(lane - 2 * u, endX, to);
  return line;
}

// A square 1px ring keyed for the whole flight: zero-size until `open`, then it
// opens to RING_PIXELS while fading out, natively.
export function pixelRing(id, x, y, open, color, u = 1) {
  const n = open ? RING_PIXELS : 1;
  const ring = div().id(id).absolute().left(x - centred(n, u)).top(y - centred(n, u))
    .w(open ? n * u : 0).h(open ? n * u : 0).border(u).border_color(color).opacity(open ? 0 : 1);
  for (const property of ['width', 'height', 'left', 'top', 'opacity']) ring.transition(property, { duration: 460, easing: 'ease-out' });
  return ring;
}
