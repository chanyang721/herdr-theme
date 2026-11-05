// External frozen evaluation oracle only; excluded from the installed plugin.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {setup,download,nativeEnvironment} from './native-model-differential.mjs';
import {stageSndfile} from './native-audio-differential.mjs';
const manifest=JSON.parse(fs.readFileSync(new URL('./eval-probe-assets.json',import.meta.url)));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const opt=(a,n)=>a.includes(n)?a[a.indexOf(n)+1]:null;
function child(program,args,env){const r=spawnSync(program,args,{env,encoding:'utf8',timeout:1800000,maxBuffer:64*1024*1024,windowsHide:true});return {exit:r.status,stdout:r.stdout||'',stderr:r.stderr||'',error:r.error?.message};}
function successful(program,args,env){const r=child(program,args,env);assert.equal(r.exit,0,`${path.basename(program)}: ${r.error||r.stderr}`);return r.stdout;}
const PREPARE=String.raw`
import io,json,pathlib,sys,wave
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
source,destination=sys.argv[1:]
with wave.open(source,'rb') as f:
 assert f.getframerate()==16000 and f.getnchannels()==1 and f.getsampwidth()==2
 pcm=np.frombuffer(f.readframes(f.getnframes()),dtype='<i2')[:80000].copy()
assert len(pcm)==80000
rows=[]
for speaker in [3,1,7,0,6,2,5,4]:
 for clip in range(16):
  samples=np.roll(pcm,speaker*997+clip*113)
  output=io.BytesIO()
  with wave.open(output,'wb') as f:
   f.setnchannels(1);f.setsampwidth(2);f.setframerate(16000);f.writeframes(samples.tobytes())
  rows.append(dict(speaker_id=speaker,audio=dict(bytes=output.getvalue(),path=None)))
pq.write_table(pa.Table.from_pylist(rows),destination,compression='NONE',use_dictionary=False)
print(json.dumps(dict(speakers=8,speaker_encounter_order=[3,1,7,0,6,2,5,4],clips_per_speaker=16,seconds_per_clip=5,total_seconds=640,identity='synthetic circular shifts of pinned public speech; not speaker accuracy evidence')))
`;
const ORACLE=String.raw`
import importlib.util,json,pathlib,runpy,sys,types
sys.stdout.reconfigure(encoding='utf-8',errors='strict')
sys.stderr.reconfigure(encoding='utf-8',errors='strict')
source,tool,*args=sys.argv[1:]
source=pathlib.Path(source)
# Neither unavailable platform telemetry nor microphone APIs participate in
# these frozen offline algorithms. All original source bytes remain unchanged.
if sys.platform=='win32':
 resource=types.ModuleType('resource');resource.RUSAGE_SELF=0
 resource.getrusage=lambda _:types.SimpleNamespace(ru_maxrss=0)
 sys.modules['resource']=resource
sounddevice=types.ModuleType('sounddevice')
def forbidden(*a,**k):raise AssertionError('offline oracle attempted microphone access')
for name in ['query_devices','InputStream','_initialize','_terminate']:setattr(sounddevice,name,forbidden)
sys.modules['sounddevice']=sounddevice
def load(name,relative):
 module=types.ModuleType(name);module.__file__=str(source/relative)
 sys.modules[name]=module
 exec(compile((source/relative).read_bytes(),module.__file__,'exec'),module.__dict__)
 return module
load('voice_settings','voice_settings.py.txt')
load('voice_policy','voice_policy.py.txt')
load('voicegate','voicegate.py.txt')
load('eval_voice_models','tests/eval_voice_models.py.txt')
if tool=='eval_voice_models' and args and args[0]!='--one':
 import subprocess
 original_run=subprocess.run
 bootstrap=sys.orig_argv[sys.orig_argv.index('-c')+1]
 def frozen_child(argv,*positional,**keywords):
  if len(argv)>1 and argv[0]==sys.executable and argv[1]==str(source/'tests/eval_voice_models.py.txt'):
   argv=[sys.executable,'-I','-c',bootstrap,str(source),'eval_voice_models',*argv[2:]]
  return original_run(argv,*positional,**keywords)
 subprocess.run=frozen_child
sys.argv=[str(source/('tests/'+tool+'.py.txt')),*args]
runpy.run_path(sys.argv[0],run_name='__main__')
`;
export function compareNumeric(expected,actual,at='value',stats={max_absolute_difference:0,compared_numeric_values:0,differing_numeric_values:0}){
 if(typeof expected==='number'){assert.equal(typeof actual,'number',at);assert.ok(Number.isFinite(actual),at);const delta=Math.abs(expected-actual);assert.ok(delta<=1e-12,`${at}: ${expected} != ${actual}`);stats.max_absolute_difference=Math.max(stats.max_absolute_difference,delta);stats.compared_numeric_values++;stats.differing_numeric_values+=delta!==0;}
 else if(Array.isArray(expected)){assert.ok(Array.isArray(actual),at);assert.equal(actual.length,expected.length,at);expected.forEach((v,i)=>compareNumeric(v,actual[i],`${at}[${i}]`,stats));}
 else if(expected&&typeof expected==='object'){assert.deepEqual(Object.keys(actual).sort(),Object.keys(expected).sort(),at);for(const k of Object.keys(expected))compareNumeric(expected[k],actual[k],`${at}.${k}`,stats);}
 else assert.equal(actual,expected,at);
 return stats;
}
export async function main(args){
 const binary=path.resolve(opt(args,'--binary')||'rust/target/debug/herdr-theme'+(process.platform==='win32'?'.exe':''));
 const work=path.resolve(opt(args,'--work-dir')||'.migration-oracle/voice-model-differential');
 const context=await setup(args,work),{paths,python,env,platform}=context;
 env.PYTHONIOENCODING='utf-8:strict';env.PYTHONUTF8='1';
 const evalWork=path.join(work,'eval');fs.mkdirSync(evalWork,{recursive:true});
 const temp=path.join(evalWork,'temp');fs.mkdirSync(temp,{recursive:true});env.TEMP=temp;env.TMP=temp;env.TMPDIR=temp;
 const source=path.join(evalWork,'frozen-source');
 for(const [name,asset] of Object.entries(manifest.sources)){const p=path.join(source,name+'.txt');fs.mkdirSync(path.dirname(p),{recursive:true});await download(asset,p);}
 const wheels=manifest.platforms[platform];assert.ok(wheels,platform);
 const wheelDir=path.join(evalWork,'wheels');fs.mkdirSync(wheelDir,{recursive:true});
 for(const wheel of wheels)await download(wheel,path.join(wheelDir,wheel.filename));
 const lock=path.join(evalWork,'requirements.txt');fs.writeFileSync(lock,wheels.map(w=>`${w.package} @ ${pathToFileURL(path.join(wheelDir,w.filename)).href} --hash=sha256:${w.sha256}`).join('\n')+'\n');
 successful(python,['-I','-m','pip','--isolated','install','--no-deps','--no-index','--require-hashes','--no-cache-dir','-r',lock],env);
 const sndfile=await stageSndfile(context,work);
 const dataset=path.join(evalWork,'data');fs.mkdirSync(dataset,{recursive:true});const parquet=path.join(dataset,'public-speech.parquet');
 const description=JSON.parse(successful(python,['-I','-c',PREPARE,paths.audio,parquet],env));
 const models=path.join(evalWork,'models');fs.mkdirSync(models,{recursive:true});
 for(const key of ['embedding','vad'])fs.copyFileSync(paths[key],path.join(models,path.basename(paths[key])));
 const nativeEnv=nativeEnvironment(env,{HERDR_SHERPA_LIBRARY:paths.library,HERDR_SNDFILE_LIBRARY:sndfile});
 const inputs={binary_sha256:hash(binary),audio_sha256:hash(paths.audio),parquet_sha256:hash(parquet),embedding_sha256:hash(paths.embedding),vad_sha256:hash(paths.vad),sherpa_library_sha256:hash(paths.library),blas_sha256:hash(paths.blas),sndfile_sha256:hash(sndfile)};
 const referenceKey=crypto.createHash('sha256').update(JSON.stringify({...inputs,binary_sha256:undefined,sndfile_sha256:undefined,sources:manifest.sources,wheels,model_wheels:context.wheels})).digest('hex');
 const report={schema:1,at:new Date().toISOString(),platform,baseline_commit:manifest.baseline_commit,inputs,dataset:description,source_checksums:Object.fromEntries(Object.entries(manifest.sources).map(([name,item])=>[name,item.sha256])),external_wheels:[...context.wheels,...wheels.map(({package:p,filename,sha256})=>({package:p,filename,sha256}))],limitations:['Synthetic identities exercise algorithms, not speaker discrimination accuracy.','Time and RSS telemetry are measured independently and cannot be numerically equal.','Windows frozen oracle has a resource telemetry shim and a rejecting sounddevice import shim; original Unix-only CLI availability is not established.','External oracle stdout uses explicitly requested UTF-8 encoding.'],cases:[],status:'incomplete'};
 const summaryPath=path.join(evalWork,'eval-differential-summary.json');
 if(fs.existsSync(summaryPath)){const previous=JSON.parse(fs.readFileSync(summaryPath));if(JSON.stringify(previous.inputs)===JSON.stringify(report.inputs))report.cases=previous.cases;}
 report.native_path_empty=true;
 const save=()=>fs.writeFileSync(summaryPath,JSON.stringify(report,null,2)+'\n');save();
 const selected=opt(args,'--only');
 for(const name of ['models','vad','chain','models_cli']){
  if(selected&&selected!==name)continue;
  const tool={models:'eval_voice_models',vad:'eval_voice_vad',chain:'eval_gate_chain',models_cli:'eval_voice_models_main'}[name],originalTool=name==='models_cli'?'eval_voice_models':tool,command={models:'voice_eval_models',vad:'voice_eval_vad',chain:'voice_eval_gate_chain',models_cli:'voice_eval_models'}[name];
  const baselineOut=path.join(evalWork,`${name}-baseline-result.json`),nativeOut=path.join(evalWork,`${name}-native-result.json`);
  const originalArgs=name==='models'?['--one',dataset,path.join(models,path.basename(paths.embedding))]:name==='vad'?[dataset,path.join(models,'silero_vad.onnx'),baselineOut]:name==='models_cli'?[dataset,models,baselineOut]:[dataset,models];
  const nativeArgs=name==='models'?originalArgs:name==='vad'?[dataset,path.join(models,'silero_vad.onnx'),nativeOut]:name==='models_cli'?[dataset,models,nativeOut]:originalArgs;
  const baselineCli=path.join(evalWork,`${name}-baseline-cli.json`),baselineMarker=path.join(evalWork,`${name}-baseline-inputs.json`);let baseline;
  if(args.includes('--reuse-oracle')&&fs.existsSync(baselineMarker)){const saved=JSON.parse(fs.readFileSync(baselineMarker));assert.equal(saved.key,referenceKey,'oracle cache input mismatch');assert.equal(saved.cli_sha256,hash(baselineCli),'oracle CLI cache changed');if(['vad','models_cli'].includes(name))assert.equal(saved.result_sha256,hash(baselineOut),'oracle result cache changed');baseline=JSON.parse(fs.readFileSync(baselineCli));console.log(`Reusing verified frozen ${tool}`);}
  else{console.log(`Running frozen ${tool}`);baseline=child(python,['-I','-c',ORACLE,source,originalTool,...originalArgs],env);fs.writeFileSync(baselineCli,JSON.stringify(baseline,null,2));if(baseline.exit===0)fs.writeFileSync(baselineMarker,JSON.stringify({key:referenceKey,cli_sha256:hash(baselineCli),...(['vad','models_cli'].includes(name)?{result_sha256:hash(baselineOut)}:{})}));}
  if(args.includes('--oracle-only')){report.cases=report.cases.filter(c=>c.tool!==tool);report.cases.push({tool,baseline_exit:baseline.exit,status:baseline.exit===0?'reference-only-incomplete':'fail'});save();assert.equal(baseline.exit,0,baseline.stderr);continue;}
  console.log(`Running native ${command}`);const native=child(binary,[command,...nativeArgs],nativeEnv);fs.writeFileSync(path.join(evalWork,`${name}-native-cli.json`),JSON.stringify(native,null,2));
  const row={tool,baseline_exit:baseline.exit,native_exit:native.exit,status:'fail'};
  try{assert.equal(baseline.exit,0,baseline.stderr);assert.equal(native.exit,0,native.stderr);assert.equal(native.stderr,baseline.stderr,'evaluation stderr');row.exact_stderr=true;
   if(name==='chain'){assert.equal(native.stdout,baseline.stdout,'gate-chain stdout');row.exact_stdout=true;}
   else{const expected=JSON.parse(name==='models'?baseline.stdout:fs.readFileSync(baselineOut)),actual=JSON.parse(name==='models'?native.stdout:fs.readFileSync(nativeOut));
    if(name==='models'||name==='models_cli'){const expectedRows=name==='models'?[expected]:expected,actualRows=name==='models'?[actual]:actual;assert.equal(actualRows.length,expectedRows.length);for(let i=0;i<actualRows.length;i++)for(const k of ['ms_per_3s','peak_rss_mb','after_load_rss_mb']){assert.ok(Number.isFinite(actualRows[i][k])&&actualRows[i][k]>=0,k);delete expectedRows[i][k];delete actualRows[i][k];}}
    Object.assign(row,compareNumeric(expected,actual));row.numeric_metrics='all within declared 1e-12';
    if(name==='vad'){row.exact_stdout=native.stdout===baseline.stdout;assert.ok(row.exact_stdout,'VAD stdout');row.exact_result_file=fs.readFileSync(nativeOut).equals(fs.readFileSync(baselineOut));assert.ok(row.exact_result_file,'VAD result file bytes');}
    if(name==='models_cli'){
     const stdout=s=>s.replace(/ \d+ ms \d+ MB(?=\r?\n|$)/g,' <timing> ms <rss> MB');
     assert.equal(stdout(native.stdout),stdout(baseline.stdout),'model outer CLI stdout excluding telemetry');row.exact_nontelemetry_stdout=true;
     const file=s=>s.replace(/("(?:ms_per_3s|peak_rss_mb|after_load_rss_mb)":\s*)-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,'$1<telemetry>');
     assert.equal(file(fs.readFileSync(nativeOut,'utf8')),file(fs.readFileSync(baselineOut,'utf8')),'model result file bytes excluding telemetry');row.exact_nontelemetry_result_file=true;
     row.empty_model_inputs=[];
     for(const kind of ['empty-directory','missing-directory','not-directory']){
      const input=path.join(evalWork,kind);if(kind==='empty-directory')fs.mkdirSync(input,{recursive:true});if(kind==='not-directory')fs.writeFileSync(input,'synthetic non-directory');
      const before=path.join(evalWork,`${kind}-baseline-out.json`),after=path.join(evalWork,`${kind}-native-out.json`);
      for(const out of [before,after])if(fs.existsSync(out))fs.unlinkSync(out);
      if(kind==='not-directory')for(const out of [before,after])fs.writeFileSync(out,'synthetic preexisting output');
      const originalEmpty=child(python,['-I','-c',ORACLE,source,'eval_voice_models',dataset,input,before],env),nativeEmpty=child(binary,[command,dataset,input,after],nativeEnv);
      assert.equal(originalEmpty.exit,0,originalEmpty.stderr);assert.deepEqual(nativeEmpty,originalEmpty,`${kind} CLI`);
      assert.equal(fs.existsSync(after),fs.existsSync(before),`${kind} output creation`);if(fs.existsSync(before))assert.deepEqual(fs.readFileSync(after),fs.readFileSync(before),`${kind} existing output preservation`);
      row.empty_model_inputs.push({kind,exit:0,exact_stdout_stderr:true,preserved_output_state:true});
     }
    }
   }row.status='pass';
  }catch(error){row.error=error.message;}
  report.cases=report.cases.filter(c=>c.tool!==tool);report.cases.push(row);save();console.log(`${tool}: ${row.status}${row.error?' '+row.error:''}`);
 }
 report.status=args.includes('--oracle-only')?'reference-only-incomplete':report.cases.length===4&&report.cases.every(c=>c.status==='pass')?'pass':report.cases.some(c=>c.status==='fail')?'fail':'partial';save();
 if(report.status!=='pass'&&!args.includes('--oracle-only'))process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(error=>{console.error(error.stack||error);process.exitCode=1;});
