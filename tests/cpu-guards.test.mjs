import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {scanSource,scanTree,findings,unexcused,report} from './cpu-scan.mjs';

// Every periodic timer in mods/ that runs faster than a second, spawns work while the window is
// hidden or writes shared state on each tick. Keep this list short: each entry is a decision.
const ALLOW=[
  {rule:'interval',file:'sixfold-desk/poll.js',match:/every\(every,/,
    reason:'createPoll itself; its callers are checked by their every: value'},
  {rule:'interval',file:'sixfold-desk/live-events.js',match:/every\(period,/,
    reason:'subscribeLiveEvents sampler; reads the in-memory log only, callers are checked by their intervalMs'},
  {rule:'interval',file:'sixfold-desk/main.js',match:/voice-focus\.json/,
    reason:'voice focus sampling: in-memory reads, the file is written only on a focus change or heartbeat'},
  {rule:'hidden',file:'sixfold-desk/main.js',match:/voice-focus\.json/,
    reason:'the microphone follows focus while the window is hidden too'},
  {rule:'hidden',file:'sixfold-desk/main.js',match:/'route',\['--drain'\]/,
    reason:'queued message routes are delivered whether or not the window is shown; runs only while a route is queued'},
  {rule:'hidden',file:'sixfold-desk/main.js',match:/'collaborate',\['drain'\]/,
    reason:'collaboration drain runs hidden by design; due only while the lease ledger holds work'},
  {rule:'hidden',file:'sixfold-desk/main.js',match:/collect_computers/,
    reason:'opt-in peer status, at most one helper run per 15 s'},
  {rule:'hidden',file:'sixfold-tabs/main.js',match:/install_doc_tabs/,
    reason:'repairs a missing document tab only, with a 30 s to 5 min backoff'},
  {rule:'hidden',file:'sixfold-linear-inbox/main.js',match:/every\(2000,/,
    reason:'overlay that exists only while open; reads local files and notifies on change'},
  {rule:'hidden',file:'sixfold-slack-inbox/main.js',match:/every\(2000,/,
    reason:'overlay that exists only while open; reads local files and notifies on change'},
  {rule:'shared',file:'sixfold-slack-inbox/main.js',match:/sixfold\.alertRead/,
    reason:'written only after the read files changed, while the overlay is open'},
  {rule:'hidden',file:'week-timeline/issue.js',match:/every\(3000,/,
    reason:'issue overlay while a Linear read is pending; reads one local file'},
];

test('periodic timers in mods/ stay slow, hidden-aware and quiet on shared state',async()=>{
  const scan=await scanTree(fileURLToPath(new URL('../mods/',import.meta.url)));
  assert.ok(scan.timers.length>5,'the scan found the mods timers');
  for(const entry of ALLOW)assert.ok(entry.reason?.length>10,`${entry.file}: an allowlist entry needs a reason`);
  const result=unexcused(findings(scan),ALLOW);
  assert.ok(!result.left.length&&!result.stale.length,`\n${report(result)}\n`);
});

test('the scan catches each pattern it guards',()=>{
  const rules=src=>findings(scanSource(src,'sample.js')).map(f=>f.rule).sort();
  assert.deepEqual(rules('cx.timer.every(700, cx => cx.notify());'),['interval']);
  assert.deepEqual(rules('const TICK_MS = 2 * 250;\ncx.timer.every(TICK_MS, cx => cx.notify());'),['interval']);
  assert.deepEqual(rules('cx.timer.every(period, tick);'),['interval'],'an unknown interval needs a decision');
  assert.deepEqual(rules('cx.timer.every(5000, cx => cx.notify());'),[]);
  assert.deepEqual(rules("cx.timer.every(5000, cx => { exec(tool, ['x']); });"),['hidden']);
  assert.deepEqual(rules('const tick = cx => { cx.spawn(async () => {}); };\ncx.timer.every(5000, tick);'),['hidden'],'a named callback is followed');
  assert.deepEqual(rules('class A {\n  tick(cx) { this.refresh(cx); }\n  refresh(cx) { cx.spawn(async () => {}); }\n}\ncx.timer.every(5000, cx => this.tick(cx));'),['hidden'],'two calls deep');
  assert.deepEqual(rules("cx.timer.every(5000, cx => { if (window()?.visible === false) return; exec(tool, []); });"),[]);
  assert.deepEqual(rules('createPoll(cx, {every: 300, job});'),['hidden','interval']);
  assert.deepEqual(rules('createPoll(cx, {every: 2000, visible: () => shown, job});'),[]);
  assert.deepEqual(rules('subscribeLiveEvents({key, read, cx, onChange});'),['interval'],'the sampler default is 500 ms');
  assert.deepEqual(rules("cx.timer.every(5000, cx => setShared('k', read()));"),['shared']);
  assert.deepEqual(rules("cx.timer.every(5000, cx => { const v = read(); if (!same(shared('k'), v)) setShared('k', v); });"),[]);
  assert.deepEqual(rules("subscribeJsonFile(cx, path, snapshot => { setShared('k', snapshot.value); });"),['shared']);
  assert.deepEqual(rules("const publish = createSharedPublisher(setShared);\nsubscribeJsonFile(cx, path, s => publish('k', s.value));\nsetShared('other', 1);"),['shared'],
    'a file with a publisher writes only through it');
  assert.deepEqual(rules('cx.timer.every(500, cx => { if (JSON.stringify(a) !== JSON.stringify(b)) cx.notify(); });').filter(r=>r!=='interval'),['compare']);
});
