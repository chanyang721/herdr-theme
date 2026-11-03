import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { trackLinks, liveLinks, LINK_FADE_MS, LINK_SEND_MS } from '../mods/sixfold-desk/collab.js';

const link = (key, extra = {}) => ({ key, name: null, machines: [null, key], working: true, ...extra });

test('an ended link fades, then leaves, and says when', () => {
  const seen = new Map();
  trackLinks(seen, [link('a')], 0);
  let result = trackLinks(seen, [], 1000);
  assert.equal(seen.get('a').gone, 1000, 'fading');
  assert.equal(result.wake, 1000 + LINK_FADE_MS, 'redraw due when the fade ends');
  result = trackLinks(seen, [], 1000 + LINK_FADE_MS);
  assert.equal(seen.size, 0);
  assert.equal(result.wake, null);
});

test('without motion an ended link leaves at once', () => {
  const seen = new Map();
  trackLinks(seen, [link('a')], 0, false);
  trackLinks(seen, [], 10, false);
  assert.equal(seen.size, 0);
});

test('a send link is due to end five minutes after its last send', () => {
  const links = liveLinks([], [{ event: { at: 5000 }, hop: { from: null, to: 'sub1' } }, { event: { at: 2000 }, hop: { from: 'sub1', to: null } }], 6000);
  assert.equal(links.length, 1);
  assert.equal(links[0].until, 5000 + LINK_SEND_MS);
  assert.equal(trackLinks(new Map(), links, 6000).wake, 5000 + LINK_SEND_MS);
});

test('lanes freed by ended links go to new ones in the same pass', () => {
  const seen = new Map();
  trackLinks(seen, ['a', 'b', 'c', 'd'].map(key => link(key)), 0);
  trackLinks(seen, [], 100);
  const result = trackLinks(seen, [link('e')], 100 + LINK_FADE_MS);
  assert.deepEqual(result.lanes.map(item => [item.link.key, item.slot]), [['e', 0]]);
});

test('with every lane fading, the longest-fading one gives its lane to a new link', () => {
  const seen = new Map();
  trackLinks(seen, ['a', 'b', 'c', 'd'].map(key => link(key)), 0);
  trackLinks(seen, ['b', 'c', 'd'].map(key => link(key)), 100);
  trackLinks(seen, [], 200);
  const result = trackLinks(seen, [link('e')], 300);
  assert.deepEqual(result.lanes.map(item => item.link.key).sort(), ['b', 'c', 'd', 'e']);
  assert.equal(seen.get('e').slot, 0, 'a faded first and gave up lane 0');
});

// Render the sidebar with a fake UI, as tests/computers.test.mjs does, to check what
// the computer list draws for sends between computers.
async function sidebar(runtime) {
  let source = await readFile(new URL('../mods/sixfold-desk/main.js', import.meta.url), 'utf8');
  source = source.replace(/import \{ View, div, svg, image \} from 'gpui-kit';/, 'const {View,div,svg,image}=globalThis.__linkRuntime;')
    .replace(/import \{ h_flex, v_flex \} from 'gpui-base';/, 'const {h_flex,v_flex}=globalThis.__linkRuntime;')
    .replace(/import \* as herdrNative from 'herdr';/, 'const herdrNative=globalThis.__linkRuntime;')
    .replace(/import \{([^}]+)\} from 'herdr';/, 'const {$1}=globalThis.__linkRuntime;')
    .replace(/import \{[^}]*\} from '.\/docs.js';/, 'const currentDocs=()=>null;const docsSection=()=>null;const prepareDocsInput=()=>{};')
    .replace(/import \{ watchAlerts, alertSection, visibleAlerts \} from '.\/alerts.js';/, 'const visibleAlerts=()=>[];')
    .replace(/import .* from '.\/alert-inbox.js';/, 'const workspaceAlertsRow=()=>null, hasWorkspaceAlerts=()=>false;');
  for (const name of ['model', 'flow', 'workflow', 'sidebar-identity', 'collab']) source = source.replace(`'./${name}.js'`, JSON.stringify(new URL(`../mods/sixfold-desk/${name}.js`, import.meta.url).href));
  source = source.replace(/import \{ pipeline \} from [^;]+;/, 'const pipeline=()=>{throw Error("unexpected path");};');
  globalThis.__linkRuntime = runtime;
  const { default: Sidebar } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  return Sidebar;
}

function element() {
  let proxy;
  proxy = new Proxy({ nodes: [] }, { get(target, key) {
    if (key === 'then') return undefined;
    if (key === 'when') return (condition, fn) => { if (condition) fn(proxy); return proxy; };
    if (key === 'id') return id => { target.rowId = id; return proxy; };
    if (key === 'child') return node => { target.nodes.push(node); return proxy; };
    if (key === 'children') return nodes => { target.nodes.push(...nodes); return proxy; };
    if (key === 'top') return value => { target.topValue = value; return proxy; };
    if (key === 'nodes' || key === 'rowId' || key === 'topValue') return target[key];
    return () => proxy;
  } });
  return proxy;
}

test('two same-way sends between computers each get a packet, and the link schedules its end', async () => {
  const runtime = {
    View: class {}, div: element, svg: element, image: element, h_flex: element, v_flex: element,
    props: () => ({ role: 'sidebar' }), theme: () => ({}), focused: () => ({ space: 'home', tab: 'h' }),
    spaces: () => [{ id: 'home', machine: null, name: 'Home', tabs: [{ id: 'h' }] }, { id: 'worker/w', machine: 'worker', name: 'Worker', tabs: [{ id: 'worker/tw' }] }],
    agents: () => [], panes: () => [], terminals: () => [{ address: 't1' }, { address: 'worker/t1' }], window: () => ({}), layout: () => ({}),
    machines: () => [{ name: null, layout: 'ready' }, { name: 'worker', layout: 'ready' }],
    shared: () => undefined, setShared: () => {}, setAgentOrder: () => {}, run: () => {}, openOverlay: () => {},
  };
  try {
    const Sidebar = await sidebar(runtime);
    const view = new Sidebar();
    const at = Date.now() - 1000;
    Object.assign(view, {
      workflowNodes: [], workflowEvents: [], pendingFlows: [], queuedRoutes: [], workspaceIcons: {}, expandedAgents: new Set(), readMessages: {}, computers: {},
      messageEvents: [{ id: 'a', seq: 1, source: 't1', target: 'worker/t1', at }, { id: 'b', seq: 2, source: 't1', target: 'worker/t1', at: at + 500 }],
      activeFlows: [{ id: 'a', source: 't1', target: 'worker/t1', at, lane: 0, phase: 'travel', travelMs: 1600 },
                    { id: 'b', source: 't1', target: 'worker/t1', at: at + 500, lane: 0, phase: 'start', travelMs: 1780 }],
    });
    const rows = new Map();
    const visit = node => { if (!node || typeof node !== 'object') return; if (node.rowId) rows.set(node.rowId, node); for (const child of node.nodes ?? []) visit(child); };
    visit(view.render());
    assert(rows.has('sf-link-send-a') && rows.has('sf-link-send-b'), 'one packet per send');
    assert.notEqual(rows.get('sf-link-send-a').topValue, rows.get('sf-link-send-b').topValue, 'the later send starts from the sender while the first travels');
    assert.equal(view.linkWake, at + 500 + LINK_SEND_MS, 'the link is due to end five minutes after the last send');
  } finally { delete globalThis.__linkRuntime; }
});
