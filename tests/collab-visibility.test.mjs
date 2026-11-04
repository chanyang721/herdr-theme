import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { projectGroups, spacePartners, collabColor, COLLAB_COLORS } from '../mods/sixfold-desk/collab.js';

const spaces = [
  { id: 'home', machine: null, name: 'Game', tabs: [{ id: 'h' }] },
  { id: 'worker/w', machine: 'worker', name: 'Game (worker)', tabs: [{ id: 'worker/tw' }] },
  { id: 'solo', machine: null, name: 'Solo', tabs: [{ id: 's' }] },
];
const working = space => ({ address: `${space}-agent`, space, status: 'working' });
const labelOf = machine => machine;

test('a workspace with the same project on another computer has a partner even with no work', () => {
  const groups = projectGroups([], spaces, labelOf);
  assert.deepEqual(spacePartners(groups, spaces[0], labelOf)?.partners, ['worker']);
  assert.deepEqual(spacePartners(groups, spaces[1], labelOf)?.partners, [null]);
  assert.equal(spacePartners(groups, spaces[2], labelOf), null, 'no partner, nothing to show');
  const busy = projectGroups([working('worker/w'), working('worker/w')], spaces, labelOf);
  assert.deepEqual(spacePartners(busy, spaces[0], labelOf).working, [2], 'the partner\'s working count');
});

test('the collaboration colour follows the theme\'s lightness', () => {
  assert.equal(collabColor({ background: '#111a23' }), COLLAB_COLORS.dark);
  assert.equal(collabColor({ background: '#f8fafb' }), COLLAB_COLORS.light);
  assert.equal(collabColor({}), COLLAB_COLORS.dark, 'unknown theme: the dark one');
  assert.deepEqual(COLLAB_COLORS, { dark: '#A9B8FF', light: '#3346B8' });
});

// Render the sidebar with a fake UI that records style calls (see link-lifecycle.test.mjs).
let loads = 0;
async function sidebar(runtime) {
  let source = await readFile(new URL('../mods/sixfold-desk/main.js', import.meta.url), 'utf8');
  source = source.replace(/import \{ View, div, svg, image \} from 'gpui-kit';/, 'const {View,div,svg,image}=globalThis.__visRuntime;')
    .replace(/import \{ h_flex, v_flex \} from 'gpui-base';/, 'const {h_flex,v_flex}=globalThis.__visRuntime;')
    .replace(/import \* as herdrNative from 'herdr';/, 'const herdrNative=globalThis.__visRuntime;')
    .replace(/import \{([^}]+)\} from 'herdr';/, 'const {$1}=globalThis.__visRuntime;')
    .replace(/import \{[^}]*\} from '.\/docs.js';/, 'const currentDocs=()=>null;const docsSection=()=>null;const prepareDocsInput=()=>{};')
    .replace(/import \{ watchAlerts, alertSection, visibleAlerts \} from '.\/alerts.js';/, 'const visibleAlerts=()=>[];')
    .replace(/import .* from '.\/alert-inbox.js';/, 'const workspaceAlertsRow=()=>null, hasWorkspaceAlerts=()=>false;')
    .replace(/import \{ panePet, petRunning, RUN_FRAME_MS, RUN_FRAMES \} from '.\/pets.js';/, 'const panePet=()=>null,petRunning=()=>false,RUN_FRAME_MS=110,RUN_FRAMES=5;')
    .replace(/import \{ paneUsage \} from '.\/session-usage.js';/, 'const paneUsage=()=>null;').replace(/import \{ paneMeta, paneMetaChip, showPaneIndex, showTitle \} from '.\/pane-meta.js';/, 'const paneMeta=()=>null,paneMetaChip=()=>null,showPaneIndex=()=>false,showTitle=()=>true;')
    .replace(/import \{ watchBadges, workspaceBadges \} from '.\/badges.js';/, 'const watchBadges=()=>{},workspaceBadges=()=>null;');
  source = source.replace("import { breathingBorder, borderComet } from './collab-flow-view.js';", 'const breathingBorder=o=>{(globalThis.__breathCalls??=[]).push(o);return div().absolute().top(-1).left(-1).right(-1).bottom(-1).rounded(7).border(2).border_color(o.color);},borderComet=o=>{(globalThis.__flowCalls??=[]).push(o);return null;};');
  for (const name of ['model', 'flow', 'workflow', 'sidebar-identity', 'collab', 'collab-flow']) source = source.replace(`'./${name}.js'`, JSON.stringify(new URL(`../mods/sixfold-desk/${name}.js`, import.meta.url).href));
  source = source.replace(/import \{ pipeline \} from [^;]+;/, 'const pipeline=()=>{throw Error("unexpected path");};');
  globalThis.__visRuntime = runtime;
  source += `\n// load ${++loads}`;
  const { default: Sidebar } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  return Sidebar;
}

const RECORDED = new Set(['bg', 'border', 'border_color', 'text_color', 'absolute']);
function element() {
  let proxy;
  proxy = new Proxy({ nodes: [], calls: [] }, { get(target, key) {
    if (key === 'then') return undefined;
    if (key === 'when') return (condition, fn) => { if (condition) fn(proxy); return proxy; };
    if (key === 'id') return id => { target.rowId = id; return proxy; };
    if (key === 'child') return node => { target.nodes.push(node); return proxy; };
    if (key === 'children') return nodes => { target.nodes.push(...nodes); return proxy; };
    if (key === 'nodes' || key === 'rowId' || key === 'calls') return target[key];
    return (...args) => { if (RECORDED.has(key)) target.calls.push([key, ...args]); return proxy; };
  } });
  return proxy;
}

function runtime(agents, background = '#111a23') {
  return {
    View: class {}, div: element, svg: element, image: element, h_flex: element, v_flex: element,
    props: () => ({ role: 'sidebar' }), theme: () => ({ background }), focused: () => ({ space: 'home', tab: 'h' }),
    spaces: () => spaces, agents: () => agents, panes: () => [],
    terminals: () => [{ address: 't1' }, { address: 'worker/t1' }], window: () => ({}), layout: () => ({}),
    machines: () => [{ name: null, layout: 'ready' }, { name: 'worker', layout: 'ready' }],
    shared: () => undefined, setShared: () => {}, setAgentOrder: () => {}, run: () => {}, openOverlay: () => {},
  };
}

function view(Sidebar, extra = {}) {
  const v = new Sidebar();
  Object.assign(v, { workflowNodes: [], workflowEvents: [], pendingFlows: [], queuedRoutes: [], workspaceIcons: {}, expandedAgents: new Set(), readMessages: {}, computers: {}, messageEvents: [], activeFlows: [], ...extra });
  return v;
}

function rows(v) {
  const found = new Map();
  const visit = node => { if (!node || typeof node !== 'object') return; if (node.rowId) found.set(node.rowId, node); for (const child of node.nodes ?? []) visit(child); };
  visit(v.render());
  return found;
}

const text = node => (node?.nodes ?? []).flatMap(child => typeof child === 'string' ? [child] : text(child));
const has = (node, ...call) => node.calls.some(item => JSON.stringify(item) === JSON.stringify(call));
// The 2px outline drawn over a box: an absolute child with border 2 in the colour.
const outlined = (node, color) => node.nodes.some(child => child?.calls && has(child, 'absolute') && has(child, 'border', 2) && has(child, 'border_color', color));

test('idle partner: the header shows the partner computer in the collaboration colour, nothing else', async () => {
  try {
    const found = rows(view(await sidebar(runtime([]))));
    const tail = found.get('sf-partner-home');
    assert(tail, 'the partner tail is shown with no work');
    assert.deepEqual(text(tail), ['worker']);
    assert(has(tail, 'text_color', COLLAB_COLORS.dark));
    assert(!found.has('sf-partner-solo'), 'no partner, no tail');
    assert(!found.has('sf-space-mark-home'), 'no shared work, no ⇄ badge');
    assert(!outlined(found.get('sf-space-home'), COLLAB_COLORS.dark), 'no outline while idle');
  } finally { delete globalThis.__visRuntime; }
});

test('shared work now: 2px outline, 10% tint and a filled ⇄ badge; light theme uses the light colour', async () => {
  try {
    let found = rows(view(await sidebar(runtime([working('home'), working('worker/w')]))));
    const box = found.get('sf-space-home');
    assert(outlined(box, COLLAB_COLORS.dark), '2px outline drawn over the box');
    assert(has(box, 'bg', COLLAB_COLORS.dark + '1A'), '10% tint');
    const badge = found.get('sf-space-mark-home');
    assert.deepEqual(text(badge), ['⇄']);
    assert(has(badge, 'bg', COLLAB_COLORS.dark), 'a filled badge');
    found = rows(view(await sidebar(runtime([working('home'), working('worker/w')], '#f8fafb'))));
    assert(has(found.get('sf-space-mark-home'), 'bg', COLLAB_COLORS.light));
  } finally { delete globalThis.__visRuntime; }
});

test('hovering a workspace lights its partner computer row, and hovering that row lights the workspace', async () => {
  try {
    const Sidebar = await sidebar(runtime([]));
    let found = rows(view(Sidebar, { hoverSpace: 'home' }));
    const row = found.get('sf-computer-remote:worker');
    assert(outlined(row, COLLAB_COLORS.dark) && has(row, 'bg', COLLAB_COLORS.dark + '1A'), 'partner computer row outlined and tinted');
    assert(!outlined(found.get('sf-computer-local'), COLLAB_COLORS.dark), 'this computer is not the partner');
    found = rows(view(Sidebar, { hoverComputer: 'worker' }));
    assert(outlined(found.get('sf-space-home'), COLLAB_COLORS.dark), 'the partner workspace lights up');
    assert(!outlined(found.get('sf-space-solo'), COLLAB_COLORS.dark));
  } finally { delete globalThis.__visRuntime; }
});

// ⑪ Two groups working together now: each has its own colour; the borders breathe (D) on their own
// periods, and a send between the computers starts a comet (F) on both. With motion off nothing
// moves: no breathing loop, no comet. The view module is stubbed (calls recorded).
test('two collaborating groups: own colours, breathing borders, and comets after a send; motion off keeps them still', async () => {
  const twoGroups = [
    { id: 'home', machine: null, name: 'Game', tabs: [{ id: 'h' }] },
    { id: 'docs', machine: null, name: 'Docs', tabs: [{ id: 'd' }] },
    { id: 'worker/w', machine: 'worker', name: 'Game (worker)', tabs: [{ id: 'worker/tw' }] },
    { id: 'worker/d', machine: 'worker', name: 'Docs', tabs: [{ id: 'worker/td' }] },
  ];
  const all = ['home', 'docs', 'worker/w', 'worker/d'].map(working);
  const make = motion => ({ ...runtime(all), spaces: () => twoGroups, shared: key => (key === 'sixfold.motion' ? motion : undefined) });
  const sizes = { home: { w: 190, h: 96 }, docs: { w: 190, h: 96 } };
  const reset = () => { globalThis.__flowCalls = []; globalThis.__breathCalls = []; };
  try {
    reset();
    let v = view(await sidebar(make(true)), { boxSizes: sizes });
    let found = rows(v);
    const badge = id => found.get(`sf-space-mark-${id}`).calls.find(call => call[0] === 'bg')?.[1];
    assert.notEqual(badge('home'), badge('docs'), 'one colour per group');
    const breaths = globalThis.__breathCalls;
    assert.deepEqual(breaths.map(call => call.id).sort(), ['docs', 'home'], 'both collaborating borders breathe');
    assert.notEqual(breaths[0].period, breaths[1].period, 'on staggered periods');
    assert.ok(breaths.every(call => call.motion && !call.dim));
    assert.equal(globalThis.__flowCalls.length, 0, 'no comet without a message');
    assert.equal(v.collabFlowing, false, 'and no corner timer');

    reset();
    const at = Date.now() - 1700;                       // the packet arrived 0.1 s ago
    v = view(await sidebar(make(true)), { boxSizes: sizes, messageEvents: [{ id: 's1', seq: 1, source: 't1', target: 'worker/t1', at }] });
    rows(v);
    assert.deepEqual(globalThis.__flowCalls.map(call => call.id).sort(), ['docs', 'home'], 'a send between the computers runs a comet on each group');
    assert.ok(globalThis.__flowCalls.every(call => call.step === 1 && call.w === 190));
    assert.ok(globalThis.__breathCalls.every(call => call.dim), 'the border is the faint track while the comet runs');
    assert.equal(v.collabFlowing, true);

    reset();
    v = view(await sidebar(make(false)), { boxSizes: sizes, messageEvents: [{ id: 's1', seq: 1, source: 't1', target: 'worker/t1', at }] });
    rows(v);
    assert.equal(globalThis.__flowCalls.length, 0, 'motion off: no comet');
    assert.ok(globalThis.__breathCalls.every(call => call.motion === false), 'motion off: the border does not breathe');
    assert.equal(v.collabFlowing, false);
  } finally { delete globalThis.__visRuntime; delete globalThis.__flowCalls; delete globalThis.__breathCalls; }
});

test('a single collaborating group keeps ⑨\'s colour', async () => {
  try {
    const found = rows(view(await sidebar(runtime([working('home'), working('worker/w')]))));
    assert.equal(found.get('sf-space-mark-home').calls.find(call => call[0] === 'bg')?.[1], COLLAB_COLORS.dark);
  } finally { delete globalThis.__visRuntime; delete globalThis.__breathCalls; }
});

test('motion off stops the stock spinner and the idle breathing too', async () => {
  const source = await readFile(new URL('../mods/sixfold-desk/main.js', import.meta.url), 'utf8');
  assert.match(source, /when\(shared\('sixfold\.motion'\)!==false,e=>e\.spin\(900\)\)/);
  assert.match(source, /when\(shared\('sixfold\.motion'\)!==false,e=>e\.loop\('opacity'/);
  const tabs = await readFile(new URL('../mods/sixfold-tabs/main.js', import.meta.url), 'utf8');
  assert.match(tabs, /shared\("sixfold\.motion"\) !== false, e => e\.spin\(900\)/);
  for (const text of [source, tabs]) {
    for (const call of text.match(/\.(?:spin|loop)\(/g) ?? []) assert.ok(call);   // every one below is guarded
    const unguarded = text.split('\n').filter(line => /\.(spin|loop)\(/.test(line) && !/motion/.test(line));
    assert.deepEqual(unguarded, [], 'every loop and spin is behind sixfold.motion');
  }
});
