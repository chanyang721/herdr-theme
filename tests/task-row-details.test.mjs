import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

function node(kind='div',value=null){
  const data={kind,value,nodes:[],calls:[]};let proxy;
  proxy=new Proxy(data,{get(target,key){
    if(key==='then')return undefined;if(key in target)return target[key];
    if(key==='child')return child=>{data.nodes.push(child);return proxy;};
    return (...args)=>{data.calls.push([key,...args]);return proxy;};
  }});return proxy;
}
globalThis.__rowDetailPrimitives={div:()=>node(),svg:value=>node('svg',value)};
const source=(await readFile(new URL('../mods/sixfold-desk/task-row-details.js',import.meta.url),'utf8'))
  .replace("import {div,svg} from 'gpui-kit';",'const {div,svg}=globalThis.__rowDetailPrimitives;');
const {rowDetailParts}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const t=Object.freeze({blocked:'#fa0',muted:'#999',background:'#111',accent:'#abc',selected:'#234'});
const flatten=tree=>tree?[tree,...tree.nodes.flatMap(child=>typeof child==='object'?flatten(child):[])]:[];
const call=(node,name)=>node.calls.find(c=>c[0]===name);

test('missing, zero and unknown details preserve the old row',()=>{
  for(const detail of [undefined,null,{},'unknown',{unread:0},{unread:-2,quota:{limited:'true'}},{unread:NaN}])
    assert.deepEqual(rowDetailParts(detail,t),{remoteBadge:null,unreadBadge:null,statusMark:null,statusColor:null,tooltip:''});
});

test('unread positive counts are bounded and compact badges reserve at most 18px',()=>{
  for(const [count,text] of [[1,'1'],[99,'99'],[100,'99+'],[1e9,'99+']]){
    const part=rowDetailParts({unread:count},t,{compact:true});
    assert.deepEqual(part.unreadBadge.nodes,[text]);assert.equal(call(part.unreadBadge,'w')[1],18);
  }
  assert.equal(rowDetailParts({unread:'2'},t).unreadBadge,null);
});

test('errors take precedence over limited quota while both remain in the tooltip',()=>{
  const detail=Object.freeze({errorLabel:'Connection failed',unread:0,quota:Object.freeze({label:'Daily limit',limited:true})});
  const part=rowDetailParts(detail,t);
  assert.equal(part.statusMark,'!');assert.equal(part.statusColor,t.blocked);
  assert.match(part.tooltip,/Connection failed/);assert.match(part.tooltip,/Daily limit/);
  assert.equal(part.unreadBadge,null);
});

test('quota only changes the existing status mark when explicitly limited',()=>{
  assert.equal(rowDetailParts({quota:{label:'Remaining',limited:false}},t).statusMark,null);
  const part=rowDetailParts({quota:{label:'Daily limit',limited:true}},t);
  assert.equal(part.statusMark,'◷');assert.equal(part.statusColor,t.blocked);
  assert.equal(part.remoteBadge,null);assert.equal(part.unreadBadge,null);
});

test('remote human names produce a tiny computer overlay without exposing addresses',()=>{
  const part=rowDetailParts(Object.freeze({remoteName:'Studio laptop'}),t);
  assert.equal(call(part.remoteBadge,'size')[1],9);assert(call(part.remoteBadge,'absolute'));
  assert.equal(part.remoteBadge.nodes[0].value,'mods/sixfold-desk/icons/device-computer.svg');
  assert.equal(call(part.remoteBadge,'tooltip')[1],'Remote: Studio laptop');
  for(const name of ['192.168.1.2','https://example.test','user@host','C:\\private','/home/user']){
    const invalid=rowDetailParts({remoteName:name},t);assert.equal(invalid.remoteBadge,null);assert.equal(invalid.tooltip,'');
  }
});

test('typed frozen input is unchanged and every part is informational without animation',()=>{
  const detail=Object.freeze({remoteName:'Worker',unread:4,quota:Object.freeze({label:'Limit',limited:true})});
  for(const motion of [false,true]){
    const part=rowDetailParts(detail,t,{compact:true,motion});
    for(const node of [...flatten(part.remoteBadge),...flatten(part.unreadBadge)])
      assert(!node.calls.some(([name])=>name.startsWith('on_')||['loop','transition'].includes(name)));
  }
  assert.deepEqual(detail,{remoteName:'Worker',unread:4,quota:{label:'Limit',limited:true}});
});
