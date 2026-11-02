import test from 'node:test';
import assert from 'node:assert/strict';
import { attention, counts, cycle, title } from '../mods/sixfold-desk/model.js';

test('blockers remain visible ahead of completions without shuffling source order',()=>{
  const input=[{address:'a',status:'done'},{address:'b',status:'blocked'},{address:'c',status:'working'},{address:'d',status:'blocked'}];
  assert.deepEqual(attention(input).map(a=>a.address),['b','d','a']);
  assert.deepEqual(input.map(a=>a.address),['a','b','c','d']);
});
test('unreported shells do not become completed agents',()=>{
  assert.deepEqual(counts([{status:null},{status:'unknown'},{status:'blocked'}]),{blocked:1,done:0,working:0,idle:0});
});
test('pane navigation wraps and supports a missing focused pane',()=>{
  const list=[{pane:'one'},{pane:'two'},{pane:'three'}];
  assert.equal(cycle(list,'three').pane,'one');
  assert.equal(cycle(list,'one',-1).pane,'three');
  assert.equal(cycle(list,null).pane,'one');
  assert.equal(cycle([],null),null);
});
test('long and Korean terminal names are retained as titles',()=>{
  const name='백엔드 주문 동기화 검토 '.repeat(8);
  assert.equal(title({title:name}),name.trim());
});
