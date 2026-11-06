import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {compareNumeric} from './native-eval-differential.mjs';
test('evaluation comparator rejects numerical drift and exact decision changes',()=>{
 const expected={eer:0.5,rows:[{passed:2,threshold:0.4}]};
 compareNumeric(expected,structuredClone(expected));
 assert.throws(()=>compareNumeric(expected,{...expected,eer:0.500000001}));
 assert.throws(()=>compareNumeric(expected,{eer:0.5,rows:[{passed:3,threshold:0.4}]}));
 assert.throws(()=>compareNumeric(expected,{eer:0.5,rows:[]}));
});
test('evaluation oracle sources and every dependency wheel are frozen by checksum',()=>{
 const assets=JSON.parse(fs.readFileSync(new URL('./eval-probe-assets.json',import.meta.url)));
 assert.equal(assets.baseline_commit,'8c5b71d2f1074bb5d1d831fa395617bf4ae2abc8');
 assert.equal(Object.keys(assets.sources).length,6);
 for(const [name,item] of Object.entries(assets.sources)){assert.match(item.sha256,/^[a-f0-9]{64}$/);assert.ok(item.url.endsWith('/'+name));assert.ok(item.url.includes(assets.baseline_commit));}
 for(const wheels of Object.values(assets.platforms)){assert.equal(wheels.length,5);for(const w of wheels){assert.match(w.sha256,/^[a-f0-9]{64}$/);assert.ok(w.url.startsWith('https://files.pythonhosted.org/'));assert.ok(w.filename.endsWith('.whl'));}}
});
test('native convolution vendors the exact SciPy PocketFFT revision and license',()=>{
 const root=new URL('../../rust/vendor/pocketfft/',import.meta.url);
 const p=JSON.parse(fs.readFileSync(new URL('provenance.json',root)));
 assert.equal(p.commit,'9367142748fcc9696a1c9e5a99b76ed9897c9daa');
 for(const source of p.sources){const actual=crypto.createHash('sha256').update(fs.readFileSync(new URL(source.filename,root))).digest('hex');assert.equal(actual,source.sha256);}
 assert.match(fs.readFileSync(new URL('LICENSE.md',root),'utf8'),/Redistribution/);
});
