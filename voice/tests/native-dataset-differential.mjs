// Original Parquet loader differential: native audio, no model or microphone.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {setup,download,nativeEnvironment} from './native-model-differential.mjs';
import {stageSndfile} from './native-audio-differential.mjs';
const assets=JSON.parse(fs.readFileSync(new URL('./eval-probe-assets.json',import.meta.url)));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const option=(a,n)=>a.includes(n)?a[a.indexOf(n)+1]:null;
function run(program,args,env,input){const r=spawnSync(program,args,{env,input,encoding:'utf8',timeout:300000,maxBuffer:32*1024*1024,windowsHide:true});assert.equal(r.status,0,r.stderr||r.error?.message);return r.stdout;}
const ORACLE=String.raw`
import json,pathlib,sys,types
import pyarrow as pa
import pyarrow.parquet as pq
source,audio,destination=sys.argv[1:]
if sys.platform=='win32':
 resource=types.ModuleType('resource');resource.RUSAGE_SELF=0;resource.getrusage=lambda _:types.SimpleNamespace(ru_maxrss=0);sys.modules['resource']=resource
scope=dict(__file__=source,__name__='frozen_eval_voice_models')
exec(compile(pathlib.Path(source).read_bytes(),source,'exec'),scope)
audio=pathlib.Path(audio).read_bytes();destination=pathlib.Path(destination);destination.mkdir(exist_ok=True)
cases=[]
types=[('int8',pa.int8(),[-128,7,0]),('int16',pa.int16(),[-32768,300,0]),('int32',pa.int32(),[-2147483648,7,0]),('int64',pa.int64(),[-9223372036854775808,7,0]),('uint8',pa.uint8(),[255,0,128]),('uint16',pa.uint16(),[65535,0,32768]),('uint32',pa.uint32(),[4294967295,0,2147483648]),('uint64',pa.uint64(),[18446744073709551615,0,9223372036854775808]),('string',pa.string(),['zeta','alpha','synthetic'])]
for label,dtype,speakers in types:
 directory=destination/label;directory.mkdir(exist_ok=True)
 # A short first-seen speaker is filtered out, and the first retained speaker
 # exceeds forty clips to exercise the original per-speaker cap.
 short='short' if label=='string' else 9
 ids=[short]+[speakers[1]]+[speakers[0]]*41+[speakers[1]]*14+[speakers[2]]*15
 table=pa.Table.from_arrays([pa.array(ids,type=dtype),pa.array([dict(bytes=audio)]*len(ids))],names=['speaker_id','audio'])
 pq.write_table(table.slice(0,20),directory/'a.parquet',compression='snappy')
 pq.write_table(table.slice(20),directory/'z.parquet',compression='snappy')
 (directory/'.hidden.parquet').write_bytes(b'invalid hidden input excluded by original glob')
 data=scope['load'](str(directory))
 def record(speaker):return dict(speaker=str(speaker),clips=len(data[speaker]),sample_counts=[len(c) for c in data[speaker]])
 cases.append(dict(type=label,directory=label,expected=dict(encounter=[record(s) for s in data],sorted=[record(s) for s in sorted(data)])))
print(json.dumps(cases))
`;
export async function main(args){
 const binary=path.resolve(option(args,'--binary')||'rust/target/debug/herdr-theme'+(process.platform==='win32'?'.exe':'')),work=path.resolve(option(args,'--work-dir')||'.migration-oracle/voice-model-differential');
 const context=await setup(args,work),{python,env,platform,paths}=context;
 const wheels=path.join(work,'eval','wheels');fs.mkdirSync(wheels,{recursive:true});
 for(const wheel of assets.platforms[platform])await download(wheel,path.join(wheels,wheel.filename));
 const requirements=path.join(work,'dataset-oracle-requirements.txt');fs.writeFileSync(requirements,assets.platforms[platform].map(w=>`${w.package} @ ${pathToFileURL(path.join(wheels,w.filename)).href} --hash=sha256:${w.sha256}`).join('\n')+'\n');
 run(python,['-I','-m','pip','--isolated','install','--no-deps','--no-index','--require-hashes','--no-cache-dir','-r',requirements],env);
 const library=await stageSndfile(context,work),folder=path.join(work,'dataset');fs.mkdirSync(folder,{recursive:true});
 const source=path.join(folder,'baseline-eval-voice-models.txt');await download(assets.sources['tests/eval_voice_models.py'],source);
 const reference=JSON.parse(run(python,['-I','-c',ORACLE,source,paths.audio,folder],env));fs.writeFileSync(path.join(folder,'baseline.json'),JSON.stringify(reference));
 const nativeEnv=nativeEnvironment(env,{HERDR_SNDFILE_LIBRARY:library});
 const summary={schema:1,platform,baseline_commit:assets.baseline_commit,source_sha256:hash(source),binary_sha256:hash(binary),library_sha256:hash(library),native_path_empty:true,cases:[],status:'incomplete'};
 for(const row of reference){const entry={type:row.type,status:'reference-only-incomplete'};
  if(!args.includes('--oracle-only')){try{const actual=JSON.parse(run(binary,['voice_probe'],nativeEnv,JSON.stringify({op:'dataset',args:{data_dir:path.join(folder,row.directory)}})));assert.deepEqual(actual,row.expected);entry.status='pass';entry.exact_loader_output=true;}catch(error){entry.status='fail';entry.error=error.message.replaceAll(work,'<validation-work>');}}
  summary.cases.push(entry);
 }
 summary.status=args.includes('--oracle-only')?'reference-only-incomplete':summary.cases.every(c=>c.status==='pass')?'pass':'fail';fs.writeFileSync(path.join(folder,'dataset-differential-summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));if(summary.status==='fail')process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(error=>{console.error(error.stack||error);process.exitCode=1;});
