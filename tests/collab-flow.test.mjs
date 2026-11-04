import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GROUP_COLORS, FLOW, contrast, luminance, paletteMode, groupColors, groupKey, hashName, corners, flowTargets, borderPath, flowColor } from '../mods/sixfold-desk/collab-flow.js';
import { COLLAB_COLORS } from '../mods/sixfold-desk/collab.js';

const theme = name => JSON.parse(readFileSync(new URL(`../themes/sixfold-${name}.json`, import.meta.url), 'utf8'));
const night = theme('night'), day = theme('day');

// CIE L*a*b* for the lightness spread and the distance from the amber needs-you colour.
function lab(color) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255).map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), y = f(0.2126 * r + 0.7152 * g + 0.0722 * b), z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const deltaE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));
const tint = (color, bg, alpha = 0.1) => '#' + [1, 3, 5].map(i => Math.round(alpha * parseInt(color.slice(i, i + 2), 16) + (1 - alpha) * parseInt(bg.slice(i, i + 2), 16)).toString(16).padStart(2, '0')).join('');

for (const [mode, th] of [['dark', night], ['light', day]]) {
  test(`${mode} group colours read at 4.5:1 on every sidebar background, differ in lightness and keep away from amber`, () => {
    const colors = GROUP_COLORS[mode];
    assert.ok(colors.length >= 4 && colors.length <= 6);
    assert.equal(colors[0], COLLAB_COLORS[mode], 'the first is ⑨\'s collaboration colour');
    const grounds = [th.background, th.colors.canvas, th.colors.chrome, th.colors.selected];
    for (const color of colors) {
      for (const ground of [...grounds, tint(color, th.colors.chrome)]) {
        assert.ok(contrast(color, ground) >= 4.5, `${color} on ${ground}: ${contrast(color, ground).toFixed(2)}`);
      }
      assert.ok(deltaE(color, th.colors.blocked) >= 50, `${color} is far from the needs-you amber`);
    }
    for (let i = 0; i < colors.length; i++) for (let j = i + 1; j < colors.length; j++) {
      assert.ok(Math.abs(lab(colors[i])[0] - lab(colors[j])[0]) >= 4, `${colors[i]} and ${colors[j]} differ in lightness`);
    }
  });
}

test('the palette mode follows the theme background', () => {
  assert.equal(paletteMode({ background: night.background }), 'dark');
  assert.equal(paletteMode({ background: day.background }), 'light');
  assert.equal(paletteMode({}), 'dark');
  assert.ok(luminance('#ffffff') > 0.99 && luminance('#000000') === 0);
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
});

test('one group keeps ⑨\'s colour; two or more each get their own, the same after a restart or reorder', () => {
  assert.deepEqual([...groupColors(['Game'], 'dark').values()], [GROUP_COLORS.dark[0]]);
  const a = groupColors(['Game', 'Docs', 'Shop'], 'dark');
  const b = groupColors(['Shop', 'Game', 'Docs '], 'dark');
  assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort(), 'depends only on the set of names');
  assert.equal(new Set(a.values()).size, 3, 'three groups, three colours');
  assert.equal(groupKey(' Ｇame '.normalize('NFKC')), 'game');
  assert.equal(hashName('Game'), hashName('game'), 'case does not change the slot');
  const many = groupColors(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'light');
  assert.equal(many.size, 7, 'more groups than colours still each get one');
  assert.ok([...many.values()].every(color => GROUP_COLORS.light.includes(color)));
});

test('the flow window moves one edge per step, and two comets run half a loop apart', () => {
  const [tl, tr, br, bl] = corners(200, 120, 20);
  assert.deepEqual([tl, tr, br, bl], [{ left: -10, top: -10 }, { left: 190, top: -10 }, { left: 190, top: 110 }, { left: -10, top: 110 }]);
  for (let step = 0; step < 4; step++) {
    const before = flowTargets((step + 3) % 4, 200, 120, 2, 20), after = flowTargets(step, 200, 120, 2, 20);
    for (let k = 0; k < 2; k++) {
      const moved = ['left', 'top'].filter(key => before[k][key] !== after[k][key]);
      assert.equal(moved.length, 1, 'along one edge, so a native linear transition follows it');
    }
    assert.notDeepEqual(after[0], after[1]);
  }
  assert.deepEqual(flowTargets(0, 200, 120, 2, 20), [tr, bl], 'opposite corners');
});

test('the border path is a closed rounded rectangle inset by half the stroke', () => {
  const calls = [];
  const builder = { stroke(w) { calls.push(['stroke', w]); return this; } };
  for (const name of ['move_to', 'line_to', 'arc_to', 'close']) builder[name] = (...args) => { calls.push([name, ...args]); return builder; };
  builder.build = () => calls.push(['build']);
  borderPath(builder, 200, 120, 6, 3);
  assert.deepEqual(calls[0], ['stroke', 3]);
  assert.deepEqual(calls[1], ['move_to', 7.5, 1.5]);
  assert.equal(calls.filter(call => call[0] === 'arc_to').length, 4, 'four rounded corners');
  assert.deepEqual(calls.slice(-2).map(call => call[0]), ['close', 'build']);
  const tiny = []; builder.stroke = w => { tiny.push(w); return builder; };
  assert.doesNotThrow(() => borderPath(builder, 4, 4, 6, 3), 'a radius larger than the box is clamped');
});

test('the comet stands out from the group\'s own border: lighter on dark, darker on light', () => {
  const dark = flowColor('#A9B8FF', 'dark'), light = flowColor('#3346B8', 'light');
  assert.ok(luminance(dark) > luminance('#A9B8FF'));
  assert.ok(luminance(light) < luminance('#3346B8'));
  assert.equal(flowColor('not a colour'), 'not a colour');
  assert.ok(FLOW.edgeMs >= 500 && FLOW.window > FLOW.radius * 2, 'the window covers a corner');
});
