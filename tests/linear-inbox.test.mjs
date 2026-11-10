import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {linearReadsUrl} from './linear-reads-url.mjs';
import {categoryLabel, linearLink, visibleItems, spacesOf, issueLine, buildRequest, requestId, resultLabel} from '../mods/sixfold-linear-inbox/model.js';
import {linearUnread, linearScoped} from '../mods/sixfold-desk/alert-model.js';

const N = '11111111-1111-4111-8111-111111111111';
const items = [
  {id: N, workspace: 'Alpha', read: false, category: 'assignments', issue: 'ABC-1', status: 'Todo', assignee: 'Me', priority: 'High', url: 'https://linear.app/demo/issue/ABC-1/x'},
  {id: 'n2', workspace: 'Beta', read: true, category: 'reminders', issue: 'ABC-2'},
  {id: 'n3', workspace: 'alpha', read: false, category: 'mentions', issue: ''},
];

test('linear items are scoped to their space and counted unread', () => {
  assert.equal(linearUnread(items, 'Alpha'), 2);
  assert.equal(linearUnread(items, 'Beta'), 0);
  assert.equal(linearScoped(items, null).length, 3);
  assert.deepEqual(visibleItems(items, {space: 'ALPHA', unreadOnly: true}).map(i => i.id), [N, 'n3']);
  assert.deepEqual(spacesOf(items), ['Alpha', 'Beta', 'alpha']);
  assert.equal(categoryLabel(items[0]), '배정');
  assert.equal(categoryLabel({category: 'unknown'}), '알림');
  assert.equal(issueLine(items[0]), 'Todo · 담당 Me · 우선순위 High');
});

test('changed fields read before → after; the card popover expires and ranks unread first', async () => {
  const {changeLines: deskLines, popoverOpen, popoverRows, POPOVER_TTL} = await import('../mods/sixfold-desk/alert-model.js');
  const {changeLines} = await import('../mods/sixfold-linear-inbox/model.js');
  const item = {changes: [{field: 'status', from: 'Todo', to: 'Done'}, {field: 'assignee', from: '', to: 'Kim'}, {field: 'secret', from: 'a', to: 'b'}]};
  assert.deepEqual(changeLines(item), ['상태 Todo → Done', '담당 없음 → Kim']);
  assert.deepEqual(deskLines(item), changeLines(item));   // the two copies stay identical
  assert.deepEqual(changeLines({}), []);
  const now = 1_000_000_000, state = {space: 'Alpha', source: 'linear', boot: 'run-1', at: now};
  assert.ok(popoverOpen(state, 'alpha', 'linear', 'run-1', now + 1000));
  assert.ok(!popoverOpen(state, 'Alpha', 'linear', 'run-2', now + 1000));   // restored after a restart
  assert.ok(!popoverOpen({...state, boot: undefined}, 'Alpha', 'linear', 'run-1', now));
  assert.ok(!popoverOpen(state, 'Alpha', 'slack', 'run-1', now));
  assert.ok(!popoverOpen(state, 'Alpha', 'linear', 'run-1', now + POPOVER_TTL));
  assert.ok(!popoverOpen({}, 'Alpha', 'linear', 'run-1', now));
  const rows = popoverRows([{id: 1, read: true, at: '3'}, {id: 2, read: false, at: '1'}, {id: 3, read: false, at: '2'}], 2);
  assert.deepEqual(rows.map(r => r.id), [3, 2]);
});

test('only linear.app links open', () => {
  assert.ok(linearLink(items[0].url));
  for (const url of ['https://evil.example/issue/x', 'javascript:alert(1)', 'https://linear.app.evil.com/x/issue/y', undefined]) assert.equal(linearLink(url), false);
});

test('requests match the collector contract and refuse bad input', () => {
  const now = new Date('2026-11-10T00:00:00Z');
  assert.deepEqual(buildRequest('mark_read', items[0], {}, {now, id: 'req-00000001'}),
    {v: 1, id: 'req-00000001', action: 'mark_read', requested_at: '2026-11-10T00:00:00.000Z', notification: N, read: true});
  assert.equal(buildRequest('set_state', items[0], {state: 'Done'}, {now, id: 'r'}).state, 'Done');
  assert.equal(buildRequest('comment', items[0], {body: '확인'}, {now, id: 'r'}).body, '확인');
  assert.throws(() => buildRequest('comment', items[0], {body: '  '}));
  assert.throws(() => buildRequest('set_state', items[0], {state: 'a\nb'}));
  assert.throws(() => buildRequest('set_state', items[2], {state: 'Done'}));   // no issue
  assert.throws(() => buildRequest('delete', items[0]));
  const seen = buildRequest('mark_seen', {id: 'comment:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', local: true}, {}, {now: new Date(0), id: 'req-1'});
  assert.deepEqual(seen, {v: 1, id: 'req-1', action: 'mark_seen', requested_at: new Date(0).toISOString(), item: 'comment:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'});
  assert.throws(() => buildRequest('mark_seen', items[0]));          // a Linear notification is read in Linear
  assert.match(requestId(1, () => 0.5), /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(resultLabel(null), '처리 대기 중…');
  assert.equal(resultLabel({ok: false, error: 'x'}), '실패: x');
});

test('new Linear alerts become arrivals into their space (Share otherwise); no sidebar host opens the window; unread ones announce on first run', async () => {
  const {createHash} = await import('node:crypto');
  const files = new Map([['linear-alerts.json', JSON.stringify({items: [{id: 'old', read: false, category: 'assignments', workspace: 'Alpha'}, {id: 'past', read: true, category: 'mentions'}], spaces: ['Alpha']})]]);
  const shared = {}, opens = [], tasks = [], timers = new Set(), callbacks = new Map(), changes = new Set();
  const cx = {notify() {}, spawn(fn) { const task = fn(cx); tasks.push(task); return task; },
    timer: {after(ms, callback) { assert.equal(ms, 20); const timer = {callback, cancel() { timers.delete(timer); }}; timers.add(timer); return timer; }, every() { assert.fail('no polling'); }}};
  const snapshot = path => { const raw = files.get(path.split('/').at(-1)); if (raw === undefined) return {status: 'missing', hash: null};
    return {status: 'ready', hash: createHash('sha256').update(raw).digest('hex'), value: JSON.parse(raw)}; };
  globalThis.__linearRuntime = {
    appHome: () => '/test', createHash,
    readJsonSnapshot: async path => snapshot(path),
    readTextFile: async path => files.get(path.split('/').at(-1)) ?? null,
    writeTextFile: async (path, value, expected) => {
      const name = path.split('/').at(-1);
      if ((files.get(name) ?? null) !== expected) throw new Error('compare-and-swap conflict');
      files.set(name, value); for (const c of changes) c();
    },
    subscribeJsonFile: (_cx, path, callback) => { callbacks.set(path, callback); return () => callbacks.delete(path); },
    subscribeFileChanges: (_cx, _path, callback) => { changes.add(callback); return () => changes.delete(callback); },
    setShared: (key, value) => { shared[key] = value; },
    openOverlay: value => opens.push(value),
    spaces: () => [{id: 's1', name: 'Alpha'}, {id: 's0', name: 'Share'}],
  };
  const storeUrl = new URL('../mods/sixfold-desk/arrival-store.js', import.meta.url).href;
  const modelUrl = new URL('../mods/sixfold-desk/arrival-model.js', import.meta.url).href;
  let source = await readFile(new URL('../mods/sixfold-desk/linear-feed.js', import.meta.url), 'utf8');
  source = source.replace(/\r\n/g, '\n').replace(/^import .* from '(herdr|crypto|\.\/panel-io\.js)';\n/gm, '')
    .replace("'./arrival-store.js'", `'${storeUrl}'`).replace("'./arrival-model.js'", `'${modelUrl}'`)
    .replace("'./alert-model.js'", `'${new URL('../mods/sixfold-desk/alert-model.js', import.meta.url).href}'`)
    .replace("'./linear-reads.js'", `'${await linearReadsUrl()}'`);
  source = `const {${Object.keys(globalThis.__linearRuntime).join(',')}} = globalThis.__linearRuntime;\n` + source;
  const store = await import(storeUrl);
  const flush = async () => { for (let n = 0; n < 20; n++) { const due = [...timers]; timers.clear(); due.forEach(t => t.callback(cx)); await Promise.all(tasks.splice(0)); await Promise.resolve(); if (!timers.size && !tasks.length) return; } assert.fail('did not settle'); };
  const publish = () => { for (const [path, callback] of callbacks) callback(snapshot(path)); };
  const feed = items => { files.set('linear-alerts.json', JSON.stringify({items, spaces: ['Alpha']})); publish(); };
  try {
    const {watchLinear} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#linear');
    const view = {}, stop = watchLinear(view, cx);
    publish(); await flush();
    // First run, no sidebar host: the still-unread assignment opens the window once; read history stays silent.
    assert.equal(opens.length, 1);
    assert.deepEqual(JSON.parse(files.get('linear-popup-events.json')).seen, ['linear:old', 'linear:past']);
    assert.deepEqual(shared['sixfold.linearSpaces'].sort(), ['Alpha', 'Share']);   // 'past' has no space: Share
    feed([{id: 'old', read: false, category: 'assignments'}, {id: 'seen', read: true, category: 'assignments'}, {id: 'remind', read: false, category: 'reminders'}]);
    await flush();
    assert.equal(opens.length, 1);                       // read or reminder only: nothing
    // A sidebar host: each new alert arrives into its space, an unknown space into Share. Comments count.
    store.setArrivalHost(() => true);
    feed([{id: 'a', read: false, category: 'commentsAndReplies', workspace: 'Alpha', issue: 'ABC-1', issue_title: 'T',
           subtitle: 'Kim commented: looks good\nsecond line', url: 'https://linear.app/demo/issue/ABC-1/t#comment-0a1b2c3d'},
          {id: 'b', read: false, category: 'assignments', workspace: 'Nowhere'}, {id: 'old', read: false, category: 'assignments'}]);
    await flush();
    assert.equal(opens.length, 1);
    const landed = store.arrivals().filter(a => a.key === 'linear:a' || a.key === 'linear:b').map(a => [a.key, a.id, a.space, a.source, a.issue]);
    assert.deepEqual(landed, [['linear:b', 'b', 'Share', 'linear', ''], ['linear:a', 'a', 'Alpha', 'linear', 'ABC-1']]);   // newest lands last
    // The popup says what changed in one line (who, what) and keeps the comment link.
    const a = store.arrivals().find(x => x.key === 'linear:a');
    assert.equal(a.line, 'Kim commented: looks good');
    assert.equal(a.url, 'https://linear.app/demo/issue/ABC-1/t#comment-0a1b2c3d');
    // An alert of a space not on screen belongs to Share everywhere: badge, popover and inbox agree with its arrival.
    assert.equal(shared['sixfold.linearItems'].find(i => i.id === 'b').workspace, 'Share');
    assert.equal(shared['sixfold.linearItems'].find(i => i.id === 'b').workspace_raw, 'Nowhere');
    assert.deepEqual(shared['sixfold.linearSpaces'].sort(), ['Alpha', 'Share']);
    const count = store.arrivals().length;
    feed([{id: 'a', read: false, category: 'mentions', workspace: 'Alpha'}, {id: 'b', read: false, category: 'assignments'}, {id: 'old', read: true, category: 'assignments'}]);
    await flush();
    assert.equal(store.arrivals().length, count);        // the same notification never arrives twice
    assert.equal(shared['sixfold.linearItems'].length, 3);
    stop(); assert.equal(callbacks.size, 0); assert.equal(changes.size, 0);   // stops with the view: nothing piles up
    store.setArrivalHost(null);
  } finally { delete globalThis.__linearRuntime; }
});

test('an arrival shows, flies in integer steps and lands; motion off only counts it', async () => {
  const {ARRIVAL, arrivalPhase, pushArrival, visibleArrivals, inFlight, nextPhaseAt, flightPath, arrivalTarget, arrivalOpen} = await import('../mods/sixfold-desk/arrival-model.js');
  const t0 = 1_000_000;
  let list = pushArrival([], {key: 'k1', source: 'slack', space: 'Alpha'}, t0);
  assert.equal(arrivalPhase(list[0], t0 + 10), 'show');
  assert.equal(arrivalPhase(list[0], t0 + ARRIVAL.showMs + 1), 'fly');
  assert.equal(arrivalPhase(list[0], t0 + ARRIVAL.showMs + ARRIVAL.flyMs), 'landed');
  assert.equal(arrivalPhase(list[0], t0 + 10, false), 'landed');          // motion off: no popup, no move
  assert.equal(inFlight(list, 'alpha', 'slack', t0 + 10), 1);            // not in the badge until it lands
  assert.equal(inFlight(list, 'Alpha', 'slack', t0 + 10, false), 0);
  assert.equal(visibleArrivals(list, t0 + 10, false).length, 0);
  assert.equal(nextPhaseAt(list, t0 + 10), t0 + ARRIVAL.showMs);
  assert.equal(nextPhaseAt(list, t0 + 10, false), null);
  list = pushArrival(list, {key: 'k1', source: 'slack', space: 'Alpha'}, t0 + 5);
  assert.equal(list.length, 1);                                           // one per key
  for (let i = 0; i < 80; i++) list = pushArrival(list, {key: `n${i}`, source: 'linear', space: 'Alpha'}, t0 + i);
  assert.equal(list.length, ARRIVAL.ledger);                              // bounded
  assert.equal(visibleArrivals(list, t0 + 100).length, ARRIVAL.visible);
  const late = pushArrival(list, {key: 'late', source: 'linear', space: 'Alpha'}, t0 + 10 * ARRIVAL.keepMs);
  assert.deepEqual(late.map(a => a.key), ['late']);                       // landed ones age out
  const path = flightPath({x: 101, y: 403}, {x: 13, y: 57});
  assert.ok(path.every(p => Number.isInteger(p.x) && Number.isInteger(p.y) && p.x % 2 === 0 && p.y % 2 === 0));
  assert.deepEqual(path.at(-1), {x: 14, y: 58});                         // ends on the target, snapped
  assert.ok(path.length <= ARRIVAL.steps && path.length >= 3);
  assert.equal(arrivalTarget('medi', ['Alpha', 'Share']), 'Share');
  assert.equal(arrivalTarget('ALPHA', ['Alpha', 'Share']), 'Alpha');
  assert.equal(arrivalTarget('x', []), 'Share');
  assert.deepEqual(arrivalOpen({source: 'linear', space: 'Alpha'}), {source: 'linear', project: 'Alpha'});
});

test('a flight wakes the sidebar only at its finite step edges, then blinks once; badges count landed items only', async () => {
  const {ARRIVAL, pushArrival, nextPhaseAt, flightStep, justLanded, flyingIds} = await import('../mods/sixfold-desk/arrival-model.js');
  const t0 = 5_000_000, list = pushArrival([], {key: 'linear:x', id: 'x', source: 'linear', space: 'Alpha'}, t0);
  const fly = t0 + ARRIVAL.showMs, step = ARRIVAL.flyMs / ARRIVAL.steps;
  const edges = [];
  for (let now = t0, next; (next = nextPhaseAt(list, now)) !== null; now = next) edges.push(next - t0);
  assert.equal(edges.length, ARRIVAL.steps + 2);                       // finite: each step, landing, blink end
  assert.equal(edges.at(-1), ARRIVAL.showMs + ARRIVAL.flyMs + ARRIVAL.blinkMs);
  assert.equal(flightStep(list[0], fly), 0);
  assert.equal(flightStep(list[0], fly + step * 2 + 1), 2);
  assert.equal(flightStep(list[0], fly + ARRIVAL.flyMs * 3), ARRIVAL.steps - 1);
  assert.equal(justLanded(list, fly + ARRIVAL.flyMs - 1).length, 0);
  assert.equal(justLanded(list, fly + ARRIVAL.flyMs + 1).length, 1);
  assert.equal(justLanded(list, fly + ARRIVAL.flyMs + ARRIVAL.blinkMs).length, 0);
  assert.equal(justLanded(list, fly + ARRIVAL.flyMs + 1, false).length, 0);
  assert.deepEqual([...flyingIds(list, t0 + 1)], ['x']);                // not in the badge yet
  assert.equal(flyingIds(list, fly + ARRIVAL.flyMs).size, 0);           // landed: counted
  assert.equal(flyingIds(list, t0 + 1, false).size, 0);                 // motion off: counted at once
});

test('of many new alerts the newest few arrive; unknown spaces are placed in Share by both mods', async () => {
  const desk = await import('../mods/sixfold-desk/alert-model.js');
  const inbox = await import('../mods/sixfold-linear-inbox/model.js');
  for (const placeItems of [desk.placeItems, inbox.placeItems]) {
    const placed = placeItems([{id: 1, workspace: 'alpha'}, {id: 2, workspace: 'Gone'}, {id: 3, workspace: ''}], ['Alpha', 'Share']);
    assert.deepEqual(placed.map(i => i.workspace), ['Alpha', 'Share', 'Share']);
    assert.equal(placed[1].workspace_raw, 'Gone');
    assert.deepEqual(placeItems([{id: 1, workspace: 'Gone'}], []).map(i => i.workspace), ['Gone']);   // no space list: unchanged
  }
});


test('an issue row in the issue search shows its unread alerts: count, newest two lines with time and comment link, and "외 n건"', async () => {
  const {issueAlerts, issueAlertSignature} = await import('../mods/sixfold-desk/alert-model.js');
  const link = 'https://linear.app/demo/issue/ABC-7/x#comment-4e5f6a7b';
  const items = [
    {id: 'n1', workspace: 'Alpha', issue: 'ABC-7', read: false, category: 'commentsAndReplies', at: '2026-11-10T04:24:00Z', subtitle: 'Kim commented: first\nmore'},
    {id: 'n2', workspace: 'Alpha', issue: 'ABC-7', read: false, category: 'commentsAndReplies', at: '2026-11-10T04:45:00Z', subtitle: 'Kim replied: second', url: link},
    {id: 'n3', workspace: 'Alpha', issue: 'ABC-7', read: false, category: 'issueStatusChanged', at: '2026-11-10T03:00:00Z', changes: [{field: 'status', label: '상태', before: 'Todo', after: 'Done'}]},
    {id: 'n4', workspace: 'Alpha', issue: 'ABC-7', read: true, category: 'commentsAndReplies', at: '2026-11-10T05:00:00Z', subtitle: 'read one'},
    {id: 'n5', workspace: 'Beta', issue: 'ABC-7', read: false, category: 'comments', at: '2026-11-10T06:00:00Z', subtitle: 'other space'},
    {id: 'n6', workspace: 'Alpha', issue: 'ABC-8', read: false, category: 'assignments', at: '2026-11-10T06:00:00Z', url: 'https://evil.example/x'}];
  const row = issueAlerts(items, 'Alpha', 'abc-7');
  assert.equal(row.unread, 3);
  assert.equal(row.more, 1);
  assert.deepEqual(row.lines.map(l => [l.id, l.category, l.text, l.url]),
    [['n2', '댓글', 'Kim replied: second', link], ['n1', '댓글', 'Kim commented: first', '']]);
  assert.equal(issueAlerts(items, 'Alpha', 'ABC-8').lines[0].url, '');     // only linear.app links open
  assert.equal(issueAlerts(items, 'Alpha', 'ABC-9'), null);                  // no alert: the row is unchanged
  assert.notEqual(issueAlertSignature(items, 'Alpha'), issueAlertSignature(items.slice(1), 'Alpha'));
  assert.equal(issueAlertSignature(items, 'Alpha'), issueAlertSignature([...items].reverse(), 'Alpha'));
});

test('the alerted-issues group: one entry per issue with unread alerts, newest first, filtered by the search', async () => {
  const {alertedIssues} = await import('../mods/sixfold-desk/alert-model.js');
  const items = [
    {id: 'a', workspace: 'Alpha', issue: 'ABC-7', issue_title: 'New one', read: false, at: '2026-11-10T04:24:00Z', subtitle: 'Kim commented: a'},
    {id: 'b', workspace: 'Alpha', issue: 'ABC-7', issue_title: 'New one', read: false, at: '2026-11-10T04:45:00Z', subtitle: 'Kim replied: b'},
    {id: 'c', workspace: 'Alpha', issue: 'ABC-8', issue_title: 'Other', read: false, at: '2026-11-10T05:00:00Z'},
    {id: 'e', workspace: 'Alpha', issue: 'ABC-9', read: true, at: '2026-11-10T05:00:00Z'},       // read
    {id: 'f', workspace: 'Beta', issue: 'ABC-10', read: false, at: '2026-11-10T05:00:00Z'}];     // other space
  const group = alertedIssues(items, 'Alpha');
  assert.deepEqual(group.map(r => [r.key, r.alerts.unread, r.at]), [['ABC-8', 1, '2026-11-10T05:00:00Z'], ['ABC-7', 2, '2026-11-10T04:45:00Z']]);
  assert.equal(group[1].alerts.lines[0].text, 'Kim replied: b');
  assert.deepEqual(alertedIssues(items, 'Alpha', 'new').map(r => r.key), ['ABC-7']);
  assert.deepEqual(alertedIssues(items, 'Alpha', 'zzz'), []);
});

test('the issue-search alert signature changes when an alert of the same id changes what it shows', async () => {
  const {issueAlertSignature} = await import('../mods/sixfold-desk/alert-model.js');
  const base = {id: 'n1', workspace: 'Alpha', issue: 'ABC-7', read: false, at: '2026-11-10T04:24:00Z', subtitle: 'Kim commented: a'};
  const sig = issueAlertSignature([base], 'Alpha');
  assert.notEqual(issueAlertSignature([{...base, subtitle: 'Kim commented: b'}], 'Alpha'), sig);
  assert.notEqual(issueAlertSignature([{...base, at: '2026-11-10T04:30:00Z'}], 'Alpha'), sig);
  assert.notEqual(issueAlertSignature([{...base, changes: [{field: 'status', before: 'a', after: 'b'}]}], 'Alpha'), sig);
  assert.equal(issueAlertSignature([{...base}], 'Alpha'), sig);
});

test('the Slack chip says the copy is delayed once its newest message is older than the limit', async () => {
  const {slackCopyDelay} = await import('../mods/sixfold-desk/alert-model.js');
  const now = Date.parse('2026-11-10T05:40:00Z');
  assert.deepEqual(slackCopyDelay({mirror_latest_at: '2026-11-07T01:16:11Z', mirror_stale_hours: 6}, now), {hours: 76, at: '2026-11-07T01:16:11Z'});
  assert.equal(slackCopyDelay({mirror_latest_at: '2026-11-10T04:00:00Z'}, now), null);
  assert.equal(slackCopyDelay({}, now), null);
  assert.equal(slackCopyDelay(null, now), null);
});

test('the alerted-issues group takes the title of the newest alert, and a renamed title changes the signature', async () => {
  const {alertedIssues, issueAlertSignature} = await import('../mods/sixfold-desk/alert-model.js');
  const items = [
    {id: 'a', workspace: 'Alpha', issue: 'ABC-7', title: 'Old title', read: false, at: '2026-11-10T04:24:00Z'},
    {id: 'b', workspace: 'Alpha', issue: 'ABC-7', title: 'New title', read: false, at: '2026-11-10T04:45:00Z'}];
  assert.equal(alertedIssues(items, 'Alpha')[0].title, 'New title');
  assert.equal(alertedIssues([...items].reverse(), 'Alpha')[0].title, 'New title');
  assert.notEqual(issueAlertSignature([{...items[0], title: 'Renamed'}], 'Alpha'), issueAlertSignature([items[0]], 'Alpha'));
});

test('read requests: one per alert, Linear ones only when mark_read is on, a local comment only on this computer', async () => {
  const {readRequest, issueReadTargets, groupReadTargets, READ_LIMIT} = await import('../mods/sixfold-desk/alert-model.js');
  const now = new Date('2026-11-10T07:00:00Z'), random = () => 0.5;
  const notice = {id: N, issue: 'ABC-1', read: false}, comment = {id: 'comment:0a1b2c3d-0000-4000-8000-000000000000', local: true, read: false};
  assert.deepEqual(readRequest(notice, 'opened', ['mark_read'], {now, random}),
    {v: 1, id: readRequest(notice, 'opened', ['mark_read'], {now, random}).id, requested_at: now.toISOString(), origin: 'opened', action: 'mark_read', notification: N, read: true});
  assert.equal(readRequest(notice, 'opened', [], {now}), null);                    // writes off: no Linear request
  assert.equal(readRequest({...notice, read: true}, 'opened', ['mark_read']), null);
  assert.equal(readRequest({id: 'n2'}, 'all', ['mark_read']), null);                // not a Linear notification id
  assert.equal(readRequest(notice, 'button', ['mark_read']), null);                 // only opened / all from the sidebar
  assert.deepEqual([readRequest(comment, 'all', [], {now}).action, readRequest(comment, 'all', []).item], ['mark_seen', comment.id]);
  const items = [{...notice, workspace: 'Alpha', at: '2'}, {id: 'b', issue: 'abc-1', workspace: 'Alpha', read: false, at: '1'},
    {id: 'c', issue: 'ABC-1', workspace: 'Alpha', read: true, at: '3'}, {id: 'd', issue: 'ABC-2', workspace: 'Beta', read: false, at: '4'},
    ...Array.from({length: 30}, (_, i) => ({id: `x${i}`, issue: `ABC-${10 + i}`, workspace: 'Alpha', read: false, at: String(100 + i)}))];
  assert.deepEqual(issueReadTargets(items, 'Alpha', 'ABC-1').map(i => i.id), [N, 'b']);
  const {alertedIssues} = await import('../mods/sixfold-desk/alert-model.js');
  assert.equal(groupReadTargets(items, 'Alpha').length, alertedIssues(items, 'Alpha').reduce((n, e) => n + e.alerts.unread, 0));   // the group's issues only
  assert.ok(groupReadTargets(items, 'Alpha').length <= READ_LIMIT);
});

test('sidebar read store: pending until the collector answers; success shows read before the next list; failure comes back with one error', async () => {
  const {linearReadsUrl} = await import('./linear-reads-url.mjs');
  const written = new Map(), results = new Map();
  globalThis.__linearReads = {appHome: () => '/home', readTextFile: async () => null, writeTextFile: async () => {}};
  const reads = await import(await linearReadsUrl());
  let hooked = 0; reads.onReadConfirmed(() => hooked++);
  const write = async (path, text, expected) => { assert.equal(expected, null); written.set(path, JSON.parse(text)); };
  const read = async path => results.get(path.split('/').pop().replace('.json', '')) ?? null;
  const now = new Date('2026-11-10T07:00:00Z');
  const a = {id: N, read: false}, b = {id: '22222222-2222-4222-8222-222222222222', read: false};
  assert.equal(await reads.requestReads([a, b, a], 'opened', ['mark_read'], {now, write, folder: '/f'}), 2);
  assert.equal(await reads.requestReads([a], 'opened', ['mark_read'], {now, write, folder: '/f'}), 0);   // already asked
  assert.deepEqual([...reads.readPendingIds()].sort(), [N, b.id].sort());
  const [ra, rb] = [...written.values()];
  results.set(ra.id, JSON.stringify({ok: true})); results.set(rb.id, JSON.stringify({ok: false, error: 'busy'}));
  assert.equal(await reads.checkReads({read, folder: '/r', now: now.getTime()}), true);
  assert.equal(hooked, 1);
  assert.deepEqual([...reads.readPendingIds()], []);
  assert.equal(reads.readState(N), 'done');
  assert.equal(reads.lastReadError(now.getTime()), '읽음 처리 실패: busy');
  assert.equal(reads.lastReadError(now.getTime() + 61_000), '');
  assert.deepEqual(reads.withLocalReads([a, b]).map(i => i.read), [true, false]);     // failed one is unread again
  assert.deepEqual(reads.withLocalReads([{...a, read: true}]).map(i => i.read), [true]);
  assert.equal(reads.readState(N), '');                                               // the feed agrees: entry dropped
  assert.equal(await reads.requestReads([b], 'all', ['mark_read'], {now, write, folder: '/f'}), 1);   // a failed one may be asked again
  delete globalThis.__linearReads;
});

test('inbox window: opening the original and 모두 읽음 carry their origin; only the shown unread alerts', async () => {
  const {buildRequest, readAllTargets, READ_ALL} = await import('../mods/sixfold-linear-inbox/model.js');
  const now = new Date('2026-11-10T07:00:00Z');
  assert.equal(buildRequest('mark_read', {id: N}, {origin: 'opened'}, {now, id: 'req-1'}).origin, 'opened');
  assert.equal(buildRequest('mark_read', {id: N}, {origin: 'other'}, {now, id: 'req-1'}).origin, undefined);
  assert.equal(buildRequest('comment', {issue: 'ABC-1'}, {body: 'x', origin: 'all'}, {now, id: 'req-1'}).origin, undefined);
  const list = [{id: N, workspace: 'Alpha', read: false}, {id: 'c', local: true, workspace: 'Alpha', read: false}, {id: 'r', workspace: 'Alpha', read: true}];
  assert.deepEqual(readAllTargets(list, 'Alpha', ['mark_read']).map(i => i.id), [N, 'c']);
  assert.deepEqual(readAllTargets(list, 'Alpha', []).map(i => i.id), ['c']);
  assert.ok(READ_ALL >= 5);
});
