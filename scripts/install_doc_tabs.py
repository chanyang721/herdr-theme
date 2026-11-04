#!/usr/bin/env python3
"""Install persistent document-only tabs without selecting a space, tab or pane.

Run without flags for a read-only plan. --install checks then copies only this
feature; --ensure-tabs recreates missing tabs using the already installed mod.
"""
import argparse
import copy
import file_lock as fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import unicodedata
from collect_docs import atomic_json, is_archived
from core_api import call
import site_config

MOD = 'project-docs-tabs'
KEYWORDS = ['결정', '확인요청', '확인 요청', '회신', '질의', '검토결과', 'decision', 'reply']


def readable(path):
    try:
        # Reading the document establishes that this is an available source,
        # rather than treating a remembered path or index as evidence.
        if path.is_symlink() or is_archived(path): return False
        with path.open(encoding='utf-8') as document: document.read(1024)
        return True
    except (OSError, UnicodeError): return False


def file_pin(path, label=None):
    path = Path(path).expanduser().absolute()
    if not readable(path): return None
    name = unicodedata.normalize('NFC', path.name)
    stamp = re.match(r'^(?:\d{8}|\d{4}-\d{2}-\d{2})[_ -]+(.+)$', name)
    value = {'id': 'pin-' + hashlib.sha256(str(path).encode()).hexdigest()[:16],
             'label': label or (stamp[1] if stamp else path.stem)}
    if stamp: value.update(kind='latest', root=str(path.parent), topic=stamp[1], recursive=False)
    else: value.update(kind='file', path=str(path))
    return value


def find_topic(root, suffix):
    try:
        matches = [p for p in root.glob('*.md') if unicodedata.normalize('NFC', p.name).endswith(suffix) and readable(p)]
    except OSError: return None
    # Multiple copies are not silently selected. Latest resolver handles dates.
    return sorted(matches, key=lambda p: unicodedata.normalize('NFC', p.name))[-1] if matches else None


def seed_space(space, project_config, repo, user_home=None, site=None):
    user_home = user_home or Path.home()
    name = space.get('name', '')
    settings = project_config.get('spaces', {}).get(space['id'], project_config.get('spaces', {}).get(name, {}))
    folders = copy.deepcopy(settings.get('folders', []))
    sources = []
    site = site or site_config.load()
    local = site.get('doc_tabs', {}).get(name)
    if isinstance(local, dict):
        # Project-specific documents are local data (site.local.json), not repository code.
        here = lambda value: site_config.expand(value, user_home)
        sources = [(here(item['path']), item.get('label')) for item in local.get('sources', [])]
        for item in local.get('topics', []):
            found = find_topic(here(item['root']), item['suffix'])
            if found: sources.append((found, item.get('label')))
        if not folders:
            folders = [{**item, 'path': str(here(item['path']))} if isinstance(item, dict) else str(here(item))
                       for item in local.get('folders', [])]
    elif name == 'Herdr':
        sources = [(repo/'README.ko.md', 'Herdr 사용 안내'), (repo/'docs/project-documents.md', '문서 관리')]
        if not folders: folders = [str(repo/'docs')]
    elif name == 'Voice':
        folder = Path(space.get('folder', ''))
        sources = [(folder/'README.md', '음성·포커스 대기열')]
        if not folders: folders = [str(folder)] if folder.is_absolute() else []
    elif site_config.is_hub(space, site):
        sources = [(repo/'COMMON_ROUTING.md', '프로젝트 작업 전달'), (repo/'README.ko.md', 'Herdr 사용 안내')]
        if not folders: folders = [str(repo/'docs')]
    else:
        folder = Path(space.get('folder', ''))
        if folder.is_absolute():
            sources = [(folder/'README.md', '프로젝트 안내')]
            if (folder/'docs').is_dir() and not folders: folders = [str(folder/'docs')]
    pins = [pin for path, label in sources if (pin := file_pin(path, label))]
    return {'name': name, 'folders': folders, 'pins': pins,
            'recent': {'days': 14, 'limit': 6, 'keywords': KEYWORDS}, 'excluded': []}


def local_space(space):
    return not space.get('machine') and '/' not in space['id']


def seed_config(document, existing, project_config, repo, user_home=None, site=None):
    output = copy.deepcopy(existing)
    if output.get('version') != 1 or not isinstance(output.get('spaces'), dict):
        raise ValueError('Expected pins version:1 and spaces mapping')
    for space in document.get('spaces', []):
        if local_space(space) and space['id'] not in output['spaces']:
            output['spaces'][space['id']] = seed_space(space, project_config, repo, user_home, site)
    return output


def nodes(tree):
    yield tree
    for child in tree.get('children', []): yield from nodes(child)


def ensure_document_tabs(document, app_home):
    result = copy.deepcopy(document)
    added = []
    for space in result.get('spaces', []):
        if not local_space(space): continue
        if any(node.get('content', {}).get('mod') == MOD for tab in space.get('tabs', []) for node in nodes(tab.get('root', {}))):
            continue
        token = hashlib.sha256(space['id'].encode()).hexdigest()[:24]
        props = {'spaceId': space['id'], 'resolverScript': str(app_home/'data/sixfold/doc-tabs/resolve_doc_pins.py'),
                 'installerScript': str(app_home/'data/sixfold/doc-tabs/install_doc_tabs.py')}
        tab = {'id': 'sf-docs-tab-' + token, 'name': '문서', 'root': {
            'id': 'sf-docs-pane-' + token, 'type': 'block', 'content': {'mod': MOD, 'props': props}}}
        space.setdefault('tabs', []).append(tab)
        added.append({'spaceId': space['id'], 'name': space.get('name', ''), 'tab': tab['id']})
    return result, added


def status():
    return json.loads(subprocess.check_output(['herdr-app', 'status'], text=True))


def copy_feature(repo, app_home):
    source = repo/'mods'/MOD
    # Native compatibility check is required before anything becomes visible.
    subprocess.run(['herdr-app', 'check', str(source)], check=True, capture_output=True, text=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    destinations = [(source, app_home/'mods'/MOD)]
    tabs_source = repo/'mods/sixfold-tabs/main.js'
    if tabs_source.exists():
        subprocess.run(['herdr-app', 'check', str(tabs_source.parent)], check=True, capture_output=True, text=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        destinations.append((tabs_source, app_home/'mods/sixfold-tabs/main.js'))
    for source_path, destination in destinations:
        if source_path.is_dir():
            destination.mkdir(parents=True, exist_ok=True)
            for original in source_path.rglob('*'):
                if original.is_file() and '.cache' not in original.parts and original.name not in ('gpui-kit.d.ts', 'herdr.d.ts', 'jsconfig.json'):
                    target = destination/original.relative_to(source_path)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(original, target)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_path, destination)
    scripts = app_home/'data/sixfold/doc-tabs'
    scripts.mkdir(parents=True, exist_ok=True)
    for name in ('install_doc_tabs.py', 'resolve_doc_pins.py', 'doc_catalog.py', 'collect_docs.py', 'core_api.py', 'render_mermaid.py', 'render_html.py', 'open_doc_tab.py',
                 'site_config.py'):
        shutil.copy2(repo/'scripts'/name, scripts/name)
    try:
        compile_swift(repo/'scripts/render_html.swift', scripts/'render-html')
    except RuntimeError as error:
        # Markdown still works without it; HTML documents then show the install notice.
        print(f'HTML renderer skipped: {str(error)[:300]}', file=sys.stderr)


def install_mermaid(repo, app_home, library):
    """Compile the offline WebKit renderer and copy a local mermaid.min.js beside it."""
    library = library.expanduser().resolve(strict=True)
    if library.name != 'mermaid.min.js':
        raise ValueError('Pass the mermaid package file dist/mermaid.min.js')
    tools = app_home/'data/sixfold/doc-tabs'
    (tools/'mermaid').mkdir(parents=True, exist_ok=True)
    shutil.copy2(library, tools/'mermaid/mermaid.min.js')
    notice = library.parents[1]/'LICENSE'
    if notice.exists(): shutil.copy2(notice, tools/'mermaid/LICENSE')
    compile_swift(repo/'scripts/render_mermaid.swift', tools/'render-mermaid')


def compile_swift(source, output):
    """Compile a WebKit renderer with the first macOS SDK the installed compiler accepts."""
    sdks = [Path('/Library/Developer/CommandLineTools/SDKs')/name for name in ('MacOSX26.5.sdk', 'MacOSX15.4.sdk')]
    found = subprocess.run(['xcrun', '--show-sdk-path'], capture_output=True, text=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if found.returncode == 0: sdks.append(Path(found.stdout.strip()))
    errors = []
    # The newest SDK can be ahead of the installed compiler; try known matches first.
    for sdk in dict.fromkeys(sdks):
        if not sdk.exists(): continue
        attempt = subprocess.run(['swiftc', '-O', '-sdk', str(sdk), str(source), '-o', str(output)], capture_output=True, text=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if not attempt.returncode: return
        errors.append(attempt.stderr)
    raise RuntimeError(f'A compatible macOS Swift SDK is required for {output.name}.\n' + '\n'.join(errors)[-2000:])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--install', action='store_true')
    group.add_argument('--ensure-tabs', action='store_true')
    parser.add_argument('--home', type=Path, default=Path(os.environ.get('HERDR_APP_HOME', Path.home()/'.config/herdr-app')))
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--mermaid', type=Path, help='local mermaid.min.js (npm package mermaid, dist/) for diagram images')
    args = parser.parse_args()
    if args.mermaid:
        # Diagram support is independent of the tab structure; install it on its own too.
        install_mermaid(args.repo, args.home.expanduser().absolute(), args.mermaid)
        if not (args.install or args.ensure_tabs):
            print(json.dumps({'mermaid': True}, ensure_ascii=False)); return
    app_home = args.home.expanduser().absolute()
    snapshot = call('doc.get', {'name': 'herdr-app'})
    planned, added = ensure_document_tabs(snapshot['value'], app_home)
    if not (args.install or args.ensure_tabs):
        print(json.dumps({'dryRun': True, 'added': added}, ensure_ascii=False)); return
    data = app_home/'data/sixfold'
    data.mkdir(parents=True, exist_ok=True)
    with (data/'doc-tabs-install.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        before = status()
        if args.install: copy_feature(args.repo, app_home)
        elif not (app_home/'mods'/MOD/'main.js').exists():
            raise ValueError('Install the checked document mod before ensuring tabs')
        config_file = data/'project-docs-pins.json'
        if args.install:
            existing = json.loads(config_file.read_text(encoding='utf-8')) if config_file.exists() else {'version': 1, 'spaces': {}}
            project_file = data/'project-docs.json'
            project = json.loads(project_file.read_text(encoding='utf-8')) if project_file.exists() else {}
            with config_file.with_suffix('.lock').open('a') as config_lock:
                fcntl.flock(config_lock, fcntl.LOCK_EX)
                existing = json.loads(config_file.read_text(encoding='utf-8')) if config_file.exists() else {'version': 1, 'spaces': {}}
                atomic_json(config_file, seed_config(snapshot['value'], existing, project, args.repo,
                                                         site=site_config.load(app=app_home)))
        # Reread after checks and copies; never overwrite a concurrent structure edit.
        for attempt in range(3):
            snapshot = call('doc.get', {'name': 'herdr-app'})
            planned, added = ensure_document_tabs(snapshot['value'], app_home)
            if not added: break
            try:
                call('doc.set', {'name': 'herdr-app', 'version': snapshot['version'], 'value': planned})
                break
            except RuntimeError:
                if attempt == 2: raise
        # No view.json write, tab.new, tab.select or focus restore is performed.
        if added: time.sleep(0.4)
        after = status()
        keys = ('space', 'tab', 'focused_pane')
        result = {'added': added, 'focusBefore': {key: before.get(key) for key in keys},
                  'focusAfter': {key: after.get(key) for key in keys},
                  'focusUnchanged': all(before.get(key) == after.get(key) for key in keys)}
        print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    main()
