import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveLink, kind as pathKind } from '../mods/project-docs-tabs/vendor/paths.js';
import { mermaidFences, applyDiagrams } from '../mods/project-docs-tabs/mermaid.js';
import { locations, locate, listTree, searchTree, kindCounts, foldersOf } from '../mods/project-docs-tabs/tree.js';
import * as zoom from '../mods/project-docs-tabs/zoom.js';
import * as remote from '../mods/project-docs-tabs/remote.js';

const { remoteTarget, createRemoteReader, remoteBlocks, remoteLink, takeRequest, fenced, machineNames, createRemoteIds, RemoteDocumentError, REMOTE_OPEN, REQUEST_TTL_MS, REMOTE_LIMIT } = remote;
// vendor/markdown.js with its media import stubbed: a remote read must never reach loadMedia.
const mediaLoads = [];
const stageMarkdown = await (async () => {
  globalThis.__remoteMarkdown = { resolveLink, kind: pathKind, loadMedia: async target => { mediaLoads.push(target); throw Error('loadMedia called'); } };
  const source = (await readFile(new URL('../mods/project-docs-tabs/vendor/markdown.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  const module = await import('data:text/javascript;base64,' + Buffer.from(`const {resolveLink,kind,loadMedia}=globalThis.__remoteMarkdown;\n${source}`).toString('base64'));
  return module.stageMarkdown;
})();
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const reply = (text, extra = {}) => ({ code: 0, stdout: JSON.stringify({ first: 1, last: text.split('\n').length, lines: text.split('\n').length, text, ...extra }), stderr: '' });
const failed = (kind, message = '', code = 3) => ({ code, stdout: JSON.stringify({ error: { kind, message, hint: '' } }), stderr: '' });
const kindOf = async promise => { try { await promise; return 'ok'; } catch (error) { assert.ok(error instanceof RemoteDocumentError, String(error)); return error.kind; } };
const reject = (request, options) => { try { remoteTarget(request, options); return 'ok'; } catch (error) { return error.kind; } };

test('remote targets accept explicit absolute paths on a listed machine and nothing else', () => {
  const machines = ['sub1', 'company-mac'];
  assert.deepEqual({ ...remoteTarget({ on: 'sub1', path: 'C:\\Users\\me\\문서\\보고서.md' }, { machines }) },
    { on: 'sub1', path: 'C:/Users/me/문서/보고서.md', kind: 'markdown', name: '보고서.md' });
  assert.equal(remoteTarget({ on: 'company-mac', path: '/Users/me/notes/./a.txt' }, { machines }).path, '/Users/me/notes/a.txt');
  assert.equal(remoteTarget({ on: 'sub1', path: '/srv/page.HTML' }).kind, 'html');
  for (const [request, kind] of [
    [{ on: 'nowhere', path: '/a.md' }, 'unknown_machine'],
    [{ on: '-rf', path: '/a.md' }, 'invalid_machine'],
    [{ on: 'sub1 && calc', path: '/a.md' }, 'invalid_machine'],
    [{ on: '', path: '/a.md' }, 'invalid_machine'],
    [{ on: null, path: '/a.md' }, 'invalid_machine'],
    [{ on: 'sub1', path: 'docs/a.md' }, 'invalid_path'],
    [{ on: 'sub1', path: '~/a.md' }, 'invalid_path'],
    [{ on: 'sub1', path: '//server/share/a.md' }, 'invalid_path'],
    [{ on: 'sub1', path: '\\\\server\\share\\a.md' }, 'invalid_path'],
    [{ on: 'sub1', path: '\\\\?\\C:\\a.md' }, 'invalid_path'],
    [{ on: 'sub1', path: '/docs/../etc/passwd.md' }, 'invalid_path'],
    [{ on: 'sub1', path: 'C:\\docs\\..\\secret.md' }, 'invalid_path'],
    [{ on: 'sub1', path: '/docs/a\n.md' }, 'invalid_path'],
    [{ on: 'sub1', path: '/docs/a\0.md' }, 'invalid_path'],
    [{ on: 'sub1', path: `/${'a'.repeat(1100)}.md` }, 'invalid_path'],
    [{ on: 'sub1', path: '/' }, 'invalid_path'],
    [{ on: 'sub1', path: 'C:/' }, 'invalid_path'],
    [{ on: 'sub1', path: 42 }, 'invalid_path'],
    [{ on: 'sub1', path: '/docs/a.pdf' }, 'unsupported'],
    [{ on: 'sub1', path: '/docs/run.sh' }, 'unsupported'],
    [{ on: 'sub1', path: '/docs/README' }, 'unsupported'],
  ]) assert.equal(reject(request, { machines }), kind, JSON.stringify(request));
});

test('a folder limit is refused before hc: the other core follows links out of any folder', () => {
  for (const roots of [['C:/docs'], ['/docs'], [], '/docs', ['docs']]) {
    assert.equal(reject({ on: 'sub1', path: '/docs/a.md', roots }), 'roots_unverifiable', JSON.stringify(roots));
  }
  assert.equal(reject({ on: 'sub1', path: '/docs/a.md', roots: null }), 'ok', 'no limit asked: an explicit path');
});

test('machine names come from machines() and leave out this computer', () => {
  assert.deepEqual(machineNames([{ name: null, layout: 'ready' }, { name: 'sub1', layout: 'ready' }, { name: 'mac', layout: 'unavailable' }, {}]), ['sub1', 'mac']);
  assert.equal(machineNames(undefined), null);
});

test('the reader asks hc with an argument array, shares a read under way and keeps nothing after it', async () => {
  const calls = [], pending = deferred();
  const reader = createRemoteReader({ hc: args => { calls.push(args); return pending.promise; } });
  const target = remoteTarget({ on: 'sub1', path: '/docs/$(rm -rf ~); `x`.md' });
  const first = reader.read(target), second = reader.read(target);
  assert.equal(first, second); assert.equal(reader.running(), 1);
  assert.deepEqual(calls, [['file', 'read', '--json', '--on', 'sub1', '--offset', '1', '--limit', '4000', '--', '/docs/$(rm -rf ~); `x`.md']], 'the path is one argument after --, never shell text');
  pending.resolve(reply('# 제목\n'));
  assert.equal((await first).text, '# 제목\n');
  assert.equal(reader.running(), 0);
  const again = createRemoteReader({ hc: async args => { calls.push(args); return reply('다시'); } });
  await again.read(target); await again.read(target);
  assert.equal(calls.length, 3, 'each settled read is asked again: no body cache');
});

test('Unicode, CRLF and emoji text arrive unchanged; long text is bounded and flagged', async () => {
  const text = '# 한글 제목 🚀\r\n\r\nÉté — naïve 中文 \u200d👩‍💻\r\n';
  const reader = createRemoteReader({ hc: async () => reply(text) });
  const read = await reader.read(remoteTarget({ on: 'sub1', path: '/d/u.md' }));
  assert.equal(read.text, text); assert.equal(read.truncated, false);
  const small = createRemoteReader({ hc: async () => reply('가'.repeat(50)), limit: 10 });
  assert.deepEqual(await small.read(remoteTarget({ on: 'sub1', path: '/d/l.md' })), { text: '가'.repeat(10), truncated: true, lines: 1 });
  const partial = createRemoteReader({ hc: async () => ({ code: 0, stdout: JSON.stringify({ first: 1, last: 10, lines: 99, text: 'head\n' }), stderr: '' }) });
  assert.equal((await partial.read(remoteTarget({ on: 'sub1', path: '/d/p.md' }))).truncated, true, 'the core stops at 8 MB of whole lines');
});

test('offline, permission, path and format failures map to typed errors without file text', async () => {
  const target = remoteTarget({ on: 'sub1', path: '/d/a.md' });
  const cases = [
    [failed('unreachable', 'cannot reach sub1: timed out'), 'offline'],
    [failed('unavailable', 'core is not running'), 'offline'],
    [failed('needs_login', 'log in'), 'offline'],
    [failed('machine_unknown', 'unknown machine "sub1"', 4), 'unknown_machine'],
    [failed('not_found', 'no file /d/a.md'), 'not_found'],
    [failed('denied', 'not allowed'), 'denied'],
    [failed('io', '/d/a.md: Access is denied. (os error 5)'), 'denied'],
    [failed('io', '/d/a.md: Permission denied (os error 13)'), 'denied'],
    [failed('io', '/d/a.md: disk on fire'), 'failed'],
    [failed('not_text', '/d/a.md is not UTF-8 text'), 'not_text'],
    [failed('invalid_params', '/d/a.md is not a regular file', 6), 'not_file'],
    [failed('invalid_params', '/d/a.md is over 64 MB', 6), 'too_large'],
    [{ code: 0, stdout: JSON.stringify({ first: 1, last: 1, lines: 1, text: 'a\0b' }), stderr: '' }, 'not_text'],
    [{ code: 1, stdout: 'garbage', stderr: 'secret body line' }, 'failed'],
    [{ code: 0, stdout: '{"text": 5}', stderr: '' }, 'failed'],
  ];
  for (const [result, kind] of cases) {
    const reader = createRemoteReader({ hc: async () => result });
    assert.equal(await kindOf(reader.read(target)), kind, JSON.stringify(result));
  }
  const timeout = createRemoteReader({ hc: async () => { throw Error('hc took longer than 30 s and was stopped'); } });
  assert.equal(await kindOf(timeout.read(target)), 'timeout');
  const lost = createRemoteReader({ hc: async () => { throw Error('BODY SHOULD NOT LEAK'); } });
  try { await lost.read(target); assert.fail('rejects'); } catch (error) {
    assert.equal(error.kind, 'failed'); assert.ok(!JSON.stringify({ m: error.message, d: error.detail }).includes('BODY'));
  }
  const offline = createRemoteReader({ hc: async () => failed('unreachable', 'cannot\nreach\u0007 sub1') });
  try { await offline.read(target); } catch (error) { assert.equal(error.detail, 'cannot reach sub1'); assert.match(error.message, /연결할 수 없습니다/); }
  assert.throws(() => createRemoteReader({}), TypeError);
});

test('HTML and text show as inert code; fences cannot be closed by the text', async () => {
  const html = '<script>alert(1)</script>\n<img src=x onerror=alert(2)>\n```\n````js\n';
  const shown = await remoteBlocks(html, remoteTarget({ on: 'sub1', path: '/d/p.html' }), () => assert.fail('HTML is not staged'));
  assert.equal(shown.blocks.length, 1);
  assert.ok(shown.blocks[0].text.startsWith('`````html\n'), 'one backtick more than the longest run');
  assert.ok(shown.blocks[0].text.endsWith('\n`````'));
  assert.ok(shown.blocks[0].text.includes('<script>alert(1)</script>'), 'kept as text, not removed or run');
  assert.equal(fenced('plain'), '```\nplain\n```');
  const text = await remoteBlocks('a ``` b', remoteTarget({ on: 'sub1', path: '/d/t.txt' }), null);
  assert.equal(text.blocks[0].text, '````\na ``` b\n````');
});

test('fences stay linear on long text: many short runs, one long run, none', () => {
  const many = '`x'.repeat(200000);
  assert.equal(many.length, 400000);
  const shown = fenced(many);
  assert.ok(shown.startsWith('```\n') && shown.endsWith('\n```'));
  assert.equal(fenced(`a${'`'.repeat(5000)}b`).split('\n')[0], '`'.repeat(5001));
  assert.equal(fenced(`${'``x'.repeat(100000)}\n${'`'.repeat(7)}`).split('\n')[0], '`'.repeat(8));
  assert.equal(fenced(''), '```\n\n```');
  assert.equal(fenced('끝 ```'), '````\n끝 ```\n````');
});

test('remote Markdown keeps its text and never stages pictures or diagrams', async () => {
  const body = '# 제목\n\n![그림](./a.png)\n\n![원격](https://example.com/x.png)\n\n```mermaid\ngraph TD; A-->B\n```\n';
  const target = remoteTarget({ on: 'sub1', path: '/d/m.md' });
  const shown = await remoteBlocks(body, target, stageMarkdown);
  assert.equal(shown.unavailable, true, 'the local picture is listed as unavailable');
  assert.ok(shown.blocks.every(block => !block.media));
  assert.deepEqual(mediaLoads, [], 'no picture is staged under the mod cache');
  assert.equal(shown.blocks.map(b => b.text).join(''), body);
  await assert.rejects(remoteBlocks('x', target, async () => ({ blocks: [{ media: { path: 'x' } }], unavailable: false })), RemoteDocumentError);
});

test('links in a remote document stay on that machine or open the web, never a local file', () => {
  const target = remoteTarget({ on: 'sub1', path: 'C:/docs/a/guide.md' });
  assert.deepEqual(remoteLink(target, 'https://example.com/x'), { url: 'https://example.com/x' });
  assert.deepEqual(remoteLink(target, '#top'), { anchor: true });
  assert.equal(remoteLink(target, 'next.md').remote.path, 'C:/docs/a/next.md');
  assert.equal(remoteLink(target, 'next.md').remote.on, 'sub1');
  assert.equal(remoteLink(target, '../b/other.md').remote.path, 'C:/docs/b/other.md');
  assert.deepEqual({ ...remoteLink(target, '../../Windows/win.md').remote }, { on: 'sub1', path: 'C:/Windows/win.md', kind: 'markdown', name: 'win.md' }, 'a click goes on the same machine');
  assert.equal(remoteLink(target, 'file:///C:/Users/me/secret.md').remote.on, 'sub1', 'file links are paths on that machine, never this one');
  assert.ok(remoteLink(target, 'javascript:alert(1)').blocked);
  assert.ok(remoteLink(target, 'mailto:a@b.c').blocked);
  assert.ok(remoteLink(target, 'tool.exe').blocked);
  assert.ok(remoteLink(target, 'next.md', { machines: ['sub2'] }).blocked, 'the machine must still be listed');
});

test('an open request is taken once and a stale or future-dated one is dropped unread', () => {
  const now = 1_000_000_000;
  const fresh = { on: 'sub1', path: '/d/a.md', at: now - 1000 };
  assert.deepEqual(takeRequest({ Demo: fresh, Other: { on: 'x', path: '/y.md', at: now } }, 'Demo', now), { request: fresh, rest: { Other: { on: 'x', path: '/y.md', at: now } }, stale: false });
  assert.deepEqual(takeRequest({ Demo: { ...fresh, at: now - REQUEST_TTL_MS - 1 } }, 'Demo', now), { request: null, rest: {}, stale: true });
  assert.equal(takeRequest({ Demo: { ...fresh, at: now + 120000 } }, 'Demo', now).stale, true);
  assert.equal(takeRequest({ Demo: { ...fresh, at: 'soon' } }, 'Demo', now).stale, true);
  assert.deepEqual(takeRequest(null, 'Demo', now), { request: null, rest: null, stale: false });
  const ids = createRemoteIds();
  assert.equal(ids({ on: 'sub1', path: 'C:/a b/문서.md' }), 'remote-1', 'one Finder level, no machine or path');
  assert.equal(ids({ on: 'sub2', path: 'C:/a b/문서.md' }), 'remote-2');
  assert.equal(ids({ on: 'sub1', path: 'C:/a b/문서.md' }), 'remote-1', 'the same file keeps its id');
});

test('remote.js has no way to write, log or run anything; only hc is called', async () => {
  const source = await readFile(new URL('../mods/project-docs-tabs/remote.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .* from ['"](.+)['"];$/gm)].map(m => m[1]);
  assert.deepEqual(imports, ['./vendor/paths.js'], 'no herdr host API, no media helper');
  for (const word of ['writeTextFile', 'setShared', 'exec(', 'console.', 'loadMedia', 'appHome', 'readTextFile', '.cache', 'localStorage']) {
    assert.ok(!source.includes(word), `remote.js must not use ${word}`);
  }
  const main = await readFile(new URL('../mods/project-docs-tabs/main.js', import.meta.url), 'utf8');
  assert.match(main, new RegExp(`const REMOTE_OPEN = '${REMOTE_OPEN.replace(/\./g, '\\.')}';`), 'main.js spells the same shared key');
});

// The 문서 tab with host stubs that record every write, run and shared value.
async function tab({ documents = [], machines = [{ name: null }, { name: 'sub1' }, { name: 'company-mac' }], hc, stored: saved = {} } = {}) {
  const handlers = new Map(), labels = [], calls = [], reads = [], writes = [], hcCalls = [], logs = [];
  const stored = structuredClone(saved);
  const element = () => {
    let id, proxy;
    proxy = new Proxy({}, { get(_target, key) {
      if (key === 'id') return value => { id = value; return proxy; };
      if (key === 'on_click') return callback => { handlers.set(id, callback); return proxy; };
      if (key === 'on_link_click') return callback => { handlers.set(`link:${id}`, callback); return proxy; };
      if (key === 'when') return (condition, callback) => condition ? callback(proxy) : proxy;
      if (key === 'child') return value => { if (typeof value === 'string') labels.push(value); return proxy; };
      return () => proxy;
    } }); return proxy;
  };
  const runtime = {
    View: class {}, div: element, image: element, v_flex: element, h_flex: element,
    locations, locate, listTree, searchTree, kindCounts, foldersOf,
    InputState: { new: () => ({ value: () => '', set_value() {}, on() {} }) }, Input: { new: () => element() },
    TextView: { markdown: (id, text) => { labels.push(text); return element().id(id); } },
    props: () => ({ spaceId: 'Demo' }), appHome: () => '/app', hostWindow: () => null,
    readTextFile: async path => { reads.push(path); return path.endsWith('/project-docs-open.json') ? null : `로컬 ${path}`; },
    writeTextFile: async (...args) => { writes.push(args); return null; },
    exec: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === 'render_mermaid') return { code: 0, stdout: '{"diagrams":[]}', stderr: '' };
      return { code: 0, stdout: JSON.stringify({ spaceId: 'Demo', documents, warnings: [], checkedAt: 1, watchRoots: [] }), stderr: '' };
    },
    hc: args => { hcCalls.push(args); return hc(args); }, machines: () => machines,
    watchFolder: () => new Promise(() => {}),
    theme: () => ({ canvas: '#101010' }), settings: () => ({ dark: true }), mermaidFences, applyDiagrams,
    shared: key => stored[key], setShared: (key, value) => { stored[key] = value; return null; },
    spaces: () => [{ id: 'Demo', active: true, tabs: [{ id: 'tab-docs', active: true }] }],
    panes: () => [{ mod: 'project-docs-tabs', tab: 'tab-docs' }],
    stageMarkdown, dirname: path => path.slice(0, path.lastIndexOf('/')), resolveLink,
    columnView: () => element(), columnsFor: () => [], visibleColumns: () => 1, listView: () => element(), breadcrumb: () => element(), icon: () => '',
    figure: () => element(), viewer: () => element(), fraction: () => ({}), ...zoom,
    remoteTarget, createRemoteIds, machineNames, createRemoteReader, remoteBlocks, remoteLink, takeRequest,
  };
  const key = `__remoteTab${Math.random().toString(36).slice(2)}`; globalThis[key] = runtime;
  let source = (await readFile(new URL('../mods/project-docs-tabs/main.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  source = `const {${Object.keys(runtime).filter(name => /^[A-Za-z_$][\w$]*$/.test(name)).join(',')}} = globalThis[${JSON.stringify(key)}];\n${source}`;
  const { default: Panel } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  delete globalThis[key];
  const cx = { notify() {}, open_url: url => calls.push(['open_url', url]), spawn: task => { const p = task(cx); p.catch(() => {}); return p; }, timer: { every() {}, after() {} } };
  const log = console.log, error = console.error, warn = console.warn;
  console.log = console.error = console.warn = (...args) => logs.push(args.join(' '));
  const view = new Panel(); view.init({}, cx);
  await flush();
  const render = () => { handlers.clear(); labels.length = 0; view.render(cx); };
  const restore = () => { console.log = log; console.error = error; console.warn = warn; view.close(); };
  return { view, cx, handlers, labels, calls, reads, writes, hcCalls, logs, stored, render, restore,
    ask: (request, at = Date.now()) => { stored[REMOTE_OPEN] = { ...(stored[REMOTE_OPEN] || {}), Demo: { ...request, at } }; render(); } };
}

const SECRET = '기밀 본문 MARKER-7f3a';

test('a remote open request shows the body from memory and writes it nowhere', async t => {
  const local = { id: 'local-a', path: 'C:/docs/a.md', name: 'a.md', label: 'a', status: 'ok', pinned: true };
  const h = await tab({ documents: [local], hc: async () => reply(`# 원격\n\n${SECRET}\n`) }); t.after(h.restore);
  const before = { calls: h.calls.length, reads: h.reads.length };
  h.ask({ on: 'sub1', path: 'C:\\docs\\a.md' }); await flush(); h.render();
  assert.deepEqual(h.hcCalls, [['file', 'read', '--json', '--on', 'sub1', '--offset', '1', '--limit', '4000', '--', 'C:/docs/a.md']]);
  assert.ok(h.labels.some(text => text.includes(SECRET)), 'the body is drawn');
  assert.ok(h.labels.some(text => text.includes('원격 · 읽기 전용')));
  assert.equal(h.stored[REMOTE_OPEN].Demo, undefined, 'the request is taken once');
  assert.equal(h.view.documents.find(d => d.id === 'local-a').path, 'C:/docs/a.md', 'the local pin with the same path stays its own document');
  assert.notEqual(h.view.selected, 'local-a');
  for (const id of ['docs-open', 'docs-edit', 'docs-copy-file', 'docs-copy-text', 'docs-pin']) assert.ok(!h.handlers.has(id), `${id} acts on a local path`);
  // Nothing about the remote body leaves memory.
  const outside = JSON.stringify({ writes: h.writes, calls: h.calls, reads: h.reads, logs: h.logs, stored: h.stored });
  assert.ok(!outside.includes('MARKER-7f3a'));
  assert.ok(!JSON.stringify(h.stored).includes('C:/docs/a.md'), 'shared() is saved to disk: no remote path kept there');
  assert.equal(h.reads.slice(before.reads).filter(path => !path.endsWith('project-docs-open.json')).length, 0, 'no local read for the remote path');
  assert.ok(h.calls.slice(before.calls).every(call => call[1] === undefined || call[0] === '/app/scripts/sixfold/herdr-theme' && !['render_mermaid', 'render_html', 'media_image'].includes(call[1])), 'no local helper');
});

test('list refreshes do not ask the machine again; 새로 고침 and a new click do', async t => {
  let n = 0; const h = await tab({ hc: async () => reply(`판 ${++n}`) }); t.after(h.restore);
  h.ask({ on: 'sub1', path: '/d/a.txt' }); await flush();
  assert.equal(h.hcCalls.length, 1);
  h.view.refresh(h.cx); await flush(); h.view.load(h.cx); await flush();
  assert.equal(h.hcCalls.length, 1, 'refresh and folder events keep the shown body');
  h.render(); h.handlers.get('docs-refresh')(null, h.cx); await flush(); h.render();
  assert.equal(h.hcCalls.length, 2); assert.ok(h.labels.some(text => text.includes('판 2')));
  h.ask({ on: 'sub1', path: '/d/a.txt' }); await flush();
  assert.equal(h.hcCalls.length, 3, 'opening it again reads it again');
});

test('a failed reread keeps the last body; a failed read is not retried by list refreshes', async t => {
  let answer = reply('첫 본문'); const h = await tab({ hc: async () => answer }); t.after(h.restore);
  h.ask({ on: 'sub1', path: '/d/a.md' }); await flush();
  answer = failed('unreachable', 'cannot reach sub1');
  h.render(); h.handlers.get('docs-refresh')(null, h.cx); await flush(); h.render();
  assert.ok(h.labels.some(text => text.includes('첫 본문')));
  assert.ok(h.labels.some(text => text.includes('연결할 수 없습니다') && text.includes('마지막 성공 본문 표시')));
  const asked = h.hcCalls.length;
  h.view.refresh(h.cx); await flush(); h.view.load(h.cx); await flush();
  assert.equal(h.hcCalls.length, asked);
});

test('going to a local document and back to the remote one reads it again', async t => {
  const local = { id: 'local-a', path: '/docs/a.md', name: 'a.md', label: 'a', status: 'ok', pinned: true };
  const h = await tab({ documents: [local], hc: async () => reply('원격 본문') }); t.after(h.restore);
  h.ask({ on: 'sub1', path: '/d/r.md' }); await flush();
  const id = h.view.selected;
  h.view.choose('local-a', h.cx); await flush();
  assert.equal(h.view.bodyText, '로컬 /docs/a.md');
  h.view.choose(id, h.cx); await flush(); h.render();
  assert.equal(h.hcCalls.length, 2);
  assert.ok(h.labels.some(text => text.includes('원격 본문')));
  assert.deepEqual(h.stored['sixfold.docs.selection.v1'], { Demo: 'local-a' }, 'only the local selection is saved');
});

test('a slower earlier open cannot overwrite the latest one, and two equal opens share one read', async t => {
  const slow = deferred(), fast = deferred();
  const h = await tab({ hc: args => args.at(-1) === '/d/old.md' ? slow.promise : fast.promise }); t.after(h.restore);
  h.ask({ on: 'sub1', path: '/d/old.md' }); await flush();
  h.ask({ on: 'company-mac', path: '/d/new.md' }); await flush();
  fast.resolve(reply('최신 본문')); await flush();
  slow.resolve(reply('늦은 옛 본문')); await flush(); h.render();
  assert.ok(h.labels.some(text => text.includes('최신 본문')));
  assert.ok(!h.labels.some(text => text.includes('늦은 옛 본문')));
  assert.equal(h.view.documents.filter(d => d.opened).length, 1);
  const same = deferred(), g = await tab({ hc: () => same.promise }); t.after(g.restore);
  g.ask({ on: 'sub1', path: '/d/a.md' }); g.view.refresh(g.cx); g.view.load(g.cx); await flush();
  assert.equal(g.hcCalls.length, 1);
  same.resolve(reply('하나')); await flush();
});

test('closing the tab drops a late reply; offline and bad requests show a reason and keep the list', async t => {
  const late = deferred(), h = await tab({ hc: () => late.promise }); t.after(h.restore);
  h.ask({ on: 'sub1', path: '/d/a.md' }); await flush();
  h.view.close(); late.resolve(reply(SECRET)); await flush();
  assert.equal(h.view.blocks, null);
  const o = await tab({ hc: async () => failed('unreachable', 'cannot reach sub1') }); t.after(o.restore);
  o.ask({ on: 'sub1', path: '/d/a.md' }); await flush(); o.render();
  assert.ok(o.labels.some(text => text.includes('확인 실패 · 그 컴퓨터에 연결할 수 없습니다.')));
  o.ask({ on: 'ghost', path: '/d/a.md' }); await flush(); o.render();
  assert.ok(o.labels.some(text => text.includes('원격 문서 열기 실패 · 연결된 컴퓨터 목록에 없는 이름입니다.')));
  o.ask({ on: 'sub1', path: '//nas/share/a.md' }); await flush(); o.render();
  assert.equal(o.hcCalls.length, 1, 'rejected requests never reach hc');
  o.ask({ on: 'sub1', path: '/d/b.md' }, Date.now() - REQUEST_TTL_MS - 5000); await flush();
  assert.equal(o.hcCalls.length, 1, 'a stale request is dropped unread');
  assert.equal(o.stored[REMOTE_OPEN].Demo, undefined);
});

test('a folder-limited request under a real junction or symbolic link never reaches hc', async t => {
  // Why the limit cannot be kept: an ordinary read follows the link out of the allowed folder,
  // as the other core's file.read does. The tab must refuse such requests, not read them.
  const { mkdtemp, mkdir, writeFile, symlink, rm, readFile: read } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const base = await mkdtemp(`${tmpdir()}/remote-roots-`);
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(`${base}/allowed`); await mkdir(`${base}/outside`);
  await writeFile(`${base}/outside/example.md`, 'outside text');
  await symlink(`${base}/outside`, `${base}/allowed/linked`, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await read(`${base}/allowed/linked/example.md`, 'utf8'), 'outside text', 'the link leads out of the folder');
  const path = `${base.replace(/\\/g, '/')}/allowed/linked/example.md`, root = `${base.replace(/\\/g, '/')}/allowed`;
  assert.equal(reject({ on: 'sub1', path, roots: [root] }), 'roots_unverifiable');
  const h = await tab({ hc: async () => reply('outside text') }); t.after(h.restore);
  h.ask({ on: 'sub1', path, roots: [root] }); await flush(); h.render();
  assert.equal(h.hcCalls.length, 0);
  assert.ok(h.labels.some(text => text.includes('원격 문서 열기 실패 · 허용 폴더 제한은')));
  assert.ok(!h.labels.some(text => text.includes('outside text')));
});

test('remote HTML is shown as source with a notice and links follow the remote machine', async t => {
  const h = await tab({ hc: async args => args.at(-1).endsWith('.html') ? reply('<b onclick="x()">hi</b>') : reply('[다음](next.md) [밖](file:///C:/Windows/win.md) [웹](https://example.com)') }); t.after(h.restore);
  h.ask({ on: 'sub1', path: '/d/page.html' }); await flush(); h.render();
  assert.ok(h.labels.some(text => text.startsWith('```html\n<b onclick="x()">hi</b>')));
  assert.ok(h.labels.some(text => text.includes('원격 HTML은 실행하거나 그리지 않고 소스로만 표시')));
  assert.ok(!h.calls.some(call => call.includes('render_html')));
  h.ask({ on: 'sub1', path: '/d/start.md' }); await flush(); h.render();
  const doc = h.view.documents.find(d => d.id === h.view.selected);
  h.view.follow(doc.path, 'https://example.com', h.cx, doc);
  assert.deepEqual(h.calls.at(-1), ['open_url', 'https://example.com']);
  h.view.follow(doc.path, 'file:///C:/Windows/win.md', h.cx, doc); await flush();
  assert.deepEqual(h.hcCalls.at(-1), ['file', 'read', '--json', '--on', 'sub1', '--offset', '1', '--limit', '4000', '--', 'C:/Windows/win.md']);
  assert.ok(!h.reads.includes('C:/Windows/win.md'), 'never the local file');
  h.view.follow(doc.path, 'javascript:alert(1)', h.cx, doc);
  assert.match(h.view.actionError, /열 수 없는 링크/);
  h.view.follow(doc.path, 'next.md', h.cx, doc); await flush();
  assert.deepEqual(h.hcCalls.at(-1), ['file', 'read', '--json', '--on', 'sub1', '--offset', '1', '--limit', '4000', '--', '/d/next.md']);
  assert.ok(!h.reads.includes('/d/next.md'), 'never the local file');
});

test('no saved state names the remote machine or path, raw or encoded, and old saved places are dropped', async t => {
  const path = '/docs/review-only-name 문서.md';
  const h = await tab({ hc: async () => reply('본문') }); t.after(h.restore);
  h.ask({ on: 'company-mac', path }); await flush(); h.render();
  assert.equal(h.view.location, 'opened', 'the Finder shows the remote row');
  h.view.toggleSidebar(h.cx); h.view.toggleSidebar(h.cx);
  const saved = JSON.stringify(h.stored);
  for (const needle of [path, encodeURIComponent(path), 'review-only-name', encodeURIComponent('문서'), 'company-mac']) {
    assert.ok(!saved.includes(needle), `shared() holds ${needle}`);
  }
  assert.equal(h.stored['sixfold.docs.finder.v1'].Demo.colPath, '');
  const old = { 'sixfold.docs.finder.v1': { Demo: { view: 'list', location: 'opened', colPath: '9999_remote-sub1-%2Fdocs%2Fx.md', sidebar: false, reading: true }, Other: { view: 'column', location: 'docs', colPath: 'a/b' } } };
  const r = await tab({ hc: async () => reply('x'), stored: old }); t.after(r.restore);
  assert.deepEqual(r.stored['sixfold.docs.finder.v1'], { Demo: { view: 'list', location: 'opened', colPath: '', sidebar: false, reading: true }, Other: { view: 'column', location: 'docs', colPath: 'a/b' } },
    'a place saved by an earlier build is cleared on start; the other choices and spaces are kept');
  assert.equal(r.hcCalls.length, 0, 'a restart never reads a remote file by itself');
});

// herdr-core files.rs `lines` (whole lines up to 8 MiB of JSON text, a control character, quote or
// backslash counted as six bytes) behind herdr-app's 8 MiB cut of hc's output, as hc(args) sees it.
const CORE_MAX = 8 << 20, APP_CAP = 8 << 20;
function coreAndApp(fileText, calls = []) {
  const all = fileText.split(/(?<=\n)/).filter(line => line.length);
  return async args => {
    calls.push(args);
    const first = Number(args[args.indexOf('--offset') + 1]), limit = Number(args[args.indexOf('--limit') + 1]);
    if (first === 0 || (first > all.length && first > 1)) return failed('invalid_params', `offset ${first}: the file has ${all.length} lines`, 6);
    let out = '', size = 0, given = 0;
    for (const line of all.slice(first - 1, first - 1 + limit)) {
      const bytes = Buffer.from(line);
      size += bytes.length + 5 * [...bytes].filter(b => b < 0x20 || b === 0x22 || b === 0x5c).length;
      if (size > CORE_MAX) break;
      out += line; given++;
    }
    if (given === 0 && limit > 0 && first <= all.length) return failed('invalid_params', `line ${first} is over 8 MB`, 6);
    const reply = Buffer.from(JSON.stringify({ first, last: first + given - 1, lines: all.length, text: out }));
    return { code: 0, stdout: reply.subarray(0, APP_CAP).toString('utf8'), stderr: '' };
  };
}

test('large documents arrive in pages under the app cap; a line too long for one reply is too large', async () => {
  const target = remoteTarget({ on: 'sub1', path: '/d/big.md' });
  // The reviewer's case: one line just under the core's budget, cut by the app's output limit.
  let calls = [];
  const edge = createRemoteReader({ hc: coreAndApp('a'.repeat(8388602), calls) });
  assert.equal(await kindOf(edge.read(target)), 'too_large');
  assert.deepEqual(calls.map(c => c[c.indexOf('--limit') + 1]), ['4000', '500', '62', '7', '1'], 'fewer lines each time, then gives up');
  assert.equal(await kindOf(createRemoteReader({ hc: coreAndApp('a'.repeat(9 << 20)) }).read(target)), 'too_large', 'the core refuses a line over its budget');
  // Many lines with multibyte text and JSON escapes: the first pages up to the shown length.
  const line = i => `${'가"\\'.repeat(66)} ${i}\n`, many = Array.from({ length: 100000 }, (_, i) => line(i)).join('');
  calls = [];
  const paged = await createRemoteReader({ hc: coreAndApp(many, calls) }).read(target);
  assert.equal(paged.text, many.slice(0, REMOTE_LIMIT)); assert.equal(paged.truncated, true); assert.equal(paged.lines, 100000);
  assert.equal(calls.length, 1, 'one page of 4,000 lines already passes the shown length');
  assert.ok(Buffer.byteLength(JSON.stringify({ text: many.split(/(?<=\n)/).slice(0, 4000).join('') })) < APP_CAP, 'that page fits the app cap');
  // Long lines that fill the core's budget before the line count: still whole lines, no cut JSON.
  const wide = Array.from({ length: 6000 }, (_, i) => `${'x'.repeat(3000)}${i}\n`).join('');
  const shown = await createRemoteReader({ hc: coreAndApp(wide) }).read(target);
  assert.equal(shown.text, wide.slice(0, REMOTE_LIMIT)); assert.equal(shown.truncated, true);
  // A long line after shorter ones ends what is shown instead of failing the document.
  const tail = `short\n${'b'.repeat(8388602)}\n`;
  const ended = await createRemoteReader({ hc: coreAndApp(tail) }).read(target);
  assert.deepEqual({ text: ended.text, truncated: ended.truncated }, { text: 'short\n', truncated: true });
  // A small file is one call and whole; an empty one too.
  calls = [];
  assert.deepEqual(await createRemoteReader({ hc: coreAndApp('# 제목\n본문\n', calls) }).read(target), { text: '# 제목\n본문\n', truncated: false, lines: 2 });
  assert.equal(calls.length, 1);
  assert.deepEqual(await createRemoteReader({ hc: coreAndApp('') }).read(target), { text: '', truncated: false, lines: 0 });
});

test('paging stops at its call budget and when a file shrinks between pages', async () => {
  const target = remoteTarget({ on: 'sub1', path: '/d/long.md' });
  const calls = [];
  const text = Array.from({ length: 50000 }, (_, i) => `${i}\n`).join('');
  const read = await createRemoteReader({ hc: coreAndApp(text, calls), pageLines: 10, maxAsks: 5 }).read(target);
  assert.equal(calls.length, 5); assert.equal(read.truncated, true); assert.equal(read.text, text.split(/(?<=\n)/).slice(0, 50).join(''));
  let n = 0;
  const shrinking = async args => (++n === 1 ? coreAndApp('1\n2\n3\n') : coreAndApp('1\n'))(args);
  const got = await createRemoteReader({ hc: shrinking, pageLines: 2 }).read(target);
  assert.deepEqual({ text: got.text, truncated: got.truncated }, { text: '1\n2\n', truncated: true });
});
