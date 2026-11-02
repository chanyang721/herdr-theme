import test from 'node:test';
import assert from 'node:assert/strict';
import { attention, counts, cycle, title, priority, readThrough, unreadCount } from '../mods/sixfold-desk/model.js';

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

test('workspace agent priority is stable and does not renumber or mutate panes',()=>{
  const panes=[{pane:'1',status:'idle'},{pane:'2',status:'done'},{pane:'3',status:'blocked'},{pane:'4',status:'working'},{pane:'5',status:'done'}];
  assert.deepEqual(priority(panes).map(p=>p.pane),['3','2','5','4','1']);
  assert.deepEqual(panes.map(p=>p.pane),['1','2','3','4','5']);
});
const messages=[{target:'a',at:1000},{target:'a',at:2000},{target:'b',at:2000}];
test('messages stay unread while the agent works and clear once it is done',()=>{
  const working=readThrough(messages,[{address:'a',status:'working'},{address:'b',status:'blocked'}],null,{},60000);
  assert.equal(unreadCount(messages,'a',working),2);
  assert.equal(unreadCount(messages,'b',working),1);
  const done=readThrough(messages,[{address:'a',status:'idle'},{address:'b',status:'done'}],null,working,60000);
  assert.equal(unreadCount(messages,'a',done),0);
  assert.equal(unreadCount(messages,'b',done),0);
});
test('a message just sent to an idle agent is not cleared before it wakes up',()=>{
  const seen=readThrough(messages,[{address:'a',status:'idle'}],null,{},3000);
  assert.equal(unreadCount(messages,'a',seen),2);
});
test('focusing an agent reads its messages even while it works',()=>{
  const seen=readThrough(messages,[{address:'a',status:'working'}],'a',{},2500);
  assert.equal(unreadCount(messages,'a',seen),0);
});
test('a later message counts again after the earlier ones were read',()=>{
  const seen={a:2000};
  assert.equal(unreadCount([...messages,{target:'a',at:3000}],'a',seen),1);
});

test('unreported and reconnecting targets keep unread messages until confirmed or focused',()=>{
  const events=[{target:'missing',at:1000},{target:'unknown',at:1000}];
  const agents=[{address:'unknown',status:null}];
  const waiting=readThrough(events,agents,null,{},7000);
  assert.equal(unreadCount(events,'missing',waiting),1);
  assert.equal(unreadCount(events,'unknown',waiting),1);
  const focused=readThrough(events,agents,'missing',waiting,7000);
  assert.equal(unreadCount(events,'missing',focused),0);
  assert.equal(unreadCount(events,'unknown',focused),1);
});
