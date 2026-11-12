import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as inbox from '../mods/sixfold-slack-inbox/model.js';
import * as desk from '../mods/sixfold-desk/alert-slack.js';

// Made-up people, channels and files only (public repository).
const feed = [
  {id: 'slack:C0TEST01:100.1', channel: 'C0TEST01', channel_name: '#alpha', project: 'Alpha', author: 'U0AAA0001', author_id: 'U0AAA0001', author_name: '김가나',
    text: '<@U0BBB0002|이다라> <@U0CCC0003> 확인 부탁드려요 <#C0TEST02|beta> 참고 <https://example.com/doc|설계 문서>', mentions: {U0CCC0003: '박마바'}},
  {id: 'slack:C0TEST01:101.1', channel: 'C0TEST01', project: 'Alpha', author: 'U0BBB0002', text: '<@U0AAA0001> 반영했습니다'},
  {id: 'slack:C0TEST03:102.1', channel: 'C0TEST03', project: 'Alpha', author: 'U0DDD0004', text: '오늘 배포합니다 &amp; 공지'},
];

test('the inbox and the desk carry the same Slack alert code', async () => {
  const block = s => s.slice(s.indexOf('const USER ='), s.indexOf('// --- end of the shared Slack alert code.'));
  const a = await readFile(new URL('../mods/sixfold-slack-inbox/model.js', import.meta.url), 'utf8');
  const b = await readFile(new URL('../mods/sixfold-desk/alert-slack.js', import.meta.url), 'utf8');
  assert.ok(block(a).length > 1000);
  assert.equal(block(a), block(b));
});

for (const [label, m] of [['inbox', inbox], ['desk', desk]]) {
  test(`${label}: names come from author_name, then mentions, then the feed's own marks, then the ID`, () => {
    const names = m.feedNames(feed);
    assert.deepEqual(names, {U0BBB0002: '이다라', C0TEST02: 'beta', U0CCC0003: '박마바', U0AAA0001: '김가나', C0TEST01: 'alpha'});
    assert.equal(m.senderName(feed[0], names), '김가나', 'author_name');
    assert.equal(m.senderName(feed[1], names), '이다라', 'a <@ID|name> mark elsewhere in the feed');
    assert.equal(m.senderName(feed[2], names), 'U0DDD0004', 'unknown stays the ID');
    assert.equal(m.senderName(feed[2], names, {U0DDD0004: '최사아'}), '최사아', 'machine-local names');
    assert.equal(m.senderName({author: '정자차 <U0EEE0005>'}, {}), '정자차', 'a "Name <ID>" author');
    assert.equal(m.senderName({}, {}), '보낸 사람 미확인');
    assert.equal(m.senderName({author: 'U0CCC0003', mentions: {U0CCC0003: '박마바(멘션)'}}, names), '박마바(멘션)', "the item's own mentions win");
  });

  test(`${label}: the title is 보낸 사람 → 받는 사람, B 외 n for more, the channel when nobody is tagged`, () => {
    const names = m.feedNames(feed);
    assert.equal(m.alertTitle(feed[0], names), '김가나 → 이다라 외 1');
    assert.equal(m.alertTitle(feed[1], names), '이다라 → 김가나');
    // Nobody tagged: channel_name, then project, then the channel ID (a feed's channel name is not used).
    assert.equal(m.alertTitle(feed[2], names), 'U0DDD0004 → Alpha', 'no channel_name: the project');
    assert.equal(m.alertTitle({...feed[2], channel: 'C0TEST01'}, names), 'U0DDD0004 → Alpha', 'the project even when another item names the channel');
    assert.equal(m.alertTitle({...feed[2], project: ''}, names), 'U0DDD0004 → C0TEST03', 'no project: the channel ID');
    assert.equal(m.alertTitle({...feed[2], channel_name: 'delta'}, names), 'U0DDD0004 → #delta');
    assert.equal(m.alertTitle({author: 'U0AAA0001', author_name: '김가나', channel_name: '#gamma', text: '<@U0AAA0001> 메모'}, names), '김가나 → #gamma', 'tagging oneself is not a recipient');
    assert.equal(m.alertTitle({author: 'U0AAA0001', text: '<@U0ZZZ0009> 봐 주세요'}, names), '김가나 → U0ZZZ0009', 'unknown recipient: its ID');
  });

  // Review HOLD 01M777RTY99QA3GQJF98TETTHQ: the item's mentions map is the newest name and wins everywhere.
  test(`${label}: the mentions map wins over author_name, a "Name <ID>" author and a spelled label`, () => {
    const names = m.feedNames(feed);
    assert.equal(m.senderName({author: '옛이름 <U0AAA0001>', mentions: {U0AAA0001: '현재이름'}}, names), '현재이름');
    assert.equal(m.alertTitle({author: '옛이름 <U0AAA0001>', mentions: {U0AAA0001: '현재이름'}, text: '<@U0BBB0002> 확인'}, names), '현재이름 → 이다라');
    assert.equal(m.senderName({author: 'U0AAA0001', author_name: '옛이름', mentions: {U0AAA0001: '현재이름'}}, names), '현재이름');
    const item = {author: 'U0AAA0001', author_name: '김가나', text: '<@U0BBB0002|옛라벨> 확인', mentions: {U0BBB0002: '새이름'}};
    assert.equal(m.alertTitle(item, names), '김가나 → 새이름');
    assert.equal(m.readable(item.text, m.namesFor(item, names), item.mentions), '@새이름 확인', 'the body says the same name');
    assert.equal(m.alertTitle({...item, mentions: {}}, names), '김가나 → 옛라벨', 'no mentions entry: the spelled label');
  });

  test(`${label}: the recipient is the first tag that is not the sender`, () => {
    const names = m.feedNames(feed);
    assert.equal(m.alertTitle({author: 'U0AAA0001', text: '<@U0AAA0001> <@U0BBB0002> 봐 주세요'}, names), '김가나 → 이다라');
    assert.equal(m.alertTitle({author: '김가나 <U0AAA0001>', text: '<@U0AAA0001> <@U0BBB0002> <@U0CCC0003>'}, names), '김가나 → 이다라 외 1', 'the "Name <ID>" author is the sender too');
  });

  test(`${label}: tags, channels and links read as text`, () => {
    const names = m.namesFor(feed[0], m.feedNames(feed));
    assert.equal(m.readable(feed[0].text, names), '@이다라 @박마바 확인 부탁드려요 #beta 참고 설계 문서');
    assert.equal(m.readable('<@U0ZZZ0009> <#C0TEST01> <#C0TEST09|> <!here> <!subteam^S0T|@개발팀> <https://example.com> &lt;b&gt; &amp;', names),
      '@U0ZZZ0009 #alpha #C0TEST09 @here @개발팀 https://example.com <b> &');
  });

  test(`${label}: attachments become chips; unsafe ids and non-Slack links are dropped`, () => {
    const files = m.attachments({files: [
      {id: 'F0TEST0001', name: '견적서_최종.pdf', mimetype: 'application/pdf', size: 245760, permalink: 'https://example-team.slack.com/files/U0AAA0001/F0TEST0001/x.pdf'},
      {id: 'F0TEST0002', name: '화면.png', mimetype: 'image/png', size: 900, permalink: 'https://evil.example.com/F0TEST0002'},
      {id: '../../etc/passwd', name: 'x.txt', mimetype: 'text/plain'},
      {id: 'F0TEST0003', name: '일정표.xlsx', mimetype: '', size: 3 * 1024 * 1024},
      {id: 'F0TEST0004', name: 'notes', mimetype: 'text/markdown', permalink: 'javascript:alert(1)'},
      null,
    ]});
    assert.deepEqual(files.map(f => [f.id, f.kind, f.ext, f.size, Boolean(f.link)]), [
      ['F0TEST0001', 'PDF', 'PDF', '240KB', true], ['F0TEST0002', '이미지', 'PNG', '900B', false],
      ['F0TEST0003', '표', 'XLSX', '3.0MB', false], ['F0TEST0004', '텍스트', '텍스트', '', false]]);
    assert.deepEqual(m.attachments({}), []);
    assert.equal(m.fileTextPath('/h', 'F0TEST0001'), '/h/data/sixfold/slack-files/F0TEST0001.txt');
    assert.equal(m.fileTextPath('/h', '../x'), null);
    assert.equal(m.fileTextShown('x'.repeat(m.FILE_TEXT_LIMIT + 5)).endsWith(`(앞 ${m.FILE_TEXT_LIMIT}자만 표시)`), true);
  });
}

// --- The desk popover with stubbed native modules: rows, chips and their two buttons.
function element() {
  let proxy; const data = {nodes: [], calls: [], handlers: {}};
  proxy = new Proxy(data, {get(t, k) {
    if (k === 'then') return undefined; if (k in t) return t[k];
    if (['child', 'trigger', 'content'].includes(k)) return n => { t.calls.push([k, n]); if (n != null) t.nodes.push(n); return proxy; };
    if (k === 'children') return ns => { t.nodes.push(...ns.filter(Boolean)); return proxy; };
    if (k === 'when') return (b, f) => { if (b) f(proxy); return proxy; };
    if (['on_click', 'on_open_change'].includes(k)) return fn => { t.handlers[k] = fn; return proxy; };
    if (k === 'id') return id => { t.elementId = id; return proxy; };
    return (...a) => { t.calls.push([k, ...a]); return proxy; };
  }}); return proxy;
}
const texts = node => typeof node === 'string' ? [node] : (node?.nodes ?? []).flatMap(texts);
const byId = (node, id) => node?.elementId === id ? node : (node?.nodes ?? []).map(n => byId(n, id)).find(Boolean) ?? null;
async function popover(files = new Map()) {
  const store = new Map();
  globalThis.__slackPop = {div: element, image: element, h_flex: element, v_flex: element, Popover: {new: element},
    shared: k => store.get(k), setShared: (k, v) => store.set(k, v), appHome: () => '/h', readTextFile: async p => files.get(p) ?? null};
  const base = new URL('../mods/sixfold-desk/', import.meta.url);
  const transform = s => s.replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base|herdr)';/g, 'const {$1}=globalThis.__slackPop;')
    .replace("'./alert-model.js'", JSON.stringify(new URL('alert-model.js', base).href)).replace("'./alert-slack.js'", JSON.stringify(new URL('alert-slack.js', base).href));
  const asUrl = s => 'data:text/javascript;base64,' + Buffer.from(s).toString('base64');
  const filesUrl = asUrl(transform(await readFile(new URL('alert-files.js', base), 'utf8')) + `//${Math.random()}`);
  const src = transform(await readFile(new URL('alert-popover.js', base), 'utf8')).replace("'./alert-files.js'", JSON.stringify(filesUrl));
  return {store, ...(await import(asUrl(src + `//${Math.random()}`))), files: await import(filesUrl)};
}
const theme = new Proxy({}, {get: (_t, k) => `#${String(k)}`});

test('the popover row says who wrote to whom, reads the tags and shows the attachment chips', async () => {
  const fileText = new Map([['/h/data/sixfold/slack-files/F0TEST0001.txt', '견적 합계 1,200\n부가세 별도']]);
  const pop = await popover(fileText);
  const item = {...feed[0], files: [{id: 'F0TEST0001', name: '견적서_최종.pdf', mimetype: 'application/pdf', size: 245760, permalink: 'https://example-team.slack.com/files/U0AAA0001/F0TEST0001/x.pdf'},
    {id: 'F0TEST0005', name: '메모.txt', mimetype: 'text/plain'}]};
  pop.store.set('sixfold.alertItems', [item, feed[1]]);
  pop.showPopover('Alpha', 'slack');
  let shown = pop.alertPopover({id: 's1', project: 'Alpha', trigger: element(), t: theme, hasSlack: true, hasLinear: false, onAll() {}});
  let all = texts(shown);
  assert.ok(all.includes('김가나 → 이다라 외 1'), all.join(' | '));
  assert.ok(all.includes('이다라 → 김가나'));
  assert.ok(all.includes('@이다라 @박마바 확인 부탁드려요 #beta 참고 설계 문서'));
  assert.ok(all.includes('견적서_최종.pdf') && all.includes('PDF · 240KB') && all.includes('메모.txt'));
  assert.equal(all.filter(s => s === '본문 보기').length, 2);
  assert.equal(all.filter(s => s === '다운로드').length, 1, 'no download without a Slack link');

  // 다운로드: only on a press, the Slack link to the default browser.
  const opened = [], cx = {notify() {}, stop_propagation() {}, open_url: u => opened.push(u), spawn: fn => (cx.task = fn(cx))};
  byId(shown, 'sf-alert-pop-slack-0-file-download-0').handlers.on_click({}, cx);
  assert.deepEqual(opened, [item.files[0].permalink]);

  // 본문 보기: the local text copy, then '본문 준비 중' for a file the collector has not saved.
  byId(shown, 'sf-alert-pop-slack-0-file-view-0').handlers.on_click({}, cx); await cx.task;
  assert.equal(pop.store.get('sixfold.alertPopover').file, `${item.id}|F0TEST0001`);
  shown = pop.alertPopover({id: 's1', project: 'Alpha', trigger: element(), t: theme, hasSlack: true, hasLinear: false, onAll() {}});
  all = texts(shown);
  assert.ok(all.includes('견적 합계 1,200\n부가세 별도') && all.includes('본문 닫기'), all.join(' | '));
  byId(shown, 'sf-alert-pop-slack-0-file-view-1').handlers.on_click({}, cx); await cx.task;
  shown = pop.alertPopover({id: 's1', project: 'Alpha', trigger: element(), t: theme, hasSlack: true, hasLinear: false, onAll() {}});
  all = texts(shown);
  assert.ok(all.includes('본문 준비 중') && !all.includes('견적 합계 1,200\n부가세 별도'), 'one text open at a time');
  byId(shown, 'sf-alert-pop-slack-0-file-view-1').handlers.on_click({}, cx);
  assert.equal(pop.store.get('sixfold.alertPopover').file, null, '본문 닫기');
  assert.deepEqual(opened, [item.files[0].permalink], 'viewing opens nothing');
});

test('the card popover reads the machine-local names, as the inbox window does', async () => {
  const site = '/h/data/sixfold/site.local.json';
  const pop = await popover(new Map([[site, JSON.stringify({slack: {user_names: {U0LOC0007: '로컬가', U0LOC0008: '로컬나'}}})]]));
  await pop.files.refreshLocalNames({read: async p => p === site ? JSON.stringify({slack: {user_names: {U0LOC0007: '로컬가', U0LOC0008: '로컬나'}}}) : null, home: '/h'});
  pop.store.set('sixfold.alertItems', [{id: 'slack:C0TEST09:200.1', project: 'Alpha', channel: 'C0TEST09', author: 'U0LOC0007', text: '<@U0LOC0008> 확인 부탁드려요'}]);
  pop.showPopover('Alpha', 'slack');
  const all = texts(pop.alertPopover({id: 's2', project: 'Alpha', trigger: element(), t: theme, hasSlack: true, hasLinear: false, onAll() {}}));
  assert.ok(all.includes('로컬가 → 로컬나') && all.includes('@로컬나 확인 부탁드려요'), all.join(' | '));
  // A partial write keeps the last names; a missing file has none.
  await pop.files.refreshLocalNames({read: async () => '{"slack":', home: '/h'});
  assert.equal(pop.files.localNames(Date.now() - 60_000).U0LOC0007, '로컬가');
  await pop.files.refreshLocalNames({read: async () => null, home: '/h'});
  assert.deepEqual(pop.files.localNames(Date.now() - 60_000), {});
});

test('the arrival peek shows the chips without buttons', async () => {
  const pop = await popover();
  pop.store.set('sixfold.alertItems', [{...feed[0], files: [{id: 'F0TEST0001', name: '견적서_최종.pdf', mimetype: 'application/pdf', permalink: 'https://example-team.slack.com/files/x'}]}]);
  const all = texts(pop.slackPeek('Alpha', theme, [feed[0].id]));
  assert.ok(all.includes('김가나 → 이다라 외 1') && all.includes('견적서_최종.pdf'));
  assert.ok(!all.includes('본문 보기') && !all.includes('다운로드'));
});

test('a missing or empty text copy reads as pending; an unsafe id is never read', async () => {
  const reads = [];
  const pop = await popover();
  const read = async p => { reads.push(p); return p.endsWith('F0TEST0006.txt') ? '  \n' : null; };
  assert.equal((await pop.files.loadFileText('F0TEST0006', {read, home: '/h'})).state, 'pending');
  assert.equal((await pop.files.loadFileText('../../x', {read, home: '/h'})).state, 'pending');
  assert.deepEqual(reads, ['/h/data/sixfold/slack-files/F0TEST0006.txt']);
});
