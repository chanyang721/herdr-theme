import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as model from '../mods/week-timeline/model.js';
import * as band from '../mods/week-timeline/band.js';

const today = '2026-11-11';
const item = (key, extra = {}) => ({ key, title: key, status: 'Todo', state: 'todo', start: '', due: '', parent: '', ...extra });
const feed = { week: { start: '2026-11-09' }, projects: [
  { key: 'ALP', name: 'ALP', milestones: [], issues: [
    item('DEMO-1', { state: 'started', start: '2026-11-10', due: '2026-11-12' }),
    item('DEMO-2', { due: today, parent: 'DEMO-1', blocked: true }),
    item('DEMO-3', { state: 'review', start: '2026-11-09', due: '2026-12-03', parent: 'DEMO-1' }),
    item('DEMO-4', { state: 'done', done_at: today, parent: 'DEMO-1' }),
  ] }, { key: 'MH', name: 'MH', milestones: [], issues: [item('DEMO-5', { due: today })] },
] };

test('summary counts work once, retains counts under folds, and follows project filter', () => {
  const s = band.bandSummary(feed, { today, filter: 'ALP', open: { ALP: false } });
  assert.deepEqual([s.total, s.today, s.blocked, s.started], [3, 1, 1, 1]);
  assert.deepEqual(s.kinds, { hot: 1, review: 1, done: 1 });
  assert.equal(s.projects.length, 1);
  assert.equal(band.bandSummary(feed, { today, filter: 'MH' }).total, 1);
  assert.equal(band.bandSummary(feed, { today, filter: 'all' }).total, 4);
  assert.equal(band.bandSummary(null, { today }).total, 0);
});

test('processing dates sort late, today, nearest, milestone fallback and undated, then state and key', () => {
  const f = { week: feed.week, projects: [{ key: 'ALP', milestones: [{id:'m1',target:'2026-11-13'}], issues: [
    item('DEMO-1'),
    item('DEMO-20', {state:'review',due:today,parent:'DEMO-1'}),
    item('DEMO-10', {state:'todo',due:today,parent:'DEMO-1'}),
    item('DEMO-3', {state:'started',due:today,parent:'DEMO-1'}),
    item('DEMO-2', {state:'started',due:today,parent:'DEMO-1'}),
    item('DEMO-9', {due:'2026-11-05',parent:'DEMO-1'}),
    item('DEMO-30', {state:'started',milestone:'m1',parent:'DEMO-1'}),
    item('DEMO-40', {state:'review',due:'2026-12-03',parent:'DEMO-1'}),
    item('DEMO-50', {state:'started',parent:'DEMO-1'}),
  ] }] };
  const result = model.weekRows(f, {today});
  const items = result.rows.filter(r => r.kind === 'item');
  assert.deepEqual(items.map(i => i.key), ['DEMO-9','DEMO-2','DEMO-3','DEMO-10','DEMO-20','DEMO-30','DEMO-40','DEMO-50']);
  assert.deepEqual(items.find(i => i.key === 'DEMO-30').marker, {at:4,edge:'',label:''});
  assert.equal(items.at(-1).marker, null);
  assert.deepEqual(band.bandSummary(f, {today}).items.map(i => i.key), items.map(i => i.key));
  assert.equal(model.processingDate({due:'2026-11-12',milestone:'m1'},new Map([['m1','2026-11-13']])), '2026-11-12');
});

test('projects and parent groups sort by their earliest work, including a loose issue, and preserve folds', () => {
  const f = {week:feed.week, projects:[
    {key:'later',milestones:[],issues:[item('X-1',{due:'2026-11-13'})]},
    {key:'first',milestones:[],issues:[
      item('DEMO-1'), item('DEMO-2'),
      item('DEMO-10',{parent:'DEMO-1',due:'2026-11-13'}),
      item('DEMO-20',{parent:'DEMO-2',due:'2026-11-05'}),
      item('DEMO-30',{due:today}),
    ]},
  ]};
  const rows=model.weekRows(f,{today,open:{'first/DEMO-2':false}}).rows;
  assert.deepEqual(rows.map(r=>r.key),['first','DEMO-2','DEMO-30','DEMO-1','DEMO-10','later','X-1']);
  assert.deepEqual(band.bandSummary(f,{today}).items.map(r=>r.key),['DEMO-20','DEMO-30','DEMO-10','X-1']);
});

test('collapsed and expanded heights reclaim space and cap the viewport at five rows', () => {
  assert.equal(band.bandHeight(false, 100), 28);
  assert.equal(band.bandHeight(true, 100), 171);
  assert.equal(band.bandHeight(true, 1), 75);
  assert.equal(band.bandHeight(true, 3), 123);
});

let copy = 0;
async function runtime(saved = new Map()) {
  const calls = [], jobs = [];
  function element() {
    const node = { calls: [], kids: [] };
    const proxy = new Proxy(node, { get(o, key) {
      if (key in o) return o[key];
      return (...args) => {
        o.calls.push([key, ...args]);
        if (key === 'child') o.kids.push(args[0]);
        if (key === 'children') o.kids.push(...args[0]);
        if (key === 'when' && args[0]) args[1](proxy);
        return proxy;
      };
    } });
    return proxy;
  }
  const lib = { ...model, ...band, View: class {}, div: element, h_flex: element, v_flex: element,
    initIssue() {}, renderIssue() {}, appHome: () => '/fake', exec: async () => ({ code: 0 }), readTextFile: async () => null,
    theme: () => ({ background: '#111821', foreground: '#d8e3eb', border: '#304050', canvas: '#0c121a', working: '#99b9f5', blocked: '#f5b56c', done: '#91cfaa' }),
    props: () => ({}), settings: () => ({ zoom: 1 }), isoDay: () => today,
    run: (name, args) => calls.push([name, args]), openOverlay: args => calls.push(['overlay', args]), closeOverlay() {},
    shared: k => saved.get(k), setShared: (k, v) => saved.set(k, v) };
  const source = readFileSync(new URL('../mods/week-timeline/main.js', import.meta.url), 'utf8');
  const names = [...source.matchAll(/^import \{([^}]*)\} from/gm)].flatMap(m => m[1].split(',').map(n => n.trim()));
  for (const n of names) assert.ok(n in lib, `runtime lacks ${n}`);
  globalThis.__band = lib;
  const code = `// ${++copy}\nconst {${names.join(',')}} = globalThis.__band;\n${source.replace(/^import [\s\S]*?;\n/gm, '')}\n//# sourceURL=week-timeline-test-${copy}.js`;
  const { default: Timeline } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const cx = { notify() {}, stop_propagation() {}, spawn(fn) { jobs.push(fn(cx)); }, timer: { every: () => ({ cancel() {} }), after: () => ({ cancel() {} }) } };
  const view = new Timeline(); view.init({}, cx);
  await Promise.all(jobs); view.feed = feed;
  const find = (node, id) => node?.calls?.some(c => c[0] === 'id' && c[1] === id) ? node : node?.kids?.map(c => find(c, id)).find(Boolean);
  const click = node => node.calls.find(c => c[0] === 'on_click')[1]({}, cx);
  return { view, cx, calls, saved, find, click };
}

test('summary click resizes the block, survives a new view, and collapse frees the space', async () => {
  const r = await runtime();
  assert.equal(r.view.expanded, false);
  assert.deepEqual(r.calls.at(-1), ['layout.resize', { id: 'week-timeline', px: 28 }]);
  r.click(r.find(r.view.render(), 'wt-summary'));
  assert.equal(r.saved.get(band.EXPANDED_KEY), true);
  assert.equal(r.calls.at(-1)[1].px, 171);
  const body = r.find(r.view.render(), 'wt-body');
  assert.ok(body.calls.some(c => c[0] === 'overflow_y_scrollbar'));
  const restarted = await runtime(r.saved);
  assert.equal(restarted.view.expanded, true);
  r.click(r.find(r.view.render(), 'wt-collapse'));
  assert.equal(r.calls.at(-1)[1].px, 28);
  assert.equal(r.saved.get(band.EXPANDED_KEY), false);
  assert.equal((await runtime(r.saved)).view.expanded, false);
});

test('full timeline link opens the overlay without toggling the band', async () => {
  const r = await runtime();
  r.view.filter = 'MH';
  r.click(r.find(r.view.render(), 'wt-summary-full'));
  assert.equal(r.view.expanded, false);
  assert.equal(r.calls.at(-1)[0], 'overlay');
  assert.equal(r.calls.at(-1)[1].props.project, 'MH');
});

test('few rows do not collapse the chip header; only actual squeezing does', async () => {
  const r = await runtime();
  Object.assign(r.view, { expanded: true, bandHeight: 75, height: 75, appliedAt: 0 });
  r.view.fitChips();
  assert.equal(r.calls.findLast(c => c[0] === 'layout.select')[1].child, 'mcp-cli-stack');
  Object.assign(r.view, { bandHeight: 171, height: 120, appliedAt: 0 });
  r.view.fitChips();
  assert.equal(r.calls.findLast(c => c[0] === 'layout.select')[1].child, 'mcp-cli-line');
  Object.assign(r.view, { expanded: false, appliedAt: 0 });
  r.view.fitChips();
  assert.equal(r.calls.findLast(c => c[0] === 'layout.select')[1].child, 'mcp-cli-stack');
});

test('the week paints deadline markers and future text, with no parent duration bar', async () => {
  const r = await runtime(); r.view.expanded = true;
  const tree = r.view.render();
  const mark = r.find(tree, 'wt-mark-DEMO-2');
  assert.ok(mark);
  const words = node => typeof node === 'string' ? [node] : (node?.kids || []).flatMap(words);
  assert.ok(words(mark).includes('◆'));
  assert.ok(words(tree).includes('→ 12/3'));
  const parent = r.find(tree, 'wt-r-1');
  assert.equal(parent.kids[1].kids.length, 0); // Date lane is empty; progress stays on the left.
  r.click(r.find(tree, 'wt-collapse'));
  const summary = r.view.render();
  assert.ok(r.find(summary, 'wt-summary-DEMO-2'));
  r.click(r.find(summary, 'wt-summary-DEMO-2'));
  assert.equal(r.calls.at(-1)[1].props.issue, 'DEMO-2');
  assert.equal(r.view.expanded, false);
});
