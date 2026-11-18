import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {cleanPanelFeed} from '../mods/sixfold-desk/panel-model.js';
import {makePanelFixture} from './panel-fixtures.mjs';

test('public profession schema matches text bounds and remains an optional open-catalog extension',async()=>{
  const schema=JSON.parse(await readFile(new URL('../schemas/herdr/panel-feed.schema.json',import.meta.url),'utf8'));
  assert.equal(schema.$defs.agent.properties.profession.$ref,'#/$defs/profession');
  assert(!schema.$defs.agent.required?.includes('profession'));
  const definition=schema.$defs.profession;
  assert.deepEqual(definition.required,['id','label']);
  assert.equal(definition.additionalProperties,false);
  for(const field of ['id','label']){
    assert.equal(definition.properties[field].type,'string');
    assert.equal(Object.hasOwn(definition.properties[field],'enum'),false);
  }
  const valid=(field,value)=>{
    const rule=definition.properties[field];
    return value.length>=rule.minLength&&value.length<=rule.maxLength&&new RegExp(rule.pattern,'u').test(value);
  };
  for(const [profession,expected] of [
    [{id:'future-discipline',label:'QA'},true],
    [{id:'x'.repeat(80),label:'Q'.repeat(48)},true],
    [{id:'x'.repeat(81),label:'QA'},false],
    [{id:'x',label:'Q'.repeat(49)},false],
    [{id:'x y',label:'QA'},false],
    [{id:'x',label:' QA'},false],
    [{id:'x',label:'QA '},false],
    [{id:'x',label:'\0'},false],
    [{id:'x',label:'\x7f'},false],
    [{id:'x',label:'QA\nreview'},false],
    [{id:'x',label:'QA\n'},false],
    [{id:'x\n',label:'QA'},false],
    [{id:'x',label:'<QA & review>'},true],
  ]){
    assert.equal(valid('id',profession.id)&&valid('label',profession.label),expected,JSON.stringify(profession));
    const feed=makePanelFixture();feed.spaces[0].agents[0].profession=profession;
    assert.equal(Object.hasOwn(cleanPanelFeed(feed).spaces[0].agents[0],'profession'),expected);
  }
});
