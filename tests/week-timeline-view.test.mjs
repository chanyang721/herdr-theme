import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as model from '../mods/week-timeline/model.js';
import * as summary from '../mods/week-timeline/summary.js';
const { weekSummary } = summary;
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

test('chip counts selected open work once, ignores tree folds, and highlights dated work', () => {
  const s=weekSummary(feed,{today,filter:'ALP',open:{ALP:false}});
  assert.deepEqual([s.total,s.today,s.late],[2,1,0]);
  assert.equal(weekSummary(feed,{today}).total,3);
  assert.equal(weekSummary(null,{today}).total,0);
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
  assert.deepEqual(weekSummary(f, {today}).items.map(i => i.key), items.map(i => i.key));
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
  assert.deepEqual(weekSummary(f,{today}).items.map(r=>r.key),['DEMO-20','DEMO-30','DEMO-10','X-1']);
});

let copy = 0;
async function runtime(initialProps = {}) {
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
  const lib = { ...model, ...summary, View: class {}, settings: () => ({ zoom: 1 }), div: element, h_flex: element, v_flex: element,
    initIssue() {}, renderIssue() {}, appHome: () => '/fake', exec: async () => ({ code: 0 }), readTextFile: async () => null,
    theme: () => ({ background: '#111821', foreground: '#d8e3eb', border: '#304050', canvas: '#0c121a', working: '#99b9f5', blocked: '#f5b56c', done: '#91cfaa' }),
    props: () => initialProps, isoDay: () => today,
    openOverlay: args => calls.push(['overlay', args]), closeOverlay: id => calls.push(['close', id]) };
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
  return { view, cx, calls, find, click };
}

const words = node => typeof node === 'string' ? [node] : (node?.kids || []).flatMap(words);
const has = (node, id) => Boolean(node?.calls?.some(c => c[0] === 'id' && c[1] === id) || node?.kids?.some(k => has(k, id)));

test('band shows seven day cells with deadline chips and a 진행 중 line, and never resizes the layout', async () => {
  const r=await runtime();
  assert.equal(r.view.mode,'band');
  const tree=r.view.render();
  assert.deepEqual(r.find(tree,'wt-days').kids.map(k=>k.kids[0]),['월 11/9','화 11/10','수 11/11 오늘','목 11/12','금 11/13','토 11/14','일 11/15']);
  assert.ok(has(r.find(tree,'wt-day-2'),'wt-chip-DEMO-2'));
  assert.ok(has(r.find(tree,'wt-day-2'),'wt-chip-DEMO-5'));
  assert.ok(has(r.find(tree,'wt-day-3'),'wt-chip-DEMO-1'));   // a parent shows on its own deadline too
  assert.ok(has(r.find(tree,'wt-ongoing'),'wt-chip-DEMO-3'));
  assert.ok(words(r.find(tree,'wt-ongoing')).includes('→ 12/3'));
  assert.ok(words(r.find(tree,'wt-summary')).includes('마감 3 · 진행 1'));
  assert.equal(r.calls.length,0);
});

test('band clicks: an issue chip opens its popup, summary and +N the week dialog, 전체 the project window', async () => {
  const r=await runtime();
  r.click(r.find(r.view.render(),'wt-chip-DEMO-3'));
  assert.equal(r.calls.at(-1)[1].props.issue,'DEMO-3');
  r.click(r.find(r.view.render(),'wt-summary'));
  assert.deepEqual(r.calls.at(-1),['overlay',{mod:'week-timeline',kind:'dialog',key:'week-timeline-week',width:1,height:1,frame:'none',props:{week:true}}]);
  r.click(r.find(r.view.render(),'wt-band-full'));
  assert.equal(r.calls.at(-1)[1].props.full,true);
  r.view.width=132+7*110;   // a narrow cell: two chips need +N
  const tree=r.view.render();
  assert.ok(has(r.find(tree,'wt-day-2'),'wt-more-2'));
  r.click(r.find(tree,'wt-more-2'));
  assert.equal(r.calls.at(-1)[1].key,'week-timeline-week');
});

test('band: no feed is one grey line; an empty week says so', async () => {
  const r=await runtime();
  r.view.feed=null; r.view.loaded=true;
  assert.ok(words(r.view.render()).some(w=>w.includes('아직 수집된 내용이 없습니다')));
  r.view.feed={week:feed.week,projects:[]};
  const tree=r.view.render();
  assert.ok(words(tree).includes('· 이번 주 할 일 없음'));
  assert.ok(words(tree).includes('마감 0 · 진행 0'));
});

test('the backdrop and close button dismiss the dialog; panel clicks stay inside', async () => {
  const r=await runtime({week:true,overlay:'week-dialog'});
  const tree=r.view.render();
  r.click(r.find(tree,'wt-dialog'));
  assert.equal(r.calls.length,0);
  r.click(r.find(tree,'wt-backdrop'));
  assert.deepEqual(r.calls.at(-1),['close','week-dialog']);
  r.click(r.find(tree,'wt-close'));
  assert.deepEqual(r.calls.at(-1),['close','week-dialog']);
});

test('the week paints deadline markers and future text, with no parent duration bar', async () => {
  const r=await runtime({week:true,overlay:'week-dialog'}),tree=r.view.render();
  const words=node=>typeof node==='string'?[node]:(node?.kids||[]).flatMap(words);
  assert.ok(words(r.find(tree,'wt-mark-DEMO-2')).includes('◆'));
  assert.ok(words(tree).includes('→ 12/3'));
  assert.equal(r.find(tree,'wt-r-1').kids[1].kids.length,0);
  r.click(r.find(tree,'wt-r-2'));
  assert.equal(r.calls.at(-1)[1].props.issue,'DEMO-2');
  assert.ok(r.find(tree,'wt-body').calls.some(c=>c[0]==='overflow_y_scrollbar'));
});

test('project and two-week controls update the table; full view closes the week dialog first', async () => {
  const r=await runtime({week:true,overlay:'week-dialog'});
  r.click(r.find(r.view.render(),'wt-f-MH'));
  assert.equal(r.view.filter,'MH');
  r.click(r.find(r.view.render(),'wt-z-14'));
  assert.equal(r.view.days,14);
  r.click(r.find(r.view.render(),'wt-open-full'));
  assert.deepEqual(r.calls.at(-2),['close','week-dialog']);
  assert.equal(r.calls.at(-1)[1].props.project,'MH');
  assert.equal(r.calls.at(-1)[1].props.full,true);
});

test('band: when a long status leaves no room, the 진행 중 line keeps one +N (review P2-4)', async () => {
  const r=await runtime();
  r.view.feed={week:feed.week,projects:[{key:'ALP',name:'Alpha',milestones:[],issues:Array.from({length:5},(_,i)=>item(`DEMO-${40+i}`,{state:'started',due:'2026-12-01'}))}]};
  r.view.note='수집 실패 '.repeat(12); r.view.width=900;
  const line=r.find(r.view.render(),'wt-ongoing');
  assert.equal(['DEMO-40','DEMO-41','DEMO-42','DEMO-43','DEMO-44'].some(k=>has(line,`wt-chip-${k}`)),false);
  assert.ok(words(r.find(line,'wt-more-ongoing')).includes('+5'));
});

test('band: 진행 중 chips can shrink with a cut title, while +N, the label and 전체 never shrink (review HOLD 2)', async () => {
  const r=await runtime();
  r.view.feed={week:feed.week,projects:[{key:'ALP',name:'Alpha',milestones:[],issues:Array.from({length:6},(_,i)=>item(`DEMO-${50+i}`,{state:'started',due:'2026-12-03',title:'W'.repeat(16)}))}]};
  r.view.width=972;
  const line=r.find(r.view.render(),'wt-ongoing'), calls=n=>n.calls.map(c=>c[0]);
  const chip=r.find(line,'wt-chip-DEMO-50');
  assert.ok(calls(chip).includes('flex_shrink_1') && calls(chip).includes('min_w') && !calls(chip).includes('flex_none'));
  assert.ok(calls(chip.kids[2]).includes('truncate'));   // ●, key, title, date
  assert.ok(calls(r.find(line,'wt-more-ongoing')).includes('flex_none'));
  assert.ok(calls(r.find(line,'wt-band-full')).includes('flex_none'));
});
