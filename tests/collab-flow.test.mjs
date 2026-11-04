import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GROUP_COLORS, FLOW, BREATH, contrast, luminance, paletteMode, groupColors, groupKey, hashName, breathPeriod,
  lastGroupSend, cometPlan, corners, cometTarget, borderPath } from '../mods/sixfold-desk/collab-flow.js';
import { COLLAB_COLORS } from '../mods/sixfold-desk/collab.js';

const theme = name => JSON.parse(readFileSync(new URL(`../themes/sixfold-${name}.json`, import.meta.url), 'utf8'));
const night = theme('night'), day = theme('day');
const tint = (color, bg, alpha = 0.1) => '#' + [1, 3, 5].map(i => Math.round(alpha * parseInt(color.slice(i, i + 2), 16) + (1 - alpha) * parseInt(bg.slice(i, i + 2), 16)).toString(16).padStart(2, '0')).join('');

for (const [mode, th] of [['dark', night], ['light', day]]) {
  test(`${mode}: four group colours, each 4.5:1 on every sidebar background and an active header`, () => {
    const colors = GROUP_COLORS[mode];
    assert.equal(colors.length, 4);
    assert.equal(colors[0], COLLAB_COLORS[mode], 'the first is ⑨\'s collaboration colour');
    assert.equal(new Set(colors).size, 4);
    for (const color of colors) {
      for (const ground of [th.background, th.colors.canvas, th.colors.chrome, th.colors.selected, tint(color, th.colors.chrome)]) {
        assert.ok(contrast(color, ground) >= 4.5, `${color} on ${ground}: ${contrast(color, ground).toFixed(2)}`);
      }
    }
  });
}

test('the palette mode follows the theme background', () => {
  assert.equal(paletteMode({ background: night.background }), 'dark');
  assert.equal(paletteMode({ background: day.background }), 'light');
  assert.equal(paletteMode({}), 'dark');
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
  assert.ok(luminance('#ffffff') > 0.99);
});

test('one group keeps ⑨\'s colour; two or more each get their own, the same after a restart or reorder', () => {
  assert.deepEqual([...groupColors(['Game'], 'dark').values()], [{ color: GROUP_COLORS.dark[0], index: 0 }]);
  const a = groupColors(['Game', 'Docs', 'Shop'], 'dark'), b = groupColors(['Shop', ' game', 'Docs'], 'dark');
  assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort(), 'depends only on the set of names');
  assert.equal(new Set([...a.values()].map(item => item.color)).size, 3);
  assert.equal(hashName('Game'), hashName('game'));
  assert.equal(groupKey(' Docs '), 'docs');
  const many = groupColors(['a', 'b', 'c', 'd', 'e'], 'light');
  assert.equal(many.size, 5, 'a fifth group shares a colour');
  assert.ok([...many.values()].every(item => GROUP_COLORS.light[item.index] === item.color));
});

test('D: groups breathe on different periods so they never pulse together', () => {
  const periods = [0, 1, 2, 3].map(breathPeriod);
  assert.equal(new Set(periods).size, 4);
  assert.ok(periods.every(p => p >= 2400 && p <= 3300));
  assert.equal(breathPeriod(4), breathPeriod(0));
  assert.ok(BREATH.from > 0 && BREATH.to === 1);
});

test('F: a send between this computer and a partner of the group starts it; others do not', () => {
  const group = { name: 'Game', machines: [null, 'worker'] };
  const hop = (at, from, to) => ({ event: { at }, hop: { from, to } });
  assert.equal(lastGroupSend(group, [hop(10, null, 'worker'), hop(30, 'worker', null), hop(50, 'other', null), hop(70, 'worker', 'other')]), 30);
  assert.equal(lastGroupSend(group, []), null);
});

test('F: the comet starts on the packet\'s arrival, runs its laps, then gives way to breathing', () => {
  const at = 100000, edge = FLOW.edgeMs, arrive = at + FLOW.arriveMs;
  const sends = new Map([['game', at]]);
  let plan = cometPlan(sends, at + 10);
  assert.equal(plan.comets.size, 0, 'the packet is still on the pipe');
  assert.equal(plan.waking, arrive - edge, 'wakes to place the comet one edge before arrival');
  plan = cometPlan(sends, arrive - edge);
  assert.equal(plan.comets.get('game').step, 0, 'placed at the entry corner');
  plan = cometPlan(sends, arrive + 1);
  assert.equal(plan.comets.get('game').step, 1, 'moving from the arrival on');
  const end = arrive + FLOW.laps * FLOW.lapMs;
  plan = cometPlan(sends, end - 1);
  assert.ok(plan.flowing && plan.waking === end);
  for (let step = 0; step <= FLOW.laps * 4; step++) {
    const corner = arrive - edge + step * edge;
    const next = cometPlan(sends, corner);
    assert.equal(next.waking, corner + edge, 'wake exactly at the next corner, including the final edge');
  }
  plan = cometPlan(sends, end);
  assert.equal(plan.flowing, false, 'after its laps: breathing');
  assert.equal(plan.waking, null, 'no timer needed');
  assert.ok(FLOW.lapMs >= 3000 && FLOW.lapMs <= 4000, 'a lap takes 3–4 s');
});

test('F: a pair of remote computers in the group also starts a comet', () => {
  const group = { machines: ['worker', 'other'] };
  assert.equal(lastGroupSend(group, [{ event: { at: 42 }, hop: { from: 'worker', to: 'other' } }]), 42);
});

test('F: at most maxComets flow at once, the newest sends first', () => {
  const now = 500000;
  const sends = new Map(['a', 'b', 'c', 'd'].map((key, i) => [key, now - FLOW.arriveMs - 100 * i]));
  const plan = cometPlan(sends, now);
  assert.equal(plan.comets.size, FLOW.maxComets);
  assert.ok(!plan.comets.has('d'), 'the oldest waits (it breathes instead)');
});

test('F: the comet enters at the top-right corner and moves one edge per step', () => {
  const [tl, tr, br, bl] = corners(200, 120, 20);
  assert.deepEqual(cometTarget(0, 200, 120, 20), tr);
  assert.deepEqual([1, 2, 3, 4].map(step => cometTarget(step, 200, 120, 20)), [br, bl, tl, tr]);
  for (let step = 0; step < 8; step++) {
    const a = cometTarget(step, 200, 120, 20), b = cometTarget(step + 1, 200, 120, 20);
    assert.equal(['left', 'top'].filter(key => a[key] !== b[key]).length, 1, 'along one edge, so a native transition follows it');
  }
  assert.equal(FLOW.edgeMs * 4, FLOW.lapMs);
  assert.ok(FLOW.tail.length >= 2 && FLOW.tail.every(([delay], i) => delay === 0 || delay > FLOW.tail[i - 1][0]), 'a tail of delayed stages');
});

test('the border path is a closed rounded rectangle inset by half the stroke', () => {
  const calls = [];
  const builder = { stroke(w) { calls.push(['stroke', w]); return this; } };
  for (const name of ['move_to', 'line_to', 'arc_to', 'close']) builder[name] = (...args) => { calls.push([name, ...args]); return builder; };
  builder.build = () => calls.push(['build']);
  borderPath(builder, 200, 120, 6, 3);
  assert.deepEqual(calls[1], ['move_to', 7.5, 1.5]);
  assert.equal(calls.filter(call => call[0] === 'arc_to').length, 4);
  assert.deepEqual(calls.slice(-2).map(call => call[0]), ['close', 'build']);
  assert.doesNotThrow(() => borderPath(builder, 4, 4, 6, 3));
});
