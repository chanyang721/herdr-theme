import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inSpace} from '../mods/sixfold-slack-inbox/model.js';
import {arrivalTarget} from '../mods/sixfold-desk/arrival-model.js';

// 2026-11-16 review: Share's 전체 보기 reopened as the mentions window without its space, so it listed
// every space's mentions. The window now starts on the card's space by the cards' own rule.
test('a thread belongs to the space its card counts it on: off-sidebar ones to Share', () => {
  const names = ['Alpha', 'Share'];
  for (const project of ['Alpha', 'alpha', 'Share', '미연결', 'Gone', '', undefined])
    for (const space of ['Alpha', 'Share'])
      assert.equal(inSpace(project, space, names), arrivalTarget(project, names).toLowerCase() === space.toLowerCase(), `${project} in ${space}`);
  assert.equal(inSpace('미연결', 'Share', ['Alpha']), true, 'Share counts even when it is not on the sidebar');
  assert.equal(inSpace('미연결', 'Share', []), false, 'no sidebar names: its own space');
  assert.equal(inSpace('미연결', '미연결', []), true);
});

function element() {
  const node = {nid: null, kids: [], handlers: {}};
  const proxy = new Proxy(node, {get(t, k) {
    if (k === 'then') return undefined;
    if (k in t) return t[k];
    if (k === 'id') return v => { t.nid = v; return proxy; };
    if (k === 'child') return n => { if (n != null) t.kids.push(n); return proxy; };
    if (k === 'children') return ns => { t.kids.push(...ns.filter(Boolean)); return proxy; };
    if (k === 'when') return (b, f) => { if (b) f(proxy); return proxy; };
    if (k === 'on_click') return f => { t.handlers.click = f; return proxy; };
    return () => proxy;
  }});
  return proxy;
}
const ids = (node, out = []) => { if (node?.nid) out.push(node.nid); for (const c of node?.kids ?? []) ids(c, out); return out; };
const find = (node, id) => node?.nid === id ? node : (node?.kids ?? []).map(c => find(c, id)).find(Boolean);

async function mentionInbox(current) {
  const opened = [], closed = [];
  class View {}
  globalThis.__spaceInbox = {View, div: element, image: element, h_flex: element, v_flex: element, Popover: {new: element},
    theme: () => new Proxy({}, {get: () => '#000'}), props: () => current.props, appHome: () => '/h', home: () => '/h',
    shared: () => null, setShared() {}, openOverlay: o => opened.push(o), closeOverlay: o => closed.push(o), exec() {},
    readTextFile: async () => null, writeTextFile: async () => {}, spaces: () => current.spaces.map(name => ({name}))};
  const base = new URL('../mods/sixfold-slack-inbox/', import.meta.url);
  const src = (await readFile(new URL('main.js', base), 'utf8'))
    .replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base|herdr)';/g, 'const {$1}=globalThis.__spaceInbox;')
    .replace("'./model.js'", JSON.stringify(new URL('model.js', base).href));
  const {default: MentionInbox} = await import('data:text/javascript;base64,' + Buffer.from(src + `//${Math.random()}`).toString('base64'));
  const cx = {spawn() {}, timer: {every() {}}, notify() {}};
  return {MentionInbox, opened, closed, cx};
}

test("Share's 전체 보기 opens the mentions window on Share's mentions, and 전체 still shows all", async () => {
  const current = {props: {overlay: 'o1', project: 'Share', newMessages: false}, spaces: ['Alpha', 'Share']};
  const {MentionInbox, opened, closed, cx} = await mentionInbox(current);
  new MentionInbox().init(current.props, cx);
  assert.deepEqual(opened.map(o => [o.kind, o.props]), [['window', {window: true, space: 'Share'}]]);
  assert.deepEqual(closed, ['o1'], 'the dialog hands over to the window');

  current.props = opened[0].props;
  const view = new MentionInbox();
  view.init(current.props, cx);
  view.items = [{id: 'slack:D0TEST01:1.1', channel: 'D0TEST01', project: 'Share', text: 'dm'},
    {id: 'slack:C0TEST09:2.1', channel: 'C0TEST09', project: '미연결', text: 'unmapped'},
    {id: 'slack:C0TEST01:3.1', channel: 'C0TEST01', project: 'Alpha', text: 'alpha'}];
  const threads = tree => ids(tree).filter(id => id.startsWith('sf-thread-') && !id.includes('-files'));
  let tree = view.render();
  assert.deepEqual(threads(tree), ['sf-thread-D0TEST01:1.1', 'sf-thread-C0TEST09:2.1'], 'Share and the off-sidebar mention only');
  find(tree, 'sf-filter-all-projects').handlers.click({}, cx);
  assert.equal(threads(view.render()).length, 3, '전체 shows every space');
  find(view.render(), 'sf-filter-space').handlers.click({}, cx);
  assert.equal(threads(view.render()).length, 2, 'the space chip brings the start filter back');

  current.props = {window: true};
  const plain = new MentionInbox();
  plain.init(current.props, cx);
  plain.items = view.items;
  tree = plain.render();
  assert.equal(threads(tree).length, 3, 'a window opened without a space shows all');
  assert.equal(find(tree, 'sf-filter-space'), undefined);
});
