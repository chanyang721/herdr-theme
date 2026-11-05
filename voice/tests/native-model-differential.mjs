// Python is an external, frozen reference implementation here. It is never
// installed into the plugin or called by any product runtime entry point.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';

export const manifest=JSON.parse(fs.readFileSync(new URL('./model-probe-assets.json',import.meta.url),'utf8'));
export const blasManifest=JSON.parse(fs.readFileSync(new URL('../native-blas-assets.json',import.meta.url),'utf8'));
export function nativeEnvironment(env,overrides={}){
  const native={...env,...overrides};
  for(const key of Object.keys(native))if(key.toLowerCase()==='path')delete native[key];
  native.PATH='';
  delete native.LD_LIBRARY_PATH;delete native.DYLD_LIBRARY_PATH;
  return native;
}
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function hashFile(file){return sha(fs.readFileSync(file));}
function option(args,name){const at=args.indexOf(name);return at<0?null:args[at+1];}
function run(command,args,env){const result=spawnSync(command,args,{env,encoding:'utf8',timeout:600000,maxBuffer:64*1024*1024,windowsHide:true});if(result.error||result.status!==0){const error=Error(`${path.basename(command)} failed (${result.status}): ${result.error||result.stderr||result.stdout}`);error.exit_status=result.status;error.child_stderr=result.stderr;throw error;}return result.stdout;}
export async function download(asset,destination){
  if(fs.existsSync(destination)){assert.equal(hashFile(destination),asset.sha256,`cached checksum mismatch: ${path.basename(destination)}`);return;}
  const response=await fetch(asset.url);if(!response.ok)throw Error(`download failed ${response.status}: ${asset.url}`);
  const part=`${destination}.${process.pid}.part`,digest=crypto.createHash('sha256');
  const hashing=new Transform({transform(chunk,_encoding,callback){digest.update(chunk);callback(null,chunk);}});
  try{await pipeline(Readable.fromWeb(response.body),hashing,fs.createWriteStream(part,{flags:'wx'}));assert.equal(digest.digest('hex'),asset.sha256,`download checksum mismatch: ${asset.url}`);fs.renameSync(part,destination);}catch(error){if(fs.existsSync(part))fs.unlinkSync(part);throw error;}
}
function filesBelow(folder){return fs.readdirSync(folder,{withFileTypes:true}).flatMap(e=>e.isDirectory()?filesBelow(path.join(folder,e.name)):e.isFile()?[path.join(folder,e.name)]:[]);}
function libraryName(){return process.platform==='win32'?'sherpa-onnx-c-api.dll':process.platform==='darwin'?'libsherpa-onnx-c-api.dylib':'libsherpa-onnx-c-api.so';}
export async function setup(args,work){
  const platform=`${process.platform}-${process.arch}`,config=manifest.platforms[platform];if(!config)throw Error(`no pinned offline model fixture for ${platform}`);
  fs.mkdirSync(work,{recursive:true});const sandbox=path.join(work,'isolated-home');fs.mkdirSync(sandbox,{recursive:true});
  const env={...process.env,HOME:sandbox,USERPROFILE:sandbox,HERDR_APP_HOME:path.join(sandbox,'app'),HERDR_VOICE_SETTINGS:path.join(sandbox,'voice.local.json'),HERDR_PLUGIN_STATE_DIR:path.join(sandbox,'state'),PIP_CONFIG_FILE:process.platform==='win32'?'NUL':'/dev/null',OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'};
  delete env.PYTHONHOME;delete env.PYTHONPATH;
  const paths={};for(const key of ['embedding','vad','audio','header']){const provided=option(args,key==='embedding'?'--model':`--${key}`);const destination=provided?path.resolve(provided):path.join(work,manifest[key].filename);if(!provided)await download(manifest[key],destination);paths[key]=destination;}
  const oracleDir=option(args,'--oracle-dir');const source=oracleDir?path.resolve(oracleDir,'voicegate.py'):path.join(work,'baseline-voicegate.txt');
  if(oracleDir)assert.equal(hashFile(source),manifest.baseline.sha256,'local oracle differs from the untouched fixed baseline');else await download(manifest.baseline,source);
  paths.source=source;
  let library=option(args,'--library');if(library)library=path.resolve(library);else{
    const archive=path.join(work,config.archive);await download({url:config.archive_url,sha256:config.archive_sha256},archive);
    const folder=path.join(work,'native');const marker=path.join(folder,'validated-archive.json');
    if(!fs.existsSync(folder)){fs.mkdirSync(folder);run('tar',['-xjf',archive,'-C',folder,'--strip-components=1'],env);const match=filesBelow(folder).find(p=>path.basename(p)===libraryName());if(!match)throw Error('native archive lacks the C API shared library');fs.writeFileSync(marker,JSON.stringify({archive_sha256:config.archive_sha256,library:path.relative(folder,match),library_sha256:hashFile(match)},null,2));}
    if(!fs.existsSync(marker))throw Error('partial native validation directory exists; use a fresh work directory');const saved=JSON.parse(fs.readFileSync(marker,'utf8'));assert.equal(saved.archive_sha256,config.archive_sha256);library=path.join(folder,saved.library);assert.equal(hashFile(library),saved.library_sha256);
  }
  paths.library=library;const libraryDir=path.dirname(library);
  const originalPath=Object.entries(env).find(([key])=>key.toLowerCase()==='path')?.[1]||'';
  for(const key of Object.keys(env))if(key.toLowerCase()==='path')delete env[key];
  env.PATH=`${libraryDir}${path.delimiter}${originalPath}`;
  if(process.platform==='linux')env.LD_LIBRARY_PATH=[libraryDir,env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  if(process.platform==='darwin')env.DYLD_LIBRARY_PATH=[libraryDir,env.DYLD_LIBRARY_PATH].filter(Boolean).join(':');
  const wheels=path.join(work,'wheels');fs.mkdirSync(wheels,{recursive:true});
  for(const wheel of config.wheels)await download(wheel,path.join(wheels,wheel.filename));
  const requirements=config.wheels.map(w=>`${w.package} @ ${pathToFileURL(path.join(wheels,w.filename)).href} --hash=sha256:${w.sha256}`).join('\n')+'\n';
  const lock=path.join(work,'oracle-requirements.txt');fs.writeFileSync(lock,requirements);const expected=sha(requirements);
  const venv=path.join(work,'oracle-venv');const python=path.join(venv,process.platform==='win32'?'Scripts/python.exe':'bin/python');const ready=path.join(venv,'validated-wheels.json');
  if(!fs.existsSync(venv)){const supplied=option(args,'--python');const base=supplied||(process.platform==='win32'?'py':'python3');const prefix=!supplied&&process.platform==='win32'?['-3.12']:[];const version=run(base,[...prefix,'-I','-c','import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'],env).trim();assert.equal(version,'3.12','the pinned external oracle requires Python 3.12');run(base,[...prefix,'-I','-m','venv',venv],env);run(python,['-I','-m','pip','--isolated','install','--no-deps','--no-index','--require-hashes','--no-cache-dir','-r',lock],env);fs.writeFileSync(ready,JSON.stringify({requirements_sha256:expected}));}
  if(!fs.existsSync(ready))throw Error('partial oracle environment exists; use a fresh work directory');assert.equal(JSON.parse(fs.readFileSync(ready,'utf8')).requirements_sha256,expected);
  const blasConfig=blasManifest.platforms[platform];if(!blasConfig)throw Error(`no pinned native BLAS for ${platform}`);
  const suppliedBlas=option(args,'--blas');let blas;
  if(suppliedBlas)blas=path.resolve(suppliedBlas);else{
    const folder=path.join(work,'native-blas');const carrier=path.join(wheels,blasConfig.wheel.filename);
    assert.equal(hashFile(carrier),blasConfig.wheel.sha256,'native BLAS carrier');
    if(!fs.existsSync(folder)){fs.mkdirSync(folder);run(python,['-I','-c',String.raw`import json,pathlib,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
 for item in json.loads(sys.argv[2]):
  target=pathlib.Path(sys.argv[3])/item['filename']
  with open(target,'xb') as output:output.write(archive.read(item['entry']))
  target.chmod((archive.getinfo(item['entry']).external_attr>>16)&0o777)
`,carrier,JSON.stringify(blasConfig.files),folder],env);}
    for(const file of blasConfig.files)assert.equal(hashFile(path.join(folder,file.filename)),file.sha256,`native BLAS ${file.filename}`);
    blas=path.join(folder,blasConfig.primary);
  }
  paths.blas=blas;env.HERDR_BLAS_LIBRARY=blas;
  return {paths,python,env,platform,wheels:config.wheels.map(({package:pkg,filename,sha256})=>({package:pkg,filename,sha256}))};
}

// Extract precisely the original public function bodies. Importing voicegate
// itself would read personal settings and load sounddevice; the frozen AST
// selection deliberately needs neither a microphone nor an installed plugin.
const ORACLE=String.raw`
import ast,ctypes,hashlib,json,pathlib,sys,wave
import numpy as np
import sherpa_onnx
assert np.__version__=='2.3.0',np.__version__
source,model_path,vad_path,audio_path,threshold,gain=sys.argv[1:]
threshold,gain=float(threshold),float(gain)
assert sherpa_onnx.__version__ == '2.0.1', sherpa_onnx.__version__
tree=ast.parse(pathlib.Path(source).read_text(encoding='utf-8'))
names={'extractor','vad','embed','judge','build'}
selected=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names]
assert {node.name for node in selected}==names
scope=dict(sherpa_onnx=sherpa_onnx,np=np,EMBEDDING_MODEL=model_path,VAD_MODEL=vad_path,VAD_THRESHOLD=threshold,RATE=16000,MIN_JUDGE_SECONDS=1.0,DEFAULT_THRESHOLD=.4)
exec(compile(ast.Module(body=selected,type_ignores=[]),'frozen-public-voicegate','exec'),scope)
with wave.open(audio_path,'rb') as audio:
 assert audio.getframerate()==16000 and audio.getnchannels()==1 and audio.getsampwidth()==2
 samples=np.frombuffer(audio.readframes(audio.getnframes()),dtype='<i2').astype('float32')/32768
model,detector=scope['extractor'](),scope['vad']()
embedding=scope['embed'](model,samples).tolist()
segments=[]
def drain():
 while not detector.empty():
  segment=detector.front
  piece=np.array(segment.samples,dtype='float32')/gain
  segments.append(dict(start=int(segment.start),sample_count=len(piece),samples=piece.tolist(),embedding=scope['embed'](model,piece).tolist()))
  detector.pop()
for offset in range(0,len(samples),512):
 detector.accept_waveform(samples[offset:offset+512]*gain)
 drain()
detector.flush()
drain()
v=np.array(embedding)
orthogonal=np.zeros_like(v)
orthogonal[int(np.argmin(np.abs(v)))]=1
orthogonal-=v*float(orthogonal@v)
orthogonal/=np.linalg.norm(orthogonal)
voiceprint=.4*v+np.sqrt(1-.4**2)*orthogonal
voiceprint/=np.linalg.norm(voiceprint)
decision_inputs,decisions=[],[]
for count in [15999,16000,16001,len(samples)]:
 piece=samples[:count]
 _,point,_=scope['judge'](model,voiceprint,.4,piece)
 for direction,cut in [('below',float(np.nextafter(point,-np.inf))),('equal',point),('above',float(np.nextafter(point,np.inf)))]:
  label=f'samples-{count}-{direction}'
  seconds,score,me=scope['judge'](model,voiceprint,cut,piece)
  decision_inputs.append(dict(label=label,sample_count=count,voiceprint=voiceprint.tolist(),threshold=cut))
  decisions.append(dict(label=label,seconds=seconds,score=score,me=me))
matrix=np.array([embedding]+[segment['embedding'] for segment in segments]+[voiceprint.tolist()])
right=matrix[::-1].copy()
weights=np.arange(1,len(matrix)+1,dtype='float64')
matrix_inputs=dict(rows=matrix.tolist(),right=right.tolist(),vector=voiceprint.tolist(),weights=weights.tolist(),threshold=.4)
matrix_expected=dict(matvec=(matrix@voiceprint).tolist(),gram=(matrix@matrix.T).tolist(),cross=(matrix@right.T).tolist(),near=((matrix@matrix.T)>=.4).tolist(),kept=((matrix@voiceprint)>=.4).tolist(),mean=np.mean(matrix,axis=0).tolist(),centre=scope['build'](matrix,weights).tolist())
class Embedding(ctypes.Structure):
 _fields_=[('model',ctypes.c_void_p),('threads',ctypes.c_int32),('debug',ctypes.c_int32),('provider',ctypes.c_void_p)]
class Silero(ctypes.Structure):
 _fields_=[('model',ctypes.c_void_p),('threshold',ctypes.c_float),('silence',ctypes.c_float),('speech',ctypes.c_float),('window',ctypes.c_int32),('max',ctypes.c_float)]
class Vad(ctypes.Structure):
 _fields_=[('silero',Silero),('rate',ctypes.c_int32),('threads',ctypes.c_int32),('provider',ctypes.c_void_p),('debug',ctypes.c_int32),('ten',Silero)]
class Segment(ctypes.Structure):
 _fields_=[('start',ctypes.c_int64),('samples',ctypes.c_void_p),('n',ctypes.c_int32)]
def layout(cls):return dict(size=ctypes.sizeof(cls),**{name:getattr(cls,name).offset for name,_ in cls._fields_})
abi=dict(pointer_bytes=ctypes.sizeof(ctypes.c_void_p),embedding_config=layout(Embedding),vad_config=layout(Vad),speech_segment=layout(Segment))
print(json.dumps(dict(schema=1,backend='sherpa-onnx',version=sherpa_onnx.__version__,sample_rate=16000,sample_count=len(samples),threshold=threshold,gain=gain,embedding=embedding,segments=segments,decisions=decisions,decision_inputs=decision_inputs,matrix_inputs=matrix_inputs,matrix_expected=matrix_expected,abi=abi),allow_nan=False))
`;

// A separate process exercises the pinned C ABI directly before the Rust
// binary. It catches layout/symbol/ownership mistakes independently of Rust
// compiler/linker problems and does not import the Python sherpa bindings.
const ABI_DEFINITIONS=ORACLE.slice(ORACLE.indexOf('class Embedding('),ORACLE.indexOf('print(json.dumps('));
const C_API_ORACLE=String.raw`
import ctypes,json,os,pathlib,sys,wave
import numpy as np
library_path,model_path,vad_path,audio_path,threshold,gain,decision_path=sys.argv[1:]
assert np.__version__=='2.3.0',np.__version__
threshold,gain=float(threshold),float(gain)
if os.name=='nt':dll_directory=os.add_dll_directory(str(pathlib.Path(library_path).parent))
lib=ctypes.CDLL(library_path)
${ABI_DEFINITIONS}
def bind(name,arguments,result):
 fn=getattr(lib,'SherpaOnnx'+name)
 fn.argtypes,fn.restype=arguments,result
 return fn
P=ctypes.c_void_p
F=ctypes.POINTER(ctypes.c_float)
version=bind('GetVersionStr',[],ctypes.c_char_p)().decode()
assert version=='2.0.1',version
create_extractor=bind('CreateSpeakerEmbeddingExtractor',[ctypes.POINTER(Embedding)],P)
destroy_extractor=bind('DestroySpeakerEmbeddingExtractor',[P],None)
create_stream=bind('SpeakerEmbeddingExtractorCreateStream',[P],P)
destroy_stream=bind('DestroyOnlineStream',[P],None)
accept_stream=bind('OnlineStreamAcceptWaveform',[P,ctypes.c_int32,F,ctypes.c_int32],None)
finish_stream=bind('OnlineStreamInputFinished',[P],None)
compute=bind('SpeakerEmbeddingExtractorComputeEmbedding',[P,P],F)
destroy_embedding=bind('SpeakerEmbeddingExtractorDestroyEmbedding',[F],None)
dimension=bind('SpeakerEmbeddingExtractorDim',[P],ctypes.c_int32)
create_vad=bind('CreateVoiceActivityDetector',[ctypes.POINTER(Vad),ctypes.c_float],P)
destroy_vad=bind('DestroyVoiceActivityDetector',[P],None)
accept_vad=bind('VoiceActivityDetectorAcceptWaveform',[P,F,ctypes.c_int32],None)
empty=bind('VoiceActivityDetectorEmpty',[P],ctypes.c_int32)
front=bind('VoiceActivityDetectorFront',[P],ctypes.POINTER(Segment))
destroy_segment=bind('DestroySpeechSegment',[ctypes.POINTER(Segment)],None)
pop=bind('VoiceActivityDetectorPop',[P],None)
flush=bind('VoiceActivityDetectorFlush',[P],None)
model_bytes,vad_bytes,cpu=model_path.encode(),vad_path.encode(),b'cpu'
pointer=lambda b:ctypes.cast(ctypes.c_char_p(b),P)
extractor=detector=None
try:
 cfg=Embedding(pointer(model_bytes),2,0,pointer(cpu))
 extractor=create_extractor(ctypes.byref(cfg))
 assert extractor,'C API extractor creation failed'
 dim=dimension(extractor)
 assert dim>0,dim
 config=Vad(Silero(pointer(vad_bytes),threshold,.3,.25,512,20),16000,1,pointer(cpu),0,Silero())
 detector=create_vad(ctypes.byref(config),60)
 assert detector,'C API VAD creation failed'
 def embed(samples):
  stream=create_stream(extractor)
  assert stream
  vector=None
  try:
   accept_stream(stream,16000,samples.ctypes.data_as(F),len(samples))
   finish_stream(stream)
   vector=compute(extractor,stream)
   assert vector,'C API embedding computation failed'
   values=np.ctypeslib.as_array(vector,shape=(dim,)).astype('float64')
   return (values/np.linalg.norm(values)).tolist()
  finally:
   if vector:destroy_embedding(vector)
   destroy_stream(stream)
 with wave.open(audio_path,'rb') as audio:
  assert audio.getframerate()==16000 and audio.getnchannels()==1 and audio.getsampwidth()==2
  samples=np.frombuffer(audio.readframes(audio.getnframes()),dtype='<i2').astype('float32')/32768
 embedding=embed(samples)
 segments=[]
 def drain():
  while not empty(detector):
   segment=front(detector)
   assert segment
   start,n=int(segment.contents.start),int(segment.contents.n)
   assert 0<=start and 0<n<=60*16000,(start,n)
   piece=np.ctypeslib.as_array(ctypes.cast(segment.contents.samples,F),shape=(n,)).copy()/gain
   destroy_segment(segment)
   pop(detector)
   segments.append(dict(start=start,sample_count=n,samples=piece.tolist(),embedding=embed(piece)))
 for offset in range(0,len(samples),512):
  block=samples[offset:offset+512]*gain
  accept_vad(detector,block.ctypes.data_as(F),len(block))
  drain()
 flush(detector)
 drain()
 decisions=[]
 for case in json.loads(pathlib.Path(decision_path).read_text()):
  count=case['sample_count']
  vector=np.array(embed(samples[:count]))
  score=float(vector@np.array(case['voiceprint']))
  seconds=count/16000
  decisions.append(dict(label=case['label'],seconds=seconds,score=score,me=None if seconds<1 else score>=case['threshold']))
 print(json.dumps(dict(schema=1,backend='sherpa-onnx',version=version,sample_rate=16000,sample_count=len(samples),threshold=threshold,gain=gain,embedding=embedding,segments=segments,decisions=decisions,abi=abi),allow_nan=False))
finally:
 if detector:destroy_vad(detector)
 if extractor:destroy_extractor(extractor)
`;

function embeddingComparison(reference,native,label){assert.equal(native.length,reference.length,`${label} dimension`);assert(reference.length>0,`${label} empty`);let max=0,dot=0,a2=0,b2=0;for(let i=0;i<reference.length;i++){assert(Number.isFinite(native[i])&&Number.isFinite(reference[i]),`${label} finite`);max=Math.max(max,Math.abs(native[i]-reference[i]));dot+=native[i]*reference[i];a2+=native[i]**2;b2+=reference[i]**2;}const cosine=dot/Math.sqrt(a2*b2);assert(max<=1e-12,`${label} max absolute difference ${max} exceeds 1e-12`);assert(cosine>=0.999999999999,`${label} cosine ${cosine} below 0.999999999999`);assert(Math.abs(Math.sqrt(b2)-1)<=1e-12,`${label} normalized`);return {max_absolute_difference:max,cosine};}
export function compare(reference,native){
  for(const key of ['schema','backend','version','sample_rate','sample_count','threshold','gain'])assert.deepEqual(native[key],reference[key],key);
  assert.deepEqual(native.abi,reference.abi,'pinned C ABI size/field offsets');
  const embedding=embeddingComparison(reference.embedding,native.embedding,'whole audio embedding');assert.equal(native.segments.length,reference.segments.length,'VAD segment count');assert(native.segments.length>0,'public speech must produce VAD segments');const segments=[];
  for(let i=0;i<reference.segments.length;i++){const a=reference.segments[i],b=native.segments[i];assert.equal(b.start,a.start,`VAD ${i} start`);assert.equal(b.sample_count,a.sample_count,`VAD ${i} sample count`);assert.equal(b.samples.length,a.samples.length);const af=new Float32Array(a.samples),bf=new Float32Array(b.samples),ab=new Uint32Array(af.buffer),bb=new Uint32Array(bf.buffer);for(let j=0;j<ab.length;j++)assert.equal(bb[j],ab[j],`VAD ${i} waveform bit ${j}`);segments.push({start:a.start,sample_count:a.sample_count,embedding:embeddingComparison(a.embedding,b.embedding,`VAD ${i} embedding`)});}
  if(reference.decisions){assert.equal(native.decisions?.length,reference.decisions.length,'boundary decision count');for(let i=0;i<reference.decisions.length;i++){const a=reference.decisions[i],b=native.decisions[i];assert.equal(b.label,a.label);assert.equal(b.seconds,a.seconds,`${a.label} duration`);assert(Math.abs(b.score-a.score)<=1e-12,`${a.label} score drift`);assert.equal(b.me,a.me,`${a.label} exact gate decision`);}}
  return {embedding,segments,exact_vad_waveforms:true,exact_boundary_decisions:reference.decisions?.length||0};
}
export function compareMatrices(reference,native){
  assert(native&&reference,'matrix probe result required');const differences={};
  function visit(a,b,label){if(Array.isArray(a)){assert(Array.isArray(b),`${label} array`);assert.equal(b.length,a.length,`${label} dimension`);a.forEach((value,i)=>visit(value,b[i],`${label}[${i}]`));}else{assert(Number.isFinite(a)&&Number.isFinite(b),`${label} finite`);const delta=Math.abs(a-b);assert(delta<=1e-12,`${label} matrix/mean/build difference ${delta}`);differences[label.split('[')[0]]=Math.max(differences[label.split('[')[0]]||0,delta);}}
  for(const field of ['matvec','gram','cross','mean','centre'])visit(reference[field],native[field],field);
  assert.deepEqual(native.near,reference.near,'exact symmetric-score threshold decisions');assert.deepEqual(native.kept,reference.kept,'exact matrix-vector threshold decisions');
  return {max_absolute_differences:differences,exact_threshold_masks:true};
}
export async function main(args=process.argv.slice(2)){
  if(args.includes('--help')){console.log('node voice/tests/native-model-differential.mjs --binary NATIVE_EXE [--python PYTHON_3_12] [--work-dir DIR] [--oracle-dir FIXED_BASELINE_VOICE_DIR] [--oracle-only]\nExplicit --model, --vad, --audio and --library inputs are also supported; every actual input hash is recorded.');return;}
  const work=path.resolve(option(args,'--work-dir')||'.migration-oracle/voice-model-differential');const {paths,python,env,platform,wheels}=await setup(args,work);
  const inputs=Object.fromEntries(Object.entries(paths).map(([key,file])=>[key,{filename:path.basename(file),sha256:hashFile(file),bytes:fs.statSync(file).size}]));
  const summary={schema:1,at:new Date().toISOString(),baseline_commit:manifest.baseline.commit,platform,python_wheels:wheels,inputs,tolerances:{embedding_max_absolute:1e-12,embedding_min_cosine:0.999999999999,vad_start:0,vad_sample_count:0,vad_waveform_float32_bits:0},cases:[]};
  const binary=option(args,'--binary')&&path.resolve(option(args,'--binary'));if(!args.includes('--oracle-only')&&!binary)throw Error('--binary is required (or explicitly choose --oracle-only, which cannot produce a parity PASS)');
  if(binary)summary.inputs.binary={filename:path.basename(binary),sha256:hashFile(binary),bytes:fs.statSync(binary).size};
  const report=path.join(work,'model-differential-summary.json');
  summary.status='running';fs.writeFileSync(report,JSON.stringify(summary,null,2)+'\n');
  try{
  for(const {threshold,gain} of [{threshold:0.35,gain:10},{threshold:0.5,gain:1}]){
    const label=`threshold-${threshold}-gain-${gain}`;const reference=JSON.parse(run(python,['-I','-c',ORACLE,paths.source,paths.embedding,paths.vad,paths.audio,String(threshold),String(gain)],env));fs.writeFileSync(path.join(work,`${label}-baseline.json`),JSON.stringify(reference));
    const decisionPath=path.join(work,`${label}-decision-inputs.json`);fs.writeFileSync(decisionPath,JSON.stringify(reference.decision_inputs));
    const matrixPath=path.join(work,`${label}-matrix-inputs.json`);fs.writeFileSync(matrixPath,JSON.stringify(reference.matrix_inputs));fs.writeFileSync(path.join(work,`${label}-matrix-baseline.json`),JSON.stringify(reference.matrix_expected));
    const cApi=JSON.parse(run(python,['-I','-c',C_API_ORACLE,paths.library,paths.embedding,paths.vad,paths.audio,String(threshold),String(gain),decisionPath],env));fs.writeFileSync(path.join(work,`${label}-c-api.json`),JSON.stringify(cApi));const c_api_comparison=compare(reference,cApi);
    const entry={label,c_api_status:'pass',c_api_comparison,reference_embedding_dimensions:reference.embedding.length,reference_vad_segments:reference.segments.length,status:'native-pending'};summary.cases.push(entry);
    if(args.includes('--oracle-only')){entry.status='native-not-run';continue;}
    const nativeEnv=nativeEnvironment(env);summary.native_path_empty=true;
    const native=JSON.parse(run(binary,['voice_model_probe','--model',paths.embedding,'--vad',paths.vad,'--audio',paths.audio,'--library',paths.library,'--blas',paths.blas,'--threshold',String(threshold),'--gain',String(gain),'--decisions',decisionPath,'--matrices',matrixPath],nativeEnv));fs.writeFileSync(path.join(work,`${label}-native.json`),JSON.stringify(native));Object.assign(entry,compare(reference,native),{matrix_comparison:compareMatrices(reference.matrix_expected,native.matrices),status:'pass'});
  }
  }catch(error){summary.status='fail';summary.failure={exit_status:error.exit_status??null,message:error.message.replaceAll(work,'<validation-work>')};fs.writeFileSync(report,JSON.stringify(summary,null,2)+'\n');throw error;}
  summary.status=args.includes('--oracle-only')?'reference-only-incomplete':'pass';fs.writeFileSync(report,JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.stack||String(error));process.exitCode=1;});
