import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskFeedSource,TASK_FEED_FILE} from '../mods/sixfold-desk/task-feed-source.js';
import {panelEventStates,cleanPanelFeed,reconcilePanelFeed} from '../mods/sixfold-desk/panel-model.js';
import {makePanelFixture} from './panel-fixtures.mjs';

test('the neutral default consumes only the task stream with stable callback metadata',()=>{
  const seen=[],push=createTaskFeedSource((value,meta)=>seen.push([value,meta]));
  const snapshot={status:'ready',value:{v:1}};
  assert.equal(TASK_FEED_FILE,'data/sixfold/task-feed.json');
  push('other',{status:'ready'});push('task',null);assert.equal(seen.length,0);
  push('task',snapshot);push('task',snapshot);push('other',{status:'missing'});
  assert.deepEqual(seen,[[snapshot,{source:'task',switched:false}]]);
});

test('missing and invalid snapshots are delivered while reconciliation retains the last valid display',()=>{
  const raw=makePanelFixture({now:1780000000000});let previous=null;const seen=[];
  const push=createTaskFeedSource(snapshot=>{
    previous=reconcilePanelFeed(snapshot.status==='ready'?snapshot.value:snapshot.status==='missing'?null:'{',previous);
    seen.push(previous);
  });
  push('task',{status:'missing'});assert.equal(previous.status,'missing');assert.equal(previous.feed,null);
  push('task',{status:'ready',value:raw});const valid=previous.feed;
  push('task',{status:'missing'});assert.equal(previous.status,'missing');assert.equal(previous.feed,valid);
  push('task',{status:'invalid'});assert.equal(previous.status,'invalid');assert.equal(previous.feed,valid);
  push('task',{status:'ready',value:{...raw,at:new Date(1780000000100).toISOString()}});
  assert.equal(previous.status,'ready');assert.notEqual(previous.feed,valid);assert.equal(seen.length,5);
});

test('single-stream recovery preserves the event watermark and plays each new ID once',()=>{
  const now=1780000000000,base=cleanPanelFeed(makePanelFixture({now})),[from,to]=base.spaces[0].agents;
  const event=id=>({id,at:now,kind:'message',from:from.id,to:to.id,label:'Message'});
  let state=null;
  const push=createTaskFeedSource(snapshot=>{
    if(snapshot.status==='ready')state=panelEventStates(snapshot.value,now,{previous:state});
  });
  push('task',{status:'ready',value:{...base,events:[event('first')]}});assert.equal(state.packets.length,0);
  push('task',{status:'missing'});push('task',{status:'invalid'});
  push('other',{status:'ready',value:{...base,events:[event('unrelated')]}});
  push('task',{status:'ready',value:{...base,events:[event('first'),event('second')]}});
  assert.deepEqual(state.packets.map(event=>event.id),['second']);
  push('task',{status:'ready',value:{...base,events:[event('first'),event('second')]}});
  assert.deepEqual(state.packets.map(event=>event.id),['second']);
});
