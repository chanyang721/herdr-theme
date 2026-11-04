#!/usr/bin/env python3
"""Read-only catalog for a space's 문서 tab: kind, version family, state and the harness view.

Nothing here writes, moves or renames a document. Classification only changes how the
tab lists files. Project-specific words belong in the local rule file
(``project-docs-pins.json`` → ``classify``), not in this module.
"""
from datetime import date, datetime, timedelta
import functools
import hashlib
import json
import os
from pathlib import Path
import re
import unicodedata

# Generic defaults; a space or the whole rule file may replace them with ``classify.kinds``.
# The first kind whose term appears in the file name (NFC, casefolded) wins.
DEFAULT_KINDS = [
    {'id': 'reply', 'label': '회신안', 'terms': ['회신', '답변', 'reply', 'response', '질의', '문의']},
    {'id': 'structure', 'label': '구조도', 'terms': ['구조', 'architecture', '아키텍처', '설계', 'design', 'diagram', '구성',
                                                'spec', '흐름', 'flow', 'microservice', 'integration', '연동']},
    {'id': 'status', 'label': '현황', 'terms': ['현황', 'status', '점검', '진행', '대기', '태스크', 'task', 'todo', 'next']},
    {'id': 'report', 'label': '보고서', 'terms': ['보고서', 'report', '견적', '산정', '범위', '분석', '검토', 'review', 'cost',
                                              'estimate', '비교', '요약', 'summary', 'wbs', '요구사항', '분류', 'plan']},
    {'id': 'decision', 'label': '결정', 'terms': ['결정', 'decision', 'adr', '확인요청', '확인 요청', '기준점', '조건', '착수',
                                              '승인', '계약']},
    {'id': 'account', 'label': '계정·환경', 'terms': ['계정', '환경', 'account', 'env', '북마크', 'bookmark', 'setup', '설정',
                                                 '권한', 'deploy', '배포', 'guide', '가이드', 'readme']},
    {'id': 'record', 'label': '기록', 'terms': ['기록', 'log', 'history', '회의', '미팅', 'meeting', 'weekly', '주간', '메모',
                                            'memo', 'notes', '정리', 'rehearsal', '리허설', 'test']},
]
OTHER = {'id': 'other', 'label': '기타'}
# Matching order above is not the listing order; the tab lists default kinds in this order.
DISPLAY = ['report', 'reply', 'decision', 'status', 'structure', 'account', 'record']
RECENT_DAYS = 7
# The same document saved in several formats lists the editable one first.
FORMATS = {'.md': 3, '.html': 2, '.htm': 2, '.pdf': 1}
# Readable or openable documents; generated harness files are Markdown.
EXTENSIONS = {'.md', '.html', '.htm', '.pdf', '.docx', '.xlsx', '.txt'}

DATE = re.compile(r'^(\d{8}|\d{4}-\d{2}-\d{2})(?:[_\- ]+|$)')
# Earlier copies keep the original name plus a marker: x.before-1103.md, x.v1-before-review.md.
BEFORE = re.compile(r'[._\- ](?:v\d+[._\-])?before(?:[._\-].*)?$', re.I)
VERSION = re.compile(r'[._\- ]v\d+$', re.I)
COPY = re.compile(r'\s*\((?:\d+|사본|copy)\)$', re.I)
# Variant words that name the same document at another stage; the rank orders same-date ties.
VARIANTS = {'최종': 3, 'final': 3, '공유본': 2, 'shared': 2, '최신본': 2, '수정본': 1, 'revised': 1,
            '초안': 0, 'draft': 0, '사본': 0, 'copy': 0}
VARIANT = re.compile(r'[._\- ](' + '|'.join(sorted(VARIANTS, key=len, reverse=True)) + r')$', re.I)
HASH = re.compile(r'[._\-]([0-9a-f]{7,40})$')
HARNESS_PREFIX = re.compile(r'^(?:pin|topic)-[0-9a-f]{8,}-')


def nfc(value):
    return unicodedata.normalize('NFC', str(value))


def fold(value):
    return nfc(value).casefold()


def parse_date(text):
    match = DATE.match(nfc(text))
    if not match:
        return None
    try:
        return datetime.strptime(match[1], '%Y-%m-%d' if '-' in match[1] else '%Y%m%d').date()
    except ValueError:
        return None


def strip_date(text):
    text = nfc(text)
    match = DATE.match(text)
    return text[match.end():] if match and parse_date(text) and text[match.end():] else text


def family_key(name):
    """Name shared by every version of one document, plus whether this file is an earlier copy."""
    stem = Path(strip_date(name)).stem
    before = bool(BEFORE.search(stem))
    stem = BEFORE.sub('', stem)
    variant = None
    while True:
        changed = COPY.sub('', VERSION.sub('', stem))
        match = VARIANT.search(changed)
        if match:
            variant = variant or match[1].casefold()
            changed = changed[:match.start()]
        if changed == stem or not changed:
            break
        stem = changed
    return fold(stem).replace(' ', '_').replace('-', '_'), before, variant


def label_of(name, prefix=None):
    """Readable label: no date prefix, no extension, short hash, optional shared prefix removed."""
    stem = HARNESS_PREFIX.sub('', Path(strip_date(name)).stem)
    stem = Path(strip_date(stem)).stem if parse_date(stem) else stem
    if prefix and fold(stem).startswith(prefix) and len(stem) > len(prefix) + 1:
        stem = stem[len(prefix):].lstrip('_- ')
    match = HASH.search(stem)
    if match and re.search(r'\d', match[1]) and len(stem) > len(match[0]):
        stem = stem[:match.start()] + ' #' + match[1][:6]
    return stem.replace('_', ' ').strip() or nfc(name)


def common_prefix(names):
    """A first word most file names share (a project name, say) adds nothing to a label."""
    words = {}
    for name in names:
        first = re.split(r'[_\- ]', Path(strip_date(name)).stem, maxsplit=1)
        if len(first) == 2 and first[0]:
            words[fold(first[0])] = words.get(fold(first[0]), 0) + 1
    if not words:
        return None
    word, count = max(words.items(), key=lambda item: item[1])
    return word if count >= 3 and count >= 0.6 * len(names) else None


def kinds_for(config, settings):
    custom = (settings.get('classify') or {}).get('kinds') or (config.get('classify') or {}).get('kinds')
    kinds = custom if isinstance(custom, list) and custom else DEFAULT_KINDS
    return [{'id': str(k['id']), 'label': str(k.get('label', k['id'])), 'terms': [fold(t) for t in k.get('terms', [])]}
            for k in kinds if isinstance(k, dict) and k.get('id')]


def classify(name, relative, kinds):
    """A folder named for a kind (adr/, 회신/) decides first; then the file name."""
    folders = [fold(strip_date(part)) for part in Path(relative).parts if part not in ('', '.')]
    for text in [*reversed(folders), fold(strip_date(name))]:
        for kind in kinds:
            if any(term and term in text for term in kind['terms']):
                return kind['id']
    return OTHER['id']


def document_date(name, relative_parts, mtime):
    """Date in the file name, else in a parent folder name, else the modification day."""
    for part in [name, *reversed(relative_parts)]:
        found = parse_date(part)
        if found:
            return found, True
    return datetime.fromtimestamp(mtime / 1000).date(), False


def doc_id(path):
    return 'doc-' + hashlib.sha256(nfc(path).encode()).hexdigest()[:16]


def build(items, pins, kinds, today=None, recent_days=RECENT_DAYS):
    """Turn scanned files into catalog rows. ``items`` come from collect_docs.documents.

    Each family keeps one head (the newest non-copy); the others are ``previous`` and listed
    under it. Files in archive folders are ``archived`` and never become a head.
    """
    today = today or date.today()
    since = today - timedelta(days=max(0, recent_days - 1))
    prefix = common_prefix([item['name'] for item in items])
    pinned_paths = {pin['path']: pin for pin in pins if pin.get('path')}
    families, rows = {}, []
    for item in items:
        relative = Path(item.get('relativePath') or item['name'])
        stamp, dated = document_date(item['name'], relative.parts[:-1], item['mtime'])
        key, before, variant = family_key(item['name'])
        row = {
            'id': doc_id(item['path']), 'path': item['path'], 'name': item['name'], 'label': label_of(item['name'], prefix),
            'kind': classify(item['name'], str(relative.parent) if str(relative.parent) != '.' else '', kinds),
            # Dated copies in other folders are one document; README in two folders is two.
            'family': 'fam-' + hashlib.sha256('\0'.join(
                [item['sourceRoot'], key] + ([] if dated else [str(relative.parent)])).encode()).hexdigest()[:16],
            'date': stamp.isoformat(), 'dated': dated, 'recent': since <= stamp <= today, 'mtime': item['mtime'],
            'size': item.get('size'),
            'folder': str(relative.parent) if str(relative.parent) != '.' else '', 'pinned': False, 'status': 'ok',
            'state': 'archived' if item.get('archived') else 'latest', 'before': before, 'variant': variant,
        }
        rows.append(row)
        if row['state'] != 'archived':
            families.setdefault(row['family'], []).append(row)
    for members in families.values():
        # A pinned path heads its family; otherwise the newest date, not a before-copy,
        # the final/shared variant, the shallowest folder and the newest write win.
        members.sort(key=lambda r: (r['path'] in pinned_paths, not r['before'], r['date'], VARIANTS.get(r['variant'], 1),
                                    -r['folder'].count('/') - bool(r['folder']), FORMATS.get(Path(r['path']).suffix.lower(), 0),
                                    r['mtime']), reverse=True)
        head = members[0]
        head['versions'] = [r['id'] for r in members[1:]]
        for row in members[1:]:
            row.update(state='previous', head=head['id'], kind=head['kind'])
    return rows


def harness_root(space_id, app_home, override=None):
    """The harness view folder of this Mac's space, or None. See the harness folder contract v1."""
    if override:
        root = Path(override).expanduser()
        return root if root.is_dir() else None
    base = Path(app_home) / 'data/sixfold/harness-local/views/workspaces'
    try:
        index = json.loads((base / 'index.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    for entry in index.get('workspaces', []) if isinstance(index, dict) else []:
        if isinstance(entry, dict) and entry.get('space_id') == space_id and entry.get('machine_name') is None:
            name = str(entry.get('workspace_id', ''))
            if name and '/' not in name and not name.startswith('.'):
                root = base / name
                return root if root.is_dir() else None
    return None


HARNESS_SECTIONS = [('status', '현황'), ('history', '기록'), ('decisions', '결정'), ('docs', '주제 문서'), ('brain', '기억')]
STATUS_ORDER = ['readme.md', 'context.md', 'goal.md', 'constraints.md', 'environment.md', 'decisions.md', 'next.md', 'escalation.md']
LABELS = {'readme.md': '한눈에 보기', 'context.md': '컨텍스트', 'goal.md': '목표', 'constraints.md': '제약',
          'environment.md': '환경', 'decisions.md': '결정 요약', 'next.md': '남은 일', 'escalation.md': '막힘',
          'brain.md': '승인된 기억', 'pending.md': '승인 대기 기억'}


def _files(folder):
    """Visible files under a harness folder; generated links are followed, broken ones hidden."""
    found = []
    folder = Path(folder)
    try:
        hardlinks = json.loads((folder / '.hardlinks.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        hardlinks = {}
    hardlinks = hardlinks if isinstance(hardlinks, dict) else {}
    for directory, subdirs, names in os.walk(folder, followlinks=False):
        subdirs[:] = sorted(name for name in subdirs if not name.startswith('.'))
        for name in names:
            path = Path(directory) / name
            if name.startswith('.') or path.suffix.lower() not in EXTENSIONS:
                continue
            try:
                target = path.resolve(strict=True)
                saved = hardlinks.get(path.relative_to(folder).as_posix())
                if isinstance(saved, dict) and isinstance(saved.get('source'), str):
                    original = Path(saved['source'])
                    if target.samefile(original):
                        target = original.resolve(strict=True)
                if not target.is_file():
                    continue
                info = target.stat()
            except (OSError, RuntimeError):
                continue
            found.append((path, target, info.st_mtime_ns // 1_000_000, info.st_size))
    return found


def harness(root, known_paths=None):
    """Rows and sections for the harness view. Paths shown are the link targets."""
    known_paths = known_paths or {}
    root = Path(root)
    rows, sections = [], []

    def add(path, target, mtime, section, group='', label=None, size=None):
        relative = path.relative_to(root)
        alias = known_paths.get(str(target))
        entry = {'id': 'harness-' + hashlib.sha256(nfc(relative).encode()).hexdigest()[:16], 'path': str(target),
                 'name': path.name, 'label': label or LABELS.get(fold(path.name)) or label_of(path.name),
                 'section': section, 'group': group, 'status': 'ok', 'pinned': False, 'harness': True,
                 'mtime': mtime, 'size': size, 'relative': str(relative)}
        stamp = next((parse_date(part) for part in reversed(relative.parts) if parse_date(part)), None)
        if stamp:
            entry['date'] = stamp.isoformat()
        if alias:
            entry['aliasOf'] = alias
        rows.append(entry)
        return entry

    row = add
    status = []
    for path, target, mtime, size in _files(root):
        row = functools.partial(add, size=size)
        relative = path.relative_to(root)
        top = relative.parts[0] if len(relative.parts) > 1 else ''
        if not top or top == 'context':
            if len(relative.parts) <= 2 and fold(path.name) != 'tree.json':
                status.append(row(path, target, mtime, 'status'))
        elif top == 'history':
            month = next((p for p in relative.parts[1:-1] if re.fullmatch(r'\d{4}-\d{2}', p)), None)
            if not month:
                stamp = next((parse_date(p) for p in reversed(relative.parts) if parse_date(p)), None)
                month = stamp.strftime('%Y-%m') if stamp else '날짜 없음'
            row(path, target, mtime, 'history', month)
        elif top == 'decisions':
            row(path, target, mtime, 'decisions')
        elif top == 'docs':
            entry = row(path, target, mtime, 'docs', relative.parts[1] if len(relative.parts) > 2 else '')
            if len(relative.parts) > 3:
                # docs/<group>/<document>/<dated link>: one document kept in several versions.
                entry['bundle'] = str(relative.parent)
                entry['label'] = label_of(relative.parts[-2] + Path(path.name).suffix)
        elif top == 'brain':
            row(path, target, mtime, 'brain')
    bundles = {}
    for entry in rows:
        if entry.get('bundle'):
            bundles.setdefault(entry['bundle'], []).append(entry)
    for members in bundles.values():
        members.sort(key=lambda r: (r.get('date', ''), r['mtime'], r['name']), reverse=True)
        members[0]['versions'] = [r['id'] for r in members[1:]]
        for other in members[1:]:
            other.update(state='previous', head=members[0]['id'], label=label_of(other['name']))
    order = {name: index for index, name in enumerate(STATUS_ORDER)}
    status.sort(key=lambda r: (order.get(fold(r['name']), len(order)), r['relative']))
    for section, label in HARNESS_SECTIONS:
        members = [r for r in rows if r['section'] == section]
        if section == 'status':
            members = status
        elif section in ('history', 'decisions'):
            members.sort(key=lambda r: (r['group'], r.get('date', ''), r['relative']), reverse=True)
        else:
            members.sort(key=lambda r: (r['group'], fold(r['label'])))
        if not members:
            continue
        groups = []
        for member in members:
            if not groups or groups[-1]['label'] != member['group']:
                groups.append({'label': member['group'], 'ids': []})
            groups[-1]['ids'].append(member['id'])
        sections.append({'id': section, 'label': label, 'groups': groups})
    return rows, sections
