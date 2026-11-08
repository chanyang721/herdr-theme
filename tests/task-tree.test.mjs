import test from 'node:test';
import assert from 'node:assert/strict';
import {projectTaskTree,projectTaskBranches} from '../mods/sixfold-desk/task-tree.js';

const project = (entries, options = {}) => projectTaskTree(entries, {parentOf: entry => entry.parent, ...options});
const ids = rows => rows.map(row => row.entry.id);

test('nested rows use explicit parents, preserve references and count every hidden descendant', () => {
  const entries = [{id:'root'}, {id:'child',parent:'root'}, {id:'grandchild',parent:'child'}, {id:'peer',parent:'root'}];
  const collapsed = project(entries);
  assert.deepEqual(ids(collapsed), ['root']);assert.equal(collapsed[0].childCount, 3);assert.equal(collapsed[0].expanded, false);
  const partial = project(entries, {expandedIDs:new Set(['root'])});
  assert.deepEqual(ids(partial), ['root','child','peer']);assert.equal(partial[1].childCount, 1);
  const all = project(entries, {defaultExpanded:true});
  assert.deepEqual(all.map(row => row.depth), [0,1,2,1]);assert.equal(all[2].parent, entries[1]);assert.equal(all[3].entry, entries[3]);
  assert.deepEqual(ids(project(entries, {defaultExpanded:true,expandedIDs:new Set()})), ['root']);
});

test('sibling comparator applies only within each family and ties keep producer order', () => {
  const entries = [{id:'a',rank:1},{id:'a2',parent:'a',rank:2},{id:'b',rank:0},{id:'a1',parent:'a',rank:0},{id:'a3',parent:'a',rank:0}];
  assert.deepEqual(ids(project(entries,{defaultExpanded:true,compare:(a,b)=>a.rank-b.rank})), ['b','a','a1','a3','a2']);
  assert.deepEqual(ids(project(entries,{defaultExpanded:true})), ['a','a2','a1','a3','b']);
});

test('orphans, self links and duplicate identities remain visible without ambiguous ownership', () => {
  const entries = [{id:'orphan',parent:'absent'},{id:'self',parent:'self'},{id:'same'},{id:'same',parent:'self'},{id:'child',parent:'same'},{title:'unidentified'}];
  const rows = project(entries,{defaultExpanded:true});
  assert.equal(rows.length, entries.length);assert.equal(new Set(rows.map(row=>row.entry)).size, entries.length);
  assert.ok(rows.every(row=>row.depth===0 && row.parent===null));
});

test('cycles break at the earliest input member and retain attached descendants once', () => {
  const entries = [{id:'b',parent:'a'},{id:'a',parent:'c'},{id:'c',parent:'b'},{id:'leaf',parent:'a'},{id:'other',parent:'other'}];
  const rows = project(entries,{defaultExpanded:true});
  assert.deepEqual(ids(rows), ['b','c','a','leaf','other']);assert.equal(rows[0].childCount, 3);
  assert.equal(rows.length, entries.length);assert.equal(new Set(rows.map(row=>row.entry)).size, entries.length);
  assert.deepEqual(project(entries,{defaultExpanded:true}), rows);
});

test('depth and node bounds are finite and overdeep entries become visible roots', () => {
  const entries = Array.from({length:1000},(_,index)=>({id:`n${index}`,parent:index?`n${index-1}`:null}));
  const rows = project(entries,{defaultExpanded:true,maxDepth:2,maxNodes:17});
  assert.equal(rows.length,17);assert.ok(rows.every(row=>row.depth<=2));
  assert.deepEqual(rows.filter(row=>row.parent===null).map(row=>row.entry.id), ['n0','n3','n6','n9','n12','n15']);
  assert.equal(rows[0].childCount,2);assert.equal(rows.at(-2).childCount,1);
  assert.equal(project(entries,{maxNodes:0}).length,0);
  assert.equal(project(entries,{defaultExpanded:true,maxDepth:0}).length,1000);
});

test('projection does not mutate frozen inputs or infer a relationship from names', () => {
  const entries = Object.freeze([Object.freeze({key:'x',title:'Parent',rank:2}),Object.freeze({key:'y',title:'Parent child',owner:'x',rank:1})]);
  const expandedIDs = new Set(['x']);
  const options = Object.freeze({idOf:entry=>entry.key,parentOf:entry=>entry.owner,expandedIDs});
  const rows = projectTaskTree(entries,options);
  assert.equal(rows.length,2);assert.equal(rows[1].parent,entries[0]);assert.deepEqual([...expandedIDs],['x']);
  assert.equal(projectTaskTree(entries,{idOf:entry=>entry.key,defaultExpanded:true})[1].parent,null);
});

test('branch folds follow visible nested descendants and expansion preserves every root',()=>{
  const entries=[{id:'root'},...Array.from({length:5},(_,index)=>({id:`child${index}`,parent:'root'})),{id:'grandchild',parent:'child2'},{id:'other'}];
  const options={parentOf:entry=>entry.parent};
  const collapsed=projectTaskBranches(entries,options);
  assert.deepEqual(ids(collapsed.rows),['root','child0','child1','child2','grandchild','other']);
  assert.deepEqual(collapsed.folds,[{parent:'root',after:'grandchild',hidden:2,count:5,expanded:false}]);
  assert.equal(collapsed.rows[0].childCount,5);assert.equal(collapsed.hidden,2);
  const expanded=projectTaskBranches(entries,{...options,expandedParents:new Set(['root'])});
  assert.equal(expanded.rows.length,entries.length);assert.equal(expanded.folds[0].hidden,0);assert.equal(expanded.folds[0].expanded,true);assert.equal(expanded.folds[0].after,'child4');
});
