import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveLink } from '../mods/project-docs-tabs/vendor/paths.js';

const document = (id, path = `/docs/${id}.md`, pinned = true) => ({ id, path, pinned, label: id, name: path.split('/').at(-1), status: 'ok' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let moduleId = 0;
async function harness({ documents = [document('a'), document('b')], selection } = {}) {
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
    View: class {}, div: element, image: element, v_flex: element, h_flex: element,
    TextView: { markdown: (_id, text) => { labels.push(text); return element(); } },
    props: () => ({ spaceId: 'Demo' }), appHome: () => '/app',
    readTextFile: async path => { if (path.endsWith('/project-docs-open.json')) return state.request ? JSON.stringify(state.request) : null; reads.push(path); return state.text(path); },
    exec: async (command, args) => {
      calls.push({ command, args });
      if (command !== 'python3') return { code: 0, stdout: '', stderr: '' };
      if (state.result) return state.result();
      return { code: 0, stdout: JSON.stringify({ spaceId: 'Demo', documents: state.documents, warnings: [], checkedAt: 1, watchRoots: ['/docs'] }), stderr: '' };
    },
    watchFolder: root => { const pending = deferred(); watchers.set(root, pending); return pending.promise; },
    theme: () => ({}), shared: key => stored[key], setShared: (key, value) => { stored[key] = value; },
    spaces: () => [{ id: 'Demo', active: state.active, tabs: [{ id: 'tab-docs', active: true }] }],
    panes: () => [{ mod: 'project-docs-tabs', tab: 'tab-docs' }],
    stageMarkdown: (...args) => state.stage(...args), dirname: path => path.slice(0, path.lastIndexOf('/')),
    resolveLink,
  };
  const key = `__documentTabs${moduleId++}`; globalThis[key] = runtime;
  let source = await readFile(new URL('../mods/project-docs-tabs/main.js', import.meta.url), 'utf8');
  source = source.replace(/^import .*;\n/gm, '');
  source = `const {${Object.keys(runtime).join(',')}} = globalThis[${JSON.stringify(key)}];\n${source}`;
  const { default: Panel } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  delete globalThis[key];
  const cx = { notify() {}, spawn: task => { const promise = task(cx); promise.catch(() => {}); return promise; }, timer: { every: (ms, callback) => timer.set(ms, callback) } };
  const view = new Panel(); view.init({}, cx);
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  const render = () => { handlers.clear(); labels.length = 0; view.render(cx); };
  await flush();
  return { state, view, calls, reads, handlers, labels, stored, timer, watchers, cx, flush, render };
}

test('document selection restores per workspace and changing it preserves other workspace selections', async t => {
  const h = await harness({ selection: 'b' }); t.after(() => h.view.close());
  assert.equal(h.view.selected, 'b'); assert.equal(h.view.bodyText, '본문 /docs/b.md');
  h.view.choose('a', h.cx); await h.flush();
  assert.deepEqual(h.stored['sixfold.docs.selection.v1'], { Other: 'other', Demo: 'a' });
  assert.equal(h.view.bodyText, '본문 /docs/a.md');
});

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
