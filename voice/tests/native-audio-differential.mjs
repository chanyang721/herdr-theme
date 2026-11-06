// External frozen audio decoder validation; no installed runtime Python.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {setup,download,nativeEnvironment} from './native-model-differential.mjs';
export const audioAssets=JSON.parse(fs.readFileSync(new URL('../native-sndfile-assets.json',import.meta.url)));
const evalAssets=JSON.parse(fs.readFileSync(new URL('./eval-probe-assets.json',import.meta.url)));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const option=(a,n)=>a.includes(n)?a[a.indexOf(n)+1]:null;
function run(command,args,env,input,cwd){const r=spawnSync(command,args,{env,input,cwd,encoding:'utf8',timeout:300000,maxBuffer:32*1024*1024,windowsHide:true});return {exit:r.status,stdout:r.stdout||'',stderr:r.stderr||'',error:r.error?.message};}
function success(command,args,env,input){const r=run(command,args,env,input);assert.equal(r.exit,0,r.stderr||r.error);return r.stdout;}
export async function stageSndfile(context,work){
 const {python,env,platform}=context,config=audioAssets.platforms[platform];assert.ok(config,platform);
 const wheels=path.join(work,'eval','wheels');fs.mkdirSync(wheels,{recursive:true});
 const dependencies=evalAssets.platforms[platform].filter(w=>['soundfile','cffi','pycparser'].includes(w.package));
 for(const wheel of dependencies)await download(wheel,path.join(wheels,wheel.filename));
 const requirements=path.join(work,'audio-oracle-requirements.txt');fs.writeFileSync(requirements,dependencies.map(w=>`${w.package} @ ${pathToFileURL(path.join(wheels,w.filename)).href} --hash=sha256:${w.sha256}`).join('\n')+'\n');
 success(python,['-I','-m','pip','--isolated','install','--no-deps','--no-index','--require-hashes','--no-cache-dir','-r',requirements],env);
 const carrier=path.join(wheels,config.wheel.filename);assert.equal(hash(carrier),config.wheel.sha256);
 const folder=path.join(work,'native-sndfile');fs.mkdirSync(folder,{recursive:true});
 success(python,['-I','-c',String.raw`import json,pathlib,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
 for item in json.loads(sys.argv[2]):
  target=pathlib.Path(sys.argv[3])/item['filename']
  if not target.exists():
   target.write_bytes(archive.read(item['entry']))
   target.chmod((archive.getinfo(item['entry']).external_attr>>16)&0o777)
`,carrier,JSON.stringify(config.files),folder],env);
 for(const file of config.files)assert.equal(hash(path.join(folder,file.filename)),file.sha256);
 const library=path.join(folder,config.primary);context.paths.sndfile=library;return library;
}
const PREPARE=String.raw`
import io,json,os,pathlib,sys,wave
import numpy as np
import soundfile as sf
source,destination=sys.argv[1:]
assert sf.__version__=='0.13.1'
assert sf.__libsndfile_version__=='1.2.2'
destination=pathlib.Path(destination);destination.mkdir(exist_ok=True)
with wave.open(source,'rb') as f:
 samples=np.frombuffer(f.readframes(f.getnframes()),dtype='<i2').astype('float32')/32768
samples=samples[16000:17024]
rows=[]
for format in sorted(sf.available_formats()):
 if format=='RAW':continue # original read(BytesIO) supplies no RAW metadata
 # SD2's encoder may create an AppleDouble resource fork even for BytesIO.
 # Isolate every format so that fork cannot change MPEG autodetection.
 cwd=destination/format;cwd.mkdir(exist_ok=True);os.chdir(cwd)
 container=io.BytesIO()
 # MPEG detection needs enough complete frames; a sub-frame-sized container
 # can be rejected before decoding. Keep valid MP3 coverage mandatory.
 piece=np.tile(samples,16) if format=='MP3' else samples
 try:sf.write(container,piece,16000,format=format)
 except Exception as error:
  rows.append(dict(format=format,status='encoder-unavailable-for-memory-input',reason=type(error).__name__));continue
 data=container.getvalue();file=destination/(format+'.audio');file.write_bytes(data)
 try:
  decoded,rate=sf.read(io.BytesIO(data),dtype='float32')
  assert rate==16000
  assert decoded.ndim==1
  rows.append(dict(format=format,status='readable-mono16k',file=file.name,cwd=format,samples=decoded.tolist()))
 except Exception as error:rows.append(dict(format=format,status='original-rejected-input',file=file.name,cwd=format,reason=type(error).__name__))
# Inputs outside the original evaluation pipeline's valid mono16k contract.
for label,pcm,rate in [('stereo',np.column_stack([samples,samples]),16000),('rate8000',samples,8000)]:
 container=io.BytesIO();sf.write(container,pcm,rate,format='WAV',subtype='PCM_16');file=destination/(label+'.audio');file.write_bytes(container.getvalue());rows.append(dict(format=label,status='original-rejected-input',file=file.name))
file=destination/'invalid.audio';file.write_bytes(b'not an audio container');rows.append(dict(format='invalid',status='original-rejected-input',file=file.name))
print(json.dumps(rows))
`;
function floatBits(values){const bytes=new ArrayBuffer(values.length*4),view=new DataView(bytes);values.forEach((x,i)=>view.setFloat32(i*4,x,true));return Buffer.from(bytes);}
export function compareAudio(expected,actual){
 assert.equal(actual.length,expected.length,'decoded frame count');const a=floatBits(actual),b=floatBits(expected);
 if(!a.equals(b)){let count=0,first=-1,max=0;for(let i=0;i<expected.length;i++){if(a.readUInt32LE(i*4)!==b.readUInt32LE(i*4)){count++;if(first<0)first=i;}max=Math.max(max,Math.abs(actual[i]-expected[i]));}assert.fail(`decoded float32 sample bits differ: ${count} frames, first ${first}, maximum absolute difference ${max}`);}
}
export async function main(args){
 const binary=path.resolve(option(args,'--binary')||'rust/target/debug/herdr-theme'+(process.platform==='win32'?'.exe':'')),work=path.resolve(option(args,'--work-dir')||'.migration-oracle/voice-model-differential');
 const context=await setup(args,work),library=await stageSndfile(context,work);
 const folder=path.join(work,'audio');fs.mkdirSync(folder,{recursive:true});
 const reference=JSON.parse(success(context.python,['-I','-c',PREPARE,context.paths.audio,folder],context.env));fs.writeFileSync(path.join(folder,'baseline.json'),JSON.stringify(reference));
 const env=nativeEnvironment(context.env,{HERDR_SNDFILE_LIBRARY:library});
 const summary={schema:1,platform:context.platform,backend:'libsndfile-1.2.2',binary_sha256:hash(binary),library_sha256:hash(library),audio_sha256:hash(context.paths.audio),native_path_empty:true,cases:[],status:'incomplete'};
 for(const row of reference){if(!row.file){summary.cases.push({format:row.format,status:row.status,reason:row.reason});continue;}
  const file=path.join(folder,row.file),native=run(binary,['voice_probe'],env,JSON.stringify({op:'decode-audio',args:{audio:file}}),row.cwd?path.join(folder,row.cwd):folder);
  fs.writeFileSync(path.join(folder,`${row.format}-native-cli.json`),JSON.stringify(native));
  const entry={format:row.format,input_sha256:hash(file),original_status:row.status,native_exit:native.exit,status:'fail'};
  try{if(row.status==='readable-mono16k'){assert.equal(native.exit,0,native.stderr);compareAudio(row.samples,JSON.parse(native.stdout));entry.frames=row.samples.length;entry.exact_float32_bits=true;}else assert.notEqual(native.exit,0,'invalid contract input was accepted');entry.status='pass';}catch(error){entry.error=error.message.replaceAll(work,'<validation-work>');}
  summary.cases.push(entry);
 }
 summary.missing_required_formats=['AIFF','AU','CAF','FLAC','MP3','OGG','WAV','WAVEX','W64','NIST','MAT4','MAT5'].filter(required=>!summary.cases.some(c=>c.format===required&&c.status==='pass'&&c.exact_float32_bits));
 summary.status=summary.cases.some(c=>c.status==='fail')||summary.missing_required_formats.length?'fail':'pass';fs.writeFileSync(path.join(folder,'audio-differential-summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));if(summary.status!=='pass')process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(error=>{console.error(error.stack||error);process.exitCode=1;});
