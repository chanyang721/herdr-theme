#!/usr/bin/env python3
"""Render one HTML report to cached PNG tiles for the 문서 tab."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from render_mermaid import png_size

# Signs that a report needs clicks, typing or popups that a still image cannot give.
# Chart libraries alone are not listed: their figures read fine as a picture.
INTERACTIVE = (
    ('클릭 이벤트', re.compile(r'<[a-z][^>]*\son(?:click|change|input|submit|toggle|mouse\w+|key\w+)\s*=', re.I)),
    # Only listeners a person triggers; load, resize and scroll handlers run without anyone.
    ('스크립트 이벤트', re.compile(r'addEventListener\s*\(\s*["\'](?:click|dblclick|change|input|submit|toggle|key\w+|mouse(?:down|up|enter|over)|pointer(?:down|up|enter|over)|touch\w+|focus)["\']|\.on(?:click|change|input|submit)\s*=', re.I)),
    ('펼침 영역', re.compile(r'<details\b', re.I)),
    ('팝업', re.compile(r'<dialog\b|\brole\s*=\s*["\']?dialog|\bdata-(?:bs-)?toggle\s*=\s*["\']?(?:modal|popover|tooltip|dropdown|collapse)|\.showModal\s*\(|\bwindow\.open\s*\(', re.I)),
    ('탭', re.compile(r'\brole\s*=\s*["\']?tab(?:list)?\b|\bdata-(?:bs-)?toggle\s*=\s*["\']?(?:tab|pill)', re.I)),
    ('입력 양식', re.compile(r'<(?:form|select|textarea|button)\b|<input\b(?![^>]*\btype\s*=\s*["\']?hidden)', re.I)),
    ('UI 라이브러리', re.compile(r'\bx-data\s*=|\bbootstrap(?:\.bundle)?(?:\.min)?\.js|\bjquery-ui\b|\balpine(?:js)?\b[^"\']*\.js', re.I)),
)
QUOTED = re.compile(r'<!--.*?-->|<(pre|code|textarea)\b[^>]*>.*?</\1>', re.I | re.S)


def interactive(text):
    """Return what in the page needs a browser, in INTERACTIVE order; empty for a static page."""
    # Comments and example markup shown as text are not part of the page's behaviour.
    text = QUOTED.sub(lambda m: '<textarea>' if m.group(1) and m.group(1).lower() == 'textarea' else '', text)
    return [label for label, pattern in INTERACTIVE if pattern.search(text)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--doc', type=Path, required=True)
    parser.add_argument('--theme', choices=('dark', 'light'), default='dark')
    parser.add_argument('--width', type=int, default=960)
    args = parser.parse_args()
    # Coarse steps keep a pane resize from rendering every pixel width; the renderer clamps too.
    args.width = min(2000, max(320, args.width // 40 * 40))
    app = Path(os.environ.get('HERDR_APP_HOME', Path.home()/'.config/herdr-app'))
    binary = app/'data/sixfold/doc-tabs/render-html'
    cache = app/'mods/project-docs-tabs/.cache'
    if not binary.exists():
        print(json.dumps({'error': 'HTML 렌더러가 설치되지 않았습니다. scripts/install_doc_tabs.py --install'}, ensure_ascii=False))
        return 1
    body = args.doc.read_bytes()
    key = hashlib.sha256(json.dumps([hashlib.sha256(body).hexdigest(),args.theme, args.width, binary.stat().st_size, binary.stat().st_mtime_ns]).encode()).hexdigest()[:24]
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
            index.write_text(json.dumps({'tiles': len(data['tiles']), 'truncated': bool(data.get('truncated'))}))
    saved = json.loads(index.read_text())
    # Indexes written before truncation was recorded hold only the tile count.
    saved = saved if isinstance(saved, dict) else {'tiles': saved, 'truncated': False}
    pages = []
    for number in range(saved['tiles']):
        width, height = png_size(cache/f'html-{key}-{number}.png')
        # Tiles are drawn at 2x; the tab lays them out at CSS pixel size.
        pages.append({'path': f'mods/project-docs-tabs/.cache/html-{key}-{number}.png', 'width': width / 2, 'height': height / 2})
    print(json.dumps({'pages': pages, 'width': args.width, 'truncated': saved['truncated'],
                      'interactive': interactive(body.decode('utf-8', 'replace'))}, ensure_ascii=False))


if __name__ == '__main__':
    sys.exit(main())
