import test from 'node:test';
import assert from 'node:assert/strict';
import { freshMessages, recentRoutes, simultaneousRoutes } from '../mods/sixfold-desk/flow.js';

const message = (id, source, target, at) => ({ id, source, target, at });

test('a burst preserves every new route without replaying a loaded log', () => {
  const old = message('old', 'a', 'b', 100);
  const burst = [old, message('2', 'c', 'd', 900), message('1', 'a', 'b', 800)];
  assert.deepEqual(freshMessages(null, burst, 1000), []);
  assert.deepEqual(freshMessages([old], burst, 1000).map(e => e.id), ['1', '2']);
  assert.deepEqual(freshMessages(burst, [...burst].reverse(), 1000), []);
});

test('stale, malformed and duplicate events cannot replay as live traffic', () => {
  const event = message('new', 'a', 'b', 20000);
  const events = [event, event, message('stale', 'a', 'b', 1), message('self', 'a', 'a', 20000),
    message('bad-time', 'a', 'b', 'now'), message('future', 'a', 'b', 25000)];
  assert.deepEqual(freshMessages([], events, 20000), [event]);
});

test('simultaneous pairs retain counts and distinguish return messages', () => {
  const events = [message('1', 'a', 'b', 1), message('2', 'c', 'd', 2),
    message('3', 'a', 'b', 3), message('4', 'b', 'a', 4)];
  assert.deepEqual(recentRoutes(events).map(e => [e.source, e.target, e.count]),
    [['b', 'a', 1], ['a', 'b', 2], ['c', 'd', 1]]);
});

test('sequenced bursts retain delayed messages and never replay an older cursor',()=>{
  const previous=[{...message('seen','a','b',1),seq:10}];
  const burst=Array.from({length:64},(_,i)=>({...message(`burst-${i}`,'a',`b${i%8}`,100),seq:11+i}));
  assert.equal(freshMessages(previous,burst,60000).length,64);
  assert.deepEqual(freshMessages([burst.at(-1)],[...previous,...burst],60000),[]);
});

test('every concurrent message retains a packet, including repeated and reverse paths',()=>{
  const flows=Array.from({length:30},(_,i)=>({...message(`m${i}`,i%3?'a':'b',i%3?'b':'a',i),phase:'travel',lane:i%2}));
  const routes=simultaneousRoutes(flows);
  assert.equal(routes.length,2);
  assert.equal(routes.reduce((total,route)=>total+route.packets.length,0),30);
  assert.deepEqual(routes.map(route=>route.count),[10,20]);
  assert.equal(new Set(routes.flatMap(route=>route.packets.map(packet=>packet.id))).size,30);
});
