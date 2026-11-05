#!/usr/bin/env python3
"""Install or update managed Herdr Theme files while preserving personal settings."""
import sys
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import workspace_mods  # noqa: E402

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


def install(repo, app, update=False, extra=()):
    """extra: (source file, path under the app home) pairs installed like the theme's own mods."""
    manifest_path = app/'data/sixfold/install-manifest.json'
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        if not isinstance(manifest, dict):
            raise ValueError('Invalid install manifest')
    else:
        manifest = {}
    files = [(p, app/p.relative_to(repo)) for folder in ('layouts', 'themes', 'mods')
             for p in sorted((repo/folder).rglob('*')) if p.is_file() and p.name not in GENERATED]
    helpers = ('workspace.py', 'core_api.py', 'balance_grid.py', 'collect_computers.py', 'route.py', 'collaborate.py', 'update_install.py', 'workspace_mods.py',
               'file_lock.py', 'agent_env.py', 'site_config.py', 'desktop.py', 'install_doc_tabs.py', 'resolve_doc_pins.py',
               'doc_catalog.py', 'doc_routing.py', 'collect_docs.py', 'open_doc_tab.py', 'render_mermaid.py', 'render_html.py')
    files += [(repo/'scripts'/name, app/'scripts/sixfold'/name) for name in helpers]
    files += [(src, app/rel) for src, rel in extra]
    # Reference palettes belong to Herdr/the user, even in update mode.
    files = [(src, dst) for src, dst in files
             if not (src.parent == repo/'themes' and src.name in REFERENCES and dst.exists())]
    keyfile = app/'keys.json'
    original = keyfile.read_text(encoding='utf-8') if keyfile.exists() else '{}'
    existing = json.loads(original)
    fragment = json.loads((repo/'keys.json').read_text(encoding='utf-8'))
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
                atomic_text(dst, src.read_text(encoding='utf-8'))
    rendered = json.dumps(existing, ensure_ascii=False, indent=2)+'\n'
    if json.loads(original) != existing:
        if keyfile.exists() and not keyfile.with_name('keys.json.before-sixfold').exists():
            atomic_text(keyfile.with_name('keys.json.before-sixfold'), original)
        atomic_text(keyfile, rendered)
    manifest_text = json.dumps(next_manifest, ensure_ascii=False, indent=2, sort_keys=True)+'\n'
    if not manifest_path.exists() or manifest_path.read_text(encoding='utf-8') != manifest_text:
        atomic_text(manifest_path, manifest_text)


def later_command(argv, home, windows=None):
    """A command to paste later, quoted for the shell people use there, naming this app home
    (the document viewer installer reads HERDR_APP_HOME, not --home)."""
    windows = sys.platform == 'win32' if windows is None else windows
    if windows:
        quote = lambda value: "'" + str(value).replace("'", "''") + "'"
        return f"$env:HERDR_APP_HOME = {quote(home)}; & " + ' '.join(quote(part) if not part.startswith('-') else part for part in map(str, argv))
    import shlex
    return f"HERDR_APP_HOME={shlex.quote(str(home))} " + shlex.join(map(str, argv))


def install_document_viewer(checkout, pin, home):
    """The document viewer installs into a personal layout with a Files panel and fetches its own
    reviewed upstream, so it runs its own installer — only when it is not installed yet."""
    if (home/'mods/sixfold-docs').exists() or (home/'mods/sixfold-files').exists():
        return
    script = checkout/pin['document_viewer']
    layout = workspace_mods.has_files_layout(home)
    command = [sys.executable, str(script), '--layout', layout or '<layout>'] + ([] if sys.platform == 'darwin' else ['--markdown-only'])
    if not layout:
        print('Document viewer: no layout with a Files panel yet (start Herdr once). Later:')
        print('  ' + later_command(command, home))
        return
    result = subprocess.run(command, env={**os.environ, 'HERDR_APP_HOME': str(home)})
    if result.returncode:
        print('Document viewer was not installed (see above); the rest of the install is done.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path(os.environ.get('HERDR_APP_HOME', Path.home()/'.config/herdr-app')))
    parser.add_argument('--update', action='store_true', help='Update managed mods; preserve personal keys/settings and modified layouts/colors')
    parser.add_argument('--without-workspace-mods', action='store_true',
                        help='Do not install the pinned Herdr Workspace Mods (the sixfold monitor strip then needs them installed separately)')
    parser.add_argument('--workspace-mods-source', type=Path,
                        help='A local Herdr Workspace Mods checkout already at the pinned commit (default: fetch it)')
    args = parser.parse_args()
    repo, home = Path(__file__).resolve().parents[1], args.home.expanduser()
    extra, pin = [], None
    if not args.without_workspace_mods:
        try:
            pin, checkout, extra = workspace_mods.pinned_files(repo, args.workspace_mods_source)
        except (workspace_mods.PinError, subprocess.CalledProcessError, OSError) as error:
            raise SystemExit(f'Could not get Herdr Workspace Mods {error}; nothing was installed. '
                             'Retry, or pass --without-workspace-mods.')
    install(repo, home, args.update, extra)
    print(f'Installed Herdr Theme in {args.home}')
    if pin:
        workspace_mods.record(home, pin)
        print(f"With Herdr Workspace Mods {pin.get('tag') or pin['commit'][:12]}: {', '.join(sorted(pin['mods']))}")
        install_document_viewer(checkout, pin, home)
    print('herdr-app check '+str(args.home/'mods/sixfold-desk'))
    print('herdr-app do layout.switch --name sixfold')


if __name__ == '__main__':
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    main()
