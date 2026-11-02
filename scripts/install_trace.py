#!/usr/bin/env python3
"""Install the hc send observer, optionally replacing the known core launcher."""
import argparse
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
shutil.copy2(root/'scripts/hc_trace.py',target/'hc_trace.py')
launcher=target/'bin/hc'
launcher.write_text('#!/bin/sh\nexec python3 '+shlex.quote(str(target/'hc_trace.py'))+' "$@"\n')
launcher.chmod(0o755)
if args.default_launcher:
    if default.resolve()!=launcher.resolve():
        default.unlink()
        default.symlink_to(launcher)
    print(f'Existing hc commands now use message tracing: {default}')
print('export PATH="$HOME/.local/share/herdr-sixfold/bin:$PATH"')
