#!/usr/bin/env python3
"""Install the hc send observer, optionally replacing the known core launcher."""
import argparse
import os
import sys
from pathlib import Path
import shlex
import shutil

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--default-launcher',action='store_true',help='route the existing ~/.local/bin/hc core symlink through the observer')
args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
target=Path.home()/'.local/share/herdr-sixfold'
default=Path.home()/'.local/bin/hc'
core=shutil.which('herdr-core')
if args.default_launcher and (not default.is_symlink() or default.resolve() not in (Path(core).resolve() if core else None,(target/'bin/hc').resolve())):
    raise SystemExit('Refusing to replace an unknown hc launcher; use the printed PATH hook instead.')
(target/'bin').mkdir(parents=True,exist_ok=True)
temporary=target/'hc_trace.py.next'
shutil.copy2(root/'scripts/hc_trace.py',temporary)
temporary.replace(target/'hc_trace.py')
launcher=target/'bin/hc'
if os.name=='nt':
    # cmd and PowerShell find hc.cmd; Git Bash finds the extensionless sh script.
    python=Path(sys.executable)
    (target/'bin/hc.cmd').write_text(f'@"{python}" "{target/"hc_trace.py"}" %*\r\n')
    launcher.write_text('#!/bin/sh\nexec '+shlex.quote(python.as_posix())+' '+shlex.quote((target/'hc_trace.py').as_posix())+' "$@"\n',newline='\n')
    if args.default_launcher:raise SystemExit('On Windows, put the printed folder before herdr-core in your user PATH instead.')
    print(f'Add this folder before herdr-core in your user PATH: {target/"bin"}')
    raise SystemExit(0)
launcher.write_text('#!/bin/sh\nexec python3 '+shlex.quote(str(target/'hc_trace.py'))+' "$@"\n')
launcher.chmod(0o755)
if args.default_launcher:
    if default.resolve()!=launcher.resolve():
        default.unlink()
        default.symlink_to(launcher)
    print(f'Existing hc commands now use message tracing: {default}')
print('export PATH="$HOME/.local/share/herdr-sixfold/bin:$PATH"')
