#!/usr/bin/env python3
"""Install the voice plugin (compatibility name for voice/install.py)."""
import os
from pathlib import Path
import sys

script = Path(__file__).resolve().parents[1] / 'voice' / 'install.py'
arguments = sys.argv[1:]
if arguments and not arguments[0].startswith('-'):
    # The old form named a separate plugin checkout; the plugin now lives in voice/.
    print(f'Ignoring {arguments[0]}: the voice plugin is installed from {script.parent}')
    arguments = arguments[1:]
os.execv(sys.executable, [sys.executable, str(script), *arguments])
