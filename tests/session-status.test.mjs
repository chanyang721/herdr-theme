import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const dark={background:'#101318',muted:'#a6b0bf'},light={background:'#ffffff',muted:'#586270'};
const element=path=>{let proxy;proxy=new Proxy({path,calls:[]},{get(target,key){if(key==='then')return undefined;if(key in target)return target[key];return (...args)=>{target.calls.push([key,...args]);return proxy;};}});return proxy;};
async function module(){
  globalThis.__statusView={div:()=>element(null),image:path=>element(path)};
  let source=(await readFile(new URL('../mods/sixfold-desk/session-status.js',import.meta.url),'utf8'))
    .replace("import {div,image} from 'gpui-kit';",'const {div,image}=globalThis.__statusView;')
    .replace("'./collab-flow.js'",JSON.stringify(new URL('../mods/sixfold-desk/collab-flow.js',import.meta.url).href));
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('seven explicit states have distinct non-colour shapes and never infer a close policy',async()=>{
  const {SESSION_STATES,sessionDisplay,sessionDescription}=await module();
  assert.equal(Object.keys(SESSION_STATES).length,7);assert.equal(new Set(Object.values(SESSION_STATES).map(x=>x.shape)).size,7);
  assert.equal(sessionDisplay({state:'unproven',reason:'close soon'}),null);assert.equal(sessionDisplay({status:'idle'}),null);
  for(const state of Object.keys(SESSION_STATES)){
    const value=sessionDisplay({state,reason:'Actual policy: 47 minutes remaining'});
    assert.equal(value.reason,'Actual policy: 47 minutes remaining');assert.equal(sessionDescription(value),`${value.label} · ${value.reason}`);
  }
  assert.equal(sessionDisplay({state:'idle',reason:'  observed\r\nreason  '}).reason,'observed  reason');
});

test('native animation is replaced with still pixels for motion-off, hidden and event effects',async()=>{
  const {SESSION_STATES,sessionStatusAsset}=await module();
  for(const state of Object.keys(SESSION_STATES))for(const theme of [dark,light])for(const size of [12,16]){
    const value={state};assert.equal(sessionStatusAsset(value,theme,{size}).animated,SESSION_STATES[state].animated);
    for(const options of [{motion:false},{visible:false},{eventActive:true}]){
      const asset=sessionStatusAsset(value,theme,{size,...options});assert.equal(asset.animated,false);assert(asset.path.endsWith('.png'));
    }
  }
});

test('all packaged dark/light and12/16 assets match their hashes and original dimensions',async()=>{
  const root=new URL('../mods/sixfold-desk/icons/status/',import.meta.url),manifest=JSON.parse(await readFile(new URL('manifest.json',root),'utf8'));
  assert.equal(manifest.length,28);
  for(const item of manifest){
    const bytes=await readFile(new URL(item.still,root));assert.equal(createHash('sha256').update(bytes).digest('hex'),item.still_sha256);
    assert.equal(bytes.readUInt32BE(16),item.size);assert.equal(bytes.readUInt32BE(20),item.size);
    if(item.animation){
      const moving=await readFile(new URL(item.animation,root));assert.equal(moving.toString('ascii',0,4),'RIFF');assert.equal(moving.toString('ascii',8,12),'WEBP');
      assert.equal(createHash('sha256').update(moving).digest('hex'),item.animation_sha256);assert(item.frames>1);
    }else assert(['idle','closed'].includes(item.state));
  }
});

test('reason text has one line, accepts actual producer values and omits absent reasons',async()=>{
  const {sessionReasonLine,sessionStatusGlyph}=await module();
  assert.equal(sessionReasonLine({state:'idle'},dark),null);
  const line=sessionReasonLine({state:'cleanup_wait',reason:'Actual idle threshold: 47 minutes'},dark);
  assert(line.calls.some(x=>x[0]==='child'&&x[1]==='Actual idle threshold: 47 minutes'));
  const glyph=sessionStatusGlyph({state:'working',reason:'Observed work is active'},dark,{id:'demo',motion:false});
  assert(glyph.path.endsWith('/working-12-dark.png'));assert(!glyph.calls.some(x=>['loop','frames','transition'].includes(x[0])));
});
