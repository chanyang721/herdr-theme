import test from 'node:test';
import assert from 'node:assert/strict';
import { projectName, machineCounts, projectGroups, collaborations, groupSends, liveLinks, LINK_SEND_MS, tone, linkPalette } from '../mods/sixfold-desk/collab.js';

const labels = { sub1: '서브1', sub2: '서브2', notebook1: '노트북1' };
const labelOf = machine => labels[machine] ?? null;
const spaces = [
  { id: 'a', name: '거상 제어판', machine: null },
  { id: 'b', name: '거상 제어판 (sub1)', machine: 'sub1' },
  { id: 'c', name: '거상 제어판 (서브2)', machine: 'sub2' },
  { id: 'n', name: '거상 제어판', machine: 'notebook1' },
  { id: 'd', name: '개인 수익화 프로젝트', machine: null },
  { id: 'd2', name: '개인 수익화 프로젝트', machine: 'sub2' },
  { id: 'e', name: '~', machine: null },
  { id: 'f', name: '~', machine: 'sub1' },
  { id: 'g', name: 'API (v2)', machine: 'sub1' },
];
const agent = (space, status = 'working') => ({ space, status });
const hop = (id, from, to, at) => ({ event: { id, at }, hop: { from, to } });

test('a trailing (computer) joins a space to the same-named project', () => {
  assert.equal(projectName(spaces[1], labelOf), '거상 제어판');
  assert.equal(projectName(spaces[2], labelOf), '거상 제어판', 'the computer label works too');
  assert.equal(projectName(spaces[8], labelOf), 'API (v2)', 'other brackets stay in the name');
  assert.equal(projectName({ name: '거상 제어판 (sub1)', machine: null }, labelOf), '거상 제어판 (sub1)', 'only the own computer is dropped');
});

test('agent counts are per computer', () => {
  const counts = machineCounts([agent('a'), agent('a', 'done'), agent('b'), agent('b', 'idle'), agent('x')], spaces);
  assert.deepEqual(counts.get(null), { blocked: 0, done: 1, working: 1, idle: 0 });
  assert.deepEqual(counts.get('sub1'), { blocked: 0, done: 0, working: 1, idle: 1 });
  assert.equal(counts.has('sub2'), false);
});

test('a project on four computers is one group with each computer\'s working count', () => {
  const groups = projectGroups([agent('a'), agent('a'), agent('b'), agent('c'), agent('n', 'idle')], spaces, labelOf);
  assert.deepEqual(groups[0], { name: '거상 제어판', machines: [null, 'notebook1', 'sub1', 'sub2'], working: [2, 0, 1, 1], active: true });
  assert.deepEqual(groups[1], { name: '개인 수익화 프로젝트', machines: [null, 'sub2'], working: [0, 0], active: false });
  assert.equal(groups.length, 2, 'home spaces are not a project');
  assert.deepEqual(collaborations([agent('a'), agent('b')], spaces, labelOf).map(group => group.name), ['거상 제어판']);
  assert.deepEqual(collaborations([agent('a'), agent('b', 'done')], spaces, labelOf), [], 'one side done is not together');
});

test('a send is filed under the smallest group holding both ends', () => {
  const groups = [{ machines: [null, 'notebook1', 'sub1', 'sub2'] }, { machines: [null, 'sub2'] }];
  const filed = groupSends([hop(1, null, 'sub2', 0), hop(2, 'sub1', null, 0), hop(3, 'sub1', 'x', 0)], groups);
  assert.deepEqual(filed.byGroup.map(list => list.map(item => item.event.id)), [[2], [1]]);
  assert.deepEqual(filed.others.map(item => item.event.id), [3]);
});

test('only working computers and recent sends are joined', () => {
  const now = 10 * LINK_SEND_MS;
  const groups = projectGroups([agent('a'), agent('b'), agent('c'), agent('n', 'idle')], spaces, labelOf);
  const links = liveLinks(groups, [hop(1, null, 'sub2', now - 1000), hop(2, 'notebook1', 'sub2', now - 1000), hop(3, 'sub1', 'notebook1', now - LINK_SEND_MS - 1)], now);
  assert.deepEqual(links, [
    { key: 'project:거상 제어판', name: '거상 제어판', machines: [null, 'sub1', 'sub2'], working: true },
    { key: 'send:notebook1|sub2', name: null, machines: ['notebook1', 'sub2'], working: false },
  ], 'the idle computer, a send inside the group and an old send add nothing');
  assert.deepEqual(liveLinks(projectGroups([agent('a')], spaces, labelOf), [], now), [], 'a shared name alone is not a link');
});

test('link colours mix toward the sidebar and stay apart from each other', () => {
  assert.equal(tone('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(tone('#fff', '#000', 0.25), '#bfbfbf');
  assert.equal(tone('not a colour', '#000', 0.5), 'not a colour');
  const dark = linkPalette({ chrome: '#151f2a', dim: '#5b6b7a', ansi14: '#5fd7d7', ansi13: '#d787d7', ansi12: '#5f87ff', ansi10: '#87d787' });
  assert.equal(new Set(dark.map(color => color.link)).size, 4);
  for (const color of dark) assert.notEqual(color.link, color.packet);
});
