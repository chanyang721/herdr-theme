"""Optional Herdr app focus projection, published by the active custom sidebar."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

APP = shutil.which('herdr-app') or os.path.expanduser('~/.local/bin/herdr-app')
CORE = (os.environ.get('SIXFOLD_REAL_HC') or shutil.which('herdr-core')
        or os.path.expanduser('~/.local/bin/herdr-core'))
HC = shutil.which('hc') or CORE
_asked = (0, None)


def focus():
    try:
        root=Path(os.environ.get('HERDR_APP_HOME',str(Path.home()/'.config/herdr-app')))
        value=json.loads((root/'data/sixfold/voice-focus.json').read_text())
        if time.time()*1000-value['at']<2500:
            return value
    except (OSError,ValueError,KeyError,TypeError):pass
    return asked()


def _run(*command):
    return json.loads(subprocess.run(command,capture_output=True,text=True,timeout=3).stdout)


def front_is_app():
    front=subprocess.run(['lsappinfo','front'],capture_output=True,text=True,timeout=3).stdout.strip()
    return 'dev.herdr.app' in subprocess.run(['lsappinfo','info','-only','bundleid',front],
                                             capture_output=True,text=True,timeout=3).stdout


def asked():
    """The sidebar's heartbeat stops while its mod reloads, and the TUI's own
    focus is then not where the user looks. While the app is in front, ask
    the window itself; unknown focus leaves no pane focused."""
    global _asked
    if time.time()-_asked[0]<0.5:
        return _asked[1]
    value=None
    try:
        if front_is_app():
            # status.agent is the last agent, not the focused pane: on a docs
            # tab it still names the last terminal, so map focused_pane.
            pane=_run(APP,'status').get('focused_pane')
            terminal=next((t['terminal'] for s in _run(APP,'ls')['spaces'] for tab in s['tabs']
                           for t in tab['terminals'] if pane and t.get('pane')==pane),None)
            listed=_run(CORE,'ls','--json')['terminals']
            bridged={t['address'] for t in _run(CORE,'ls','--json','--label','sixfold.source-session=default')['terminals']}
            labels=_run(CORE,'get',terminal).get('labels') or {} if terminal else {}
            value={'at':time.time()*1000,'active':True,'terminal':terminal,'asked':True,
                   'source':labels.get('sixfold.source-pane'),
                   'panes':[{'pane_id':f"app:{t['address']}",'agent':'claude' if t['agent']=='claude-code' else t['agent'],
                             'agent_status':t.get('status')} for t in listed
                            if t['address'] not in bridged and t.get('agent') in ('claude','claude-code','codex')]}
    except (OSError,ValueError,KeyError,TypeError,subprocess.TimeoutExpired):
        value={'at':time.time()*1000,'active':True,'terminal':None,'asked':True,'panes':[]} if _front() else None
    _asked=(time.time(),value)
    return value


def _front():
    try:return front_is_app()
    except (OSError,subprocess.TimeoutExpired):return False


def active():
    return bool((focus() or {}).get('active'))


def project(current, value=None):
    value=focus() if value is None else value
    if not value:return current
    for pane in value.get('panes',[]):
        current[pane['pane_id']]={**pane,'focused':False}
    if value.get('active'):
        target=value.get('source') or 'app:'+str(value.get('terminal'))
        for pid,pane in current.items():pane['focused']=pid==target
    return current
