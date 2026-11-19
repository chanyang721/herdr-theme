import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {scanSource,scanTree,findings,unexcused,report} from './cpu-scan.mjs';

// Every periodic timer in mods/ (timer.every, or a timer.after that schedules itself again) that
// runs faster than a second, spawns work while the window is hidden or writes shared state on each
// tick. Keep this list short: each entry is a decision. `match` tests the call and its callback's
// first words, so a new timer in the same file is not excused.
const ALLOW=[
  {rule:'interval',file:'mods/sixfold-desk/poll.js',match:/^timer\.every\(every, tick$/,
    reason:'createPoll itself; its callers are checked by their every: value'},
  {rule:'interval',file:'mods/sixfold-desk/live-events.js',match:/^timer\.every\(period, \(\)=>\{if\(!disposed&&version===token\)sample\(\);\}$/,
    reason:'subscribeLiveEvents sampler; reads the in-memory log only, callers are checked by their intervalMs'},
  {rule:'interval',file:'mods/sixfold-desk/main.js',match:/^timer\.every\(500, cx=>\{ const config=this\.sidebarFiles\?\.voice;/,
    reason:'voice focus sampling (opt-in): in-memory reads; voice-focus.json is written on a focus change and as a 1.5 s heartbeat'},
  {rule:'hidden',file:'mods/sixfold-desk/main.js',match:/^timer\.every\(500, cx=>\{ const config=this\.sidebarFiles\?\.voice;/,
    reason:'the microphone follows focus while the window is hidden too; the heartbeat keeps the helper from acting on stale focus'},
  {rule:'interval',file:'mods/sixfold-desk/alerts.js',match:/^timer\.after\(20, \(\)=>\{scheduled=null;refresh\(cx\);\}$/,
    reason:'20 ms debounce of input changes; schedules again only when an input changed during the run'},
  {rule:'interval',file:'mods/sixfold-desk/linear-feed.js',match:/^timer\.after\(20, \(\) => \{ scheduled = null; refresh\(cx\); \}$/,
    reason:'20 ms debounce of input changes; schedules again only when an input changed during the run'},
  {rule:'interval',file:'mods/sixfold-desk/github-feed.js',match:/^timer\.after\(20, \(\) => \{ scheduled = null; refresh\(cx\); \}$/,
    reason:'20 ms debounce of input changes (as linear-feed.js); schedules again only when an input changed during the run'},
  {rule:'interval',file:'mods/sixfold-desk/alert-files.js',match:/^timer\.after\(ms, look$/,
    reason:'nextFileWait: 3 s, then 10 s, ending at 7 min, only while a file text popover is open'},
  {rule:'hidden',file:'mods/sixfold-desk/alert-files.js',match:/^timer\.after\(ms, look$/,
    reason:'only while a file text popover is open; asks the collector for the text and reads one local file'},
  {rule:'interval',file:'mods/sixfold-slack-inbox/main.js',match:/^timer\.after\(ms, look$/,
    reason:'nextFileWait: 3 s, then 10 s, ending at 7 min, only while a file text popover is open'},
  {rule:'hidden',file:'mods/sixfold-slack-inbox/main.js',match:/^timer\.after\(ms, look$/,
    reason:'only while a file text popover is open; asks the collector for the text and reads one local file'},
  {rule:'hidden',file:'mods/sixfold-tabs/main.js',match:/^timer\.every\(5000, ensure$/,
    reason:'runs the installer only while a document tab is missing, with a 30 s to 5 min backoff'},
  {rule:'hidden',file:'mods/sixfold-linear-inbox/main.js',match:/^timer\.every\(2000, refresh$/,
    reason:'overlay that exists only while open; reads local files and notifies on change'},
  {rule:'hidden',file:'mods/sixfold-slack-inbox/main.js',match:/^timer\.every\(2000, refresh$/,
    reason:'overlay that exists only while open; reads local files and notifies on change'},
  {rule:'shared',file:'mods/sixfold-slack-inbox/main.js',match:/^timer\.every\(2000, refresh$/,
    reason:'sixfold.alertRead is written only after the read files changed, while the overlay is open'},
  {rule:'hidden',file:'mods/week-timeline/issue.js',match:/^timer\.every\(3000, cx => \{ if \(v\.reading\) loadDetail\(v, cx, false\); \}$/,
    reason:'issue overlay while a Linear read is pending; reads one local file'},
];

test('periodic timers in mods/ stay slow, hidden-aware and quiet on shared state',async()=>{
  const scan=await scanTree(fileURLToPath(new URL('../mods/',import.meta.url)),'mods/');
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
  assert.deepEqual(rules("cx.timer.every(5000, cx => { // skipped while visible is false\n exec(tool, []); });"),['hidden'],'a comment is not a check');
  assert.deepEqual(rules("const shown = () => window()?.visible !== false;\ncx.timer.every(5000, cx => { if (!shown()) return; exec(tool, []); });"),[],'an expression arrow is followed');
  assert.deepEqual(rules("c.poll = () => { c.timer = cx.timer.after(500, () => { cx.spawn(async () => {}); c.poll(); }); };"),['hidden','interval'],
    'a timer.after that schedules itself again is periodic');
  assert.deepEqual(rules("const later = c => c.timer.after(ms, look);\nconst look = c => { c.spawn(async () => {}); later(c); };"),['hidden','interval'],'also through a named callback');
  assert.deepEqual(rules("c.poll = () => { if (c.hidden()) return; cx.timer.after(POLL_MS, () => { cx.spawn(async () => {}); c.poll(); }); };\nconst POLL_MS = 2000;"),[]);
  assert.deepEqual(rules("c.wake = () => { cx.timer.after(Math.max(1, at - Date.now()), () => { c.notify(); c.wake(); }); };"),[],'a deadline wake is not a fixed period');
  assert.deepEqual(rules("const once = () => { cx.timer.after(100, () => cx.notify()); };"),[],'a one-shot timer is not periodic');
});
