// ⑪ Shared work across computers, pure parts (no host imports, so tests load it directly):
// one colour per collaborating group (⑩ palette), and the border flow F+D —
// F: when a message between the group's computers arrives, a comet runs on from the message
//    pipe around the workspace border for a few laps (pipeline.js clip-window technique:
//    native linear transitions, JavaScript only moves it on at each corner);
// D: otherwise the border breathes (native opacity loop), each group on its own period.
// Everything moves only while collaborating and with sixfold.motion on.

// ⑩ palette, the same index = the same group colour in both modes. Index 0 is ⑨'s. The fourth
// dark colour is lifted from ⑩'s #C98BFF to #CC92FF to keep 4.5:1 on an active (selected) header.
export const GROUP_COLORS = {
  dark: ['#A9B8FF', '#FF8CC6', '#7FF0D6', '#CC92FF'],
  light: ['#3346B8', '#A8205F', '#00493C', '#7A2FB0'],
};

export const FLOW = {
  lapMs: 3600,            // one lap of the border (spec: 3–4 s), linear
  laps: 2,                // laps after a message arrives, then back to breathing
  arriveMs: 1600,         // a message packet's travel along the pipe (pipeline.js default)
  window: 22,             // the clip window, wider than a corner's arc
  stroke: 3,              // the comet
  radius: 6,              // the box's corner radius
  tail: [[0, 1], [110, 0.55], [220, 0.3]],   // [delay ms, opacity]: head and two tail stages
  track: 0.3,             // the group border's opacity while a comet runs on it
  maxComets: 3,           // at most this many groups flow at once (newest sends first)
};
FLOW.edgeMs = FLOW.lapMs / 4;

// D: breathing periods (there and back), staggered so groups never pulse together.
export const BREATH = { from: 0.35, to: 1, periods: [2400, 2700, 3000, 3300] };

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

// The palette mode, from the theme background (as ⑨'s collabColor reads it).
export function paletteMode(t) {
  const lum = luminance(t?.background ?? t?.chrome);
  return lum !== null && lum > 0.214 ? 'light' : 'dark';
}

export const groupKey = name => String(name ?? '').normalize('NFC').trim().toLowerCase();

// FNV-1a: the same project name prefers the same colour after every restart.
export function hashName(name) {
  let h = 0x811c9dc5;
  for (const ch of groupKey(name)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

// group key -> { color, index } for the groups shown now. One group keeps ⑨'s colour; two or
// more each take their preferred slot, collisions moving to the next free one in name order,
// so the result depends only on the set of names. More groups than colours share.
export function groupColors(names, mode = 'dark') {
  const list = GROUP_COLORS[mode] ?? GROUP_COLORS.dark;
  const keys = [...new Set(names.map(groupKey).filter(Boolean))].sort();
  const out = new Map();
  if (keys.length < 2) { for (const key of keys) out.set(key, { color: list[0], index: 0 }); return out; }
  const used = new Set();
  for (const key of keys) {
    let slot = hashName(key) % list.length;
    for (let i = 0; i < list.length && used.has(slot); i++) slot = (slot + 1) % list.length;
    if (used.has(slot)) slot = hashName(key) % list.length;
    used.add(slot);
    out.set(key, { color: list[slot], index: slot });
  }
  return out;
}

// The breathing period for a group's colour slot.
export const breathPeriod = index => BREATH.periods[Math.abs(index) % BREATH.periods.length];

// The newest send between this computer and one of the group's other computers (ms, or null).
// hops: machineHops() items ({ event: { at }, hop: { from, to } }); null is this computer.
export function lastGroupSend(group, hops) {
  const machines = new Set(group?.machines ?? []);
  let at = null;
  for (const { event, hop } of hops ?? []) {
    if (!Number.isFinite(event?.at) || hop.from === hop.to) continue;
    if (!(hop.from === null || hop.to === null)) continue;
    if (!machines.has(hop.from) || !machines.has(hop.to)) continue;
    if (at === null || event.at > at) at = event.at;
  }
  return at;
}

// The comets running now: group key -> { start, step }. A comet starts when the newest send
// of a collaborating group arrives (send + arriveMs) and runs laps × 4 edges. At most
// maxComets at once, the newest sends first. `waking` is the next time something starts or
// ends (null when nothing is pending), so a timer runs only while it matters.
export function cometPlan(sends, now, options = FLOW) {
  // It is placed at the entry corner one edge before the packet arrives, so it starts moving
  // (a transition from there) exactly on arrival, then runs `laps` laps.
  const edge = options.lapMs / 4, length = edge + options.laps * options.lapMs;
  const running = [], pending = [];
  for (const [key, at] of sends) {
    if (!Number.isFinite(at)) continue;
    const start = at + options.arriveMs - edge;
    if (now < start) pending.push(start);
    else if (now < start + length) running.push({ key, start, step: Math.floor((now - start) / edge) });
  }
  running.sort((a, b) => b.start - a.start);
  const shown = new Map(running.slice(0, options.maxComets).map(item => [item.key, item]));
  const ends = [...shown.values()].map(item => item.start + length);
  const wakes = [...pending, ...ends].filter(value => value > now);
  return { comets: shown, waking: wakes.length ? Math.min(...wakes) : null, flowing: shown.size > 0 };
}

// Clip-window top-left positions centred on the box corners, clockwise from top-left.
export function corners(w, h, win = FLOW.window) {
  const d = win / 2;
  return [{ left: -d, top: -d }, { left: w - d, top: -d }, { left: w - d, top: h - d }, { left: -d, top: h - d }];
}

// Where the comet's window is at a step: step 0 at the top-right corner, where the message
// pipes come in, then clockwise one corner per step (one edge per native transition).
export function cometTarget(step, w, h, win = FLOW.window) {
  return corners(w, h, win)[(1 + step) % 4];
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
