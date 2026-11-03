#!/usr/bin/env python3
"""macOS native regression probe: real Sixfold renders in a disposable app/core.

Run manually: python3 tests/native_ui_reload.py [--reloads 80]. Saves four
synthetic theme shots, missing-export/restore results, reload stress receipts,
and a restart shot under /tmp. Never uses the user's app/core for commands.
Only the app/core launched with this probe's isolated env are stopped.
"""
import argparse
import os,json,subprocess,time,tempfile,shutil
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--reloads',type=int,default=80)
parser.add_argument('--failed-reloads',type=int,default=0,help='Repeat incomplete-import/restore cycles until OOM or this limit')
parser.add_argument('--install-smoke',action='store_true',help='Exercise the guarded installer twice against the disposable app')
args=parser.parse_args()
if not 0 <= args.reloads <= 1000 or not 0 <= args.failed_reloads <= 200: parser.error('--reloads must be 0..1000 and --failed-reloads 0..200')
core=shutil.which('herdr-core')
if not core: raise SystemExit('herdr-core must be available on PATH')
from pathlib import Path
repo=Path(__file__).resolve().parents[1];base=Path(tempfile.mkdtemp(prefix='herdr-null-repro-',dir='/tmp'));app=base/'app';mod=app/'mods/sixfold-desk';mod.parent.mkdir(parents=True);shutil.copytree(repo/'mods/sixfold-desk',mod)
(app/'themes').mkdir();(app/'layouts').mkdir();(app/'data/sixfold').mkdir(parents=True)
for name in ['atom-one-dark','sixfold-day','sixfold-night','win98']:shutil.copy2(Path.home()/f'.config/herdr-app/themes/{name}.json',app/f'themes/{name}.json')
s=(mod/'main.js').read_text().replace('agents, panes, spaces, terminals, focused,','')
s+='''
const fixturePanes=['working','blocked','idle','done','working','blocked'].map((status,i)=>({pane:'pane'+i,tab:'tab',terminal:'demo'+i,status,focused:i===4,title:status+' / 합성 세션',cwd:'/synthetic',program:{key:'codex',name:'Codex',agent:true}}));
const panes=()=>fixturePanes,spaces=()=>[{id:'space',name:'Share',active:true,machine:null,tabs:[{id:'tab',active:true,name:'합성자료',panes:6}]}],terminals=()=>fixturePanes.map(p=>({address:p.terminal,status:p.status,labels:{},program:p.program,cwd:p.cwd})),agents=()=>fixturePanes.map(p=>({...p,address:p.terminal,space:'space'})),focused=()=>({space:'space',tab:'tab',pane:'pane4',terminal:'demo4'});
'''
main=mod/'main.js';main.write_text(s)
(app/'data/sixfold/workspace-pins.local.json').write_text(json.dumps({'spaces':[{'id':'space','machine':None}]}))
(app/'data/sixfold/project-alerts.json').write_text(json.dumps({'items':[],'projects':['Share']}))
head=lambda i:{'id':f'p{i}','type':'column','children':[{'id':f'h{i}','type':'block','size':{'px':28},'content':{'mod':'sixfold-desk','props':{'role':'pane','pane':f'pane{i}'}}},{'id':f'b{i}','type':'block','background':'background','content':{'mod':'qa-body'}}]}
body=app/'mods/qa-body';body.mkdir();(body/'main.js').write_text("import {View,div} from 'gpui-kit';import {theme} from 'herdr';export default class extends View{render(){return div().p(12).text_color(theme().foreground).child('합성 검증 / 실제 세션 아님');}}")
layout={'id':'root','type':'row','theme':'sixfold-night','children':[{'id':'sidebar','type':'block','size':{'px':300},'content':{'mod':'sixfold-desk','props':{'role':'sidebar'}}},{'id':'work','type':'column','children':[{'id':'toolbar','type':'block','size':{'px':36},'content':{'mod':'sixfold-desk','props':{'role':'toolbar'}}},* [head(i) for i in range(6)],{'id':'footer','type':'block','size':{'px':28},'content':{'mod':'sixfold-desk','props':{'role':'footer'}}}]}]};lp=app/'layouts/qa.json';lp.write_text(json.dumps(layout))
(app/'shared.json').write_text(json.dumps({'frame.welcomed':'skipped','layout':'qa','sixfold.language':'ko'}));(app/'update-notes.json').write_text(json.dumps({'last_run':'0.1.12','presented':['0.1.12']}));(app/'window.json').write_text(json.dumps({'bounds':[40,40,1320,980]}));(app/'settings.json').write_text(json.dumps({'telemetry':False,'sounds':{'enabled':False},'appearance':'dark','core':core,'zoom':1}))
variables={'HERDR_APP_HOME':str(app),'XDG_STATE_HOME':str(base/'s'),'XDG_CONFIG_HOME':str(base/'c'),'HC_SESSION':'null-repro','HERDR_TELEMETRY':'0'};env={**os.environ,**variables};(base/'env.json').write_text(json.dumps(variables))
def run(*args):return subprocess.check_output(args,env=env,text=True,stderr=subprocess.STDOUT)
def launch():
 cmd=['open','-n','-g','-a','/Applications/Herdr.app']
 for k,v in variables.items():cmd+=['--env',k+'='+v]
 subprocess.run(cmd+['--stdout',str(base/'app.log'),'--stderr',str(base/'app.log')],check=True)
 for _ in range(100):
  try:
   value=json.loads(run('herdr-app','status'));time.sleep(1);return value
  except Exception:time.sleep(.1)
 raise RuntimeError('launch timeout')
def status():return json.loads(run('herdr-app','status'))
def stop():
 try:run('herdr-app','do','app.quit')
 except Exception:pass
 time.sleep(.8)
def write(text):
 temp=base/'next-main.js';temp.write_text(text);os.replace(temp,main);time.sleep(.7)
receipt={'base':str(base),'fixture':True,'themes':[],'reloads':[]};print(str(base),flush=True)
try:
 launch()
 for name in ['atom-one-dark','sixfold-day','sixfold-night','win98']:
  layout['theme']=name;lp.write_text(json.dumps(layout));time.sleep(1.2);st=status();shot=str(base/f'{name}.png');run('herdr-app','shot',shot);receipt['themes'].append({'theme':name,'status':st,'shot':shot});assert not st['errors'],st;print(json.dumps({'theme':name,'errors':st['errors']}),flush=True)
 # A new main references an export not yet installed: model a sequential file copy.
 write(s.replace("import { WORDS, counts,", "import { notYetInstalled, WORDS, counts,"));st=status();receipt['partialInstall']=st;assert any('Could not find export' in error for error in st['errors']),st;run('herdr-app','shot',str(base/'partial-install.png'));print(json.dumps({'partialInstallErrors':st['errors']}),flush=True)
 write(s);receipt['restoredAfterPartial']=status();assert not receipt['restoredAfterPartial']['errors'];print(json.dumps({'restoreErrors':receipt['restoredAfterPartial']['errors']}),flush=True)
 stop();launch();receipt['coldBaseline']=status()
 for i in range(1,args.reloads+1):
  write(s+f'\n// reload generation {i}\n');st=status();receipt['reloads'].append({'generation':i,'errors':st['errors']})
  if st['errors']:
   print(json.dumps(receipt['reloads'][-1]),flush=True);run('herdr-app','shot',str(base/'stress-failure.png'));break
  if i%10==0:print(json.dumps({'generation':i,'errors':[]}),flush=True)
 receipt['failedReloadCycles']=[]
 for i in range(1,args.failed_reloads+1):
  write(s.replace("import { WORDS, counts,", "import { notYetInstalled, WORDS, counts,"))
  failed=status()
  write(s);restored=status()
  receipt['failedReloadCycles'].append({'cycle':i,'failedErrors':failed['errors'],'restoredErrors':restored['errors']})
  if restored['errors']:
   print(json.dumps({'failedReloadCycle':i,'restoredErrors':restored['errors']}),flush=True)
   run('herdr-app','shot',str(base/'failed-reload-stress.png'));break
  if i%10==0:print(json.dumps({'failedReloadCycle':i,'restoredErrors':[]}),flush=True)
 receipt['freshCheck']=run('herdr-app','check',str(mod));stop();launch();receipt['cleanRestart']=status();assert not receipt['cleanRestart']['errors'];run('herdr-app','shot',str(base/'restart.png'));print(json.dumps({'restartErrors':receipt['cleanRestart']['errors']}),flush=True)
 if args.install_smoke:
  candidate=base/'candidate';source=candidate/'mods/sixfold-desk';source.mkdir(parents=True);(candidate/'layouts').mkdir()
  (source/'qa-dependency.js').write_text('export const qaVersion=()=>"dependency ready";')
  receipt['installer']=[]
  for revision in (1,2):
   (source/'main.js').write_text("import {qaVersion} from './qa-dependency.js';\n"+s.replace("'HERDR THEME / WORKSPACE'",f"'QA INSTALL V{revision} / '+qaVersion()"))
   result=run('python3',str(repo/'scripts/update_install.py'),'--repo',str(candidate),'--home',str(app),'mods/sixfold-desk/main.js','mods/sixfold-desk/qa-dependency.js')
   st=status();shot=str(base/f'installed-{revision}.png');run('herdr-app','shot',shot)
   receipt['installer'].append({'revision':revision,'result':result,'status':st,'shot':shot})
   assert not st['errors'],st
  # A missing export is rejected in the complete staging tree, before live reload.
  (source/'main.js').write_text("import {stillMissing} from './qa-dependency.js';\n"+s)
  rejected=subprocess.run(['python3',str(repo/'scripts/update_install.py'),'--repo',str(candidate),'--home',str(app),'mods/sixfold-desk/main.js'],env=env,capture_output=True,text=True)
  assert rejected.returncode!=0 and 'Native check failed' in rejected.stderr,rejected
  assert 'QA INSTALL V2' in main.read_text()
  receipt['installerRejectedPartial']={'returncode':rejected.returncode,'stderr':rejected.stderr,'status':status()}
  print(json.dumps({'installer':'two swaps passed; partial candidate rejected'}),flush=True)

finally:
 stop()
 try:run(core,'server','stop')
 except Exception:pass
 (base/'receipt.json').write_text(json.dumps(receipt,indent=2))
