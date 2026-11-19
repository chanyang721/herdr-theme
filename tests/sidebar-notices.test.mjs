import test from 'node:test';
import assert from 'node:assert/strict';
import {sidebarNotices,setFallbackSpace} from '../mods/sixfold-desk/model.js';
import {placeItems} from '../mods/sixfold-desk/alert-model.js';
import {arrivalTarget} from '../mods/sixfold-desk/arrival-model.js';

test('footer notices keep at most three well-formed short lines and run nothing',()=>{
  const got=sidebarNotices([{id:'a',text:'  Waiting 2  ',tone:'blocked',tooltip:'x'},{id:'../b',text:'bad id'},{id:'c',text:''},
    {id:'d',text:'x'.repeat(200),tone:'odd',command:{name:'run'}},{id:'e',text:'e'},{id:'f',text:'f'}]);
  assert.deepEqual(got.map(n=>[n.id,n.text.length,n.tone]),[['a',9,'blocked'],['d',80,'dim'],['e',1,'dim']]);
  assert.ok(got.every(n=>!('command' in n)));
  assert.deepEqual(sidebarNotices(null),[]);
});

test('alerts without a shown workspace go to the configured fallback workspace',()=>{
  assert.equal(arrivalTarget('gone',['Alpha','Hub']),'Hub');
  setFallbackSpace('Desk');
  try{
    assert.equal(arrivalTarget('gone',['Alpha','Desk']),'Desk');
    assert.deepEqual(placeItems([{id:1,workspace:'gone'}],['Alpha','Desk']).map(i=>i.workspace),['Desk']);
    setFallbackSpace('  ');
    assert.equal(arrivalTarget('gone',['Alpha','Desk']),'Desk','a blank name keeps the current one');
  }finally{setFallbackSpace('Hub');}
});
