#!/usr/bin/env python3
"""Install Herdr Theme without replacing another layout or existing key bindings."""
import argparse
import json
import os
import shutil
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path(os.environ.get('HERDR_APP_HOME', Path.home()/'.config/herdr-app')))
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    destinations = [(p, args.home/p.relative_to(repo)) for folder in ('layouts','themes','mods')
                    for p in (repo/folder).rglob('*') if p.is_file()]
    destinations += [(repo/'scripts'/name, args.home/'scripts/sixfold'/name)
                     for name in ('workspace.py','core_api.py','balance_grid.py','collect_computers.py','route.py','collaborate.py')]
    # Herdr already supplies these names. Preserve installed/customized palettes.
    references = {'atom-one-dark.json', 'win98.json'}
    destinations = [(source, destination) for source, destination in destinations
                    if not (source.parent == repo/'themes' and source.name in references and destination.exists())]
    for source, destination in destinations:
        if destination.exists():
            raise SystemExit(f'Already exists; refusing to overwrite: {destination}')
    keyfile = args.home/'keys.json'
    original = keyfile.read_text() if keyfile.exists() else '{}'
    existing = json.loads(original)
    fragment = json.loads((repo/'keys.json').read_text())
    for section, bindings in fragment.items():
        if section in existing:
            raise SystemExit(f'Key section already exists: {section}')
        existing[section] = bindings
    for source, destination in destinations:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    if keyfile.exists():
        backup = keyfile.with_name('keys.json.before-sixfold')
        if not backup.exists():
            backup.write_text(original)
    keyfile.write_text(json.dumps(existing,ensure_ascii=False,indent=2)+'\n')
    print(f'Installed Herdr Theme in {args.home}')
    print('herdr-app check '+str(args.home/'mods/sixfold-desk'))
    print('herdr-app do layout.switch --name sixfold')


if __name__ == '__main__':
    main()
