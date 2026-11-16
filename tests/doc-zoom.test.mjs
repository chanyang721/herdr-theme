import test from 'node:test';
import assert from 'node:assert/strict';
import { fitScale, widthScale, fitView, clampView, openView, zoomAt, zoomTo, panBy, toggleView, wheelStep, pinchStep, keyCommand, command, percent, MAX_SCALE, PAD } from '../mods/project-docs-tabs/zoom.js';

// The Medihomes architecture flowchart: 3072pt wide, shown in a 1200×800 pane.
const media = { width: 3072, height: 1864 };
const viewport = { width: 1200, height: 800 };
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} ≠ ${expected}`);

test('fit shows the whole diagram centred and never enlarges a small one', () => {
  const view = fitView(media, viewport);
  near(view.scale, (1200 - 2 * PAD) / 3072, 'width-bound fit');
  near(view.x, PAD, 'left edge sits on the padding');
  near(view.y, (800 - 1864 * view.scale) / 2, 'vertically centred');
  assert.equal(fitScale({ width: 200, height: 100 }, viewport), 1, 'a small diagram stays at 100%');
  assert.equal(fitScale(null, viewport), 1);
});

test('an unreadable fit opens fitted to the width around the clicked part', () => {
  const tall = { width: 1600, height: 3000 };
  const fit = fitScale(tall, viewport);
  assert.ok(fit < 0.6);
  const view = openView(tall, viewport, 0.5, 0.8);
  near(view.scale, widthScale(tall, viewport), 'width fit');
  near(view.y + 0.8 * tall.height * view.scale, viewport.height / 2, 'the clicked part is centred');
  assert.deepEqual(openView({ width: 600, height: 400 }, viewport), fitView({ width: 600, height: 400 }, viewport), 'a readable fit stays fitted');
});

test('zooming keeps the point under the pointer still and stays within 25%–400%', () => {
  const start = fitView(media, viewport), pointer = { x: 900, y: 300 };
  const under = { x: (pointer.x - start.x) / start.scale, y: (pointer.y - start.y) / start.scale };
  const zoomed = zoomAt(start, 2, pointer, media, viewport);
  near(zoomed.scale, start.scale * 2, 'doubled');
  near(zoomed.x + under.x * zoomed.scale, pointer.x, 'same picture point under the pointer (x)');
  near(zoomed.y + under.y * zoomed.scale, pointer.y, 'same picture point under the pointer (y)');
  assert.equal(zoomAt(start, 1000, pointer, media, viewport).scale, MAX_SCALE);
  const small = { width: 600, height: 400 };
  near(zoomAt(fitView(small, viewport), 0.0001, null, small, viewport).scale, 0.25, 'smallest is 25% when the fit is larger');
  const huge = { width: 8000, height: 3000 };
  near(zoomAt(fitView(huge, viewport), 0.0001, null, huge, viewport).scale, fitScale(huge, viewport), 'or the fit when that is smaller');
});

test('panning stops at the edges and a picture smaller than the viewport stays centred', () => {
  const actual = zoomTo(fitView(media, viewport), 1, media, viewport);
  assert.equal(actual.scale, 1);
  const far = panBy(actual, 99999, 99999, media, viewport);
  assert.equal(far.x, PAD); assert.equal(far.y, PAD);
  const other = panBy(actual, -99999, -99999, media, viewport);
  assert.equal(other.x, 1200 - 3072 - PAD); assert.equal(other.y, 800 - 1864 - PAD);
  const fit = fitView(media, viewport);
  assert.deepEqual(panBy(fit, 0, 500, media, viewport), fit, 'the fitted height cannot be dragged off centre');
  assert.deepEqual(clampView({ scale: 1, x: 5, y: 5 }, { width: 100, height: 50 }, viewport), { scale: 1, x: 550, y: 375 });
});

test('double-click toggles between fit and 100% at the clicked point', () => {
  const fit = fitView(media, viewport);
  const actual = toggleView(fit, { x: 600, y: 400 }, media, viewport);
  assert.equal(actual.scale, 1);
  assert.deepEqual(toggleView(actual, { x: 10, y: 10 }, media, viewport), fit);
});

test('⌘- or ⌥-scroll and pinch zoom around the pointer; plain scroll pans; ⌃ is left to the system', () => {
  const fit = fitView(media, viewport), at = { x: 600, y: 400 };
  const actual = zoomTo(fit, 1, media, viewport);
  const panned = wheelStep(actual, { delta: { x: -30, y: -50 }, modifiers: {}, local_position: at }, media, viewport);
  assert.equal(panned.scale, 1); near(panned.x, actual.x - 30, 'x pans'); near(panned.y, actual.y - 50, 'y pans');
  const lines = wheelStep(actual, { delta: { x: 0, y: 0 }, delta_lines: { x: 0, y: -2 }, modifiers: {} }, media, viewport);
  near(lines.y, actual.y - 80, 'a mouse wheel line moves 40px');
  const sideways = wheelStep(actual, { delta: { x: 0, y: -40 }, modifiers: { shift: true } }, media, viewport);
  near(sideways.x, actual.x - 40, '⇧ turns the wheel sideways'); near(sideways.y, actual.y, 'and not down');
  const notch = wheelStep(fit, { delta: { x: 0, y: 0 }, delta_lines: { x: 0, y: 1 }, modifiers: { platform: true }, local_position: at }, media, viewport);
  near(notch.scale, fit.scale * 1.1, 'one ⌘-wheel notch is 10%');
  assert.ok(wheelStep(fit, { delta: { x: 0, y: 50 }, modifiers: { alt: true }, local_position: at }, media, viewport).scale > fit.scale, '⌥-scroll zooms too');
  const control = wheelStep(actual, { delta: { x: 0, y: 50 }, modifiers: { control: true }, local_position: at }, media, viewport);
  assert.equal(control.scale, 1, '⌃-scroll does not zoom');
  const pinched = pinchStep(fit, { delta: 0.1, local_position: at }, media, viewport);
  near(pinched.scale, fit.scale * 1.1, 'a pinch delta of 0.1 is 10% larger');
});

test('keys follow Preview: ⌘+ ⌘= ⌘− zoom, ⌘0 actual size, ⌘9 fit, arrows pan, Esc and Space close', () => {
  const key = (key, modifiers = {}) => keyCommand({ key, modifiers });
  assert.equal(key('=', { platform: true }), 'in'); assert.equal(key('+', { platform: true, shift: true }), 'in');
  assert.equal(key('-', { platform: true }), 'out'); assert.equal(key('0', { platform: true }), 'actual');
  assert.equal(key('9', { platform: true }), 'fit'); assert.equal(key('1', { platform: true }), null, '⌘1 stays the tab switch');
  assert.equal(key('escape'), 'close'); assert.equal(key('space'), 'close');
  assert.equal(key('='), 'in', 'plain keys work when the app keeps ⌘+ for itself');
  assert.equal(key('left'), 'left'); assert.equal(key('down', { alt: true }), 'down-page'); assert.equal(key('left', { platform: true }), null);
  assert.equal(key('w', { platform: true }), null); assert.equal(key('=', { control: true }), null);
  const fit = fitView(media, viewport);
  assert.equal(command(fit, 'actual', media, viewport).scale, 1);
  assert.deepEqual(command(command(fit, 'in', media, viewport), 'fit', media, viewport), fit);
  const actual = command(fit, 'actual', media, viewport);
  near(command(actual, 'right-page', media, viewport).x, Math.max(actual.x - 1200 * 0.9, 1200 - 3072 - PAD), '⌥→ moves most of a screen');
  assert.equal(percent(0.3825), '38%');
});
