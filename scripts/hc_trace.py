#!/usr/bin/env python3
"""Transparent hc launcher: record successful sends for Sixfold's message-flow UI."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid


def source_address(env):
    if env.get('HC_TERMINAL_ID'):
        return env['HC_TERMINAL_ID']
    source=env.get('HERDR_PANE_ID')
    if not source:return None
    try:
        data=json.loads((Path.home()/'.local/state/herdr-sixfold/migration-map.local.json').read_text())
        return next(p['terminal'] for p in data.get('panes',[]) if p['source']==source)
    except (OSError,ValueError,KeyError,StopIteration):return None


def append_event(path, source, target, now=None):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    with path.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        try:events=json.loads(path.read_text()).get('events',[])
        except (OSError,ValueError):events=[]
        event={'id':uuid.uuid4().hex,'source':source or 'external','target':target,'at':now or int(time.time()*1000)}
        events=(events+[event])[-32:]
        tmp=path.with_name(path.name+'.tmp')
        tmp.write_text(json.dumps({'events':events}));os.replace(tmp,path)
    return event


class ForwardParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


def main():
    real=os.environ.get('SIXFOLD_REAL_HC') or shutil.which('herdr-core')
    if not real:raise SystemExit('Sixfold: herdr-core not found; set SIXFOLD_REAL_HC to the original hc.')
    args=sys.argv[1:]
    if not args or args[0]!='send':os.execv(real,[real,*args])
    parser=ForwardParser(add_help=False)
    parser.add_argument('--wait',action='store_true');parser.add_argument('--json',action='store_true')
    parser.add_argument('--force',action='store_true');parser.add_argument('--timeout');parser.add_argument('--if')
    parser.add_argument('target');parser.add_argument('text')
    try:parsed=parser.parse_args(args[1:])
    except (SystemExit,ValueError):os.execv(real,[real,*args])
    env=os.environ.copy();source=source_address(env)
    if source:env['HC_TERMINAL_ID']=source
    result=subprocess.run([real,*args],env=env)
    if result.returncode==0:
        target=parsed.target
        try:
            observed=subprocess.check_output([real,'get',target],text=True,timeout=3)
            target=json.loads(observed).get('address',target)
        except (OSError,ValueError,subprocess.SubprocessError):pass
        app_home=Path(os.environ.get('HERDR_APP_HOME',Path.home()/'.config/herdr-app'))
        try:append_event(app_home/'data/sixfold/messages.json',source,target)
        except OSError as e:print(f'Sixfold: message was sent, but flow logging failed: {e}',file=sys.stderr)
    raise SystemExit(result.returncode)


if __name__=='__main__':main()
