#!/usr/bin/env python3
"""Open an existing local document in the theme's side panel without moving pane focus."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file',type=Path)
    args=parser.parse_args()
    file=args.file.resolve(strict=True)
    if not file.is_file():parser.error('select a file')
    app=Path(os.environ.get('HERDR_APP_HOME',Path.home()/'.config/herdr-app'))
    for name in ('sixfold-files','sixfold-docs','files-plus','preview-plus'):
        if not (app/'mods'/name/'main.js').exists():parser.error('run scripts/install_preview.py first')
    status=json.loads(subprocess.check_output(['herdr-app','status'],text=True))
    data=app/'data/sixfold';data.mkdir(parents=True,exist_ok=True)
    path=data/'preview-open.json';tmp=path.with_suffix('.tmp')
    tmp.write_text(json.dumps({'space':status['space'],'file':str(file),'root':str(file.parent)}));tmp.replace(path)
    for command,params in [('layout.select',{'stack':'panel-body','child':'files'}),('layout.select',{'stack':'files','child':'files-plus-tree'}),('layout.show',{'id':'panel'})]:
        subprocess.run(['herdr-app','do',command,json.dumps(params)],check=True,capture_output=True,text=True)
    # Commands are queued by the mod host after its stack child becomes active.
    time.sleep(.15)
    subprocess.run(['herdr-app','do','sixfold-files.open'],check=True)


if __name__=='__main__':main()
