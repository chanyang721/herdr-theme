#!/usr/bin/env python3
"""Route documents from shared folders to the space they are about; read-only.

A shared folder (reports, Downloads) holds documents for several projects. Instead of a
hand-written ``match`` per space, the local routing file lists the shared folders and,
per space name, the words that identify it. Each document goes to the one space whose
words appear most in its path, title and opening text; a tie or no word goes to the
fallback space, except for sources marked ``requireMatch`` (Downloads), whose
unmatched files are listed nowhere.

Nothing is moved, linked or renamed. Company and project words live only in the local
file (``project-docs-routing.local.json``), never in this module.

Routing file (version 1)::

    {"version": 1,
     "fallback": "Share",
     "sources": [{"path": "~/Documents/Reports"},
                 {"path": "~/Downloads", "depth": 1, "requireMatch": true}],
     "spaces": {"Project A": {"terms": ["project-a", "프로젝트A"]}}}
"""
import functools
import html
import json
import os
from pathlib import Path
import re
import unicodedata

HEAD_BYTES = 4096
# A word in the path or title says more about the subject than one in the body.
PATH_WEIGHT, TITLE_WEIGHT, BODY_WEIGHT = 3, 2, 1
TEXT_SUFFIXES = {'.md', '.txt', '.html', '.htm'}
TAG = re.compile(r'<[^>]+>')
SCRIPT = re.compile(r'<(script|style)\b.*?</\1\s*>', re.I | re.S)
TITLE = re.compile(r'<title[^>]*>(.*?)</title\s*>', re.I | re.S)
HEADING = re.compile(r'^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$', re.M)


def fold(value):
    return unicodedata.normalize('NFC', str(value)).casefold()


def default_path(app_home):
    return Path(app_home) / 'data/sixfold/project-docs-routing.local.json'


def load(path):
    """The routing settings, or None when the file is missing or not version 1."""
    try:
        data = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get('version') != 1 or not isinstance(data.get('spaces'), dict):
        return None
    sources = [s if isinstance(s, dict) else {'path': s} for s in data.get('sources', []) if isinstance(s, (dict, str))]
    spaces = {}
    for name, value in data['spaces'].items():
        terms = (value or {}).get('terms', []) if isinstance(value, dict) else value
        terms = [fold(t).strip() for t in terms if isinstance(t, str) and t.strip()] if isinstance(terms, list) else []
        if terms:
            spaces[fold(name)] = {'name': str(name), 'terms': sorted(set(terms), key=len, reverse=True)}
    return {'fallback': data.get('fallback'), 'sources': [s for s in sources if isinstance(s.get('path'), str)],
            'spaces': spaces}


@functools.lru_cache(maxsize=4096)
def _head(path, mtime, size):
    """(title, opening text) of a text document, both folded; empty for other formats."""
    del mtime, size  # Cache key only: a rewritten file is read again.
    if Path(path).suffix.lower() not in TEXT_SUFFIXES:
        return '', ''
    try:
        with open(path, 'rb') as stream:
            raw = stream.read(HEAD_BYTES * 4 if Path(path).suffix.lower() in ('.html', '.htm') else HEAD_BYTES)
    except OSError:
        return '', ''
    text = raw.decode('utf-8', errors='ignore')
    if Path(path).suffix.lower() in ('.html', '.htm'):
        match = TITLE.search(text)
        title = html.unescape(TAG.sub(' ', match[1])) if match else ''
        body = html.unescape(TAG.sub(' ', SCRIPT.sub(' ', text)))[:HEAD_BYTES]
    else:
        match = HEADING.search(text)
        title, body = (match[1] if match else ''), text
    return fold(' '.join(title.split())), fold(' '.join(body.split()))


def head(item):
    return _head(item['path'], item.get('mtime'), item.get('size'))


def scores(item, spaces):
    """Space key → score for one scanned document."""
    where = fold(' '.join(Path(item.get('relativePath') or item['name']).parts))
    title, body = None, None
    result = {}
    for key, space in spaces.items():
        score = 0
        for term in space['terms']:
            if term in where:
                score += PATH_WEIGHT
                continue
            if title is None:
                title, body = head(item)
            if term in title:
                score += TITLE_WEIGHT
            elif term in body:
                score += BODY_WEIGHT
        if score:
            result[key] = score
    return result


def target(item, routing, require_match=False):
    """Name of the space a document belongs to, or None when it is listed nowhere."""
    found = scores(item, routing['spaces'])
    if found:
        best = max(found.values())
        winners = [key for key, value in found.items() if value == best]
        if len(winners) == 1:
            return routing['spaces'][winners[0]]['name']
    if require_match and not found:
        return None
    return routing.get('fallback')


def title_of(item):
    return head(item)[0]


def routed(routing, space_name, scan, warnings=None):
    """Scanned items from the routing sources that belong to ``space_name``.

    ``scan(entries, warnings)`` is ``collect_docs.documents`` with archived files included.
    Each item gains ``routedFrom`` (the source folder) and ``title`` when one was read.
    """
    if not routing or not space_name:
        return []
    want = fold(space_name)
    known = want in routing['spaces'] or want == fold(routing.get('fallback') or '')
    if not known:
        return []
    result = []
    for source in routing['sources']:
        entry = {'path': source['path']}
        if isinstance(source.get('depth'), int) and source['depth'] > 0:
            entry['depth'] = source['depth']
        for item in scan([entry], warnings if warnings is not None else []):
            name = target(item, routing, bool(source.get('requireMatch')))
            if name is None or fold(name) != want:
                continue
            title = title_of(item)
            result.append(dict(item, routedFrom=str(Path(source['path']).expanduser()), **({'title': title} if title else {})))
    return result


def roots(routing, space_name):
    """Folders to watch for this space: every routing source when the space takes part."""
    if not routing or not space_name:
        return []
    want = fold(space_name)
    if want not in routing['spaces'] and want != fold(routing.get('fallback') or ''):
        return []
    return [str(Path(s['path']).expanduser()) for s in routing['sources']]


if __name__ == '__main__':
    import argparse
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from collect_docs import documents
    parser = argparse.ArgumentParser(description='Print where each routed document goes.')
    parser.add_argument('--routing', type=Path,
                        default=default_path(os.environ.get('HERDR_APP_HOME', Path.home() / '.config/herdr-app')))
    args = parser.parse_args()
    settings = load(args.routing)
    if not settings:
        parser.exit(1, 'no routing file\n')
    for source in settings['sources']:
        for doc in documents([{'path': source['path'], **({'depth': source['depth']} if source.get('depth') else {})}],
                             include_archived=True):
            print(target(doc, settings, bool(source.get('requireMatch'))) or '-', doc['path'], sep='\t')
