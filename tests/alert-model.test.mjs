import test from 'node:test';
import assert from 'node:assert/strict';
import {scopedAlerts,alertVersion} from '../mods/sixfold-desk/alert-model.js';
const item={id:'channel:123.4',project:'MediHomes',text:'New message'};
test('messages stay in the mapped workspace',()=>{
 const items=[item,{...item,id:'other:1',project:'PeaceMinusOne'}];
 assert.equal(scopedAlerts(items,{project:'Medihomes'}).length,1);
 assert.equal(scopedAlerts(items,{project:'Share'}).length,0);
});
test('read receipt survives polling and edits; a new timestamp counts again',()=>{
 const read={[item.id]:alertVersion(item)};
 assert.equal(scopedAlerts([{...item,text:'edited'}],{read,unread:true}).length,0);
 assert.equal(scopedAlerts([{...item,id:'channel:124.5'}],{read,unread:true}).length,1);
});
