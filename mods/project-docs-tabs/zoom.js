// Pure geometry for the diagram viewer: no host calls, safe inside render().
//
// A view is { scale, x, y }: `scale` is screen points per natural diagram point (1 = 100%, the
// size Mermaid laid the diagram out at), and x/y place the picture's top-left corner inside the
// viewport. Diagram PNGs carry twice their natural size, so on a Retina screen 100% is one image
// pixel per screen pixel; past SHARP_SCALE the picture is enlarged and turns soft.
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;
export const SHARP_SCALE = 1;
// Below this the fitted diagram is too small to read, so the viewer opens fitted to the width.
export const READABLE_SCALE = 0.6;
export const PAD = 24;
// One ⌘+ / ⌘− step.
export const STEP = 1.25;
// One wheel notch, as Preview steps.
const NOTCH = 1.1;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const room = (viewport, pad) => ({ width: Math.max(1, viewport.width - 2 * pad), height: Math.max(1, viewport.height - 2 * pad) });

// The scale that shows the whole picture inside the viewport, never above 100%.
export function fitScale(media, viewport, pad = PAD) {
  if (!media?.width || !media?.height || !viewport?.width || !viewport?.height) return 1;
  const r = room(viewport, pad);
  return Math.min(1, r.width / media.width, r.height / media.height);
}

// The scale that fills the viewport's width, never above 100%.
export function widthScale(media, viewport, pad = PAD) {
  if (!media?.width || !viewport?.width) return 1;
  return Math.min(1, room(viewport, pad).width / media.width);
}

// Allowed scales: down to the fit scale (or 25%, whichever is smaller) and up to 400%.
export function clampScale(scale, media, viewport) {
  return clamp(scale, Math.min(MIN_SCALE, fitScale(media, viewport)), MAX_SCALE);
}

// Keeps the picture on screen: a picture smaller than the viewport is centred on that axis; a
// larger one may move until its edge reaches the padding, never further.
export function clampView(view, media, viewport, pad = PAD) {
  const width = media.width * view.scale, height = media.height * view.scale;
  const axis = (offset, size, length) => size + 2 * pad <= length ? (length - size) / 2 : clamp(offset, length - size - pad, pad);
  return { scale: view.scale, x: axis(view.x, width, viewport.width), y: axis(view.y, height, viewport.height) };
}

// The whole picture, centred (⌘9).
export function fitView(media, viewport) {
  return clampView({ scale: fitScale(media, viewport), x: 0, y: 0 }, media, viewport);
}

// Shows picture point (u, v) — fractions of its width and height — at viewport point `at`.
export function viewAt(scale, u, v, at, media, viewport) {
  return clampView({ scale, x: at.x - u * media.width * scale, y: at.y - v * media.height * scale }, media, viewport);
}

// How the viewer opens on a double-click or the ⤢ button at picture point (u, v): fitted when
// that is readable, otherwise fitted to the width with the clicked part in view.
export function openView(media, viewport, u = 0.5, v = 0.5) {
  const fit = fitScale(media, viewport);
  if (fit >= READABLE_SCALE) return fitView(media, viewport);
  const scale = Math.max(fit, widthScale(media, viewport));
  return viewAt(scale, u, v, { x: viewport.width / 2, y: viewport.height / 2 }, media, viewport);
}

// Scale by `factor` keeping the picture point under `point` (viewport coordinates) still.
// Without a point the viewport centre is the anchor, as for the keyboard and buttons.
export function zoomAt(view, factor, point, media, viewport) {
  const anchor = point || { x: viewport.width / 2, y: viewport.height / 2 };
  const scale = clampScale(view.scale * factor, media, viewport);
  const ratio = scale / view.scale;
  return clampView({ scale, x: anchor.x - (anchor.x - view.x) * ratio, y: anchor.y - (anchor.y - view.y) * ratio }, media, viewport);
}

// Jump to an exact scale (100% for ⌘0).
export function zoomTo(view, scale, media, viewport, point = null) {
  return zoomAt(view, scale / view.scale, point, media, viewport);
}

export function panBy(view, dx, dy, media, viewport) {
  return clampView({ scale: view.scale, x: view.x + dx, y: view.y + dy }, media, viewport);
}

// Double-click: from the fit view to 100% at the clicked point, otherwise back to fit.
export function toggleView(view, point, media, viewport) {
  const fit = fitScale(media, viewport);
  return Math.abs(view.scale - fit) < 0.01 && fit < 1 ? zoomTo(view, 1, media, viewport, point) : fitView(media, viewport);
}

// A wheel step. ⌘ or ⌥ held zooms around the pointer (Preview); ⌃ is left to the system's
// screen zoom. Otherwise it pans; ⇧ turns a mouse wheel sideways. A wheel reporting lines
// moves 40px a line and zooms one notch per line; a trackpad reports pixels.
export function wheelStep(view, event, media, viewport, point = event.local_position || null) {
  const m = event.modifiers || {}, lines = event.delta_lines && (event.delta_lines.x || event.delta_lines.y);
  let dx = lines ? event.delta_lines.x * 40 : event.delta?.x || 0;
  let dy = lines ? event.delta_lines.y * 40 : event.delta?.y || 0;
  if (m.platform || m.alt) {
    const amount = lines ? event.delta_lines.y : dy / 40;
    if (!amount) return view;
    return zoomAt(view, Math.pow(NOTCH, clamp(amount, -5, 5)), point, media, viewport);
  }
  if (m.shift && !dx) [dx, dy] = [dy, 0];
  return panBy(view, dx, dy, media, viewport);
}

// A pinch step: delta 0.1 is 10% larger.
export function pinchStep(view, event, media, viewport, point = event.local_position || null) {
  return zoomAt(view, clamp(1 + (event.delta || 0), 0.5, 2), point, media, viewport);
}

// Keys the viewer answers, as Preview: ⌘+ ⌘= in, ⌘− out, ⌘0 actual size, ⌘9 fit. ⌘ is optional
// so the keys still work if the app keeps ⌘+ / ⌘0 for its own zoom. Arrows pan, ⌥ by a screen.
// Esc and Space close.
export function keyCommand(event) {
  const key = String(event?.key || '').toLowerCase(), m = event?.modifiers || {};
  if (key === 'escape' || (key === 'space' && !m.platform)) return 'close';
  if (m.control) return null;
  if (!m.alt) {
    if (key === '=' || key === '+') return 'in';
    if (key === '-' || key === '_') return 'out';
    if (key === '0') return 'actual';
    if (key === '9') return 'fit';
  }
  if (m.platform) return null;
  const page = m.alt ? '-page' : '';
  if (['left', 'right', 'up', 'down'].includes(key)) return key + page;
  return null;
}

// Applies a keyboard or toolbar command.
export function command(view, name, media, viewport) {
  const [direction, page] = String(name).split('-');
  const step = page ? 0.9 : 0;
  const dx = page ? viewport.width * step : 80, dy = page ? viewport.height * step : 80;
  switch (direction) {
    case 'in': return zoomAt(view, STEP, null, media, viewport);
    case 'out': return zoomAt(view, 1 / STEP, null, media, viewport);
    case 'fit': return fitView(media, viewport);
    case 'actual': return zoomTo(view, 1, media, viewport);
    case 'left': return panBy(view, dx, 0, media, viewport);
    case 'right': return panBy(view, -dx, 0, media, viewport);
    case 'up': return panBy(view, 0, dy, media, viewport);
    case 'down': return panBy(view, 0, -dy, media, viewport);
    default: return view;
  }
}

export const percent = scale => `${Math.round(scale * 100)}%`;
