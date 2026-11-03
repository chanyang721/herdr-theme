import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('workspace badges: a generic, validated slot keyed by computer and space',async()=>{
 let source=(await readFile(new URL('../mods/sixfold-desk/badges.js',import.meta.url),'utf8')).replace(/^import[^\n]*\n/gm,'');
 source='const div=()=>null,h_flex=()=>null,appHome=()=>"",readTextFile=async()=>null,watchFolder=async()=>{},openOverlay=()=>{},run=()=>{},shared=()=>undefined;\n'+source;
 const m=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 assert.equal(m.badgeKey(null,'sp1'),'|sp1');
 assert.equal(m.badgeKey('sub1','sub1/spc82'),'sub1|spc82');
 const clean=m.cleanBadges({
  '|sp1':[{id:'a',text:' ! 2 ',tone:'blocked',tooltip:'two open',open:{mod:'some-mod',props:{x:1},kind:'window'}},{id:'b',text:'',tone:'accent'},{text:'no id'}],
  'nokey':[{id:'c',text:'x'}],
  'sub1|spc82':[{id:'d',text:'note',tone:'weird',command:{name:'some-mod.show',args:{n:1}}},{id:'e',text:'bad',open:{mod:'../escape'}}],
 });
 assert.deepEqual(Object.keys(clean).sort(),['sub1|spc82','|sp1']);
 assert.equal(clean['|sp1'].length,1);
 assert.equal(clean['|sp1'][0].text,'! 2');
 assert.equal(clean['sub1|spc82'][0].tone,'dim','unknown tones fall back');
 assert.equal(clean['sub1|spc82'][1].open,null,'a mod name with a path is refused');
 assert.deepEqual(m.badgesFor('|sp1',{'|sp1':[{id:'file'}]},{'|sp1':[{id:'live',text:'L'}]}).map(b=>b.id),['live'],'shared state wins over the file');
 assert.deepEqual(m.badgesFor('|sp1',{'|sp1':[{id:'file'}]},undefined).map(b=>b.id),['file']);
 const text=await readFile(new URL('../mods/sixfold-desk/badges.js',import.meta.url),'utf8');
 assert.ok(!/harness|escalation|기억함/i.test(text),'the public slot carries no private terms');
});
