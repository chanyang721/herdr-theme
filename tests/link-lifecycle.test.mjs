import {classicPanelImports} from './classic-panel-imports.mjs';
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
let loads = 0;
async function sidebar(runtime) {
  let source = await readFile(new URL('../mods/sixfold-desk/main.js', import.meta.url), 'utf8');
  source=source.replace("'./panel-host.js'",JSON.stringify(new URL('../mods/sixfold-desk/panel-host.js',import.meta.url).href));
  source=classicPanelImports(source).replace("'./panel-model.js'",JSON.stringify(new URL('../mods/sixfold-desk/panel-model.js',import.meta.url).href));
  source=source.replace("import {createRetainedPanel} from './panel-retained.js';",'const createRetainedPanel=()=>null;');
  for(const name of ['task-feed-source','task-issue-state'])source=source.replace(`'./${name}.js'`,JSON.stringify(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url).href));
  source=source.replace("import {createRetainedCards} from './retained-cards.js';",'const createRetainedCards=()=>({begin(){},card(_id,_signature,build){return build();},end(){},dispose(){}});');
  source=source.replace(/import .* from '.\/panel-io.js';/,'const subscribeJsonFile=()=>()=>{},readJsonSnapshot=async()=>({status:"missing",hash:null}),FILE_CHANGED_COMMAND="file-feed-changed",fileDelivery=()=>({enqueue:(callback,value)=>callback(value),flush(){}});')
    .replace(/import .* from '.\/sidebar-files.js';/,'const watchSidebarFiles=()=>{};')
    .replace(/import .* from '.\/mic.js';/,"const watchMic=()=>{},paneMic=()=>null,paneMicChip=()=>null,MIC_KEY='sixfold.voice.mic';")
    .replace("'./live-events.js'",JSON.stringify(new URL('../mods/sixfold-desk/live-events.js',import.meta.url).href));
  source = source.replace(/import \{ View, div, svg, image \} from 'gpui-kit';/, 'const {View,div,svg,image}=globalThis.__linkRuntime;')
    .replace(/import \{ h_flex, v_flex \} from 'gpui-base';/, 'const {h_flex,v_flex}=globalThis.__linkRuntime;')
    .replace(/import \* as herdrNative from 'herdr';/, 'const herdrNative=globalThis.__linkRuntime;')
    .replace(/import \{([^}]+)\} from 'herdr';/, 'const {$1}=globalThis.__linkRuntime;')
    .replace(/import \{[^}]*\} from '.\/docs.js';/, 'const currentDocs=()=>null;const docsSection=()=>null;const prepareDocsInput=()=>{};')
    .replace(/import \{ watchAlerts, alertSection, visibleAlerts \} from '.\/alerts.js';/, 'const visibleAlerts=()=>[];')
    .replace(/import .* from '.\/alert-inbox.js';/, 'const workspaceAlertsRow=()=>null, hasWorkspaceAlerts=()=>false;')
    .replace(/import \{ panePet \} from '.\/pets.js';/, 'const panePet=()=>null;')
    .replace(/import \{ paneUsage \} from '.\/session-usage.js';/, 'const paneUsage=()=>null;').replace(/import \{ paneMeta, paneMetaChip, showPaneIndex, showTitle \} from '.\/pane-meta.js';/,'const paneMeta=()=>null,paneMetaChip=()=>null,showPaneIndex=()=>false,showTitle=()=>true;')
    .replace(/import \{ watchBadges, workspaceBadges \} from '.\/badges.js';/, 'const watchBadges=()=>{},workspaceBadges=()=>null;').replace(/import \{ watchAsks[^}]*\} from '.\/asks.js';/,'const watchAsks=()=>{},askSection=()=>null,hasAsks=()=>false;').replace(/import \{ askFor \} from '.\/ask-model.js';/,'const askFor=()=>null;').replace(/import \{ watchReports[^}]*\} from '.\/session-reports.js';/,'const watchReports=()=>{},reportsSection=()=>null;');
  source = source.replace("import { breathingBorder, borderComet } from './collab-flow-view.js';", 'const breathingBorder=o=>{(globalThis.__breathCalls??=[]).push(o);return div().absolute().top(-1).left(-1).right(-1).bottom(-1).rounded(7).border(2).border_color(o.color);},borderComet=o=>{(globalThis.__flowCalls??=[]).push(o);return null;};');
  for (const name of ['model', 'flow', 'workflow', 'sidebar-identity', 'collab', 'collab-flow']) source = source.replace(`'./${name}.js'`, JSON.stringify(new URL(`../mods/sixfold-desk/${name}.js`, import.meta.url).href));
  source = source.replace(/import \{ pipeline \} from [^;]+;/, 'const pipeline=()=>{throw Error("unexpected path");};');
  globalThis.__linkRuntime = runtime;
  // A distinct source per call: the module reads its runtime once, at import.
  source += `\n// load ${++loads}`;
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
    if (key === 'w' || key === 'size') return value => { target[key + 'Value'] = value; return proxy; };
    if (key === 'nodes' || key === 'rowId' || key === 'topValue' || key === 'wValue' || key === 'sizeValue') return target[key];
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
    for (const id of ['sf-link-send-a', 'sf-link-send-b']) {
      // 2026-11-09: a 5px dot stuck out of the 1px pipe; a packet is as wide as the line.
      assert.equal(rows.get(id).wValue, 1, `${id} stays inside the pipe`);
      assert.equal(rows.get(id).sizeValue, undefined, `${id} is not a round dot`);
    }
    assert.equal(view.linkWake, at + 500 + LINK_SEND_MS, 'the link is due to end five minutes after the last send');
  } finally { delete globalThis.__linkRuntime; }
});

function sidebarRuntime(spaces, agents, machines) {
  return {
    View: class {}, div: element, svg: element, image: element, h_flex: element, v_flex: element,
    props: () => ({ role: 'sidebar' }), theme: () => ({}), focused: () => ({ space: spaces[0].id, tab: spaces[0].tabs[0].id }),
    spaces: () => spaces, agents: () => agents, panes: () => [],
    terminals: () => [{ address: 't1' }, { address: 'worker/t1' }, { address: 'other/t1' }], window: () => ({}), layout: () => ({}),
    machines: () => machines.map(name => ({ name, layout: 'ready' })),
    shared: () => undefined, setShared: () => {}, setAgentOrder: () => {}, run: () => {}, openOverlay: () => {},
  };
}

function renderRows(view) {
  const rows = new Map();
  const visit = node => { if (!node || typeof node !== 'object') return; if (node.rowId) rows.set(node.rowId, node); for (const child of node.nodes ?? []) visit(child); };
  visit(view.render());
  return rows;
}

function quietView(Sidebar, messageEvents = []) {
  const view = new Sidebar();
  Object.assign(view, { workflowNodes: [], workflowEvents: [], pendingFlows: [], queuedRoutes: [], workspaceIcons: {}, expandedAgents: new Set(), readMessages: {}, computers: {}, messageEvents, activeFlows: [] });
  return view;
}

test('a workspace worked on from other computers carries ⇄ on its border, with a count from two up', async () => {
  const spaces = [
    { id: 'home', machine: null, name: 'Game', tabs: [{ id: 'h' }] },
    { id: 'worker/w', machine: 'worker', name: 'Game (worker)', tabs: [{ id: 'worker/tw' }] },
    { id: 'other/o', machine: 'other', name: 'Game', tabs: [{ id: 'other/to' }] },
  ];
  const working = space => ({ address: `${space}-agent`, space, status: 'working' });
  try {
    let Sidebar = await sidebar(sidebarRuntime(spaces, [working('home'), working('worker/w')], [null, 'worker', 'other']));
    let rows = renderRows(quietView(Sidebar));
    assert.deepEqual(rows.get('sf-space-mark-home')?.nodes, ['⇄'], 'one other computer: the mark alone');
    Sidebar = await sidebar(sidebarRuntime(spaces, [working('home'), working('worker/w'), working('other/o')], [null, 'worker', 'other']));
    rows = renderRows(quietView(Sidebar));
    assert.deepEqual(rows.get('sf-space-mark-home')?.nodes, ['⇄2'], 'two other computers: the mark and their number');
    Sidebar = await sidebar(sidebarRuntime(spaces, [working('home')], [null, 'worker', 'other']));
    rows = renderRows(quietView(Sidebar));
    assert(!rows.has('sf-space-mark-home'), 'no shared work, no mark');
  } finally { delete globalThis.__linkRuntime; }
});

test('after a send link has gone, the ten-minute counts still schedule their redraw', async () => {
  const spaces = [{ id: 'home', machine: null, name: 'Home', tabs: [{ id: 'h' }] }, { id: 'worker/w', machine: 'worker', name: 'Worker', tabs: [{ id: 'worker/tw' }] }];
  try {
    const Sidebar = await sidebar(sidebarRuntime(spaces, [], [null, 'worker']));
    const at = Date.now() - 6 * 60 * 1000;
    const view = quietView(Sidebar, [{ id: 'a', seq: 1, source: 't1', target: 'worker/t1', at }]);
    renderRows(view);
    assert.equal(view.linkSeen.size, 0, 'past five minutes the send no longer links the computers');
    assert.equal(view.linkWake, at + 10 * 60 * 1000 + 1, 'redraw when the send leaves the ↑/↓ window');
  } finally { delete globalThis.__linkRuntime; }
});

test('a mod pane (no terminal) gets no session row and is not counted', async () => {
  const spaces = [{ id: 'home', machine: null, name: 'Docs', tabs: [{ id: 'h' }] }];
  const runtime = sidebarRuntime(spaces, [{ address: 't1', space: 'home', status: 'idle' }], [null]);
  runtime.panes = () => [
    { pane: 'p1', terminal: 't1', tab: 'h', title: 'Writer', status: 'idle' },
    { pane: 'p2', terminal: null, mod: 'project-docs-tabs', tab: 'h', title: 'project-docs-tabs' },
  ];
  try {
    const Sidebar = await sidebar(runtime);
    const rows = renderRows(quietView(Sidebar));
    assert(rows.has('sf-member-p1'), 'the terminal keeps its row');
    assert(!rows.has('sf-member-p2'), 'the mod pane has none');
  } finally { delete globalThis.__linkRuntime; }
});
