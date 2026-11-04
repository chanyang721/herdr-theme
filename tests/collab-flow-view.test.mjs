import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {FLOW, BREATH, cometTarget} from '../mods/sixfold-desk/collab-flow.js';

// Load the real drawing functions; record the native operations they ask for.
function element() {
  const node = {calls: [], nodes: []};
  const proxy = new Proxy(node, {get(target, key) {
    if (key in target) return target[key];
    if (key === 'then') return undefined;
    return (...args) => {
      if (key === 'children') target.nodes.push(...args[0]);
      else if (key === 'child') target.nodes.push(args[0]);
      else target.calls.push([key, ...args]);
      return proxy;
    };
  }});
  return proxy;
}
const builder = {stroke() {return this;}};
for (const method of ['move_to', 'line_to', 'arc_to', 'close']) builder[method] = () => builder;
builder.build = () => 'path';
const source = (await readFile(new URL('../mods/sixfold-desk/collab-flow-view.js', import.meta.url), 'utf8'))
  .replace("import { div, PathBuilder } from 'gpui-kit';", 'const {div,PathBuilder,window}=globalThis.__borderRuntime;')
  .replace("'./collab-flow.js'", JSON.stringify(new URL('../mods/sixfold-desk/collab-flow.js', import.meta.url).href));
globalThis.__borderRuntime = {div: element, PathBuilder: builder, window: {paint_path: element}};
const {breathingBorder, borderComet} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
delete globalThis.__borderRuntime;
const value = (node, name) => node.calls.find(call => call[0] === name)?.[1];

test('the real border uses a native opacity loop only while motion is enabled and no comet runs', () => {
  const options = {id: 'game', color: '#A9B8FF', period: 2700, motion: true};
  const loop = breathingBorder(options).calls.find(call => call[0] === 'loop');
  assert.deepEqual(loop, ['loop', 'opacity', {from: BREATH.from, to: BREATH.to, period: 2700, easing: 'ease-in-out'}]);
  const off = breathingBorder({...options, motion: false});
  assert(!off.calls.some(call => call[0] === 'loop'));
  assert.equal(value(off, 'border'), 2);
  const track = breathingBorder({...options, dim: true});
  assert(!track.calls.some(call => call[0] === 'loop'));
  assert.equal(value(track, 'opacity'), FLOW.track);
});

test('the real comet draws three native transition windows with inverse path offsets and separate send identities', () => {
  const options = {id: 'game', start: 123, w: 190, h: 96, color: '#A9B8FF', step: 2, motion: true};
  assert.equal(borderComet({...options, motion: false}), null);
  assert.equal(borderComet({...options, w: 0}), null);
  const comet = borderComet(options), at = cometTarget(options.step, options.w, options.h);
  assert.equal(value(borderComet({...options, step: 0}), 'opacity'), 0, 'staging at the entry corner stays hidden until the packet arrives');
  assert.equal(value(comet, 'opacity'), 1);
  assert.equal(comet.nodes.length, 3);
  for (const [index, stage] of comet.nodes.entries()) {
    assert.equal(value(stage, 'left'), at.left);
    assert.equal(value(stage, 'top'), at.top);
    assert.equal(value(stage.nodes[0], 'left'), -at.left);
    assert.equal(value(stage.nodes[0], 'top'), -at.top);
    assert.equal(value(stage, 'opacity'), FLOW.tail[index][1]);
    const transitions = stage.calls.filter(call => call[0] === 'transition');
    assert.deepEqual(transitions.map(call => call[1]), ['left', 'top']);
    assert(transitions.every(call => call[2].delay === FLOW.tail[index][0] && call[2].easing === 'linear'));
  }
  assert.notEqual(value(comet, 'id'), value(borderComet({...options, start: 456}), 'id'), 'a new send starts at its entry corner instead of crossing the old path');
});
