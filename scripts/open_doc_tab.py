#!/usr/bin/env python3
"""Open a local document in its project's 문서 tab instead of an external editor."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import time
import unicodedata

MOD = 'project-docs-tabs'
REQUEST = 'project-docs-open.json'


def normalized(value):
    return unicodedata.normalize('NFC', str(value)).lower()


def choose_space(config, file, wanted=None, live=None):
    """Return the space id whose document folders or pins own the file.

    live limits the choice to spaces that exist now; rules of removed spaces stay in the config.
    """
    spaces = {k: v for k, v in config.get('spaces', {}).items() if live is None or k in live}
    if wanted:
        for space_id, settings in spaces.items():
            if wanted in (space_id, settings.get('name')):
                return space_id
        raise SystemExit(f'Unknown space: {wanted}')
    best = None
    for space_id, settings in spaces.items():
        for entry in settings.get('folders', []):
            root = Path(entry if isinstance(entry, str) else entry['path']).expanduser().resolve()
            if not file.is_relative_to(root):
                continue
            keywords = [] if isinstance(entry, str) else entry.get('match', [])
            relative = normalized(file.relative_to(root))
            if keywords and not any(normalized(word) in relative for word in keywords):
                continue
            # The most specific folder wins; a keyword rule beats a bare folder.
            score = (len(root.parts), bool(keywords))
            if best is None or score > best[0]:
                best = (score, space_id)
        for pin in settings.get('pins', []):
            if pin.get('path') and Path(pin['path']).expanduser().resolve() == file:
                return space_id
    return best[1] if best else None


def docs_tab(listing, space_id):
    for space in listing.get('spaces', []):
        if space['id'] == space_id:
            for tab in space.get('tabs', []):
                if tab.get('id', '').startswith('sf-docs-tab-'):
                    return tab['id']
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', type=Path)
    parser.add_argument('--space', help='space name or id (default: the space whose document folders contain the file)')
    parser.add_argument('--no-show', action='store_true', help='load it in the tab without switching to it')
    args = parser.parse_args()
    file = args.file.expanduser().resolve(strict=True)
    if not file.is_file():
        parser.error('select a file')
    app = Path(os.environ.get('HERDR_APP_HOME', Path.home()/'.config/herdr-app'))
    if not (app/'mods'/MOD/'main.js').exists():
        parser.error('install the document tabs first: python3 scripts/install_doc_tabs.py --install')
    config = json.loads((app/'data/sixfold/project-docs-pins.json').read_text())
    listing = json.loads(subprocess.check_output(['herdr-app', 'ls'], text=True))
    live = {space['id'] for space in listing.get('spaces', []) if docs_tab(listing, space['id'])}
    space_id = choose_space(config, file, args.space, live)
    if not space_id:
        status = json.loads(subprocess.check_output(['herdr-app', 'status'], text=True))
        space_id = status['space']
    tab = docs_tab(listing, space_id)
    if not tab:
        raise SystemExit(f'No 문서 tab in space {space_id}; run scripts/install_doc_tabs.py --install')
    path = app/'data/sixfold'/REQUEST
    # One request per space, so opening documents in two spaces at once keeps both.
    with path.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            requests = json.loads(path.read_text()).get('requests', {})
        except (OSError, ValueError, AttributeError):
            requests = {}
        requests[space_id] = {'path': str(file), 'at': time.time_ns() // 1_000_000}
        tmp = path.with_suffix('.tmp')
        tmp.write_text(json.dumps({'version': 2, 'requests': requests}, ensure_ascii=False))
        tmp.replace(path)
    if not args.no_show:
        subprocess.run(['herdr-app', 'do', 'tab.select', '--id', tab], check=True, capture_output=True, text=True)
    print(json.dumps({'space': space_id, 'tab': tab, 'file': str(file), 'shown': not args.no_show}, ensure_ascii=False))


if __name__ == '__main__':
    main()
