#!/usr/bin/env python3
"""Register the 5-minute observer in dry-run mode; enable apply only after reviewed live trial."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import time

LABEL = 'co.lukuku.close-finished-spaces'


def write_changed(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_bytes() == content:
        return False
    if path.exists():
        backup = path.with_name(path.name + '.before-' + dt.datetime.now().strftime('%Y%m%d%H%M%S'))
        shutil.copy2(path, backup)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_bytes(content)
    tmp.chmod(0o600)
    tmp.replace(path)
    return True


def install(home, source, *, apply=False, execute=False):
    home, source = Path(home), Path(source)
    base = home / 'Library/Application Support/LukukuWatch'
    config_path = base / 'close-finished-spaces.json'
    source_code = (source / 'scripts/close_finished_spaces.py').read_bytes()
    helper_code = (source / 'scripts/space_job_evidence.py').read_bytes()
    code_hash = hashlib.sha256(source_code + helper_code).hexdigest()
    config = json.loads(config_path.read_text()) if config_path.exists() else json.loads((source / 'config/close-finished-spaces.example.json').read_text())
    if not config_path.exists():
        pins = home / '.config/herdr-app/data/sixfold/workspace-pins.local.json'
        if pins.exists():
            config['fixed_spaces'] = json.loads(pins.read_text()).get('spaces', [])
    if apply:
        state = json.loads((base / 'close-finished-spaces-state.json').read_text())
        trial = state.get('trial', {})
        if state.get('observer_sha256') != code_hash or trial.get('error_count', 0) or trial.get('samples', 0) < 7 or time.time() - trial.get('started_at', time.time()) < 1800 or time.time() - state.get('last_at', 0) > 660:
            raise ValueError('30-minute live dry-run with current code and 7 healthy samples is required')
        config['reviewed_dry_run_at'] = time.time()
        config['reviewed_observer_sha256'] = code_hash
    destination = base / 'close_finished_spaces.py'
    mode = '--apply' if apply else '--dry-run'
    plist_path = home / 'Library/LaunchAgents' / (LABEL + '.plist')
    plist = {'Label': LABEL, 'ProgramArguments': [sys.executable, str(destination), '--config', str(config_path), mode],
             'StartInterval': 300, 'RunAtLoad': True, 'ProcessType': 'Background', 'WorkingDirectory': str(base),
             'EnvironmentVariables': {'HOME': str(home), 'PATH': f'{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'},
             'StandardOutPath': str(base / 'close-finished-spaces.stdout.log'), 'StandardErrorPath': str(base / 'close-finished-spaces.stderr.log')}
    result = {'label': LABEL, 'mode': mode, 'script': str(destination), 'plist': str(plist_path), 'execute': execute}
    if not execute:
        return result
    write_changed(base / 'space_job_evidence.py', helper_code)
    write_changed(destination, source_code)
    write_changed(config_path, (json.dumps(config, ensure_ascii=False, indent=2) + '\n').encode())
    changed = write_changed(plist_path, plistlib.dumps(plist))
    service = f'gui/{os.getuid()}/{LABEL}'
    loaded = subprocess.run(['launchctl', 'print', service], capture_output=True).returncode == 0
    if loaded and changed:
        subprocess.run(['launchctl', 'bootout', service], check=True)
        loaded = False
    if not loaded:
        subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist_path)], check=True)
        subprocess.run(['launchctl', 'kickstart', service], check=True)
    result['loaded'] = subprocess.run(['launchctl', 'print', service], capture_output=True).returncode == 0
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path.home())
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--install', action='store_true', help='write files and register launchd; default is a plan')
    parser.add_argument('--enable-apply', action='store_true', help='review the saved trial and switch to real cleanup')
    args = parser.parse_args()
    print(json.dumps(install(args.home, args.source, apply=args.enable_apply, execute=args.install), ensure_ascii=False))


if __name__ == '__main__':
    main()
