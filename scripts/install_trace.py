#!/usr/bin/env python3
"""Install an optional hc send observer; print the PATH hook instead of editing a shell profile."""
from pathlib import Path
import shlex
import shutil

root=Path(__file__).resolve().parents[1]
target=Path.home()/'.local/share/herdr-sixfold'
(target/'bin').mkdir(parents=True,exist_ok=True)
shutil.copy2(root/'scripts/hc_trace.py',target/'hc_trace.py')
launcher=target/'bin/hc'
launcher.write_text('#!/bin/sh\nexec python3 '+shlex.quote(str(target/'hc_trace.py'))+' "$@"\n')
launcher.chmod(0o755)
print('export PATH="$HOME/.local/share/herdr-sixfold/bin:$PATH"')
