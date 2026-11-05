#!/usr/bin/env python3
"""Read-only project document selection; only explicit pin commands write pin rules.

The CLI prints ``catalog()``: pins first, then every document in the space's folders with
its kind, version family and state, then the harness view. ``resolve()`` is the older
pins-plus-recent selection that pin commands still validate against.
"""
import sys
import argparse
from datetime import date, datetime, timedelta
import file_lock as fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import unicodedata

from collect_docs import EXTENSIONS, atomic_json, documents, is_archived
import doc_catalog

DEFAULT_KEYWORDS = ['결정', '확인요청', '확인 요청', '회신', '질의', '검토결과', '검토 결과']
DATE_PREFIX = re.compile(r'^(\d{8}|\d{4}-\d{2}-\d{2})[_\- ]+(.+)$')


def normalized(value):
    return unicodedata.normalize('NFC', str(value))


def dated_topic(name):
    match = DATE_PREFIX.match(normalized(name))
    if not match:
        return None, normalized(name)
    try:
        stamp = datetime.strptime(match[1], '%Y-%m-%d' if '-' in match[1] else '%Y%m%d').date()
    except ValueError:
        return None, normalized(name)
    return stamp, match[2]


def identity(root, topic):
    return 'topic-' + hashlib.sha256((str(Path(root).expanduser().resolve()) + '\0' + normalized(topic)).encode()).hexdigest()[:16]


def checked_path(path, root=None):
    """Never treat a symlink, archive or escaped candidate as an approved original."""
    path = Path(path).expanduser()
    if not path.is_absolute() or is_archived(path) or path.suffix.lower() not in EXTENSIONS:
        raise ValueError('unsupported_path')
    if path.is_symlink():
        raise ValueError('symlink_excluded')
    if root is not None:
        root = Path(root).expanduser()
        if root.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError('outside_root')
        # Reject symlink directory hops even if their destination remains inside root.
        relative = path.absolute().relative_to(root.absolute())
        cursor = root
        for component in relative.parts:
            cursor = cursor / component
            if cursor.is_symlink():
                raise ValueError('symlink_excluded')
    return path


def scan(folders, warnings):
    approved = []
    for entry in folders:
        root = Path(entry if isinstance(entry, str) else entry['path']).expanduser()
        if not root.is_absolute() or root.is_symlink() or is_archived(root):
            warnings.append('source_excluded:' + str(root))
            continue
        approved.append(entry)
    result = []
    for item in documents(approved, warnings, include_archived=False):
        try:
            checked_path(item['path'], item['sourceRoot'])
        except (OSError, ValueError):
            continue
        result.append(item)
    return result


def rule_document(rule, cache, warnings, today):
    base = {key: rule[key] for key in ('id', 'label', 'kind') if key in rule}
    base.update(pinned=True, path=None, status='missing')
    try:
        if rule.get('kind', 'file') == 'file':
            path = checked_path(rule['path'], rule.get('root', str(Path(rule['path']).expanduser().parent)))
            base.update(path=str(path), name=path.name, root=str(path.parent))
            if path.is_file():
                base.update(mtime=path.stat().st_mtime_ns // 1_000_000, status='ok')
            else:
                base['error'] = 'file_missing'
            return base
        if rule['kind'] != 'latest':
            raise ValueError('unknown_pin_kind')
        root = str(Path(rule['root']).expanduser())
        topic = normalized(rule['topic'])
        base.update(root=root, topic=topic)
        if root not in cache:
            cache[root] = scan([root], warnings)
        matches = []
        for item in cache[root]:
            relative = Path(item['path']).relative_to(Path(root).resolve())
            depth = 1 if rule.get('recursive') is False else rule.get('depth')
            if depth is not None and len(relative.parts) > int(depth):
                continue
            stamp, candidate = dated_topic(item['name'])
            if candidate == topic and stamp and stamp <= today:
                matches.append((stamp, item))
        if not matches:
            base['error'] = 'topic_missing'
            return base
        newest = max(stamp for stamp, _ in matches)
        candidates = [item for stamp, item in matches if stamp == newest]
        if len(candidates) != 1:
            base.update(status='conflict', error='same_date_conflict', candidates=[item['path'] for item in candidates])
            return base
        base.update(candidates[0], status='ok', root=root, topic=topic, date=newest.isoformat())
        return base
    except (OSError, ValueError, KeyError) as error:
        base.update(status='error', error=str(error))
        return base


def resolve(config, space_id, today=None):
    today = today or date.today()
    if config.get('version') != 1 or not isinstance(config.get('spaces'), dict):
        raise ValueError('Expected version:1 and spaces mapping')
    if space_id not in config['spaces']:
        raise ValueError('Unknown space: ' + space_id)
    settings = config['spaces'][space_id]
    warnings, cache = [], {}
    pins = settings.get('pins', [])
    if len({pin['id'] for pin in pins}) != len(pins):
        raise ValueError('Duplicate pin IDs')
    selected = [rule_document(pin, cache, warnings, today) for pin in pins]
    recent = settings.get('recent', {})
    days = max(0, int(recent.get('days', 14)))
    limit = max(0, min(12, int(recent.get('limit', 6))))
    keywords = [normalized(term).casefold() for term in recent.get('keywords', DEFAULT_KEYWORDS)]
    excluded = set(settings.get('excluded', []))
    groups = {}
    for item in scan(settings.get('folders', []), warnings):
        stamp, topic = dated_topic(item['name'])
        if not any(term in normalized(item['name']).casefold() for term in keywords):
            continue
        effective = stamp or datetime.fromtimestamp(item['mtime'] / 1000).date()
        if not today - timedelta(days=max(0, days - 1)) <= effective <= today or not days:
            continue
        # Files sharing a basename in separate source folders are independent topics.
        root = item['folder']
        item_id = identity(root, topic)
        if item_id in excluded:
            continue
        if any(pin.get('path') == item['path'] or
               (pin.get('kind') == 'latest' and normalized(pin.get('topic', '')) == topic and
                Path(item['path']).is_relative_to(Path(pin['root']).expanduser().resolve())) for pin in pins):
            continue
        groups.setdefault(item_id, []).append((effective, item, topic, stamp))
    candidates = []
    for item_id, values in groups.items():
        newest = max(value[0] for value in values)
        latest = [value for value in values if value[0] == newest]
        # Undated files cannot share an exact basename within one directory.
        latest.sort(key=lambda value: value[1]['path'])
        _, item, topic, stamp = latest[0]
        entry = dict(item, id=item_id, label=Path(topic).stem, kind='latest' if stamp else 'file',
                     topic=topic, root=item['folder'], pinned=False, date=newest.isoformat(), status='ok')
        if len(latest) > 1:
            entry.update(path=None, status='conflict', error='same_date_conflict', candidates=[value[1]['path'] for value in latest])
        candidates.append(entry)
    candidates.sort(key=lambda item: (item['date'], item['mtime'], item['id']), reverse=True)
    roots = [str(Path(entry if isinstance(entry, str) else entry['path']).expanduser()) for entry in settings.get('folders', [])]
    roots += [str(Path(pin.get('root', str(Path(pin.get('path', '/')).parent))).expanduser()) for pin in pins]
    return {'version': 1, 'spaceId': space_id, 'name': settings.get('name', space_id),
            'checkedAt': datetime.now().astimezone().isoformat(), 'documents': selected + candidates[:limit],
            'warnings': sorted(set(warnings)), 'watchRoots': sorted(set(roots))}


def catalog(config, space_id, today=None, app_home=None):
    """Everything the 문서 tab lists for one space; reads files, never changes them."""
    today = today or date.today()
    base = resolve(config, space_id, today)
    settings = config['spaces'][space_id]
    kinds = doc_catalog.kinds_for(config, settings)
    days = int((settings.get('recent') or {}).get('highlightDays', doc_catalog.RECENT_DAYS))
    warnings = list(base['warnings'])
    approved = []
    for entry in settings.get('folders', []):
        root = Path(entry if isinstance(entry, str) else entry['path']).expanduser()
        if root.is_absolute() and not root.is_symlink() and not is_archived(root):
            approved.append(entry)
    pins = [d for d in base['documents'] if d.get('pinned')]
    rows = doc_catalog.build(documents(approved, warnings, include_archived=True), pins, kinds, today, days)
    by_path = {row['path']: row for row in rows}
    for pin in pins:
        row = by_path.get(pin.get('path'))
        if row:
            pin.update({key: row[key] for key in ('kind', 'family', 'date', 'modified', 'recent', 'folder') if key in row})
            pin['versions'] = row.get('versions', [])
            for other in rows:
                if other.get('head') == row['id']:
                    other['head'] = pin['id']
            rows.remove(row)
        elif pin.get('name'):
            pin['kind'] = doc_catalog.classify(pin['name'], '', kinds)
            if pin.get('mtime'):
                stamp, _ = doc_catalog.document_date(pin['name'], (), pin['mtime'])
                pin.update(date=stamp.isoformat(), recent=today - timedelta(days=max(0, days - 1)) <= stamp <= today)
        pin.setdefault('kind', doc_catalog.OTHER['id'])
    # A pinned head may be a different path than the catalog head; keep one head per family.
    pinned_families = {pin.get('family') for pin in pins if pin.get('family')}
    for row in rows:
        if row['family'] in pinned_families and row['state'] == 'latest':
            row['state'] = 'previous'
            row['head'] = next(pin['id'] for pin in pins if pin.get('family') == row['family'])
    # Newest write first, whatever date the file name carries.
    rows.sort(key=lambda r: (r['mtime'], r['date'], r['id']), reverse=True)
    override = (settings.get('harness') or {}).get('root')
    root = doc_catalog.harness_root(space_id, app_home or app_home_default(), override)
    harness, sections = [], []
    if root:
        known = {d['path']: d['id'] for d in pins + rows if d.get('path')}
        harness, sections = doc_catalog.harness(root, known)
    order = [kind['id'] for kind in kinds]
    order.sort(key=lambda kind: doc_catalog.DISPLAY.index(kind) if kind in doc_catalog.DISPLAY else len(doc_catalog.DISPLAY))
    order.append(doc_catalog.OTHER['id'])
    labels = {kind['id']: kind['label'] for kind in kinds} | {doc_catalog.OTHER['id']: doc_catalog.OTHER['label']}
    return {'version': 2, 'spaceId': space_id, 'name': base['name'], 'checkedAt': base['checkedAt'],
            'documents': pins + rows + harness, 'warnings': sorted(set(warnings)),
            'watchRoots': sorted(set(base['watchRoots'] + ([str(root)] if root else []))),
            'kinds': [{'id': kind, 'label': labels[kind]} for kind in order], 'recentDays': days,
            'harness': {'root': str(root), 'sections': sections} if root else None}


def app_home_default():
    return Path(os.environ.get('HERDR_APP_HOME', Path.home() / '.config/herdr-app'))


def mutate(config, space_id, pin_path=None, unpin=None, pin_id=None):
    settings = config['spaces'][space_id]
    settings.setdefault('pins', [])
    settings.setdefault('excluded', [])
    if unpin:
        item = next((item for item in resolve(config, space_id)['documents'] if item['id'] == unpin), None)
        if item and item.get('root') and item.get('name'):
            _, topic = dated_topic(item['name'])
            auto_id = identity(str(Path(item['path']).parent) if item.get('path') else item['root'], topic)
            if auto_id not in settings['excluded']:
                settings['excluded'].append(auto_id)
        settings['pins'] = [pin for pin in settings['pins'] if pin['id'] != unpin]
        if unpin not in settings['excluded']:
            settings['excluded'].append(unpin)
        return
    if pin_id:
        item = next((item for item in resolve(config, space_id)['documents'] if item['id'] == pin_id), None)
        if item is None or item['status'] != 'ok':
            raise ValueError('Document is unavailable')
        pin_path = item['path']
    path = checked_path(pin_path)
    if not path.is_file():
        raise ValueError('Document is unavailable')
    stamp, topic = dated_topic(path.name)
    root = str(path.parent)
    item_id = identity(root, topic)
    rule = {'id': item_id, 'label': Path(topic).stem, 'kind': 'latest' if stamp else 'file'}
    if stamp:
        rule.update(root=root, topic=topic, recursive=False)
    else:
        rule.update(path=str(path))
    settings['pins'] = [pin for pin in settings['pins'] if pin['id'] != item_id]
    settings['pins'].append(rule)
    settings['excluded'] = [item for item in settings['excluded'] if item != item_id]


def main():
    default = Path(os.environ.get('HERDR_APP_HOME', Path.home() / '.config/herdr-app')) / 'data/sixfold/project-docs-pins.json'
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=default)
    parser.add_argument('--space', required=True)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--pin')
    actions.add_argument('--pin-id')
    actions.add_argument('--unpin')
    args = parser.parse_args()
    try:
        if args.pin or args.pin_id or args.unpin:
            with args.config.with_suffix('.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                config = json.loads(args.config.read_text(encoding='utf-8'))
                resolve(config, args.space)  # Validate before writing user rules.
                mutate(config, args.space, args.pin, args.unpin, args.pin_id)
                atomic_json(args.config, config)
        else:
            config = json.loads(args.config.read_text(encoding='utf-8'))
        print(json.dumps(catalog(config, args.space), ensure_ascii=False))
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    main()
