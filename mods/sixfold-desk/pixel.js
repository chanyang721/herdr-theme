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
export function pixelRoute(from, to, lane, startX, endX, color, u = 1, id = null) {
  [from, to, lane, startX, endX] = [from, to, lane, startX, endX].map(value => snap(value, u));
  const line = (id ? div().id(id) : div()).absolute().left(0).top(0);
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

// A square ring keyed for the whole flight: zero-size until `open`, then it
// opens to RING_PIXELS. `delay` holds it back, `hold` keeps it lit before it
// fades, `thickness` is its border in pixels. All native, no timer.
export function pixelRing(id, x, y, open, color, u = 1, { thickness = 1, delay = 0, hold = 0 } = {}) {
  const n = open ? RING_PIXELS : 1;
  const ring = div().id(id).absolute().left(x - centred(n, u)).top(y - centred(n, u))
    .w(open ? n * u : 0).h(open ? n * u : 0).border(thickness * u).border_color(color).opacity(open ? 0 : 1);
  for (const property of ['width', 'height', 'left', 'top']) ring.transition(property, { duration: 300, delay, easing: 'ease-out' });
  ring.transition('opacity', { duration: 460, delay: delay + hold, easing: 'ease-out' });
  return ring;
}

// A message landing (2026-11-10, user: the white square was too much): one
// small blink in the flow's own colour. The 3x3 block appears on the receiving
// end, holds a moment and fades once. Keyed like the rings: zero-size until
// `open`, so it is invisible during the flight. One native transition each.
export const LANDING = Object.freeze({ hold: 160, fade: 320 });
export function pixelLanding(id, x, y, open, color, u = 1) {
  const side = open ? PACKET_PIXELS * u : 0, offset = open ? centred(PACKET_PIXELS, u) : 0;
  const block = pixelBlock(x - offset, y - offset, side, side, color, id).opacity(open ? 0 : 1);
  for (const property of ['width', 'height', 'left', 'top']) block.transition(property, { duration: 40, easing: 'linear' });
  return block.transition('opacity', { duration: LANDING.fade, delay: LANDING.hold, easing: 'ease-out' });
}

// The arrival ("done") mark of a task event, made to be seen (2026-11-10): a 5x5 block lights
// on the receiving end, a 2px ring opens and stays lit, and a second ring opens
// a moment later, so it blinks twice. `color` should contrast with the
// background (the theme foreground). Every part is one native transition that
// starts at the single arrival phase change.
export const ARRIVAL = Object.freeze({ thickness: 2, hold: 900, second: 300, core: 5 });
export function pixelArrival(id, x, y, open, color, u = 1) {
  // Keyed like the rings: zero-size and opaque until arrival, then full size
  // at once, lit for a moment, then faded.
  const side = open ? ARRIVAL.core * u : 0, offset = open ? centred(ARRIVAL.core, u) : 0;
  const flash = pixelBlock(x - offset, y - offset, side, side, color, `${id}-core`).opacity(open ? 0 : 1);
  for (const property of ['width', 'height', 'left', 'top']) flash.transition(property, { duration: 60, easing: 'linear' });
  flash.transition('opacity', { duration: 600, delay: ARRIVAL.hold - 300, easing: 'ease-in' });
  return [
    flash,
    pixelRing(id, x, y, open, color, u, { thickness: ARRIVAL.thickness, hold: ARRIVAL.hold }),
    pixelRing(`${id}-again`, x, y, open, color, u, { thickness: ARRIVAL.thickness, delay: ARRIVAL.second, hold: ARRIVAL.hold - ARRIVAL.second }),
  ];
}
