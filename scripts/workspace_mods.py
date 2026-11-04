#!/usr/bin/env python3
"""The Herdr Workspace Mods release this theme installs with it, pinned in workspace-mods.lock.json.

Both installers (install.py, update_install.py) call `pinned_files()`: it brings a local
checkout to the exact pinned commit and lists each layout mod's runtime files with their
installed paths (`mods/<name>/...`). Nothing here writes into the app home.
"""
import json
import os
import subprocess
from pathlib import Path

GENERATED = {'gpui-kit.d.ts', 'herdr.d.ts', 'jsconfig.json', '.DS_Store'}
SKIP_DIRS = {'__pycache__', '.cache', 'node_modules'}
LOCK_NAME = 'workspace-mods.lock.json'


class PinError(RuntimeError):
    pass


def read_pin(repo):
    pin = json.loads((Path(repo) / LOCK_NAME).read_text(encoding='utf-8'))
    commit = pin.get('commit', '')
    if len(commit) != 40 or any(c not in '0123456789abcdef' for c in commit):
        raise PinError(f'{LOCK_NAME}: commit must be a full 40-character hash')
    mods = pin.get('mods')
    if not isinstance(mods, dict) or not mods:
        raise PinError(f'{LOCK_NAME}: mods must name each mod and its folder in the release')
    for name, folder in mods.items():
        parts = Path(folder).parts
        if Path(folder).is_absolute() or '..' in parts or Path(name).name != name or not name:
            raise PinError(f'{LOCK_NAME}: unsafe mod entry {name!r}: {folder!r}')
    return pin


def default_cache():
    return Path.home() / '.local/share/herdr-sixfold/vendor/herdr-workspace-mods'


def _git(cwd, *args):
    return subprocess.run(['git', '-C', str(cwd), *args], check=True, capture_output=True, text=True,
                          encoding='utf-8', errors='replace',
                          creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).stdout.strip()


def checkout(pin, source=None):
    """A clean checkout at the pinned commit: `source` as given (never changed), else the
    vendor cache, cloned or moved to the pin when needed. Raises PinError otherwise."""
    commit = pin['commit']
    if source is not None:
        source = Path(source).expanduser()
    else:
        source = default_cache()
        fresh = not (source / '.git').exists()
        if fresh:
            source.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(['git', 'clone', '--filter=blob:none', '--no-checkout', pin['repository'], str(source)],
                           check=True, capture_output=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if fresh or not _has_head(source) or _git(source, 'rev-parse', 'HEAD') != commit:
            if not fresh and _git(source, 'status', '--porcelain'):
                raise PinError(f'{source} has local changes; not moving it to the pinned commit')
            _git(source, 'fetch', '--depth', '1', 'origin', commit)
            _git(source, 'checkout', '--detach', commit)
    try:
        head = _git(source, 'rev-parse', 'HEAD')
    except (subprocess.CalledProcessError, OSError) as error:
        raise PinError(f'Not a git checkout of Herdr Workspace Mods: {source}') from error
    if head != commit:
        raise PinError(f'{source} is at {head[:12]}, not the pinned {commit[:12]}')
    if _git(source, 'status', '--porcelain'):
        raise PinError(f'{source} has local changes; refusing to install from it')
    return source


def _has_head(source):
    try:
        _git(source, 'rev-parse', '--verify', 'HEAD')
        return True
    except subprocess.CalledProcessError:
        return False


def pinned_files(repo, source=None):
    """(pin, checkout, [(source file, Path('mods/<name>/...'))]) for every pinned mod."""
    pin = read_pin(repo)
    root = checkout(pin, source)
    files = []
    for name, folder in sorted(pin['mods'].items()):
        base = root / folder
        if not (base / 'mod.json').is_file():
            raise PinError(f'Pinned release has no mod at {folder}')
        for path in sorted(base.rglob('*')):
            rel = path.relative_to(base)
            if not path.is_file() or path.is_symlink() or path.name in GENERATED or SKIP_DIRS & set(rel.parts):
                continue
            files.append((path, Path('mods', name, *rel.parts)))
    return pin, root, files


def record(app, pin):
    """data/sixfold/workspace-mods.json: which release is installed (for people and the next update)."""
    path = Path(app) / 'data/sixfold/workspace-mods.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps({'repository': pin['repository'], 'tag': pin.get('tag'), 'commit': pin['commit'],
                       'mods': sorted(pin['mods'])}, indent=2) + '\n'
    if not path.exists() or path.read_text(encoding='utf-8') != text:
        tmp = path.with_suffix('.tmp')
        tmp.write_text(text, encoding='utf-8')
        os.replace(tmp, path)


def has_files_layout(app):
    """A personal layout with a Files panel, which the document viewer installs into; its name or None."""
    for layout in sorted((Path(app) / 'layouts').glob('*.json')):
        try:
            doc = json.loads(layout.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue

        def walk(node):
            return isinstance(node, dict) and (node.get('id') == 'files' or any(walk(c) for c in node.get('children', [])))
        if walk(doc):
            return layout.stem
    return None
