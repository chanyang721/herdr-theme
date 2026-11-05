import test from 'node:test';
import assert from 'node:assert/strict';
import {compare,compareMatrices,manifest,blasManifest,nativeEnvironment} from './native-model-differential.mjs';
test('native comparison removes interpreter PATH lookup without changing the external oracle environment',()=>{
  const original={Path:'oracle-path',PATH:'other-path',path:'third-path',HOME:'synthetic-home',LD_LIBRARY_PATH:'oracle-libs'};
  const native=nativeEnvironment(original,{HERDR_SHERPA_LIBRARY:'/explicit/native/library'});
  assert.deepEqual(Object.keys(native).filter(key=>key.toLowerCase()==='path'),['PATH']);
  assert.equal(native.PATH,'');assert.equal(original.Path,'oracle-path');assert.equal(original.LD_LIBRARY_PATH,'oracle-libs');
  assert.equal(native.HERDR_SHERPA_LIBRARY,'/explicit/native/library');assert.equal(native.HOME,'synthetic-home');
});

function fixture(){return {schema:1,backend:'sherpa-onnx',version:'2.0.1',sample_rate:16000,sample_count:16000,threshold:0.35,gain:10,embedding:[1,0],abi:{pointer_bytes:8,speech_segment:{size:24,start:0,samples:8,n:16}},segments:[{start:512,sample_count:3,samples:[0.1,-0.125,0],embedding:[1,0]}]};}
test('model comparator checks float32 waveform bits independently of JSON spelling',()=>{
  const reference=fixture(),native=structuredClone(reference);reference.segments[0].samples[0]=Math.fround(0.1);native.segments[0].samples[0]=0.1;
  assert.equal(compare(reference,native).exact_vad_waveforms,true);
});
test('model comparator rejects shifted, truncated or changed VAD segments',()=>{
  for(const change of [x=>x.segments[0].start++,x=>x.segments[0].sample_count--,x=>x.segments[0].samples[1]=-0.126,x=>x.segments=[]]){
    const reference=fixture(),native=structuredClone(reference);change(native);assert.throws(()=>compare(reference,native));
  }
});
test('model comparator rejects embedding drift, invalid ABI and version mismatch',()=>{
  for(const change of [x=>x.embedding=[0.99,0.1],x=>x.embedding=[1,1e-10],x=>x.abi.speech_segment.n=12,x=>x.version='different']){
    const reference=fixture(),native=structuredClone(reference);change(native);assert.throws(()=>compare(reference,native));
  }
});
test('model comparator rejects a changed boundary decision despite an allowed score delta',()=>{
  const reference=fixture(),native=structuredClone(reference);
  reference.decisions=[{label:'equal-score-threshold',seconds:1,score:0.4,me:true}];
  native.decisions=[{label:'equal-score-threshold',seconds:1,score:0.39999999999999997,me:false}];
  assert.throws(()=>compare(reference,native),/exact gate decision/);
});
test('external oracle, wheels, model, public speech and native archives are hash-pinned',()=>{
  assert.equal(manifest.baseline.commit,'8c5b71d2f1074bb5d1d831fa395617bf4ae2abc8');
  for(const key of ['baseline','embedding','vad','audio','header']){assert.match(manifest[key].sha256,/^[a-f0-9]{64}$/);assert(manifest[key].url.startsWith('https://'));}
  for(const platform of ['darwin-arm64','darwin-x64','linux-x64','win32-x64']){const config=manifest.platforms[platform];assert.match(config.archive_sha256,/^[a-f0-9]{64}$/);assert.equal(config.wheels.length,3);for(const wheel of config.wheels){assert.match(wheel.sha256,/^[a-f0-9]{64}$/);assert(wheel.url.startsWith('https://files.pythonhosted.org/'));}}
});
test('runtime BLAS carriers match the oracle and contain only native libraries and licenses',()=>{
  assert.equal(blasManifest.provider,'OpenBLAS');assert.equal(blasManifest.version,'0.3.29');assert.equal(blasManifest.abi,'ILP64');
  for(const [platform,config] of Object.entries(blasManifest.platforms)){
    const reference=manifest.platforms[platform].wheels.find(w=>w.package==='numpy');assert.equal(config.wheel.sha256,reference.sha256);assert.equal(config.wheel.url,reference.url);
    assert(config.files.some(file=>file.filename===config.primary));assert(config.files.some(file=>file.filename==='LICENSE.txt'));
    for(const file of config.files){assert.match(file.sha256,/^[a-f0-9]{64}$/);assert(!/\.py[co]?$/.test(file.filename));assert(!file.filename.includes('/'));}
  }
});
test('matrix comparator rejects changed threshold masks even within numeric tolerance',()=>{
  const reference={matvec:[0.4],gram:[[1]],cross:[[0.4]],mean:[0.2,0.3],centre:[1,0],near:[[true]],kept:[false]};
  assert.equal(compareMatrices(reference,structuredClone(reference)).exact_threshold_masks,true);
  const native=structuredClone(reference);native.matvec[0]+=1e-16;native.kept=[true];assert.throws(()=>compareMatrices(reference,native),/threshold decisions/);
  const wrong=structuredClone(reference);wrong.gram=[[0.9]];assert.throws(()=>compareMatrices(reference,wrong),/difference/);
});
