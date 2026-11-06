import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('untouched original Parquet loader corpus covers all integer widths and exact uint64 identities',()=>{
 const cases=JSON.parse(fs.readFileSync(new URL('./fixtures/dataset-original-parquet.json',import.meta.url)));
 assert.deepEqual(cases.map(c=>c.type),['int8','int16','int32','int64','uint8','uint16','uint32','uint64','string']);
 const u64=cases.find(c=>c.type==='uint64').expected;
 assert.deepEqual(u64.encounter.map(c=>c.speaker),['0','18446744073709551615','9223372036854775808']);
 assert.deepEqual(u64.sorted.map(c=>c.speaker),['0','9223372036854775808','18446744073709551615']);
 for(const row of cases){assert.equal(row.expected.encounter.length,3);assert.equal(Math.max(...row.expected.encounter.map(c=>c.clips)),40);for(const speaker of row.expected.encounter){assert.equal(speaker.sample_counts.length,speaker.clips);assert.ok(speaker.sample_counts.reduce((a,b)=>a+b,0)>=75*16000);}}
});
