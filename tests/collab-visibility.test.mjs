import {classicPanelImports} from './classic-panel-imports.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { projectGroups, spacePartners, collabColor, COLLAB_COLORS } from '../mods/sixfold-desk/collab.js';
import { FLOW } from '../mods/sixfold-desk/collab-flow.js';

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
  source=source.replace("'./panel-host.js'",JSON.stringify(new URL('../mods/sixfold-desk/panel-host.js',import.meta.url).href));
  source=classicPanelImports(source).replace("'./panel-model.js'",JSON.stringify(new URL('../mods/sixfold-desk/panel-model.js',import.meta.url).href));
  source=source.replace("import {createRetainedPanel} from './panel-retained.js';",'const createRetainedPanel=()=>null;');
  for(const name of ['task-feed-source','task-issue-state'])source=source.replace(`'./${name}.js'`,JSON.stringify(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url).href));
  source=source.replace("import {createRetainedCards} from './retained-cards.js';",'const createRetainedCards=()=>({begin(){},card(_id,_signature,build){return build();},end(){},dispose(){}});');
  source=source.replace(/import .* from '.\/panel-io.js';/,'const subscribeJsonFile=()=>()=>{},readJsonSnapshot=async()=>({status:"missing",hash:null}),FILE_CHANGED_COMMAND="file-feed-changed",fileDelivery=()=>({enqueue:(callback,value)=>callback(value),flush(){}});')
    .replace(/import .* from '.\/sidebar-files.js';/,'const watchSidebarFiles=()=>{};')
    .replace(/import .* from '.\/mic.js';/,"const watchMic=()=>{},paneMic=()=>null,paneMicChip=()=>null,MIC_KEY='sixfold.voice.mic';")
    .replace("'./live-events.js'",JSON.stringify(new URL('../mods/sixfold-desk/live-events.js',import.meta.url).href));
  source = source.replace(/import \{ View, div, svg, image \} from 'gpui-kit';/, 'const {View,div,svg,image}=globalThis.__visRuntime;')
    .replace(/import \{ h_flex, v_flex \} from 'gpui-base';/, 'const {h_flex,v_flex}=globalThis.__visRuntime;')
    .replace(/import \* as herdrNative from 'herdr';/, 'const herdrNative=globalThis.__visRuntime;')
    .replace(/import \{([^}]+)\} from 'herdr';/, 'const {$1}=globalThis.__visRuntime;')
    .replace(/import \{[^}]*\} from '.\/docs-finder.js';/,"const docsFinder=(_view,_space,trigger)=>trigger,docsFinderSignature=()=>null,setDocsFinderOpen=()=>{},docsGroup=()=>null;").replace(/import \{[^}]*\} from '.\/docs.js';/, 'const watchDocs=()=>{};const currentDocs=()=>null;const docsSection=()=>null;const prepareDocsInput=()=>{};')
    .replace(/import \{ watchAlerts, alertSection, visibleAlerts \} from '.\/alerts.js';/, 'const watchAlerts=()=>{};const visibleAlerts=()=>[];')
    .replace(/import .* from '.\/alert-inbox.js';/, 'const workspaceAlertsRow=()=>null, hasWorkspaceAlerts=()=>false;').replace(/import .* from '.\/alert-arrivals.js';/,"const startAlertArrivals=()=>()=>{},alertArrivalLayer=()=>[],alertCardSignature=()=>'';")
    .replace(/import \{ panePet \} from '.\/pets.js';/, 'const panePet=()=>null;')
    .replace(/import \{ paneUsage \} from '.\/session-usage.js';/, 'const paneUsage=()=>null;').replace(/import \{ paneWork, paneWorkChip \} from '.\/pane-work.js';/,'const paneWork=()=>null,paneWorkChip=()=>null;').replace(/import \{ paneMeta, paneMetaChip, showPaneIndex, showTitle \} from '.\/pane-meta.js';/, 'const paneMeta=()=>null,paneMetaChip=()=>null,showPaneIndex=()=>false,showTitle=()=>true;')
    .replace(/import \{ watchBadges, workspaceBadges \} from '.\/badges.js';/, 'const watchBadges=()=>{},workspaceBadges=()=>null;').replace(/import \{ watchAsks[^}]*\} from '.\/asks.js';/,'const watchAsks=()=>{},askSection=()=>null,hasAsks=()=>false;').replace(/import \{ askFor \} from '.\/ask-model.js';/,'const askFor=()=>null;').replace(/import \{ watchReports[^}]*\} from '.\/session-reports.js';/,'const watchReports=()=>{},reportsSection=()=>null;');
  source = source.replace("import { breathingBorder, borderComet } from './collab-flow-view.js';", 'const breathingBorder=o=>{(globalThis.__breathCalls??=[]).push(o);return div().absolute().top(-1).left(-1).right(-1).bottom(-1).rounded(7).border(2).border_color(o.color);},borderComet=o=>{(globalThis.__flowCalls??=[]).push(o);return null;};');
  for (const name of ['model', 'flow', 'workflow', 'sidebar-identity', 'collab', 'collab-flow']) source = source.replace(`'./${name}.js'`, JSON.stringify(new URL(`../mods/sixfold-desk/${name}.js`, import.meta.url).href));
  source = source.replace(/import \{ pipeline \} from [^;]+;/, 'const pipeline=o=>{(globalThis.__pipelineCalls??=[]).push(o);return div();};');
  globalThis.__visRuntime = runtime;
  source += `\n// load ${++loads}`;
  const { default: Sidebar } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  return Sidebar;
}

const RECORDED = new Set(['bg', 'border', 'border_color', 'text_color', 'absolute', 'on_size_change']);
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
    settings: () => ({zoom: 1}),
  };
}

function view(Sidebar, extra = {}) {
  const v = new Sidebar();
  Object.assign(v, { workflowNodes: [], workflowEvents: [], pendingFlows: [], queuedRoutes: [], workspaceIcons: {}, expandedAgents: new Set(), readMessages: {}, computers: {}, messageEvents: [], activeFlows: [], ...extra });
  return v;
}

function rows(v, cx) {
  const found = new Map();
  const visit = node => { if (!node || typeof node !== 'object') return; if (node.rowId) found.set(node.rowId, node); for (const child of node.nodes ?? []) visit(child); };
  visit(v.render(cx));
  return found;
}

const text = node => (node?.nodes ?? []).flatMap(child => typeof child === 'string' ? [child] : text(child));
const has = (node, ...call) => node.calls.some(item => JSON.stringify(item) === JSON.stringify(call));
// The 2px outline drawn over a box: an absolute child with border 2 in the colour.
const outlined = (node, color) => node.nodes.some(child => child?.calls && has(child, 'absolute') && has(child, 'border', 2) && has(child, 'border_color', color));

test('workspace curves enter the receiver group colour only for its active cross-computer partners', async () => {
  const inventory = [
    {id:'home',name:'Game',machine:null,tabs:[{id:'h'}]},
    {id:'docs',name:'Docs',machine:null,tabs:[{id:'d'}]},
    {id:'worker/w',name:'Game',machine:'worker',tabs:[{id:'worker/w'}]},
    {id:'worker/d',name:'Docs',machine:'worker',tabs:[{id:'worker/d'}]},
    {id:'solo',name:'Solo',machine:null,tabs:[{id:'s'}]},
    {id:'worker/solo',name:'Remote only',machine:'worker',tabs:[{id:'worker/s'}]},
    {id:'other/w',name:'Game',machine:'other',tabs:[{id:'other/w'}]},
    {id:'stray/w',name:'Unrelated',machine:'stray',tabs:[{id:'stray/w'}]},
  ];
  const addresses = ['t1','t3','worker/t1','worker/t3','t2','worker/t2','other/t1','stray/t1'];
  const members = inventory.map((space,i)=>({pane:'p'+i,tab:space.tabs[0].id,terminal:addresses[i],title:'Session',status:'working'}));
  const allAgents = inventory.map((space,i)=>({...working(space.id),address:addresses[i]}));
  let active = allAgents, shownComputer = 'local';
  const rt = {...runtime([]),spaces:()=>inventory,panes:()=>members,terminals:()=>addresses.map(address=>({address})),agents:()=>active,
    theme:()=>({background:'#111a23',accent:'#00AABB',ansi6:'#114455'}),shared:key=>key==='sixfold.computing.selected'?shownComputer:undefined,
    machines:()=>[null,'worker','other','stray'].map(name=>({name,layout:'ready'}))};
  try {
    const Sidebar = await sidebar(rt);
    const curve = (source,target,lane=0) => {
      globalThis.__pipelineCalls=[];
      const found=rows(view(Sidebar,{activeFlows:[{id:'send',source,target,lane,at:Date.now(),phase:'travel'}]}));
      assert.equal(globalThis.__pipelineCalls.length,1,'one visible workspace curve');
      return {color:globalThis.__pipelineCalls[0].color,found};
    };
    const badgeColor = (found,id)=>found.get('sf-space-mark-'+id).calls.find(call=>call[0]==='bg')[1];
    let result=curve('worker/t1','t1');
    assert.equal(result.color,badgeColor(result.found,'home'),'incoming shared project matches its border');
    result=curve('t1','worker/t3');
    assert.equal(result.color,badgeColor(result.found,'docs'),'outgoing flow follows the receiver project colour');
    assert.notEqual(result.color,badgeColor(result.found,'home'),'the sender project does not choose the colour');
    assert.equal(curve('t1','t3',1).color,'#114455','same computer keeps its lane palette even between active groups');
    assert.equal(curve('t1','worker/t2').color,'#00AABB','remote non-collaboration keeps its palette');
    assert.equal(curve('stray/t1','t1').color,'#00AABB','unrelated computer is not a partner of the active receiver');
    active=allAgents.filter(agent=>agent.space!=='worker/w'&&agent.space!=='other/w');
    assert.equal(curve('worker/t1','t1').color,'#00AABB','a shared name without active collaboration keeps its palette');
    active=[...allAgents.filter(agent=>agent.address!=='t1'),{...working('home'),address:'home-helper'}];
    result=curve('worker/t1','t1');
    assert.equal(result.color,badgeColor(result.found,'home'),'a recipient without agent metadata resolves through its pane');
    active=allAgents;
    shownComputer='remote:worker';
    result=curve('worker/t1','other/t1');
    assert.equal(result.color,badgeColor(result.found,'worker/w'),'a remote-to-remote pair uses the receiving group colour too');
  } finally { delete globalThis.__visRuntime; delete globalThis.__pipelineCalls; delete globalThis.__breathCalls; delete globalThis.__flowCalls; }
});

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

test('a fifth shared project still breathes and carries a badge beyond the four pipe lanes', async () => {
  const names = ['A0', 'A1', 'A2', 'A3', 'Game'];
  const many = names.flatMap(name => [
    { id: `here-${name}`, machine: null, name, tabs: [{ id: `h-${name}` }] },
    { id: `worker/${name}`, machine: 'worker', name, tabs: [{ id: `worker/t-${name}` }] },
  ]);
  const rt = { ...runtime(many.map(space => working(space.id))), spaces: () => many, focused: () => ({ space: 'here-A0', tab: 'h-A0' }) };
  try {
    globalThis.__breathCalls = [];
    const found = rows(view(await sidebar(rt)));
    assert.equal(globalThis.__breathCalls.length, 5);
    for (const name of names) {
      const badge = found.get(`sf-space-mark-here-${name}`);
      const color = badge.calls.find(call => call[0] === 'bg')[1];
      assert(outlined(found.get(`sf-space-here-${name}`), color), `${name}: outlined`);
      assert.deepEqual(text(badge), ['⇄'], `${name}: badge`);
    }
  } finally { delete globalThis.__visRuntime; delete globalThis.__breathCalls; }
});

test('ended work and hover have no breathing or comet, even while the old pipe fades', async () => {
  let active = [working('home'), working('worker/w')];
  const rt = {...runtime([]), agents: () => active};
  try {
    const v = view(await sidebar(rt), {boxSizes: {home: {w: 190, h: 96}}, messageEvents: [{id: 's1', source: 't1', target: 'worker/t1', at: Date.now() - 1700}]});
    rows(v);
    active = [];
    globalThis.__breathCalls = [];
    globalThis.__flowCalls = [];
    v.hoverComputer = 'worker';
    const found = rows(v);
    assert.deepEqual(globalThis.__breathCalls, []);
    assert.deepEqual(globalThis.__flowCalls, []);
    assert.equal(v.collabFlowing, false);
    assert(outlined(found.get('sf-space-home'), COLLAB_COLORS.dark), 'static hover outline remains');
  } finally { delete globalThis.__visRuntime; delete globalThis.__breathCalls; delete globalThis.__flowCalls; }
});

test('the comet timer wakes only on the next boundary and cancels when motion stops', async () => {
  const realNow = Date.now;
  let now = 100000, motion = true, notifications = 0;
  const scheduled = [], tasks = [], intervals = [];
  const cx = {
    notify() { notifications++; },
    spawn(task) { const promise = task(cx); tasks.push(promise); return promise; },
    timer: {
      every(ms, callback) { intervals.push({ms, callback}); },
      after(ms, callback) {
        const task = {at: now + ms, callback, cancelled: false, cancel() {this.cancelled = true;}};
        scheduled.push(task);
        return task;
      },
    },
  };
  const rt = {...runtime([working('home'), working('worker/w')]), shared: key => key === 'sixfold.motion' ? motion : undefined,
    appHome: () => '/app', readTextFile: async () => {throw Error('absent');}, nextCommand: () => new Promise(() => {})};
  try {
    Date.now = () => now;
    const Sidebar = await sidebar(rt);
    const v = new Sidebar();
    v.init({}, cx);
    await tasks[0];
    v.messageEvents = [{id: 's1', source: 't1', target: 'worker/t1', at: now}];
    rows(v, cx);
    assert.equal(v.cometTimer.at, now + FLOW.arriveMs - FLOW.edgeMs, 'place the comet before its arrival');
    assert(!intervals.some(item => item.ms === FLOW.edgeMs), 'no free-running corner interval');
    const count = scheduled.length;
    now += 100;
    rows(v, cx);
    assert.equal(scheduled.length, count, 'unrelated redraw keeps the same timer');
    const pending = v.cometTimer;
    now = pending.at;
    const before = notifications;
    pending.callback(cx);
    assert.equal(notifications, before + 1);
    rows(v, cx);
    assert.equal(v.cometTimer.at, v.messageEvents[0].at + FLOW.arriveMs, 'next redraw is the arrival');
    const arrival = v.cometTimer;
    motion = false;
    rows(v, cx);
    assert(arrival.cancelled);
    assert.equal(v.cometWake, null);
    arrival.callback(cx);
    assert.equal(notifications, before + 1, 'a stale timer cannot redraw after cancellation');
  } finally { Date.now = realNow; delete globalThis.__visRuntime; delete globalThis.__breathCalls; delete globalThis.__flowCalls; }
});

test('border measurements use logical pixels at non-default zoom', async () => {
  try {
    const v = view(await sidebar({...runtime([]), settings: () => ({zoom: 1.5})}));
    const measure = rows(v).get('sf-space-home').calls.find(call => call[0] === 'on_size_change')[1];
    let notifications = 0;
    const cx = {notify() {notifications++;}};
    measure({width: 300, height: 150}, cx);
    assert.deepEqual(v.boxSizes.home, {w: 200, h: 100});
    measure({width: 300.1, height: 150}, cx);
    assert.equal(notifications, 1, 'subpixel noise does not redraw');
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
