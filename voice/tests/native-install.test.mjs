import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const voice=fileURLToPath(new URL('..',import.meta.url));
const binary=process.env.HERDR_THEME_BIN || fileURLToPath(new URL('../../rust/target/debug/herdr-theme',import.meta.url));
const mac=process.platform==='darwin';
const quote=value=>`'${value.replaceAll("'", "'\\''")}'`;
function setup(t) {
  const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'native-voice-home-')));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const fakebin=path.join(home,'fakebin');fs.mkdirSync(fakebin);
  const db=path.join(home,'herdr-fixture.json');
  const old=path.join(home,'work','previous-voice');fs.mkdirSync(old,{recursive:true});
  fs.writeFileSync(db,JSON.stringify({root:old,enabled:true}));
  const fake=path.join(home,'fake-herdr.mjs');
  fs.writeFileSync(fake,`import fs from 'node:fs';
const db=process.env.FAKE_HERDR_DB,args=process.argv.slice(2);
const state=fs.existsSync(db)?JSON.parse(fs.readFileSync(db,'utf8')):{};
fs.appendFileSync(db+'.log',JSON.stringify(args)+'\\n');
if(args[0]==='plugin'&&args[1]==='list')console.log(JSON.stringify({result:{plugins:state.root?[{plugin_id:'local.focus-queue',manifest_path:state.root+'/herdr-plugin.toml',enabled:state.enabled??true}]:[]}}));
else if(args[0]==='plugin'&&args[1]==='link'){state.root=args[2];state.enabled=true;}
else if(args[0]==='plugin'&&args[1]==='unlink')delete state.root;
else if(args[0]==='plugin'&&args[1]==='enable')state.enabled=true;
else throw Error('unexpected fake Herdr request: '+JSON.stringify(args));
fs.writeFileSync(db,JSON.stringify(state));
`);
  const launcher=path.join(fakebin,'herdr');
  fs.writeFileSync(launcher,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fake)} "$@"\n`);fs.chmodSync(launcher,0o755);
  const claude=path.join(home,'.claude');fs.mkdirSync(claude);
  const settings=path.join(claude,'settings.json');fs.writeFileSync(settings,JSON.stringify({model:'kept',hooks:{UserPromptSubmit:[{hooks:[{type:'command',command:`/usr/bin/python3 ${old}/voice_submit_hook.py`}]},{hooks:[{type:'command',command:'echo other-hook'}]}]}}));
  const sixfold=path.join(home,'.config/herdr-app/data/sixfold');fs.mkdirSync(sixfold,{recursive:true});
  fs.writeFileSync(path.join(sixfold,'voice-integration.json'),JSON.stringify({script:`${old}/focus_queue.py`}));
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('HERDR_')&&!key.startsWith('FAKE_')));
  Object.assign(env,{PATH:`${fakebin}:/usr/bin:/bin`,FAKE_HERDR_DB:db});
  const run=(...args)=>spawnSync(binary,['voice_install','--home',home,'--source',voice,...args],{env,encoding:'utf8',timeout:30000});
  return {home,db,settings,sixfold,run,target:path.join(home,'.local/share/herdr-focus-queue/plugin')};
}
function ok(result){assert.equal(result.status,0,`${result.error||''}\n${result.stdout}\n${result.stderr}`);}
function hooks(settings){return (settings.hooks?.UserPromptSubmit||[]).flatMap(entry=>entry.hooks||[]).map(h=>h.command);}
function noBytecode(folder){for(const entry of fs.readdirSync(folder,{withFileTypes:true})){assert.notEqual(entry.name,'__pycache__');if(entry.isDirectory())noBytecode(path.join(folder,entry.name));}}

test('test_everything_moves_to_the_installed_copy',{skip:!mac},t=>{
  const x=setup(t);const result=x.run();ok(result);
  assert.equal(JSON.parse(fs.readFileSync(x.db)).root,x.target);
  assert(fs.existsSync(path.join(x.target,'herdr-theme')));
  assert(!fs.existsSync(path.join(x.target,'focus_queue.py')));
  noBytecode(x.target);
  const settings=JSON.parse(fs.readFileSync(x.settings));assert.equal(settings.model,'kept');assert.equal(settings.voice.enabled,true);
  const commands=hooks(settings);assert.equal(commands.length,2);assert.equal(commands[0],'echo other-hook');assert(commands[1].endsWith("' voice_submit_hook"));assert(commands[1].includes(x.target));
  const integration=JSON.parse(fs.readFileSync(path.join(x.sixfold,'voice-integration.json')));
  assert.equal(integration.command,path.join(x.target,'herdr-theme'));assert.deepEqual(integration.args,['focus_queue']);
  const agent=fs.readFileSync(path.join(x.home,'Library/LaunchAgents/local.herdr-sixfold.herdr-codex-focus.plist'),'utf8');
  assert(agent.includes('<string>codex_focus</string>'));assert(!agent.includes('python'));assert(agent.includes(x.target));
  assert(result.stdout.includes('all voice entry points run'));
  assert(!fs.existsSync(path.join(x.sixfold,'voice.local.json')));
  assert(!fs.existsSync(path.join(x.home,'.local/share/herdr-focus-queue/native')));
});
test('test_a_second_run_changes_nothing',{skip:!mac},t=>{
  const x=setup(t);ok(x.run());
  const before=fs.readFileSync(x.settings,'utf8');
  const result=x.run();ok(result);assert(result.stdout.includes('already current'));assert.equal(fs.readFileSync(x.settings,'utf8'),before);
  const commands=fs.readFileSync(x.db+'.log','utf8').trim().split('\n').map(JSON.parse);assert.equal(commands.filter(a=>a[0]==='plugin'&&a[1]==='link').length,1);
});
test('test_moving_an_install_without_the_hook_does_not_add_it',{skip:!mac},t=>{
  const x=setup(t);fs.writeFileSync(x.settings,JSON.stringify({model:'kept'}));const result=x.run();ok(result);
  assert(!JSON.parse(fs.readFileSync(x.settings)).hooks);assert(result.stdout.includes('hook is off'));
});
test('test_a_new_install_adds_the_hook',{skip:!mac},t=>{
  const x=setup(t);
  fs.writeFileSync(x.db,'{}');fs.writeFileSync(x.settings,'{}');ok(x.run());assert.equal(hooks(JSON.parse(fs.readFileSync(x.settings))).length,1);
  const command=hooks(JSON.parse(fs.readFileSync(x.settings)))[0];assert(command.endsWith("' voice_submit_hook"));assert(command.includes(x.target));
});
test('test_check_fails_while_an_old_folder_is_linked',{skip:!mac},t=>{
  const x=setup(t);const stale=x.run('--check');assert.equal(stale.status,1);assert(stale.stdout.includes('not this copy'));
});
test('test_an_update_swaps_the_copy_in_place',{skip:!mac},t=>{
  const x=setup(t);ok(x.run());const before=fs.statSync(x.target).ino;fs.writeFileSync(path.join(x.target,'README.md'),'stale\n');
  const result=x.run();ok(result);assert(result.stdout.includes('updated'));assert.notEqual(fs.statSync(x.target).ino,before);assert.notEqual(fs.readFileSync(path.join(x.target,'README.md'),'utf8'),'stale\n');assert.deepEqual(fs.readdirSync(path.dirname(x.target)),['plugin']);
});
