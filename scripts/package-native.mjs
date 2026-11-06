// Produce a portable, traceable CI artifact; never install or start a service.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const args=process.argv.slice(2);
const option=name=>args[args.indexOf(name)+1];
if(!args.includes('--binary')||!args.includes('--out'))throw Error('--binary and --out are required');
const binary=path.resolve(option('--binary')),out=path.resolve(option('--out'));
const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(!/^[a-f0-9]{40}$/.test(commit))throw Error('Full source commit required');
execFileSync('git',['diff','--exit-code','HEAD'],{stdio:'pipe'});
fs.mkdirSync(out,{recursive:true});
const files=[];
function copy(source,relative){
  const target=path.join(out,relative);fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);
  const bytes=fs.readFileSync(target);files.push({path:relative,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
}
copy(binary,path.basename(binary));
for(const [source,relative] of [
  ['LICENSE','licenses/theme-LICENSE'],
  ['rust/vendor/pocketfft/LICENSE.md','licenses/pocketfft-LICENSE.md'],
  ['rust/licenses/numpy.txt','licenses/numpy-LICENSE.txt'],
  ['rust/vendor/pocketfft/provenance.json','provenance/pocketfft.json'],
  ['voice/native-blas-assets.json','provenance/native-blas-assets.json'],
  ['voice/native-sndfile-assets.json','provenance/native-sndfile-assets.json'],
  ['voice/tests/model-probe-assets.json','provenance/model-probe-assets.json'],
  ['voice/docs/manual-macos-acceptance.md','manual-macos-acceptance.md'],
])copy(source,relative);
const receipt={schema:1,source_commit:commit,source_tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),platform:process.platform,architecture:process.arch,rustc:execFileSync('rustc',['-vV'],{encoding:'utf8'}).trim(),files};
fs.writeFileSync(path.join(out,'artifact-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
if(args.includes('--archive')){
  const archive=path.resolve(option('--archive'));
  if(fs.existsSync(archive)||fs.existsSync(archive+'.sha256'))throw Error('Archive already exists');
  // A tar preserves Unix execute bits through GitHub's surrounding artifact ZIP.
  // Git Bash's GNU tar interprets a Windows drive prefix as a remote host.
  const tar=process.platform==='win32'?path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe'):'tar';
  execFileSync(tar,['-czf',archive,'-C',out,'.']);
  const digest=crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(archive+'.sha256',`${digest}  ${path.basename(archive)}\n`,{flag:'wx'});
}
console.log(JSON.stringify({source_commit:commit,platform:receipt.platform,architecture:receipt.architecture,files:files.length}));
