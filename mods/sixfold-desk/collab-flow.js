// ⑩ shared work, pure parts: one colour per collaborating group, and the corner-stepped
// flow around a collaborating workspace's border. No host imports, so tests load it directly.
// Sizes, speed and colours are the knobs a confirmed mockup may change (FLOW, GROUP_COLORS).

// Index 0 is ⑨'s collaboration colour; the same index is the same hue family in both modes
// (0 periwinkle, 1 violet, 2 rose, 3 azure, 4 lilac/plum). Lightness steps at least ~4.4 L*
// apart so groups differ by lightness too, not hue alone. Every colour is at least 4.5:1 on the
// sidebar backgrounds (canvas, chrome, selected, a 10% tint) and far from the amber needs-you.
export const GROUP_COLORS = {
  dark: ['#A9B8FF', '#BBA0F6', '#FFB0DC', '#AADDFF', '#E9E1FF'],
  light: ['#3346B8', '#402E77', '#A33177', '#004C73', '#4B2147'],
};

// The flow: a short bright piece of the border (a "comet") seen through a small window that
// slides from corner to corner with a native transition; the sidebar steps it at each corner.
export const FLOW = { edgeMs: 1100, window: 22, stroke: 3, radius: 6, comets: 2 };

const hex = value => /^#([0-9a-f]{6})/i.exec(String(value ?? '').trim())?.[1] ?? null;
const channel = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function luminance(color) {
  const h = hex(color);
  if (!h) return null;
  const [r, g, b] = [0, 2, 4].map(i => channel(parseInt(h.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// WCAG contrast ratio of two colours (1–21).
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// The sidebar's palette mode, read from the theme's background as ⑨'s collabColor does.
export function paletteMode(t) {
  const lum = luminance(t?.background ?? t?.chrome);
  return lum !== null && lum > 0.214 ? 'light' : 'dark';   // 0.214 ≈ sRGB 0.5 grey
}

export const groupKey = name => String(name ?? '').normalize('NFC').trim().toLowerCase();

// FNV-1a: the same project name gets the same preferred slot after every restart.
export function hashName(name) {
  let h = 0x811c9dc5;
  for (const ch of groupKey(name)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

// group key -> colour for the groups shown now. One group keeps ⑨'s colour; with two or more
// each takes its preferred slot, and collisions move to the next free slot in name order, so
// the result depends only on the set of names (stable across restarts and reorders).
export function groupColors(names, mode = 'dark') {
  const list = GROUP_COLORS[mode] ?? GROUP_COLORS.dark;
  const keys = [...new Set(names.map(groupKey).filter(Boolean))].sort();
  const out = new Map();
  if (keys.length < 2) { for (const key of keys) out.set(key, list[0]); return out; }
  const used = new Set();
  for (const key of keys) {
    let slot = hashName(key) % list.length;
    for (let i = 0; i < list.length && used.has(slot); i++) slot = (slot + 1) % list.length;
    if (used.has(slot)) slot = hashName(key) % list.length;     // more groups than colours: share
    used.add(slot);
    out.set(key, list[slot]);
  }
  return out;
}

// Window top-left positions centred on the box's four corners, clockwise from top-left.
export function corners(w, h, win = FLOW.window) {
  const d = win / 2;
  return [{ left: -d, top: -d }, { left: w - d, top: -d }, { left: w - d, top: h - d }, { left: -d, top: h - d }];
}

// Where each comet's window goes at a step (0–3): comet k heads for corner step+1+2k, so two
// comets run half a loop apart. Each move is one edge, so a native linear transition follows it.
export function flowTargets(step, w, h, comets = FLOW.comets, win = FLOW.window) {
  const c = corners(w, h, win);
  return Array.from({ length: comets }, (_, k) => c[(step + 1 + 2 * k) % 4]);
}

// The rounded border as a stroked path, inset by half the stroke so it lies on the box edge.
// `builder` is gpui-kit's PathBuilder (passed in, so tests can record the calls).
export function borderPath(builder, w, h, r = FLOW.radius, stroke = FLOW.stroke) {
  const i = stroke / 2, R = Math.max(0, Math.min(r, (w - stroke) / 2, (h - stroke) / 2));
  return builder.stroke(stroke)
    .move_to(i + R, i).line_to(w - i - R, i).arc_to(R, R, 0, false, true, w - i, i + R)
    .line_to(w - i, h - i - R).arc_to(R, R, 0, false, true, w - i - R, h - i)
    .line_to(i + R, h - i).arc_to(R, R, 0, false, true, i, h - i - R)
    .line_to(i, i + R).arc_to(R, R, 0, false, true, i + R, i)
    .close().build();
}

// The comet must read against the group's own 2px border: lighter on dark, darker on light.
export function flowColor(color, mode = 'dark') {
  const h = hex(color);
  if (!h) return color;
  const target = mode === 'light' ? 0 : 255, amount = 0.45;
  return '#' + [0, 2, 4].map(i => {
    const c = parseInt(h.slice(i, i + 2), 16);
    return Math.round(c + (target - c) * amount).toString(16).padStart(2, '0');
  }).join('');
}
