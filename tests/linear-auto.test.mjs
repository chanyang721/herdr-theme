import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {alert8, approvalRequest, autoSignature, autoView, localRequest, partOpen, requestId} from '../mods/sixfold-desk/linear-auto-model.js';

function element(kind='div',value=null){
  const data={kind,value,nodes:[],calls:[]};let proxy;
  proxy=new Proxy(data,{get(target,key){
    if(key==='then')return undefined;if(key in target)return target[key];
    if(['child','trigger','content'].includes(key))return node=>{data.calls.push([key,node]);if(node!=null)data.nodes.push(node);return proxy;};
    if(key==='children')return nodes=>{data.nodes.push(...nodes.filter(Boolean));return proxy;};
    if(key==='when')return (condition,fn)=>{if(condition)fn(proxy);return proxy;};
    return (...args)=>{data.calls.push([key,...args]);return proxy;};
  }});return proxy;
}
const walk=tree=>[tree,...(tree.nodes||[]).filter(node=>typeof node==='object').flatMap(walk)];
const call=(node,name)=>node.calls.find(item=>item[0]===name);
const byId=(tree,id)=>walk(tree).find(node=>call(node,'id')?.[1]===id);
const words=tree=>walk(tree).flatMap(node=>node.nodes.filter(value=>typeof value==='string'));
const click=(node,cx)=>call(node,'on_click')?.[1]({},cx);
const theme={surface:'#151a22',chrome:'#10151e',foreground:'#e5edf5',muted:'#a6b0bf',dim:'#788594',accent:'#a9b8ff',border:'#39434f',selected:'#253249',hover:'#253249',blocked:'#edac67'};
let serial=0;
const MODEL=new URL('../mods/sixfold-desk/linear-auto-model.js',import.meta.url).href;
async function load(file,stubs){
  globalThis.__autoStubs=stubs;
  const source=(await readFile(new URL(`../mods/sixfold-desk/${file}`,import.meta.url),'utf8'))
    .replace(/import \{([^}]+)\} from '(?:gpui-kit|gpui-base|herdr)';/g,'const {$1}=globalThis.__autoStubs;')
    .replace("'./linear-auto-model.js'",JSON.stringify(MODEL));
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${serial++}`);
}
const view=()=>load('linear-auto-view.js',{div:()=>element(),h_flex:()=>element('row'),v_flex:()=>element('column')});

const ID='a1b2c3d4-efc0-4f00-8000-000000000001';
const proposal={comment:'Herdr 자동 작업으로 처리했습니다.\n\n**한 일**\n버튼을 API에 연결했다.\n\n**남은 것**\n없음',state:'In Review',
  from_status:'In Progress',publish:'',checks:['비밀값·로컬 경로·이메일·내부 주소 없음'],draft:'/data/drafts/a1b2c3d4.md',report_id:'r1'};
const ledger=(...entries)=>({v:1,switch:{enabled:true,mode:'live',spaces:{Alpha:true}},entries});
const entry=(over={})=>({id:ID,issue:'DEMO-7',title:'대기실 문구',url:'https://linear.app/demo/issue/DEMO-7',workspace:'Alpha',
  at:'2026-11-10T07:30:00Z',state:'proposed',reason:'나에게 새로 배정됨',proposal,...over});
const NOW=new Date('2026-11-10T08:00:00Z');
const WRITES=['mark_read','set_state','comment'];

test('autoView splits a space into 반영 대기 · 결정 필요 · 자동 작업 and ignores other spaces',()=>{
  const v=autoView(ledger(entry(),entry({id:'b'.repeat(8)+'-x',state:'decide',reason:'"고객"'}),
    entry({id:'c'.repeat(8)+'-x',state:'dispatched'}),entry({id:'d'.repeat(8)+'-x',state:'info'}),
    entry({id:'e'.repeat(8)+'-x',workspace:'Beta'})),'Alpha');
  assert.deepEqual([v.pending.length,v.decide.length,v.running.length],[1,1,1]);
  assert.equal(v.pending[0].key,'a1b2c3d4');assert.equal(v.pending[0].proposal.state,'In Review');
  assert.equal(v.mode,'live');assert.equal(v.spaceOn,true);
  assert.equal(autoView(null,'Alpha').pending.length,0);
});

test('approval requests match the collector: auto-<alert8>-<c|s>-<n>, exact body, writes switch respected',()=>{
  const r=autoView(ledger(entry()),'Alpha').pending[0];
  const c=approvalRequest(r,'comment',WRITES,{now:NOW});
  assert.deepEqual(c,{v:1,id:'auto-a1b2c3d4-c-r1',action:'comment',issue:'DEMO-7',requested_at:NOW.toISOString(),origin:'button',body:proposal.comment});
  const s=approvalRequest(r,'state',WRITES,{now:NOW});
  assert.equal(s.action,'set_state');assert.equal(s.state,'In Review');assert.equal(s.id,'auto-a1b2c3d4-s-r1');
  assert.equal(approvalRequest(r,'comment',WRITES,{now:new Date(NOW.getTime()+5000)}).id,c.id,'one id per proposal part, whenever pressed');
  assert.equal(partOpen(r,'comment',new Set([requestId(r,'comment')])),false,'confirmed here before the ledger: no button');
  assert.equal(approvalRequest(r,'comment',WRITES,{now:NOW,body:'  고친 글  '}).body,'고친 글');
  assert.equal(approvalRequest(r,'comment',['mark_read'],{now:NOW}),null,'comment writes off: no request');
  assert.equal(approvalRequest(r,'comment',WRITES,{now:NOW,body:'x'.repeat(4001)}),null);
  assert.equal(alert8(ID),'a1b2c3d4');
});

test('an applied part has no button; a failed one can be pressed again',()=>{
  const ok=autoView(ledger(entry({applied:{comment:{ok:true}}})),'Alpha').pending[0];
  assert.equal(partOpen(ok,'comment'),false);assert.equal(approvalRequest(ok,'comment',WRITES,{now:NOW}),null);
  assert.equal(partOpen(ok,'state'),true);
  const failed=autoView(ledger(entry({applied:{comment:{ok:false,error:'x'}}})),'Alpha').pending[0];
  assert.equal(partOpen(failed,'comment'),true);
  const noState=autoView(ledger(entry({proposal:{...proposal,state:''}})),'Alpha').pending[0];
  assert.equal(partOpen(noState,'state'),false);
});

test('local requests: discard only a proposal, start only an alert waiting for a person',()=>{
  const v=autoView(ledger(entry(),entry({id:'b'.repeat(8)+'-x',state:'decide'})),'Alpha');
  assert.deepEqual(localRequest(v.pending[0],'discard',{now:NOW,serial:'z'}),{v:1,id:'discard-a1b2c3d4-z',action:'discard',alert:ID,requested_at:NOW.toISOString()});
  assert.equal(localRequest(v.pending[0],'start',{now:NOW}),null);
  assert.equal(localRequest(v.decide[0],'start',{now:NOW,serial:'z'}).action,'start');
  assert.equal(localRequest(v.decide[0],'discard',{now:NOW}),null);
});

test('the group draws buttons that only call back; applied parts show ✓',async()=>{
  const {autoGroup}=await view(),seen=[],cx={stop_propagation(){seen.push('stop');}};
  const v=autoView(ledger(entry(),entry({id:'b'.repeat(8)+'-x',state:'decide',reason:'"고객" — 사람 판단'})),'Alpha');
  const tree=autoGroup({id:'alpha',view:v,onApprove:(r,part)=>seen.push(['approve',r.issue,part]),onApplyAll:r=>seen.push(['all',r.issue]),
    onEdit:r=>seen.push(['edit',r.key]),onDiscard:r=>seen.push(['discard',r.key]),onStart:r=>seen.push(['start',r.key])},theme);
  assert(words(tree).includes('자동 작업'));assert(words(tree).includes('반영 대기 1'));assert(words(tree).includes('결정 필요 1'));
  assert(words(tree).includes('버튼을 API에 연결했다.'),'one-line summary of 한 일');
  for(const key of ['comment','state','all','edit','discard'])click(byId(tree,`task-issues-auto-${key}-alpha-a1b2c3d4`),cx);
  click(byId(tree,'task-issues-auto-start-alpha-bbbbbbbb'),cx);
  assert.deepEqual(seen.filter(s=>s!=='stop'),[['approve','DEMO-7','comment'],['approve','DEMO-7','state'],['all','DEMO-7'],
    ['edit','a1b2c3d4'],['discard','a1b2c3d4'],['start','bbbbbbbb']]);
  const applied=autoGroup({id:'alpha',view:autoView(ledger(entry({applied:{comment:{ok:true}}})),'Alpha'),onApprove(){}},theme);
  assert(!byId(applied,'task-issues-auto-comment-alpha-a1b2c3d4'));assert(words(applied).includes('✓ 댓글'));
  assert(!byId(applied,'task-issues-auto-all-alpha-a1b2c3d4'),'모두 반영 needs both parts open');
});

test('busy parts cannot be pressed twice; a failed write shows one line; nothing to show draws nothing',async()=>{
  const {autoGroup}=await view();let pressed=0;
  const v=autoView(ledger(entry({applied:{state:{ok:false,error:'Linear 오류'}}})),'Alpha');
  const tree=autoGroup({id:'alpha',view:v,busy:new Set(['a1b2c3d4:comment']),onApprove:()=>pressed++},theme);
  assert(!call(byId(tree,'task-issues-auto-comment-alpha-a1b2c3d4'),'on_click'));
  assert(words(tree).includes('처리 중'));assert(words(tree).some(w=>w.startsWith('반영 실패: Linear 오류')));
  assert.equal(pressed,0);
  assert.equal(autoGroup({id:'alpha',view:autoView(ledger(entry({state:'info'})),'Alpha')},theme),null);
});

const ioFor=async(files,written,{slowDraft=null}={})=>load('linear-auto.js',{appHome:()=>'/home',
  readTextFile:async p=>{if(slowDraft&&p.endsWith('.md'))await slowDraft;if(!files.has(p))throw new Error('missing');return files.get(p);},
  writeTextFile:async(p,text)=>{written.push([p,JSON.parse(text)]);}});

test('IO: two presses while the draft is read send one request; a success stays done until the ledger shows it',async()=>{
  const files=new Map([['/data/drafts/a1b2c3d4.md','고친 글\n']]),written=[];let release;
  const io=await ioFor(files,written,{slowDraft:new Promise(resolve=>{release=resolve;})});
  const r=autoView(ledger(entry()),'Alpha').pending[0];
  const first=io.approve(r,['comment'],WRITES,{now:NOW}),second=io.approve(r,['comment'],WRITES,{now:NOW});
  release();
  assert.deepEqual([(await first).length,(await second).length],[1,0]);
  assert.equal(written.length,1);
  const id=written[0][1].id;
  files.set(`/home/data/sixfold/linear-actions/results/${id}.json`,JSON.stringify({id,ok:true}));
  await io.checkApprovals({now:NOW.getTime()});
  assert(io.doneIds().has(id));
  assert.deepEqual(await io.approve(r,['comment'],WRITES,{now:NOW}),[],'succeeded, ledger not caught up: no second request');
  assert.equal(written.length,1);
  io.settleLedger(autoView(ledger(entry({applied:{comment:{ok:true}}})),'Alpha'));
  assert(!io.doneIds().has(id),'the ledger shows it: the local mark is dropped');
});

test('IO: an unreadable or empty edited draft sends nothing and says so',async()=>{
  for(const files of [new Map(),new Map([['/data/drafts/a1b2c3d4.md','  \n']])]){
    const written=[],io=await ioFor(files,written);
    const r=autoView(ledger(entry()),'Alpha').pending[0];
    assert.deepEqual(await io.approve(r,['comment'],WRITES,{now:NOW}),[]);
    assert.equal(written.length,0);
    assert.match(io.autoError(NOW.getTime()),/초안을 읽지 못해 보내지 않았습니다/);
    assert.equal(io.busyKeys(NOW.getTime()).size,0,'the part can be pressed again after fixing the draft');
  }
  const written=[],io=await ioFor(new Map(),written);   // no draft at all: the proposal itself
  const r=autoView(ledger(entry({proposal:{...proposal,draft:''}})),'Alpha').pending[0];
  await io.approve(r,['comment'],WRITES,{now:NOW});
  assert.equal(written[0][1].body,proposal.comment);
});

test('IO: the edited draft is what gets posted; results clear busy and report failures',async()=>{
  const files=new Map([['/data/drafts/a1b2c3d4.md','사람이 고친 댓글\n']]),list=[];
  const io=await ioFor(files,list);
  const r=autoView(ledger(entry()),'Alpha').pending[0];
  const ids=await io.approve(r,['comment','state'],WRITES,{now:NOW});
  assert.equal(ids.length,2);
  const written=new Map(list);
  const [comment,state]=[...written.values()];
  assert.equal(comment.body,'사람이 고친 댓글');assert.equal(state.state,'In Review');
  assert(io.busyKeys(NOW.getTime()).has('a1b2c3d4:comment'));
  assert.deepEqual(await io.approve(r,['comment'],WRITES,{now:NOW}),[],'a busy part is not sent twice');
  files.set(`/home/data/sixfold/linear-actions/results/${ids[0]}.json`,JSON.stringify({id:ids[0],ok:true}));
  files.set(`/home/data/sixfold/linear-actions/results/${ids[1]}.json`,JSON.stringify({id:ids[1],ok:false,error:'state not found'}));
  assert.equal(await io.checkApprovals({now:NOW.getTime()}),true);
  assert.equal(io.busyKeys(NOW.getTime()).size,0);
  assert.equal(io.autoError(NOW.getTime()),'반영 실패: state not found');
  const discard=await io.local(r,'discard',{now:NOW});
  assert(new Map(list).get(`/home/data/sixfold/linear-auto-actions/${discard}.json`).action==='discard');
  assert.equal(await io.local(r,'discard',{now:NOW}),null,'a second press while it is pending sends nothing');
});

test('a follow-up alert asks a person to forward it to the open task, with no start button',async()=>{
  const {autoGroup}=await view();
  const v=autoView(ledger(entry({id:'f'.repeat(8)+'-x',state:'followup',host_task:'01M7BBBBBBBBBBBBBBBBBBBBBB',reason:'요청 댓글'})),'Alpha');
  assert.equal(v.decide.length,1);
  const tree=autoGroup({id:'alpha',view:v,onStart(){}},theme);
  assert(words(tree).some(w=>w.startsWith('전달 필요 · 진행 중 task 01M7BBBBBB')));
  assert(!byId(tree,'task-issues-auto-start-alpha-ffffffff'));
});

test('signature changes only when a drawn state changes',()=>{
  const a=autoSignature(ledger(entry()),'Alpha');
  assert.equal(a,autoSignature(ledger(entry({note:'다른 메모'})),'Alpha'));
  assert.notEqual(a,autoSignature(ledger(entry({applied:{comment:{ok:true}}})),'Alpha'));
});
