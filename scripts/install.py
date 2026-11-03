#!/usr/bin/env python3
"""Install or update managed Herdr Theme files while preserving personal settings."""
import argparse
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path

GENERATED = {'gpui-kit.d.ts', 'herdr.d.ts', 'jsconfig.json', '.DS_Store'}
REFERENCES = {'atom-one-dark.json', 'win98.json'}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False, encoding='utf-8') as temp:
        temp.write(text)
        name = temp.name
    try:
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def install(repo, app, update=False):
    manifest_path = app/'data/sixfold/install-manifest.json'
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        if not isinstance(manifest, dict):
            raise ValueError('Invalid install manifest')
    else:
        manifest = {}
    files = [(p, app/p.relative_to(repo)) for folder in ('layouts', 'themes', 'mods')
             for p in sorted((repo/folder).rglob('*')) if p.is_file() and p.name not in GENERATED]
    files += [(repo/'scripts'/name, app/'scripts/sixfold'/name)
              for name in ('workspace.py', 'core_api.py', 'balance_grid.py', 'collect_computers.py', 'route.py', 'collaborate.py', 'update_install.py')]
    # Reference palettes belong to Herdr/the user, even in update mode.
    files = [(src, dst) for src, dst in files
             if not (src.parent == repo/'themes' and src.name in REFERENCES and dst.exists())]
    keyfile = app/'keys.json'
    original = keyfile.read_text() if keyfile.exists() else '{}'
    existing = json.loads(original)
    fragment = json.loads((repo/'keys.json').read_text())
    if not isinstance(existing, dict):
        raise ValueError('keys.json must be an object')
    if not update:
        for _, dst in files:
            if dst.exists():
                raise SystemExit(f'Already exists; refusing to overwrite: {dst}')
        for section in fragment:
            if section in existing:
                raise SystemExit(f'Key section already exists: {section}')
    for section, bindings in fragment.items():
        existing.setdefault(section, bindings)
    selected = []
    next_manifest = dict(manifest)
    for src, dst in files:
        rel = dst.relative_to(app).as_posix()
        # Existing layouts/palettes may contain the user's monitor arrangement or
        # colors. Only update an unchanged version previously installed by us.
        if update and dst.exists() and rel.split('/')[0] in ('layouts', 'themes'):
            if manifest.get(rel) != digest(dst):
                continue
        selected.append((src, dst))
        next_manifest[rel] = digest(src)
    # Stage each whole mod before replacing it: its imports and exports become
    # visible together, rather than as a series of incompatible file writes.
    mod_names = sorted({dst.relative_to(app).parts[1] for _, dst in selected
                        if dst.relative_to(app).parts[0] == 'mods'})
    app.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.sixfold-install-', dir=app) as temporary:
        stage = Path(temporary)
        for name in mod_names:
            pairs = [(src, dst) for src, dst in selected
                     if dst.relative_to(app).parts[:2] == ('mods', name)]
            if all(dst.exists() and src.read_bytes() == dst.read_bytes() for src, dst in pairs):
                continue
            target = app/'mods'/name
            staged = stage/name
            if target.exists():
                shutil.copytree(target, staged)
            else:
                staged.mkdir()
            for src, dst in pairs:
                out = staged/dst.relative_to(target)
                out.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, out)
            target.parent.mkdir(parents=True, exist_ok=True)
            previous = stage/(name+'.previous')
            if target.exists():
                target.rename(previous)
            try:
                staged.rename(target)
            except BaseException:
                if previous.exists():
                    previous.rename(target)
                raise
        for src, dst in selected:
            if dst.relative_to(app).parts[0] == 'mods':
                continue
            if not dst.exists() or dst.read_bytes() != src.read_bytes():
                atomic_text(dst, src.read_text())
    rendered = json.dumps(existing, ensure_ascii=False, indent=2)+'\n'
    if json.loads(original) != existing:
        if keyfile.exists() and not keyfile.with_name('keys.json.before-sixfold').exists():
            atomic_text(keyfile.with_name('keys.json.before-sixfold'), original)
        atomic_text(keyfile, rendered)
    manifest_text = json.dumps(next_manifest, ensure_ascii=False, indent=2, sort_keys=True)+'\n'
    if not manifest_path.exists() or manifest_path.read_text() != manifest_text:
        atomic_text(manifest_path, manifest_text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path(os.environ.get('HERDR_APP_HOME', Path.home()/'.config/herdr-app')))
    parser.add_argument('--update', action='store_true', help='Update managed mods; preserve personal keys/settings and modified layouts/colors')
    args = parser.parse_args()
    install(Path(__file__).resolve().parents[1], args.home.expanduser(), args.update)
    print(f'Installed Herdr Theme in {args.home}')
    print('herdr-app check '+str(args.home/'mods/sixfold-desk'))
    print('herdr-app do layout.switch --name sixfold')


if __name__ == '__main__':
    main()
