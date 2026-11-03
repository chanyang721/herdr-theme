#!/usr/bin/env python3
"""Seed local workspace pins once, resolving IDs from this computer's Herdr app."""
import argparse
import fcntl
import json
import os
import subprocess
from pathlib import Path

NAMES = ('Share', 'PeaceMinusOne', 'Medihomes')


def seed(app_home, ensure_spaces=False, command='herdr-app'):
    target = app_home/'data/sixfold/workspace-pins.local.json'
    if target.exists():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    with (target.parent/'workspace-pins-seed.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if target.exists():
            return False
        env = {**os.environ, 'HERDR_APP_HOME': str(app_home)}
        def call(*args):
            result = subprocess.run([command, *args], env=env, check=True, capture_output=True, text=True)
            return json.loads(result.stdout) if result.stdout.strip() else {}
        def spaces():
            value = call('ls')
            if not isinstance(value, dict) or not isinstance(value.get('spaces'), list):
                raise ValueError('herdr-app ls did not return a spaces array')
            return value['spaces']
        available = spaces()
        original = None
        pins = []
        for name in NAMES:
            matches = [s for s in available if s.get('machine') is None and
                       str(s.get('name', '')).casefold() == name.casefold() and
                       isinstance(s.get('id'), str) and s['id']]
            if not matches:
                if not ensure_spaces:
                    raise ValueError(f'Missing workspace {name}; use --ensure-spaces to create it')
                if original is None:
                    original = call('status')
                try:
                    call('do', 'space.new', '--name', name, '--machine', '')
                finally:
                    # Creation may select the new space. Restore this screen's
                    # previous selection without moving or recreating terminals.
                    if original.get('space'):
                        call('do', 'space.select', '--id', original['space'])
                    if original.get('focused_pane'):
                        call('do', 'pane.focus', '--pane', original['focused_pane'])
                available = spaces()
                matches = [s for s in available if s.get('machine') is None and
                           str(s.get('name', '')).casefold() == name.casefold() and
                           isinstance(s.get('id'), str) and s['id']]
                if not matches:
                    raise ValueError(f'Created workspace {name} is absent from herdr-app ls')
            pins.append({'id': matches[0]['id'], 'machine': None})
        # Exclusive creation also protects against a manual edit racing the seed.
        try:
            with target.open('x') as out:
                json.dump({'spaces': pins}, out, ensure_ascii=False, indent=2)
                out.write('\n')
        except FileExistsError:
            return False
        return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path(os.environ.get('HERDR_APP_HOME', Path.home()/'.config/herdr-app')))
    parser.add_argument('--ensure-spaces', action='store_true')
    args = parser.parse_args()
    created = seed(args.home.expanduser(), args.ensure_spaces, os.environ.get('HERDR_APP_BIN', 'herdr-app'))
    print('Seeded workspace pins' if created else 'Preserved existing workspace pins')


if __name__ == '__main__':
    main()
