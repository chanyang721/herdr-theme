// Verify the release source/bundle has no theme-owned interpreter entry points.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
// Documentation asset generation is not installed or packaged as a runtime entry
// point. Keep this exact-path exception narrow; other Python remains forbidden.
const documentationTools=new Set(['scripts/media/build_readme_walkthrough.py']);
const errors=[];
for(const path of files){
  if(documentationTools.has(path))continue;
  if(path.endsWith('.py'))errors.push(`${path}: Python source remains in the release`);
  if(/\.(gif|png|jpg|ico|pdf|woff2?)$/.test(path))continue;
  let text;try{text=readFileSync(path,'utf8');}catch{continue;}
  if(/^#!.*\bpython[\d.]*(?:\s|$)/m.test(text))errors.push(`${path}: Python shebang`);
}
if(errors.length){console.error(errors.join('\n'));process.exit(1);}
console.log(`Native release inventory: ${files.length} tracked files, no runtime Python files or interpreter entry points (documentation tooling excluded).`);
