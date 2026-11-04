#!/usr/bin/env python3
"""Render the Mermaid blocks of one Markdown file to cached PNGs for the 문서 tab."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile

FENCE = re.compile(r'^( {0,3})(`{3,}|~{3,})[ \t]*mermaid\b[^\n]*$')


def mermaid_blocks(text):
    """Return each fenced ```mermaid block's code, in document order."""
    lines, blocks, index = text.split('\n'), [], 0
    while index < len(lines):
        opening = FENCE.match(lines[index])
        if not opening:
            index += 1
            continue
        marker, body = opening[2], []
        index += 1
        while index < len(lines) and not re.match(r'^ {0,3}' + re.escape(marker[0]) + '{' + str(len(marker)) + r',}[ \t]*$', lines[index]):
            body.append(lines[index])
            index += 1
        if index < len(lines):
            blocks.append('\n'.join(body))
        index += 1
    return blocks


def png_size(path):
    with open(path, 'rb') as handle:
        header = handle.read(24)
    return struct.unpack('>II', header[16:24])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--doc', type=Path, required=True)
    parser.add_argument('--theme', choices=('dark', 'light'), default='dark')
    parser.add_argument('--background', default='#ffffff')
    args = parser.parse_args()
    app = Path(os.environ.get('HERDR_APP_HOME', Path.home()/'.config/herdr-app'))
    tools = app/'data/sixfold/doc-tabs'
    binary, library = tools/'render-mermaid', tools/'mermaid/mermaid.min.js'
    cache = app/'mods/project-docs-tabs/.cache'
    blocks = mermaid_blocks(args.doc.read_text(encoding='utf-8', errors='replace'))
    if blocks and not (binary.exists() and library.exists()):
        print(json.dumps({'diagrams': [], 'error': 'Mermaid 렌더러가 설치되지 않았습니다. scripts/install_doc_tabs.py --install --mermaid <mermaid.min.js>'}, ensure_ascii=False))
        return
    version = library.stat().st_size if library.exists() else 0
    diagrams = []
    for code in dict.fromkeys(blocks):
        key = hashlib.sha256(json.dumps([code, args.theme, args.background, version]).encode()).hexdigest()[:24]
        name = f'mermaid-{key}.png'
        target = cache/name
        if not target.exists():
            cache.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory() as folder:
                source = Path(folder)/'diagram.mmd'
                source.write_text(code, encoding='utf-8')
                partial = Path(folder)/name
                result = subprocess.run([str(binary), str(source), str(partial), str(library), args.theme, args.background],
                                        capture_output=True, text=True, timeout=30, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                if result.returncode or not partial.exists():
                    try:
                        detail = json.loads(result.stdout).get('error')
                    except ValueError:
                        detail = result.stderr.strip()[-300:]
                    diagrams.append({'code': code, 'error': detail or 'Mermaid 렌더링 실패'})
                    continue
                shutil.move(str(partial), str(target))
        width, height = png_size(target)
        # The PNG is drawn at 2x; the tab lays it out at CSS pixel size.
        diagrams.append({'code': code, 'path': f'mods/project-docs-tabs/.cache/{name}', 'width': width / 2, 'height': height / 2})
    print(json.dumps({'diagrams': diagrams}, ensure_ascii=False))


if __name__ == '__main__':
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    sys.exit(main())
