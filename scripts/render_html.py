#!/usr/bin/env python3
"""Render one HTML report to cached PNG tiles for the 문서 tab."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from render_mermaid import png_size


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--doc', type=Path, required=True)
    parser.add_argument('--theme', choices=('dark', 'light'), default='dark')
    parser.add_argument('--width', type=int, default=960)
    args = parser.parse_args()
    app = Path(os.environ.get('HERDR_APP_HOME', Path.home()/'.config/herdr-app'))
    binary = app/'data/sixfold/doc-tabs/render-html'
    cache = app/'mods/project-docs-tabs/.cache'
    if not binary.exists():
        print(json.dumps({'error': 'HTML 렌더러가 설치되지 않았습니다. scripts/install_doc_tabs.py --install'}, ensure_ascii=False))
        return 1
    key = hashlib.sha256(json.dumps([hashlib.sha256(args.doc.read_bytes()).hexdigest(),args.theme, args.width, binary.stat().st_size]).encode()).hexdigest()[:24]
    index = cache/f'html-{key}.json'
    if not index.exists():
        with tempfile.TemporaryDirectory() as folder:
            result = subprocess.run([str(binary), str(args.doc), f'{folder}/html-{key}', args.theme, str(args.width)],
                                    capture_output=True, text=True, timeout=60)
            try:
                data = json.loads(result.stdout)
            except ValueError:
                data = {'error': result.stderr.strip()[-300:] or 'HTML 렌더링 실패'}
            if result.returncode or 'tiles' not in data:
                print(json.dumps({'error': data.get('error') or 'HTML 렌더링 실패'}, ensure_ascii=False))
                return 1
            cache.mkdir(parents=True, exist_ok=True)
            for number in range(len(data['tiles'])):
                shutil.move(f'{folder}/html-{key}-{number}.png', cache/f'html-{key}-{number}.png')
            # The index is written last, so a partial render is never reused.
            index.write_text(json.dumps(len(data['tiles'])))
    pages = []
    for number in range(json.loads(index.read_text())):
        width, height = png_size(cache/f'html-{key}-{number}.png')
        # Tiles are drawn at 2x; the tab lays them out at CSS pixel size.
        pages.append({'path': f'mods/project-docs-tabs/.cache/html-{key}-{number}.png', 'width': width / 2, 'height': height / 2})
    print(json.dumps({'pages': pages}, ensure_ascii=False))


if __name__ == '__main__':
    sys.exit(main())
