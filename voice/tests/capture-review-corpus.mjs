// Test-only external NumPy/CPython oracle. Product binaries never invoke Python.
// Uses an already prepared NumPy 2.3.0 environment; no installation or network.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const baseline='8c5b71d2f1074bb5d1d831fa395617bf4ae2abc8';
const args=process.argv.slice(2),option=n=>args.includes(n)?args[args.indexOf(n)+1]:null;
const python=option('--python');assert(python,'--python must name an external CPython 3.12 environment with NumPy 2.3.0');
const work=path.resolve(option('--workdir')||'.migration-oracle/voice-review-corpus');fs.mkdirSync(work,{recursive:true});
const source=execFileSync('git',['show',`${baseline}:voice/voice_settings.py`]);fs.writeFileSync(path.join(work,'voice_settings.py'),source);
const program=String.raw`
import sys,json,struct,os
import numpy as np
from pathlib import Path
import voice_settings as settings
assert sys.version_info[:2] == (3,12)
assert np.__version__ == '2.3.0'
def bits(x): return struct.pack('>d',float(x)).hex()
rng=np.random.default_rng(9284)
arrays=[[0.0],[-0.0],[0.,-0.],[-0.,-0.],[1.,2.],[1e16,1.,-1e16],[1e-250,2e-250],[-1e308,1e308],[1.0000000000000002,1.0000000000000004]]
arrays += [(rng.standard_normal(int(rng.integers(1,30)))*10.**int(rng.integers(-180,180))).tolist() for _ in range(90)]
qs=[0.,0.05,0.1,0.2,0.5,0.8,0.9,0.95,1.]
rows=[]
for values in arrays:
    x=np.asarray(values,dtype=np.float64)
    rows.append({'values':values,'percentiles':[{'q':q,'bits':bits(np.quantile(x,q))} for q in qs],'median_bits':bits(np.median(x)),'value_bits':[bits(v) for v in values]})
raws=[{}, {'max_chars_per_second':20,'vad_gain':3,'short_score':True}, {'auto_send_devices':['', ' ', None, True, False, 1e-8,1e20,1e16, ["a'b",'"'],{'x':1e-8}],'devices':{'a':{},'b':False},'unknown':1}]
setting_rows=[]
target=Path(__file__).parent/'settings.json';os.environ['HERDR_VOICE_SETTINGS']=str(target)
for raw in raws:
    target.write_text(json.dumps(raw),encoding='ascii');got=settings.load();setting_rows.append({'raw':raw,'merged':got,'types':{k:type(v).__name__ for k,v in got.items()}})
settings.update(lambda data:data.update({'z':{'b':2,'a':1},'a':1e-8}))
print(json.dumps({'quantiles':rows,'settings':setting_rows,'updated_bytes_hex':target.read_bytes().hex()}))
`;
fs.writeFileSync(path.join(work,'capture.py'),program);
const raw=execFileSync(path.resolve(python),[path.join(work,'capture.py')],{encoding:'utf8',timeout:30000,windowsHide:true}).trim();
const output=JSON.parse(raw);
const oracle={baseline,numpy:'2.3.0',voice_settings_sha256:crypto.createHash('sha256').update(source).digest('hex')};
// Preserve CPython's number lexemes (10.0 vs 10 and negative zero). A Node
// parse/stringify round trip would silently discard this part of the oracle.
const report='{"oracle":'+JSON.stringify(oracle)+','+raw.slice(1);
const target=path.resolve(option('--out')||path.join(work,'corpus.json'));fs.writeFileSync(target,report+'\n');
console.log(JSON.stringify({output:target,quantiles:output.quantiles.length*9,medians:output.quantiles.length,settings:output.settings.length}));
