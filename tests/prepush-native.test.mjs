import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,rmSync,chmodSync} from 'node:fs';
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
// The fakes log to one absolute file, so a run checked in a throwaway worktree still records its calls.
// Fake cargo reports its executables the way cargo's JSON does: the right one, a test-mode build of the
// same binary and the fixture binary, with Windows-style escaped separators.
const fakeCargo=String.raw`echo "cargo $*" >> "$HOOK_LOG"
[ "$1" = test ] || exit 0
lock=$(dirname "$CARGO_TARGET_DIR")/prepush-lock
[ -f "$lock/pid" ] && echo "cargo held $(cat "$lock/pid")" >> "$HOOK_LOG"
[ -e "$CARGO_TARGET_DIR/old" ] && echo "cargo saw old" >> "$HOOK_LOG"
if [ "$HOOK_FAKE_MODE" = zero_rust ]; then echo "test result: ok. 0 passed; 0 failed;"; else echo "test result: ok. 71 passed; 0 failed;"; fi
[ "$HOOK_FAKE_MODE" = no_bin ] && exit 0
mkdir -p "$CARGO_TARGET_DIR/debug" && : > "$CARGO_TARGET_DIR/debug/herdr-theme"
[ "$HOOK_FAKE_MODE" = no_artifact ] && exit 0
d=$CARGO_TARGET_DIR/debug
[ -n "$CARGO_BUILD_TARGET" ] && d=$CARGO_TARGET_DIR/$CARGO_BUILD_TARGET/debug
mkdir -p "$d/deps" && : > "$d/herdr-theme" && : > "$d/deps/herdr_theme-1" && : > "$d/herdr-theme-test-fixture"
[ "$HOOK_FAKE_MODE" = big ] && head -c 8192 /dev/zero > "$d/big"
j() { printf '%s' "$1" | sed 's|/|\\\\|g'; }
a() { echo "{\"reason\":\"compiler-artifact\",\"target\":{\"kind\":[\"bin\"],\"crate_types\":[\"bin\"],\"name\":\"$1\",\"test\":true},\"profile\":{\"debuginfo\":2,\"test\":$2},\"executable\":\"$(j "$3")\",\"fresh\":false}"; }
a herdr-theme false "$d/herdr-theme"
a herdr-theme true "$d/deps/herdr_theme-1"
a herdr-theme-test-fixture false "$d/herdr-theme-test-fixture"
echo '{"reason":"build-finished","success":true}'
`;
const fakeNpm=String.raw`echo "npm $*" >> "$HOOK_LOG"
echo "bin $HERDR_THEME_BIN" >> "$HOOK_LOG"
lock=$(dirname "$CARGO_TARGET_DIR")/prepush-lock
[ -f "$lock/pid" ] && echo "npm held $(cat "$lock/pid")" >> "$HOOK_LOG"
if [ "$HOOK_FAKE_MODE" = zero_tests ]; then echo "ℹ pass 0"; else echo "ℹ pass 153"; fi
`;
// opt.subs: more marked lines to replace; opt.nonHead: push the first of two commits (throwaway worktree);
// opt.before(repo): set up state; opt.wrap: shell command run instead of the hook (it calls the hook itself).
function run(t,mode,extra={},opt={}){const base=sandbox(t),repo=join(base,'repo');mkdirSync(join(repo,'fakes'),{recursive:true});
const fakes={
 'cygpath.sh':'echo "cygpath $*" >> "$HOOK_LOG"\n[ "$HOOK_FAKE_MODE" = cygpath_fail ] && exit 9\necho "$2"\n',
 'npm.sh':fakeNpm,
 'cargo.sh':fakeCargo,
};for(const [name,body]of Object.entries(fakes))writeFileSync(join(repo,'fakes',name),body);
let hook=readFileSync(join(root,'scripts/pre-push'),'utf8');for(const [from,to]of [
 ['CYG=cygpath  # @tool-cygpath',"CYG='sh fakes/cygpath.sh'"],
 ['CARGO=cargo  # @tool-cargo',"CARGO='sh fakes/cargo.sh'"],
 ['NPM=npm  # @tool-npm',"NPM='sh fakes/npm.sh'"],
 [': # @tool-env','printf "PYTHONPATH=%s\\n" "${PYTHONPATH-unset}" >> "$HOOK_LOG"'],
 ...(opt.subs||[]),
]){assert.equal(hook.split(from).length,2,from);hook=hook.replace(from,to);}
mkdirSync(join(repo,'mods/sixfold-desk'),{recursive:true});mkdirSync(join(repo,'mods/sixfold-new-space'),{recursive:true});writeFileSync(join(repo,'mods/sixfold-desk/main.js'),'');writeFileSync(join(repo,'mods/sixfold-new-space/main.js'),'');
const sha=init(repo,hook);
if(opt.nonHead){writeFileSync(join(repo,'later.txt'),'later\n');git(repo,['add','-A']);git(repo,['-c','core.hooksPath=.no-hooks','-c','user.name=t','-c','user.email=t@example.invalid','commit','-qm','later']);}
opt.before?.(repo);
const log=join(repo,'calls.log').replace(/\\/g,'/');
const result=spawnSync(shell,opt.wrap?['-c',opt.wrap]:['scripts/pre-push'],{cwd:repo,env:cleanEnv({HOOK_FAKE_MODE:mode,HOOK_LOG:log,...extra}),encoding:'utf8',input:`refs/heads/main ${sha} refs/heads/main ${shas}\n`});return {result,repo,calls:existsSync(log)?readFileSync(log,'utf8').split(/\r?\n/):[]};}
const capSub=kib=>['TARGET_CAP_KIB=8388608  # @tool-target-cap',`TARGET_CAP_KIB=${kib}  #`];
const waitSub=s=>['LOCK_WAIT_S=3600  # @tool-lock-wait',`LOCK_WAIT_S=${s}  #`];
test('native hook stops before checks when path conversion fails',{skip:!hasShell},t=>{const{result,calls}=run(t,'cygpath_fail');assert.notEqual(result.status,0);assert.match(result.stderr,/cannot convert/);assert(calls.some(c=>c.startsWith('cygpath ')));assert(!calls.some(c=>/^(npm|cargo) /.test(c)));});
test('native hook rejects a zero JavaScript run',{skip:!hasShell},t=>{const{result,calls}=run(t,'zero_tests');assert.notEqual(result.status,0);assert.match(result.stderr,/0 tests passed/);assert(calls.some(c=>c.startsWith('npm ')));});
test('native hook gives the JavaScript tests the executable cargo test built',{skip:!hasShell},t=>{const{result,calls,repo}=run(t,'ok');assert.equal(result.status,0,result.stderr);const order=calls.filter(c=>/^(npm|cargo) test/.test(c)).map(c=>c.split(' ')[0]);assert.deepEqual(order,['cargo','npm']);assert(calls.some(c=>/^bin .*prepush-target\/debug\/herdr-theme$/.test(c)),calls.join('\n'));assert(calls.some(c=>c.startsWith('cargo test')&&c.includes('--message-format=json-render-diagnostics')),calls.join('\n'));assert(!result.stderr.includes('"reason":'),result.stderr);assert(existsSync(join(repo,'.git/prepush-target/debug/herdr-theme')),'a build under the cap is kept');});
test('native hook takes the executable from cargo output when a target triple moves it',{skip:!hasShell},t=>{const{result,calls}=run(t,'ok',{CARGO_BUILD_TARGET:'x86_64-test-triple'});assert.equal(result.status,0,result.stderr);const bins=calls.filter(c=>c.startsWith('bin '));assert.equal(bins.length,1,calls.join('\n'));assert.match(bins[0],/prepush-target\/x86_64-test-triple\/debug\/herdr-theme$/);});
test('native hook does not fall back to an older debug executable cargo did not report',{skip:!hasShell},t=>{const{result,calls}=run(t,'no_artifact');assert.notEqual(result.status,0);assert.match(result.stderr,/built no herdr-theme executable/);assert(!calls.some(c=>c.startsWith('npm ')));});
test('native hook holds one clone lock through both suites and releases it',{skip:!hasShell},t=>{const{result,calls,repo}=run(t,'ok');assert.equal(result.status,0,result.stderr);const held=k=>calls.find(c=>c.startsWith(k+' held '))?.slice(k.length+6);assert(held('cargo'),calls.join('\n'));assert.equal(held('npm'),held('cargo'));assert(!existsSync(join(repo,'.git/prepush-lock')));});
test('native hook waits for a running push of the same clone and does not take its lock',{skip:!hasShell},t=>{const{result,calls}=run(t,'ok',{},{subs:[waitSub(2)],wrap:'mkdir .git/prepush-lock; sleep 30 >/dev/null 2>&1 & h=$!; echo $h > .git/prepush-lock/pid; sh scripts/pre-push; rc=$?; echo "after $(cat .git/prepush-lock/pid) $h" >> "$HOOK_LOG"; kill $h; exit $rc'});assert.notEqual(result.status,0);assert.match(result.stderr,/waiting for another push/);assert.match(result.stderr,/held for over 2 s/);assert(!calls.some(c=>/^(npm|cargo) /.test(c)),calls.join('\n'));const after=calls.find(c=>c.startsWith('after '))?.split(' ');assert(after&&after[1]===after[2],calls.join('\n'));});
test('native hook takes over the lock of a push that is no longer running',{skip:!hasShell},t=>{const{result,calls,repo}=run(t,'ok',{},{wrap:"mkdir .git/prepush-lock; sh -c 'exit 0' & p=$!; wait $p; echo $p > .git/prepush-lock/pid; sh scripts/pre-push"});assert.equal(result.status,0,result.stderr);assert.match(result.stderr,/no longer running/);assert(calls.some(c=>c.startsWith('npm held ')));assert(!existsSync(join(repo,'.git/prepush-lock')));});
test('native hook empties the build folder when it grows past the cap',{skip:!hasShell},t=>{const{result,repo}=run(t,'big',{},{subs:[capSub(4)]});assert.equal(result.status,0,result.stderr);assert.match(result.stderr,/over the 0 MiB limit; emptying/);assert(!existsSync(join(repo,'.git/prepush-target')));});
test('native hook empties an oversized build folder before building',{skip:!hasShell},t=>{const{result,calls}=run(t,'ok',{},{subs:[capSub(4)],before:repo=>{mkdirSync(join(repo,'.git/prepush-target'),{recursive:true});writeFileSync(join(repo,'.git/prepush-target/old'),Buffer.alloc(16384));}});assert.equal(result.status,0,result.stderr);assert.match(result.stderr,/emptying/);assert(calls.some(c=>c.startsWith('cargo test')));assert(!calls.includes('cargo saw old'),calls.join('\n'));});
test('native hook removes its throwaway worktree and lock when it exits early',{skip:!hasShell},t=>{const{result,calls,repo}=run(t,'cygpath_fail',{},{nonHead:true});assert.notEqual(result.status,0);assert.match(result.stderr,/cannot convert/);assert(calls.some(c=>c.startsWith('cygpath ')));assert.equal(git(repo,['worktree','list','--porcelain']).split('\n').filter(l=>l.startsWith('worktree ')).length,1);assert.deepEqual(readdirSync(join(repo,'.git')).filter(n=>n.startsWith('prepush-')),[]);});
test('native hook checks a pushed commit that is not HEAD in a throwaway worktree',{skip:!hasShell},t=>{const{result,calls,repo}=run(t,'ok',{},{nonHead:true});assert.equal(result.status,0,result.stderr);assert(calls.some(c=>/^bin .*prepush-target\/debug\/herdr-theme$/.test(c)),calls.join('\n'));assert.equal(git(repo,['worktree','list','--porcelain']).split('\n').filter(l=>l.startsWith('worktree ')).length,1);assert.deepEqual(readdirSync(join(repo,'.git')).filter(n=>n.startsWith('prepush-')&&n!=='prepush-target'),[]);});
test('native hook stops before JavaScript when cargo test built no executable',{skip:!hasShell},t=>{const{result,calls}=run(t,'no_bin');assert.notEqual(result.status,0);assert.match(result.stderr,/built no herdr-theme executable/);assert(!calls.some(c=>c.startsWith('npm ')));});
test('native hook rejects a zero Rust run',{skip:!hasShell},t=>{const{result,calls}=run(t,'zero_rust');assert.notEqual(result.status,0);assert.match(result.stderr,/0 Rust tests passed/);assert(calls.some(c=>c.startsWith('cargo test')));});
test('native hook needs no interpreter and drops caller Python settings',{skip:!hasShell},t=>{const{result,calls}=run(t,'ok',{PYTHONPATH:'/shadow/unittest'});assert.equal(result.status,0,result.stderr);assert(calls.includes('PYTHONPATH=unset'));assert(calls.some(c=>c.startsWith('cargo test')));assert(!calls.some(c=>c.startsWith('py ')));});
test('PREPUSH overrides cannot bypass an actual push',{skip:!hasShell},t=>{const base=sandbox(t),repo=join(base,'repo'),bare=join(base,'remote.git');mkdirSync(repo);init(repo,readFileSync(join(root,'scripts/pre-push'),'utf8'));git(base,['init','--bare','-q',bare]);git(repo,['remote','add','origin',bare]);const hook=join(repo,'.git/hooks/pre-push');writeFileSync(hook,'#!/bin/sh\nexec sh scripts/pre-push "$@"\n');chmodSync(hook,0o755);const result=spawnSync('git',['push','origin','HEAD:refs/heads/main'],{cwd:repo,env:cleanEnv({PREPUSH_PY:'true',PREPUSH_CYGPATH:'true'}),encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,/PREPUSH_/);assert.equal(git(repo,['ls-remote',bare,'refs/heads/main']),'');});
