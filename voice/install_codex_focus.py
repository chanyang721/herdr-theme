#!/usr/bin/env python3
"""Install the sidebar-independent Codex mic guard as a user LaunchAgent."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys

JOB = 'herdr-codex-focus'


def label(home=None):
    """'<label_prefix>.herdr-codex-focus'; the prefix is machine-local (site.local.json)."""
    home = Path(home or Path.home())
    try:
        prefix = json.loads((home / '.config/herdr-app/data/sixfold/site.local.json').read_text()).get('label_prefix')
    except (OSError, ValueError, AttributeError):
        prefix = None
    return f"{prefix if isinstance(prefix, str) and prefix else 'local.herdr-sixfold'}.{JOB}"


LABEL = label()


def install(home, root, python, start=True):
    guard = root / 'codex_focus.py'
    if not guard.is_file():
        raise SystemExit('codex_focus.py is missing')
    state = home / '.local/state/herdr/plugins/local.focus-queue'
    state.mkdir(parents=True, exist_ok=True)
    agents = home / 'Library/LaunchAgents'
    agents.mkdir(parents=True, exist_ok=True)
    name = label(home)
    path = agents / (name + '.plist')
    value = {'Label': name, 'ProgramArguments': [str(python), str(guard), '--serve'],
             'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 5,
             'EnvironmentVariables': {'PATH': str(home / '.local/bin') + ':/opt/homebrew/bin:/usr/bin:/bin',
                                      'HERDR_PLUGIN_STATE_DIR': str(state)},
             'StandardOutPath': str(state / 'codex-focus-monitor.log'),
             'StandardErrorPath': str(state / 'codex-focus-monitor.log')}
    temporary = path.with_suffix('.tmp')
    temporary.write_bytes(plistlib.dumps(value))
    temporary.replace(path)
    if start:
        domain = 'gui/' + str(os.getuid())
        # Restart only our monitor. Voice calls and the app remain untouched.
        subprocess.run(['launchctl', 'bootout', domain + '/' + name], capture_output=True)
        subprocess.run(['launchctl', 'bootstrap', domain, str(path)], check=True)
    print(f'Codex focus guard installed: {path}; manual mute preserved; no voice connection toggled')
    return path


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target-home', type=Path, default=Path.home())
    parser.add_argument('--no-start', action='store_true')
    parser.add_argument('--uninstall', action='store_true')
    args = parser.parse_args()
    if args.target_home.resolve() != Path.home().resolve() and not args.no_start:
        parser.error('an isolated target home requires --no-start')
    if args.uninstall:
        name = label(args.target_home)
        if not args.no_start:
            subprocess.run(['launchctl', 'bootout', 'gui/' + str(os.getuid()) + '/' + name], capture_output=True)
        (args.target_home / 'Library/LaunchAgents' / (name + '.plist')).unlink(missing_ok=True)
    else:
        install(args.target_home, Path(__file__).resolve().parent, Path(sys.executable), not args.no_start)
