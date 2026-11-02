#!/usr/bin/env python3
"""Enable optional app focus routing through an installed herdr-focus-queue checkout."""
import argparse
import json
from pathlib import Path

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('plugin',type=Path,help='Path to the herdr-focus-queue checkout with app_backend.py')
args=parser.parse_args()
script=args.plugin.resolve()/'focus_queue.py'
if not script.is_file() or not (script.parent/'app_backend.py').is_file():
    raise SystemExit('Install the app-compatible focus-queue integration first.')
folder=Path.home()/'.config/herdr-app/data/sixfold'
folder.mkdir(parents=True,exist_ok=True)
(folder/'voice-integration.json').write_text(json.dumps({'script':str(script)}))
print('Herdr app focus routing enabled. Microphone permission and actual transcription still need verification.')
