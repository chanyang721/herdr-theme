import test from 'node:test';
import assert from 'node:assert/strict';
import {audioAssets,compareAudio} from './native-audio-differential.mjs';
test('audio decoder comparison requires exact frame counts and float32 bits',()=>{
 compareAudio([0,0.25,-0.5],[0,0.25,-0.5]);
 assert.throws(()=>compareAudio([0],[0,0]));
 assert.throws(()=>compareAudio([0.25],[0.25000003]));
 assert.throws(()=>compareAudio([-0],[0]));
});
test('native audio distribution contains only checksum-pinned libraries and licenses',()=>{
 assert.equal(audioAssets.version,'1.2.2');
 assert.match(audioAssets.source_archive_sha256,/^[a-f0-9]{64}$/);
 for(const config of Object.values(audioAssets.platforms)){
  assert.match(config.wheel.sha256,/^[a-f0-9]{64}$/);
  assert.equal(config.files.length,2);
  assert.ok(config.files.some(f=>f.filename===config.primary));
  for(const f of config.files){assert.match(f.sha256,/^[a-f0-9]{64}$/);assert.ok(f.filename==='COPYING'||/\.(dll|dylib|so)$/.test(f.filename));assert.ok(!f.entry.endsWith('.py'));}
 }
});
