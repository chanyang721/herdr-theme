import test from 'node:test';
import assert from 'node:assert/strict';
import { crossMachine, followComputer } from '../mods/sixfold-desk/flow.js';

const machines = { t1: null, t5: null, 'sub1/t7': 'sub1', 'sub2/t2': 'sub2' };
const machineOf = address => machines[address];

test('a send between two computers is a cross-machine route', () => {
  assert.deepEqual(crossMachine({ source: 't1', target: 'sub1/t7' }, machineOf), { from: null, to: 'sub1' });
  assert.deepEqual(crossMachine({ source: 'sub1/t7', target: 'sub2/t2' }, machineOf), { from: 'sub1', to: 'sub2' });
});

test('a send on one computer or to an unknown terminal is not', () => {
  assert.equal(crossMachine({ source: 't1', target: 't5' }, machineOf), null);
  assert.equal(crossMachine({ source: 't1', target: 'gone' }, machineOf), null);
});

test('the sidebar follows focus to another computer', () => {
  const state = {};
  assert.equal(followComputer(state, 'local', 'local'), 'local');
  assert.equal(followComputer(state, 'remote:sub1', 'local'), 'remote:sub1');
});

test('a manual pick holds until focus moves again', () => {
  const state = {};
  assert.equal(followComputer(state, 'local', 'remote:sub2'), 'remote:sub2');
  assert.equal(followComputer(state, 'local', 'remote:sub2'), 'remote:sub2');
  state.follow = false; // a click on a computer row
  assert.equal(followComputer(state, 'local', 'remote:sub2'), 'remote:sub2');
  assert.equal(followComputer(state, 'remote:sub1', 'remote:sub2'), 'remote:sub1');
});
