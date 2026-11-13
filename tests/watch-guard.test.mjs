import test from 'node:test';
import assert from 'node:assert/strict';
import {createRetry, watchRecorder, errorKind} from '../mods/sixfold-desk/watch-guard.js';

function clock() {
  let now = 0; const timers = new Set();
  return {
    now: () => now,
    timer: (ms, fn) => { const t = {at: now + ms, ms, fn, cancel() { timers.delete(t); }}; timers.add(t); return t; },
    pending: () => [...timers].map(t => t.ms),
    advance(ms) { now += ms; for (const t of [...timers].sort((a, b) => a.at - b.at)) if (t.at <= now) { timers.delete(t); t.fn(); } },
  };
}

test('error kinds keep only a short classification, never the message', () => {
  assert.equal(errorKind(new Error('File changed while reading its typed snapshot')), 'ledger-changed');
  assert.equal(errorKind(new Error('View no longer displays alerts')), 'hidden');
  assert.equal(errorKind(new Error('Invalid Slack popup event ledger')), 'ledger-invalid');
  assert.equal(errorKind(new Error('compare-and-swap conflict')), 'write-conflict');
  assert.equal(errorKind(new Error('outstanding host task limit of 1024')), 'spawn-refused');
  assert.equal(errorKind(new TypeError('token xoxb-123 in /Users/someone/path')), 'error:TypeError');
});

test('failures retry after 5 s, 30 s, then 2 min; one retry at a time; success resets and cancels', () => {
  const c = clock(), entries = []; let retries = 0;
  const retry = createRetry({timer: c.timer, now: c.now, retry: () => retries++, record: e => entries.push(e)});
  retry.fail(new Error('x')); retry.fail(new Error('x'));
  assert.deepEqual(c.pending(), [5000], 'a second failure while a retry waits adds no timer');
  c.advance(5000); assert.equal(retries, 1);
  retry.fail(new Error('x')); assert.deepEqual(c.pending(), [120000], 'the third failure waits longest');
  retry.ok(); assert.deepEqual(c.pending(), [], 'a success cancels the waiting retry');
  assert.equal(entries.at(-1).kind, 'ok'); assert.equal(retry.failures, 0);
  retry.fail(new Error('x')); assert.deepEqual(c.pending(), [5000], 'after a success the delay starts over');
  retry.dispose(); assert.deepEqual(c.pending(), []);
  retry.fail(new Error('x')); assert.deepEqual(c.pending(), [], 'nothing after dispose');
});

test('a hidden view and a noted stall are recorded without a retry timer', () => {
  const c = clock(), entries = [];
  const retry = createRetry({timer: c.timer, now: c.now, retry: () => {}, record: e => entries.push(e)});
  retry.fail(new Error('View no longer displays alerts')); retry.note('stalled');
  assert.deepEqual(c.pending(), []); assert.deepEqual(entries.map(e => e.kind), ['hidden', 'stalled']);
});

test('the recorder throttles a repeated failure and always writes the recovery', () => {
  const writes = [], record = watchRecorder(text => writes.push(JSON.parse(text)));
  record({kind: 'stalled', at: 0, failures: 1}); record({kind: 'stalled', at: 1000, failures: 2});
  assert.equal(writes.length, 1, 'the same failure within a minute is not rewritten');
  record({kind: 'stalled', at: 61000, failures: 3}); assert.equal(writes.length, 2);
  record({kind: 'ok', at: 62000, failures: 0});
  assert.deepEqual(writes.at(-1), {schema: 1, state: 'ok', since: new Date(62000).toISOString(), failures: 0, last_error: {kind: 'stalled', at: new Date(61000).toISOString()}});
});
