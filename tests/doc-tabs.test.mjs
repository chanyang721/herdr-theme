import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveLink } from '../mods/project-docs-tabs/vendor/paths.js';
import { mermaidFences, applyDiagrams } from '../mods/project-docs-tabs/mermaid.js';
import { locations, locate, listTree, searchTree, kindCounts, foldersOf, shortDate, matches } from '../mods/project-docs-tabs/tree.js';

const document = (id, path = `/docs/${id}.md`, pinned = true) => ({ id, path, pinned, label: id, name: path.split('/').at(-1), status: 'ok' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let moduleId = 0;
// Loads a mod file with its imports replaced by the given runtime names (GPUI stubs, siblings).
async function load(file, runtime) {
  const key = `__documentTabs${moduleId++}`; globalThis[key] = runtime;
  let source = await readFile(new URL(`../mods/project-docs-tabs/${file}`, import.meta.url), 'utf8');
  source = source.replace(/^import .*;\r?\n/gm, '');
  source = `const {${Object.keys(runtime).join(',')}} = globalThis[${JSON.stringify(key)}];\n${source}`;
  const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  delete globalThis[key];
  return module;
}
async function harness({ documents = [document('a'), document('b')], selection, lineEnding } = {}) {
  const handlers = new Map(), calls = [], reads = [], labels = [], timer = new Map(), watchers = new Map();
  const state = { documents, selected: selection, active: false, text: path => `본문 ${path}`, result: null, stage: async text => ({ blocks: [{ text }], files: [], unavailable: false }) };
  const stored = { 'sixfold.docs.selection.v1': selection ? { Demo: selection, Other: 'other' } : { Other: 'other' } };
  function element() {
    let id, proxy;
    proxy = new Proxy({}, { get(_target, key) {
      if (key === 'id') return value => { id = value; return proxy; };
      if (key === 'on_click') return callback => { handlers.set(id, callback); return proxy; };
      if (key === 'when') return (condition, callback) => condition ? callback(proxy) : proxy;
      if (key === 'child') return value => { if (typeof value === 'string') labels.push(value); return proxy; };
      return () => proxy;
    } }); return proxy;
  }
  const runtime = {
    View: class {}, div: element, image: element, v_flex: element, h_flex: element, Button: { new: id => element().id(id) },
    locations, locate, listTree, searchTree, kindCounts, foldersOf,
    InputState: { new: () => { const input = { text: '', events: {}, value: () => input.text, set_value: v => { input.text = v; }, on: (name, fn) => { input.events[name] = fn; return true; } }; state.input = input; return input; } },
    Input: { new: () => element() },
    TextView: { markdown: (_id, text) => { labels.push(text); return element(); } },
    props: () => ({ spaceId: 'Demo' }), appHome: () => '/app',
    readTextFile: async path => { if (path.endsWith('/project-docs-open.json')) return state.request ? JSON.stringify(state.request) : null; reads.push(path); return state.text(path); },
    exec: async (command, args) => {
      calls.push({ command, args });
      if (command === 'osascript' && state.osascript) return state.osascript(args);
      if (command !== 'python3') return { code: 0, stdout: '', stderr: '' };
      if (args[0].endsWith('render_mermaid.py')) return state.mermaid ? state.mermaid(args) : { code: 0, stdout: '{"diagrams":[]}', stderr: '' };
      if (args[0].endsWith('render_html.py')) return state.html(args);
      if (state.result) return state.result();
      return { code: 0, stdout: JSON.stringify({ spaceId: 'Demo', documents: state.documents, warnings: [], checkedAt: 1, watchRoots: ['/docs'] }), stderr: '' };
    },
    watchFolder: root => { const pending = deferred(); watchers.set(root, pending); return pending.promise; },
    theme: () => ({ canvas: '#101010' }), settings: () => ({ dark: true }), mermaidFences, applyDiagrams, shared: key => stored[key], setShared: (key, value) => { stored[key] = value; },
    spaces: () => [{ id: 'Demo', active: state.active, tabs: [{ id: 'tab-docs', active: true }] }],
    panes: () => [{ mod: 'project-docs-tabs', tab: 'tab-docs' }],
    stageMarkdown: (...args) => state.stage(...args), dirname: path => path.slice(0, path.lastIndexOf('/')),
    resolveLink,
  };
  const columns = await load('column-view.js', { div: element, v_flex: element, h_flex: element, Button: runtime.Button });
  const finder = await load('finder.js', { div: element, v_flex: element, h_flex: element, entryIcon: columns.icon });
  Object.assign(runtime, { columnView: columns.columnView, listView: finder.listView, breadcrumb: finder.breadcrumb, icon: finder.icon });
  const key = `__documentTabs${moduleId++}`; globalThis[key] = runtime;
  let source = await readFile(new URL('../mods/project-docs-tabs/main.js', import.meta.url), 'utf8');
  if (lineEnding) source = source.replace(/\r?\n/g, lineEnding);
  source = source.replace(/^import .*;\r?\n/gm, '');
  source = `const {${Object.keys(runtime).join(',')}} = globalThis[${JSON.stringify(key)}];\n${source}`;
  const { default: Panel } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  delete globalThis[key];
  const cx = { notify() {}, spawn: task => { const promise = task(cx); promise.catch(() => {}); return promise; }, timer: { every: (ms, callback) => timer.set(ms, callback), after: (ms, callback) => timer.set(`after-${ms}`, callback) } };
  const view = new Panel(); view.init({}, cx);
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  const render = () => { handlers.clear(); labels.length = 0; view.render(cx); };
  await flush();
  return { state, view, calls, reads, handlers, labels, stored, timer, watchers, cx, flush, render };
}

for (const lineEnding of ['\n', '\r\n']) {
test(`document selection restores per workspace and changing it preserves other workspace selections (${lineEnding === '\n' ? 'LF' : 'CRLF'})`, async t => {
  const h = await harness({ selection: 'b', lineEnding }); t.after(() => h.view.close());
  assert.equal(h.view.selected, 'b'); assert.equal(h.view.bodyText, '본문 /docs/b.md');
  h.view.choose('a', h.cx); await h.flush();
  assert.deepEqual(h.stored['sixfold.docs.selection.v1'], { Other: 'other', Demo: 'a' });
  assert.equal(h.view.bodyText, '본문 /docs/a.md');
});
}

test('late reads from the previous document cannot overwrite a new selection', async t => {
  const h = await harness(); t.after(() => h.view.close());
  const old = deferred(); h.state.text = path => path === '/docs/a.md' ? old.promise : 'new selection';
  h.view.load(h.cx); h.view.choose('b', h.cx); await h.flush();
  assert.equal(h.view.bodyText, 'new selection');
  old.resolve('late old body'); await h.flush();
  assert.equal(h.view.bodyText, 'new selection'); assert.equal(h.view.selected, 'b');
});

test('late Markdown staging from a previous date cannot overwrite the latest dated path', async t => {
  const h = await harness(); t.after(() => h.view.close());
  const old = deferred(); h.state.stage = text => text === 'old body' ? old.promise : Promise.resolve({ blocks: [{ text }], files: [], unavailable: false });
  h.state.text = () => 'old body'; h.view.load(h.cx); await h.flush();
  h.state.documents = [document('a', '/docs/20261102-a.md')]; h.state.text = () => 'latest body';
  h.view.refresh(h.cx); await h.flush();
  old.resolve({ blocks: [{ text: 'old body' }], files: [], unavailable: false }); await h.flush();
  assert.equal(h.view.bodyText, 'latest body'); assert.equal(h.view.blocks[0].text, 'latest body');
  assert.equal(h.view.newVersion, true);
});

test('failed rereads keep the last successful same-file body and show a failure', async t => {
  const h = await harness(); t.after(() => h.view.close());
  const body = h.view.blocks, success = h.view.lastSuccess;
  h.state.text = () => { throw Error('access denied'); }; h.view.load(h.cx); await h.flush();
  assert.equal(h.view.blocks, body); assert.equal(h.view.lastSuccess, success); assert.match(h.view.bodyError, /access denied/);
  h.render(); assert.ok(h.labels.some(text => text.includes('마지막 성공 본문 표시')));
  h.state.text = () => 'recovered'; h.view.load(h.cx); await h.flush();
  assert.equal(h.view.bodyError, null); assert.equal(h.view.bodyText, 'recovered');
});

test('watcher events, five-second fallback and workspace tab activation reread documents', async t => {
  const h = await harness(); t.after(() => h.view.close());
  assert.ok(h.timer.has(5000)); assert.ok(h.watchers.has('/docs')); assert.ok(h.watchers.has('/app/data/sixfold'));
  const initial = h.calls.length;
  h.watchers.get('/app/data/sixfold').resolve(['/app/data/sixfold/doc-tabs-install.lock']); await h.flush();
  assert.equal(h.calls.length, initial, 'installer locks must not trigger self-refresh loops');
  h.state.text = () => 'watch update'; h.watchers.get('/docs').resolve(['/docs/a.md']); await h.flush();
  assert.equal(h.view.bodyText, 'watch update');
  h.state.text = () => 'fallback update'; h.timer.get(5000)(h.cx); await h.flush(); assert.equal(h.view.bodyText, 'fallback update');
  h.render(); const before = h.calls.length; h.state.active = true; h.render(); await h.flush(); assert.ok(h.calls.length > before);
  const after = h.calls.length; h.render(); await h.flush(); assert.equal(h.calls.length, after);
});

test('ADR Markdown links open inside the read-only panel and can become pins', async t => {
  const h = await harness(); t.after(() => h.view.close());
  h.view.follow('/docs/adr/README.md', './0015-queue.md', h.cx); await h.flush();
  assert.equal(h.view.bodyText, '본문 /docs/adr/0015-queue.md');
  assert.ok(h.view.documents.some(d => d.opened && d.path === '/docs/adr/0015-queue.md'));
  assert.ok(h.calls.every(c => c.command === 'python3'));
  h.render(); h.handlers.get('docs-pin')({}, h.cx); await h.flush();
  assert.ok(h.calls.some(c => c.args.includes('--pin') && c.args.includes('/docs/adr/0015-queue.md')));
});

test('background loading does not launch an editor and external actions require explicit clicks', async t => {
  const h = await harness(); t.after(() => h.view.close());
  h.render(); assert.ok(h.calls.every(call => call.command === 'python3'));
  h.handlers.get('docs-edit')({}, h.cx); await h.flush();
  assert.deepEqual(h.calls.at(-1), { command: 'code', args: ['--reuse-window', '/docs/a.md'] });
  h.handlers.get('docs-open')({}, h.cx); await h.flush();
  assert.deepEqual(h.calls.at(-1), { command: 'open', args: ['/docs/a.md'] });
});

test('pin and unpin actions target the selected document and resolver space', async t => {
  const h = await harness(); t.after(() => h.view.close());
  h.render(); h.handlers.get('docs-pin')({}, h.cx); await h.flush();
  assert.ok(h.calls.some(call => call.command === 'python3' && call.args.includes('--space') && call.args.includes('Demo') && call.args.at(-2) === '--unpin' && call.args.at(-1) === 'a'));
  h.state.documents = [document('a', '/docs/a.md', false)]; h.view.refresh(h.cx); await h.flush();
  h.render(); h.handlers.get('docs-pin')({}, h.cx); await h.flush();
  assert.ok(h.calls.some(call => call.args.at(-2) === '--pin' && call.args.at(-1) === '/docs/a.md'));
});

test('resolver failure preserves visible documents and Office files never become Markdown', async t => {
  const h = await harness({ documents: [document('office', '/docs/report.xlsx')] }); t.after(() => h.view.close());
  assert.equal(h.reads.length, 0); h.render(); assert.ok(h.labels.includes('PDF·Word·Excel 문서는 기본 앱으로 여세요.'));
  h.state.result = () => ({ code: 1, stdout: '', stderr: 'source unavailable' }); h.view.refresh(h.cx); await h.flush();
  assert.equal(h.view.documents[0].id, 'office'); assert.match(h.view.listError, /source unavailable/);
});

test('large Markdown is bounded for rendering and closing blocks delayed body delivery', async t => {
  const h = await harness(); t.after(() => h.view.close());
  let stagedLength = 0;
  h.state.stage = async text => { stagedLength = text.length; return { blocks: [{ text }], files: [], unavailable: false }; };
  h.state.text = () => '한'.repeat(400001); h.view.load(h.cx); await h.flush();
  assert.equal(stagedLength, 400000); assert.equal(h.view.truncated, true);
  const pending = deferred(), lastBody = h.view.bodyText;
  h.state.text = () => pending.promise; h.view.load(h.cx); h.view.close(); pending.resolve('arrived after close'); await h.flush();
  assert.equal(h.view.bodyText, lastBody); assert.equal(h.view.watchers.size, 0);
});

test('missing and conflicting latest candidates retain the last successful body and stop loading', async t => {
  const h = await harness(); t.after(() => h.view.close());
  for (const status of ['missing', 'conflict']) {
    const body = h.view.blocks, success = h.view.lastSuccess, key = h.view.bodyKey;
    const pending = deferred(); h.state.text = () => pending.promise; h.view.load(h.cx);
    assert.equal(h.view.loading, true);
    h.state.documents = [{ ...document('a'), status, path: null, error: `latest ${status}` }];
    h.view.refresh(h.cx); await h.flush();
    assert.equal(h.view.blocks, body); assert.equal(h.view.lastSuccess, success); assert.equal(h.view.bodyKey, key);
    assert.equal(h.view.loading, false); assert.equal(h.view.bodyError, `latest ${status}`);
    pending.resolve('late inaccessible body'); await h.flush();
    assert.equal(h.view.blocks, body); assert.equal(h.view.bodyText, '본문 /docs/a.md');
    h.render(); assert.ok(h.labels.some(text => text.includes('마지막 성공 본문 표시')));
    h.state.documents = [document('a')]; h.state.text = () => '본문 /docs/a.md'; h.view.refresh(h.cx); await h.flush();
  }
});

test('malformed or wrong-workspace resolver replies cannot replace the last valid list', async t => {
  const h = await harness(); t.after(() => h.view.close());
  const documents = h.view.documents, body = h.view.blocks;
  for (const invalid of [{ spaceId: 'Demo' }, { spaceId: 'Demo', documents: {} }, { spaceId: 'Other', documents: [document('foreign')] }]) {
    h.state.result = () => ({ code: 0, stdout: JSON.stringify(invalid), stderr: '' });
    h.view.refresh(h.cx); await h.flush();
    assert.equal(h.view.documents, documents); assert.equal(h.view.blocks, body); assert.match(h.view.listError, /목록 형식/);
    assert.doesNotThrow(() => h.render());
  }
});

test('an open request shows its file once in the matching space and leaves other spaces alone', async t => {
  const h = await harness({ documents: [document('a'), document('b', '/docs/b.md')] }); t.after(() => h.view.close());
  h.state.request = { spaceId: 'Other', path: '/docs/b.md', at: 5 }; h.view.refresh(h.cx); await h.flush();
  assert.equal(h.view.selected, 'a');
  h.state.request = { spaceId: 'Demo', path: '/docs/b.md', at: 6 }; h.view.refresh(h.cx); await h.flush();
  assert.equal(h.view.selected, 'b');
  h.view.choose('a', h.cx); await h.flush(); h.view.refresh(h.cx); await h.flush();
  assert.equal(h.view.selected, 'a', 'a handled request must not reopen after the person moves on');
  h.state.request = { spaceId: 'Demo', path: '/reports/new.md', at: 7 }; h.view.refresh(h.cx); await h.flush();
  const opened = h.view.documents.find(d => d.opened);
  assert.equal(opened.path, '/reports/new.md'); assert.equal(h.view.selected, opened.id);
});

test('per-space open requests are each shown in their own space and pinned ones are favorites', async t => {
  const h = await harness({ documents: [document('a'), document('r', '/reports/r.md', false), document('b')] }); t.after(() => h.view.close());
  h.state.request = { version: 2, requests: { Other: { path: '/docs/a.md', at: 9 }, Demo: { path: '/docs/b.md', at: 8 } } };
  h.view.refresh(h.cx); await h.flush();
  assert.equal(h.view.selected, 'b', 'a later request for another space must not hide this space\'s request');
  h.render();
  assert.ok(h.labels.includes('즐겨찾기') && h.labels.includes('공간 문서'));
  assert.ok(h.handlers.has('docs-fav-a') && h.handlers.has('docs-fav-b') && !h.handlers.has('docs-fav-r'), 'only pinned documents are favorites');
});

test('mermaid fences are found by exact code and unrendered diagrams stay as code', () => {
  const text = '앞\n```mermaid\nflowchart LR\n  A-->B\n```\n중간\n~~~~ mermaid\nsequenceDiagram\n~~~~\n```js\nmermaid\n```\n끝';
  const fences = mermaidFences(text);
  assert.deepEqual(fences.map(f => f.code), ['flowchart LR\n  A-->B', 'sequenceDiagram']);
  assert.equal(text.slice(fences[0].start, fences[0].end), '```mermaid\nflowchart LR\n  A-->B\n```');
  assert.deepEqual(mermaidFences('```mermaid\nunclosed'), []);
  const media = { path: 'mods/project-docs-tabs/.cache/m.png', width: 10, height: 5 };
  const blocks = applyDiagrams([{ text }], new Map([['flowchart LR\n  A-->B', media]]));
  assert.equal(blocks[0].text, '앞\n'); assert.deepEqual(blocks[1], { media, diagram: true });
  assert.ok(blocks[2].text.includes('~~~~ mermaid\nsequenceDiagram'), 'a failed diagram keeps its code');
  assert.deepEqual(applyDiagrams([{ text }], new Map()), [{ text }]);
});

test('documents with mermaid render diagram images once and keep code with a notice on failure', async t => {
  const h = await harness(); t.after(() => h.view.close());
  let runs = 0;
  h.state.mermaid = args => { runs++; assert.deepEqual(args.slice(-4), ['--theme', 'dark', '--background', '#101010']);
    return { code: 0, stdout: JSON.stringify({ diagrams: [{ code: 'graph TD\nA-->B', path: 'mods/project-docs-tabs/.cache/a.png', width: 40, height: 20 }] }), stderr: '' }; };
  h.state.text = () => '# 제목\n```mermaid\ngraph TD\nA-->B\n```\n끝'; h.view.load(h.cx); await h.flush();
  assert.equal(h.view.blocks.filter(b => b.diagram).length, 1); assert.equal(runs, 1);
  h.view.load(h.cx); await h.flush(); assert.equal(runs, 1, 'an unchanged document does not rerender diagrams');
  h.state.mermaid = () => ({ code: 0, stdout: JSON.stringify({ diagrams: [{ code: 'graph TD\nA-->C', error: 'Parse error' }] }), stderr: '' });
  h.state.text = () => '```mermaid\ngraph TD\nA-->C\n```'; h.view.load(h.cx); await h.flush();
  assert.equal(h.view.blocks.some(b => b.diagram), false); assert.match(h.view.diagramError, /Parse error/);
});

test('html documents render as page images once and report renderer failures', async t => {
  const h = await harness({ documents: [document('report', '/docs/report.html')] }); t.after(() => h.view.close());
  let runs = 0;
  h.state.html = args => { runs++; assert.deepEqual(args.slice(1), ['--doc', '/docs/report.html', '--theme', 'dark', '--width', '760']);
    return { code: 0, stdout: JSON.stringify({ pages: [{ path: 'mods/project-docs-tabs/.cache/html-a-0.png', width: 960, height: 2000 }, { path: 'mods/project-docs-tabs/.cache/html-a-1.png', width: 960, height: 300 }] }), stderr: '' }; };
  h.state.text = () => '<html><body>표</body></html>'; h.view.load(h.cx); await h.flush();
  assert.equal(h.view.blocks.length, 2); assert.ok(h.view.blocks.every(b => b.media && b.diagram)); assert.equal(runs, 1);
  h.view.load(h.cx); await h.flush(); assert.equal(runs, 1, 'an unchanged page is not rendered again');
  h.render(); assert.ok(h.labels.some(l => l.startsWith('HTML은'))); assert.ok(!h.handlers.has('docs-browser'), 'a static page has no browser banner');
  h.state.html = () => ({ code: 1, stdout: JSON.stringify({ error: 'HTML 렌더러가 설치되지 않았습니다.' }), stderr: '' });
  h.state.text = () => '<html>바뀜</html>'; h.view.load(h.cx); await h.flush();
  assert.match(h.view.bodyError, /설치되지 않았습니다/); assert.equal(h.view.blocks.length, 2, 'the last good page stays');
});

test('html renders at the pane width and redraws once the pane stops resizing', async t => {
  const h = await harness({ documents: [document('report', '/docs/report.html')] }); t.after(() => h.view.close());
  const widths = [];
  h.state.html = args => { const width = Number(args.at(-1)); widths.push(width);
    return { code: 0, stdout: JSON.stringify({ pages: [{ path: `w${width}.png`, width, height: 100 }] }), stderr: '' }; };
  h.state.text = () => '<html>표</html>'; h.view.load(h.cx); await h.flush();
  assert.deepEqual(widths, [760]);
  h.view.width = 815; h.view.resized(h.cx); assert.ok(!h.timer.has('after-400'), 'a step under 40px keeps the picture');
  h.view.width = 1030; h.view.resized(h.cx); h.view.width = 1100; h.view.resized(h.cx);
  h.timer.get('after-400')(h.cx); await h.flush();
  assert.deepEqual(widths, [760, 1040]); assert.equal(h.view.html.width, 1040);
});

test('html with clicks or popups shows a banner that opens the default browser', async t => {
  const h = await harness({ documents: [document('report', '/docs/report.html')] }); t.after(() => h.view.close());
  h.state.html = () => ({ code: 0, stdout: JSON.stringify({ pages: [{ path: 'a.png', width: 760, height: 100 }], interactive: ['펼침 영역', '입력 양식'], truncated: true }), stderr: '' });
  h.state.osascript = () => ({ code: 0, stdout: '/Applications/Browser.app\n', stderr: '' });
  h.state.text = () => '<details><summary>더</summary></details>'; h.view.load(h.cx); await h.flush();
  h.render();
  assert.ok(h.labels.includes('이 문서는 클릭·팝업이 있어 브라우저에서 여세요'));
  assert.ok(h.labels.some(l => l.includes('펼침 영역, 입력 양식'))); assert.ok(h.labels.some(l => l.startsWith('긴 문서라')));
  h.handlers.get('docs-browser')(null, h.cx); await h.flush();
  assert.deepEqual(h.calls.at(-1), { command: 'open', args: ['-a', '/Applications/Browser.app', '/docs/report.html'] });
  h.state.osascript = () => ({ code: 1, stdout: '', stderr: 'no handler' });
  h.handlers.get('docs-browser')(null, h.cx); await h.flush();
  assert.deepEqual(h.calls.at(-1), { command: 'open', args: ['/docs/report.html'] }, 'falls back to the system default');
});

test('only 열람 rows close; listed catalog documents stay in the tree', async t => {
  const listed = { ...document('r', '/docs/r.md', false), state: 'latest', kind: 'other', mtime: 10 };
  const h = await harness({ documents: [document('a'), listed] }); t.after(() => h.view.close());
  h.render(); assert.ok(!h.handlers.has('doc-close-a'), 'pinned rows close with 고정 해제');
  assert.ok(!h.handlers.has('doc-close-r'), 'catalog rows have no close button');
  h.view.dismiss('r', h.cx); assert.deepEqual(h.view.documents.map(d => d.id), ['a', 'r']);
  h.view.reveal('/elsewhere/x.md'); h.render();
  h.handlers.get('doc-close-opened-/elsewhere/x.md')(null, h.cx); await h.flush();
  assert.equal(h.view.linked, null); assert.ok(!h.view.documents.some(d => d.opened));
});

const catalogDocs = () => [document('a'),
  { ...document('new', '/docs/20261104_회신.md', false), state: 'latest', kind: 'reply', recent: true, versions: ['old'], date: '2026-11-04', size: 1200 },
  { ...document('old', '/docs/20261101_회신.before-x.md', false), state: 'previous', kind: 'reply', head: 'new', date: '2026-11-01' },
  { ...document('s', '/docs/구조.html', false), state: 'latest', kind: 'structure', date: '2026-10-01' },
  { ...document('z', '/docs/_보관/z.pdf', false), state: 'archived', kind: 'other', date: '2026-09-01' }];
const KINDS = [{ id: 'reply', label: '회신안' }, { id: 'structure', label: '구조도' }, { id: 'other', label: '기타' }];

test('column view: folders open the next column, files open in the viewer, the path bar follows', async t => {
  const h = await harness({ documents: catalogDocs() }); t.after(() => h.view.close());
  h.view.kinds = KINDS; h.render();
  assert.ok(h.handlers.has('docs-loc-docs') && h.handlers.has('docs-loc-archived'), 'sidebar lists 공간 문서 and 보관');
  assert.ok(h.handlers.has('docs-fav-a'), 'pinned documents are favorites');
  assert.ok(h.handlers.has('docs-col-docs-c0-회신안'), 'kind folders form the first column');
  assert.ok(!h.labels.includes('● new'), 'files stay closed until their folder opens');
  h.handlers.get('docs-col-docs-c0-회신안')(null, h.cx); h.render();
  assert.equal(h.view.colPath, '회신안'); assert.ok(h.labels.includes('● new'), 'recent documents are marked');
  assert.ok(!h.labels.includes('old'), 'earlier versions are not separate rows');
  const file = [...h.handlers.keys()].find(k => k.startsWith('docs-col-docs-c1-회신안/'));
  h.handlers.get(file)(null, h.cx); await h.flush(); h.render();
  assert.equal(h.view.selected, 'new'); assert.equal(h.view.bodyText, '본문 /docs/20261104_회신.md');
  assert.ok(h.handlers.has('doc-version-old'), 'the viewer offers earlier versions');
  h.handlers.get('doc-version-old')(null, h.cx); await h.flush(); assert.equal(h.view.selected, 'old');
  h.render(); assert.ok(h.handlers.has('docs-path-1'), 'the path bar shows the folder');
  h.handlers.get('docs-path-0')(null, h.cx); assert.equal(h.view.colPath, '');
  assert.deepEqual(h.stored['sixfold.docs.finder.v1'].Demo, { view: 'column', location: 'docs', colPath: '' });
});

test('list view sorts by column, unfolds folders and versions; search and kind filter live in the toolbar', async t => {
  const h = await harness({ documents: catalogDocs() }); t.after(() => h.view.close());
  h.view.kinds = KINDS; h.render();
  h.handlers.get('docs-view-list')(null, h.cx); h.render();
  assert.ok(h.handlers.has('docs-list-docs-sort-size') && h.labels.includes('수정일 ▼'));
  h.handlers.get('docs-list-docs-row-회신안')(null, h.cx); h.render();
  const head = [...h.handlers.keys()].find(k => k.startsWith('docs-list-docs-toggle-회신안/'));
  h.handlers.get(head)(null, h.cx); h.render(); assert.ok(h.labels.includes('이전 버전'));
  h.handlers.get('docs-list-docs-sort-name')(null, h.cx); h.render(); assert.ok(h.labels.includes('이름 ▲'));
  h.handlers.get('docs-kind-menu')(null, h.cx); h.render();
  h.handlers.get('docs-kind-structure')(null, h.cx); h.render();
  assert.ok(!h.handlers.has('docs-list-docs-row-회신안') && h.handlers.has('docs-list-docs-row-구조도'));
  h.handlers.get('docs-kind-all')(null, h.cx);
  h.state.input.text = '회신'; h.state.input.events.change({}, h.cx); h.render();
  assert.ok(h.handlers.has('docs-search-row-hit/new') && h.handlers.has('docs-search-row-hit/old'), 'search covers earlier versions');
  h.state.input.events.submit({}, h.cx); await h.flush(); assert.equal(h.view.selected, 'new');
  h.handlers.get('docs-loc-archived')(null, h.cx); h.render();
  assert.equal(h.view.query, ''); assert.ok(h.handlers.has('docs-list-archived-row-기타'));
});

test('harness location and favorites; a harness link selects the listed document', async t => {
  const docs = [document('a'), { id: 'h1', path: '/h/README.md', name: 'README.md', label: '한눈에 보기', harness: true, section: 'status', status: 'ok' },
    { id: 'h2', path: '/docs/a.md', name: 'a.md', label: 'a', harness: true, section: 'docs', aliasOf: 'a', status: 'ok' }];
  const h = await harness({ documents: docs, selection: 'h1' }); t.after(() => h.view.close());
  h.view.harness = { sections: [{ id: 'status', label: '현황', groups: [{ label: '', ids: ['h1'] }] }, { id: 'docs', label: '주제 문서', groups: [{ label: '고정', ids: ['h2'] }] }] };
  h.view.revealInBrowser('h1'); h.render();
  assert.equal(h.view.location, 'harness'); assert.ok(h.labels.includes('한눈에 보기'));
  assert.ok(!h.handlers.has('docs-pin'), 'generated harness files are not pinned');
  h.view.openPath('주제 문서', true, h.cx); h.view.openPath('주제 문서/고정', true, h.cx); h.render();
  const alias = [...h.handlers.keys()].find(k => k.startsWith('docs-col-harness-c2-'));
  h.handlers.get(alias)(null, h.cx); await h.flush(); assert.equal(h.view.selected, 'a');
});

test('tree helpers: search words, dates, locations and list nodes', () => {
  assert.ok(matches({ label: '견적 회신안', folder: '프로젝트' }, '회신 프로젝트'));
  assert.ok(!matches({ label: '견적' }, '구조'));
  assert.ok(matches({ label: 'A\u0301'.normalize('NFD') }, 'Á'));
  assert.equal(shortDate('2026-11-04', new Date(2026, 10, 4)), '11-04');
  const docs = catalogDocs();
  assert.deepEqual(kindCounts(docs, KINDS).map(k => [k.id, k.count]), [['reply', 1], ['structure', 1], ['other', 1]]);
  const locs = locations(docs, { kinds: KINDS });
  assert.deepEqual(locs.map(l => [l.key, l.count]), [['docs', 3], ['archived', 1]]);
  assert.equal(locate(locs, 'z').key, 'archived');
  const tree = listTree(locs[0], docs);
  const reply = tree.children.find(n => n.name === '회신안').children[0];
  assert.deepEqual([reply.badge, reply.children.map(c => c.docId)], ['2판', ['old']]);
  assert.deepEqual(foldersOf('a/b/c.md'), ['a', 'a/b']); assert.deepEqual(foldersOf('a/b', true), ['a', 'a/b']);
  assert.deepEqual(searchTree(docs, '구조', KINDS).children.map(n => n.docId), ['s']);
});

test('the column view is the byte-identical shared copy', async () => {
  const text = await readFile(new URL('../mods/project-docs-tabs/column-view.js', import.meta.url), 'utf8');
  assert.match(text.split('\n')[0].trimEnd(), /^export const COLUMN_VIEW_VERSION = \d+;$/);
});

test('a selected 열람 tab is shown again after the mod reloads', async t => {
  const h = await harness({ selection: 'opened-/elsewhere/x.html' }); t.after(() => h.view.close());
  assert.equal(h.view.selected, 'opened-/elsewhere/x.html');
  assert.ok(h.view.documents.some(d => d.opened && d.path === '/elsewhere/x.html'));
});

test('kind folders and the 수정일 column list the newest write first, whatever date the name carries', async () => {
  const row = (id, date, mtime, modified) => ({ ...document(id, `/docs/${id}.md`, false), state: 'latest', kind: 'report', date, mtime, modified });
  const docs = [row('old-name-new-write', '2026-11-01', 3000, '2026-11-05'), row('new-name-old-write', '2026-11-04', 1000, '2026-11-04'),
    row('middle', '2026-11-03', 2000, '2026-11-04')];
  const loc = locations(docs, { kinds: [{ id: 'report', label: '보고서' }] }).find(l => l.key === 'docs');
  const files = loc.entries.filter(e => !e.dir);
  // column view sorts newest-first by path, so the path rank must follow mtime.
  assert.deepEqual(files.map(e => e.id).sort((a, b) => files.find(f => f.id === b).path.localeCompare(files.find(f => f.id === a).path)),
    ['old-name-new-write', 'middle', 'new-name-old-write']);
  assert.equal(files.find(e => e.id === 'old-name-new-write').date, '2026-11-05');
  const finder = await load('finder.js', { div: () => ({}), v_flex: () => ({}), h_flex: () => ({}), entryIcon: () => '' });
  const tree = listTree(loc, docs).children[0].children;
  assert.deepEqual(finder.sortNodes(tree, { key: 'date', dir: -1 }).map(n => n.docId), ['old-name-new-write', 'middle', 'new-name-old-write']);
  assert.deepEqual(finder.sortNodes(tree, { key: 'date', dir: 1 }).map(n => n.docId), ['new-name-old-write', 'middle', 'old-name-new-write']);
});
