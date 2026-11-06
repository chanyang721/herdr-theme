import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,chmodSync} from 'node:fs';
import {resolve,join,relative,dirname,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const shell=['sh','C:/Program Files/Git/bin/bash.exe'].find(p=>spawnSync(p,['-c','exit 0']).status===0);
const hasShell=!!shell;
const shas='0'.repeat(40);
function cleanEnv(extra={}){const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('PREPUSH_')||['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_PREFIX','GIT_COMMON_DIR','GIT_OBJECT_DIRECTORY'].includes(k))delete env[k];if(shell?.includes('/')){const k=Object.keys(env).find(k=>k.toLowerCase()==='path')||'PATH';env[k]=dirname(shell)+delimiter+(env[k]||'');}return {...env,...extra};}
function git(cwd,args){const r=spawnSync('git',args,{cwd,env:cleanEnv(),encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout.trim();}
function sandbox(t){mkdirSync(join(root,'artifacts'),{recursive:true});const base=mkdtempSync(join(root,'artifacts','hook-native-'));t.after(()=>{const rel=relative(join(root,'artifacts'),base);assert(!rel.startsWith('..')&&!rel.startsWith('/')&&rel.length>0);rmSync(base,{recursive:true,force:true});});return base;}
function init(repo,hook){mkdirSync(join(repo,'scripts'),{recursive:true});writeFileSync(join(repo,'scripts/pre-push'),hook);git(repo,['init','-q']);git(repo,['add','-A']);git(repo,['-c','core.hooksPath=.no-hooks','-c','user.name=t','-c','user.email=t@example.invalid','commit','-qm','fixture']);return git(repo,['rev-parse','HEAD']);}
function run(t,mode,extra={}){const base=sandbox(t),repo=join(base,'repo');mkdirSync(join(repo,'fakes'),{recursive:true});
const fakes={
 'cygpath.sh':'echo "cygpath $*" >> calls.log\n[ "$HOOK_FAKE_MODE" = cygpath_fail ] && exit 9\necho "$2"\n',
 'npm.sh':'echo "npm $*" >> calls.log\nif [ "$HOOK_FAKE_MODE" = zero_tests ]; then echo "ℹ pass 0"; else echo "ℹ pass 153"; fi\n',
 'cargo.sh':'echo "cargo $*" >> calls.log\nif [ "$1" = test ]; then if [ "$HOOK_FAKE_MODE" = zero_rust ]; then echo "test result: ok. 0 passed; 0 failed;"; else echo "test result: ok. 71 passed; 0 failed;"; fi; fi\n',
};for(const [name,body]of Object.entries(fakes))writeFileSync(join(repo,'fakes',name),body);
let hook=readFileSync(join(root,'scripts/pre-push'),'utf8');for(const [from,to]of [
 ['CYG=cygpath  # @tool-cygpath',"CYG='sh fakes/cygpath.sh'"],
 ['CARGO=cargo  # @tool-cargo',"CARGO='sh fakes/cargo.sh'"],
 ['NPM=npm  # @tool-npm',"NPM='sh fakes/npm.sh'"],
 [': # @tool-env','printf "PYTHONPATH=%s\\n" "${PYTHONPATH-unset}" >> calls.log'],
]){assert.equal(hook.split(from).length,2,from);hook=hook.replace(from,to);}
mkdirSync(join(repo,'mods/sixfold-desk'),{recursive:true});mkdirSync(join(repo,'mods/sixfold-new-space'),{recursive:true});writeFileSync(join(repo,'mods/sixfold-desk/main.js'),'');writeFileSync(join(repo,'mods/sixfold-new-space/main.js'),'');
const sha=init(repo,hook);const result=spawnSync(shell,['scripts/pre-push'],{cwd:repo,env:cleanEnv({HOOK_FAKE_MODE:mode,...extra}),encoding:'utf8',input:`refs/heads/main ${sha} refs/heads/main ${shas}\n`});const log=join(repo,'calls.log');return {result,calls:existsSync(log)?readFileSync(log,'utf8').split(/\r?\n/):[]};}
test('native hook stops before checks when path conversion fails',{skip:!hasShell},t=>{const{result,calls}=run(t,'cygpath_fail');assert.notEqual(result.status,0);assert.match(result.stderr,/cannot convert/);assert(calls.some(c=>c.startsWith('cygpath ')));assert(!calls.some(c=>/^(npm|cargo) /.test(c)));});
test('native hook rejects a zero JavaScript run',{skip:!hasShell},t=>{const{result,calls}=run(t,'zero_tests');assert.notEqual(result.status,0);assert.match(result.stderr,/0 tests passed/);assert(calls.some(c=>c.startsWith('npm ')));});
test('native hook rejects a zero Rust run',{skip:!hasShell},t=>{const{result,calls}=run(t,'zero_rust');assert.notEqual(result.status,0);assert.match(result.stderr,/0 Rust tests passed/);assert(calls.some(c=>c.startsWith('cargo test')));});
test('native hook needs no interpreter and drops caller Python settings',{skip:!hasShell},t=>{const{result,calls}=run(t,'ok',{PYTHONPATH:'/shadow/unittest'});assert.equal(result.status,0,result.stderr);assert(calls.includes('PYTHONPATH=unset'));assert(calls.some(c=>c.startsWith('cargo test')));assert(!calls.some(c=>c.startsWith('py ')));});
test('PREPUSH overrides cannot bypass an actual push',{skip:!hasShell},t=>{const base=sandbox(t),repo=join(base,'repo'),bare=join(base,'remote.git');mkdirSync(repo);init(repo,readFileSync(join(root,'scripts/pre-push'),'utf8'));git(base,['init','--bare','-q',bare]);git(repo,['remote','add','origin',bare]);const hook=join(repo,'.git/hooks/pre-push');writeFileSync(hook,'#!/bin/sh\nexec sh scripts/pre-push "$@"\n');chmodSync(hook,0o755);const result=spawnSync('git',['push','origin','HEAD:refs/heads/main'],{cwd:repo,env:cleanEnv({PREPUSH_PY:'true',PREPUSH_CYGPATH:'true'}),encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,/PREPUSH_/);assert.equal(git(repo,['ls-remote',bare,'refs/heads/main']),'');});
