import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowNodes,delegationEvents} from '../mods/sixfold-desk/workflow.js';

test('nested children keep observed ancestry regardless of input order',()=>{
  const rows=workflowNodes([
    {id:'grandchild',parent:'child',terminal:'t1',label:'Review'},
    {id:'child',parent:'t1',terminal:'t1',label:'Explore',status:'상태 미확인'},
  ],['t1']);
  assert.deepEqual(rows.map(node=>[node.id,node.depth]),[['child',1],['grandchild',2]]);
  assert.equal(rows[0].status,'상태 미확인');
});

test('unknown parents, cycles and foreign workspace ownership are not guessed',()=>{
  const rows=workflowNodes([
    {id:'a',parent:'b',terminal:'t1'}, {id:'b',parent:'a',terminal:'t1'},
    {id:'orphan',parent:'missing',terminal:'t1'},
    {id:'foreign',parent:'t2',terminal:'t1'},
    {id:'valid',parent:'t1',terminal:'t1'},
    {id:'valid',parent:'t1',terminal:'t1'},
  ],['t1','t2']);
  assert.deepEqual(rows.map(node=>node.id),['valid']);
  assert.deepEqual(delegationEvents([
    {id:'real',source:'t1',target:'valid',kind:'delegate'},
    {id:'fake-parent',source:'t2',target:'valid',kind:'delegate'},
    {id:'return',source:'valid',target:'t1',kind:'complete'},
  ],rows).map(event=>event.id),['real']);
});
