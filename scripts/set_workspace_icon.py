#!/usr/bin/env python3
"""Set a local workspace icon without committing customer assets to the theme."""
import sys
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workspace',help='workspace id or exact name')
    parser.add_argument('image',type=Path)
    parser.add_argument('--background',default=None,help='optional badge background, e.g. #ffffff')
    parser.add_argument('--tint',action='store_true',help='tint a monochrome SVG with the workspace color')
    args=parser.parse_args()
    source=args.image.resolve(strict=True)
    if source.suffix.lower() not in ('.svg','.png','.jpg','.jpeg','.webp'):
        parser.error('use SVG, PNG, JPEG or WebP')
    app=Path(os.environ.get('HERDR_APP_HOME',Path.home()/'.config/herdr-app'))
    data=app/'data/sixfold'
    folder=data/'icons'
    folder.mkdir(parents=True,exist_ok=True)
    name=hashlib.sha256(source.read_bytes()).hexdigest()[:16]+source.suffix.lower()
    if source != (folder/name).resolve():
        shutil.copy2(source,folder/name)
    path=data/'workspace-icons.json'
    icons=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    icons[args.workspace]={'path':f'data/sixfold/icons/{name}','tint':args.tint}
    if args.background:icons[args.workspace]['background']=args.background
    temporary=path.with_suffix('.tmp')
    temporary.write_text(json.dumps(icons,ensure_ascii=False), encoding='utf-8')
    temporary.chmod(0o600)
    temporary.replace(path)
    print(f'Updated local icon: {args.workspace}')


if __name__ == '__main__':
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    main()
