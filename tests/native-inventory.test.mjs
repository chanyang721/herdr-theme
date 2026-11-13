import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync, spawnSync} from 'node:child_process';
const checker=fileURLToPath(new URL('../scripts/check-native.mjs',import.meta.url));
function check(files){
  const cwd=mkdtempSync(path.join(tmpdir(),'native-inventory-'));
  try{
    execFileSync('git',['init','--quiet'],{cwd});
    for(const [name,text] of Object.entries(files)){
      const target=path.join(cwd,name);
      mkdirSync(path.dirname(target),{recursive:true});
      writeFileSync(target,text);
    }
    execFileSync('git',['add','.'],{cwd});
    return spawnSync(process.execPath,[checker],{cwd,encoding:'utf8'});
  }finally{rmSync(cwd,{recursive:true,force:true});}
}
test('native inventory permits only the documentation walkthrough generator',()=>{
  const result=check({'scripts/media/build_readme_walkthrough.py':'#!/usr/bin/env python3\n'});
  assert.equal(result.status,0,result.stderr);
});
test('native inventory rejects adjacent and runtime Python despite the documentation exception',()=>{
  const result=check({'scripts/media/build_readme_walkthrough.py':'#!/usr/bin/env python3\n','scripts/media/other.py':'pass\n','scripts/runtime.py':'pass\n'});
  assert.equal(result.status,1);
  assert.match(result.stderr,/scripts\/media\/other.py: Python source/);
  assert.match(result.stderr,/scripts\/runtime.py: Python source/);
});
test('native inventory still rejects extensionless Python interpreter entry points',()=>{
  const result=check({'scripts/runtime':'#!/usr/bin/env python3\n'});
  assert.equal(result.status,1);
  assert.match(result.stderr,/Python shebang/);
});
