// The issue popup's apply/cancel flow against a fake herdr runtime (files and exec in memory).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as detail from '../mods/week-timeline/detail.js';
import * as model from '../mods/week-timeline/model.js';

const KEY = 'DEMO-1', DIR = '/fake/data/sixfold/week-timeline-issues';
const REQ = `${DIR}/${KEY}.request.json`, RES = `${DIR}/${KEY}.apply.json`;
let copies = 0;   // each popup() gets its own module copy (data: URLs are cached)

async function popup() {
  const files = new Map(), runs = [];
  let onApply = () => ({ code: 0 });
  let reader = p => files.get(p) ?? null;
  const herdr = {
    appHome: () => '/fake', props: () => ({}), theme: () => ({}), run() {}, closeOverlay() {},
    readTextFile: async p => reader(p),
    writeTextFile: async (p, text, expected) => {
      if ((files.get(p) ?? null) !== expected) throw new Error('stale snapshot');
      files.set(p, text);
    },
    exec: async (command, args) => { runs.push([command, ...args]); return command === '/apply' ? onApply(files, args) : { code: 0 }; },
  };
  const gpui = { div() {}, h_flex() {}, v_flex() {}, Input: {}, Textarea: {}, InputState: { new: () => ({}) }, TextareaState: { new: () => ({}) } };
  const lib = { ...herdr, ...gpui, ...model, ...detail };
  const source = readFileSync(new URL('../mods/week-timeline/issue.js', import.meta.url), 'utf8');
  const names = [...source.matchAll(/^import \{([^}]*)\} from/gm)].flatMap(m => m[1].split(',').map(s => s.trim()).filter(Boolean));
  for (const n of names) assert.ok(n in lib, `test runtime lacks ${n}`);
  globalThis.__wt = lib;
  const body = source.replace(/^import [\s\S]*?;\n/gm, '');
  const code = `// copy ${++copies}\nconst {${names.join(',')}} = globalThis.__wt;\n${body}\nexport { loadCarried, applyNow, cancelAll, removeAt, stage };`;
  const m = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const jobs = [];
  const cx = { notify() {}, spawn(fn) { jobs.push(fn(cx)); }, timer: { every: () => ({ cancel() {} }) }, stop_propagation() {} };
  const drain = async () => { while (jobs.length) await Promise.all(jobs.splice(0)); };
  files.set('/fake/data/sixfold/week-timeline-bridge.json', JSON.stringify({ command: '/read', apply: { command: '/apply' } }));
  const v = { key: KEY, pending: [], closed: false, timers: [], detail: { issue: { key: KEY, status: 'Todo', labels: [], due: '', description: '' } } };
  return { m, v, cx, drain, files, runs, setApply: f => { onApply = f; }, setRead: f => { reader = f; } };
}

test('a stale earlier success is not taken for this apply (P1)', async () => {
  const { m, v, cx, drain, files, setApply } = await popup();
  files.set(RES, JSON.stringify({ key: KEY, at: '2026-11-11T10:00:00+09:00', request: 'old-request', ok: true, applied: 1, kept: [] }));
  setApply(() => ({ code: 1 }));                       // this run failed and wrote nothing
  v.pending = [{ kind: 'status', to: 'Done' }];
  m.applyNow(v, cx); await drain();
  assert.deepEqual(v.pending, [{ kind: 'status', to: 'Done' }]);
  assert.equal(v.result, null);
  assert.match(v.message, /그대로/);
});

test('the result for this request is used, even with a non-zero exit', async () => {
  const { m, v, cx, drain, files, setApply } = await popup();
  setApply(files => {
    const request = JSON.parse(files.get(REQ));
    files.set(RES, JSON.stringify({ key: KEY, at: 'x', request: request.id, ok: false, error: '권한', applied: 0, kept: request.changes }));
    return { code: 1 };
  });
  v.pending = [{ kind: 'status', to: 'Done' }];
  m.applyNow(v, cx); await drain();
  assert.equal(v.result.ok, false);
  assert.deepEqual(v.pending, [{ kind: 'status', to: 'Done' }]);
  assert.equal(v.message, '권한');
});

test('cancel after a failed apply does not come back on reopen (P2)', async () => {
  const { m, v, cx, drain, files } = await popup();
  files.set(REQ, JSON.stringify({ key: KEY, id: 'req-1', changes: [{ kind: 'status', to: 'Done' }, { kind: 'due', to: null }] }));
  m.loadCarried(v, cx); await drain();
  assert.equal(v.pending.length, 2);
  m.removeAt(v, 0, cx); await drain();
  const reopened = { ...v, pending: [] };
  m.loadCarried(reopened, cx); await drain();
  assert.deepEqual(reopened.pending, [{ kind: 'due', to: null }]);
  m.cancelAll(v, cx); await drain();
  const again = { ...v, pending: [] };
  m.loadCarried(again, cx); await drain();
  assert.deepEqual(again.pending, []);
});

test('replies carry an idempotency key and the request an id', async () => {
  const { m, v, cx, drain, files, setApply } = await popup();
  m.stage(v, { kind: 'reply', parent: '', body: '한 번' }, cx);
  assert.match(v.pending[0].rid, /^[A-Za-z0-9_-]{8,64}$/);
  let seen = null;
  setApply(files => { seen = JSON.parse(files.get(REQ)); return { code: 1 }; });
  m.applyNow(v, cx); await drain();
  assert.match(seen.id, /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(seen.changes[0].rid, v.pending[0].rid);   // a retry sends the same key again
});

test('a late save cannot rewrite the request the popup approved (re-review P1)', async () => {
  const { m, v, cx, drain, files, setApply, setRead } = await popup();
  files.set(REQ, JSON.stringify({ key: KEY, id: 'old', changes: [{ kind: 'status', to: 'In Progress' }] }));
  v.carried = true; v.pending = [{ kind: 'status', to: 'In Progress' }];
  let first = true, release;
  setRead(p => {
    if (p === REQ && first) { first = false; return new Promise(resolve => { release = () => resolve(files.get(p)); }); }
    return files.get(p) ?? null;
  });
  m.stage(v, { kind: 'due', to: '2026-11-20' }, cx);   // its save of status + due is slow
  m.removeAt(v, 0, cx);                                 // now only the due change
  await new Promise(resolve => setImmediate(resolve));
  let sent, args;
  setApply(async (files, given) => {
    release(); await new Promise(resolve => setImmediate(resolve));
    sent = JSON.parse(files.get(REQ)); args = given;
    return { code: 0 };
  });
  m.applyNow(v, cx); await drain();
  assert.deepEqual(sent.changes, [{ kind: 'due', to: '2026-11-20' }]);
  assert.equal(args[args.indexOf('--request') + 1], sent.id);   // the command runs that request id only
});

test('a refused request (another one in the file) keeps the changes', async () => {
  const { m, v, cx, drain, files, setApply } = await popup();
  setApply((files, given) => {
    const id = given[given.indexOf('--request') + 1];
    files.set(RES, JSON.stringify({ key: KEY, at: 'x', request: id, mismatch: true, ok: false, error: '반영 요청이 그 사이 바뀜', applied: 0, kept: [] }));
    return { code: 1 };
  });
  v.pending = [{ kind: 'status', to: 'Done' }];
  m.applyNow(v, cx); await drain();
  assert.deepEqual(v.pending, [{ kind: 'status', to: 'Done' }]);
  assert.match(v.message, /바뀜/);
});
