import test from 'node:test';
import assert from 'node:assert/strict';
import { projectName, machineCounts, collaborations } from '../mods/sixfold-desk/collab.js';

const labels = { sub1: '서브1', sub2: '서브2' };
const labelOf = machine => labels[machine] ?? null;
const spaces = [
  { id: 'a', name: '거상 제어판', machine: null },
  { id: 'b', name: '거상 제어판 (sub1)', machine: 'sub1' },
  { id: 'c', name: '거상 제어판 (서브2)', machine: 'sub2' },
  { id: 'd', name: '개인 수익화 프로젝트', machine: null },
  { id: 'e', name: '~', machine: null },
  { id: 'f', name: '~', machine: 'sub1' },
  { id: 'g', name: 'API (v2)', machine: 'sub1' },
];
const agent = (space, status) => ({ space, status });

test('a trailing (computer) joins a space to the same-named project', () => {
  assert.equal(projectName(spaces[1], labelOf), '거상 제어판');
  assert.equal(projectName(spaces[2], labelOf), '거상 제어판', 'the computer label works too');
  assert.equal(projectName(spaces[6], labelOf), 'API (v2)', 'other brackets stay in the name');
  assert.equal(projectName({ name: '거상 제어판 (sub1)', machine: null }, labelOf), '거상 제어판 (sub1)', 'only the own computer is dropped');
});

test('agent counts are per computer', () => {
  const counts = machineCounts([agent('a', 'working'), agent('a', 'done'), agent('b', 'working'), agent('b', 'idle'), agent('x', 'working')], spaces);
  assert.deepEqual(counts.get(null), { blocked: 0, done: 1, working: 1, idle: 0 });
  assert.deepEqual(counts.get('sub1'), { blocked: 0, done: 0, working: 1, idle: 1 });
  assert.equal(counts.has('sub2'), false);
});

test('working agents on two computers in one project are a collaboration', () => {
  assert.deepEqual(collaborations([agent('b', 'working'), agent('a', 'working'), agent('c', 'idle')], spaces, labelOf),
    [{ name: '거상 제어판', machines: [null, 'sub1'] }]);
  assert.deepEqual(collaborations([agent('a', 'working'), agent('b', 'working'), agent('c', 'working')], spaces, labelOf)[0].machines,
    [null, 'sub1', 'sub2']);
});

test('one side done, one computer only, or home spaces are not', () => {
  assert.deepEqual(collaborations([agent('a', 'working'), agent('b', 'done')], spaces, labelOf), []);
  assert.deepEqual(collaborations([agent('a', 'working'), agent('d', 'working')], spaces, labelOf), []);
  assert.deepEqual(collaborations([agent('e', 'working'), agent('f', 'working')], spaces, labelOf), []);
});
