import test from 'node:test';
import assert from 'node:assert/strict';
import { crossMachine, followComputer, terminalMachine, machineHops, machineTraffic } from '../mods/sixfold-desk/flow.js';

const machines = { t1: null, t5: null, 'sub1/t7': 'sub1', 'sub2/t2': 'sub2' };
const machineOf = address => machines[address];

test('a send between two computers is a cross-machine route', () => {
  assert.deepEqual(crossMachine({ source: 't1', target: 'sub1/t7' }, machineOf), { from: null, to: 'sub1', far: 'sub1' });
  assert.deepEqual(crossMachine({ source: 'sub1/t7', target: 'sub2/t2' }, machineOf), { from: 'sub1', to: 'sub2', far: 'sub2' });
  assert.equal(crossMachine({ source: 'sub1/t7', target: 't1' }, machineOf).far, 'sub1', 'a send to here names where it came from');
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

test('no focused space is not a focus move', () => {
  const state = {};
  assert.equal(followComputer(state, 'remote:sub1', 'local'), 'local');
  assert.equal(followComputer(state, 'remote:sub1', 'local'), 'local');
  assert.equal(followComputer(state, 'local', 'local'), 'local');
  assert.equal(followComputer(state, 'remote:sub1', 'local'), 'remote:sub1');
  assert.equal(followComputer(state, null, 'local'), 'remote:sub1');
  assert.equal(followComputer(state, 'remote:sub1', 'local'), 'remote:sub1', 'focus coming back is not a new move');
  assert.equal(followComputer({}, null, 'remote:sub2'), 'remote:sub2');
});

test('a parked remote terminal still names its computer', () => {
  const known = new Set(['t1', 'sub1/t7']); // terminals(): sub1/t7 has no pane
  const machineOf = address => terminalMachine(address, known);
  assert.equal(machineOf('sub1/t7'), 'sub1');
  assert.equal(machineOf('t1'), null);
  assert.equal(machineOf('sub1/t9'), undefined);
  assert.deepEqual(crossMachine({ source: 't1', target: 'sub1/t7' }, machineOf), { from: null, to: 'sub1', far: 'sub1' });
});

test('recent sends between computers, newest first, and per-computer counts', () => {
  const now = 1_000_000_000;
  const events = [
    { id: 'old', source: 't1', target: 'sub1/t7', at: now - 11 * 60 * 1000 },
    { id: 'a', source: 't1', target: 'sub1/t7', at: now - 60_000 },
    { id: 'b', source: 't1', target: 't5', at: now - 50_000 },
    { id: 'c', source: 'sub1/t7', target: 't1', at: now - 40_000 },
    { id: 'd', source: 'sub1/t7', target: 'sub2/t2', at: now - 30_000 },
  ];
  assert.deepEqual(machineHops(events, machineOf, 2).map(item => item.event.id), ['d', 'c']);
  assert.equal(machineHops(events, machineOf).length, 4, 'a send on one computer is not listed');
  const traffic = machineTraffic(events, machineOf, now);
  assert.deepEqual(traffic.get(null), { sent: 1, received: 1 }, 'older than ten minutes is left out');
  assert.deepEqual(traffic.get('sub1'), { sent: 2, received: 1 });
  assert.deepEqual(traffic.get('sub2'), { sent: 0, received: 1 });
});
