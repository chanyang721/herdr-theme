#!/usr/bin/env python3
"""Register the 5-minute space-cleanup observer in dry-run mode; enable apply only after a
reviewed live trial, or after the person approved apply and one dry-run of this code ran."""
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
CLEANUP = {
    'label': LABEL,
    'script': 'close_finished_spaces.py',
    # The order matches close_finished_spaces.OBSERVER_FILES (the reviewed hash).
    'files': ('close_finished_spaces.py', 'space_job_evidence.py', 'agent_sessions.py'),
    'config': 'close-finished-spaces.json',
    'example': 'config/close-finished-spaces.example.json',
    'state': 'close-finished-spaces-state.json',
    'log': 'close-finished-spaces',
    'pins': True,
}


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


def detect_harness(home):
    """The harness checkout this machine records into, and the Python that runs it."""
    local = Path(home) / '.config/herdr-app/data/sixfold/harness-local/config.json'
    try:
        repo = Path(json.loads(local.read_text()).get('repo_path') or '')
    except (OSError, ValueError):
        return None
    script = repo / 'runtime/harness.py'
    if not script.is_file():
        return None
    venv = Path(home) / '.local/share/herdr-harness/venv/bin/python'
    return {'python': str(venv if venv.exists() else sys.executable), 'script': str(script)}


def install_observer(home, source, spec, *, apply=False, user_approved=False, execute=False):
    home, source = Path(home), Path(source)
    base = home / 'Library/Application Support/LukukuWatch'
    config_path = base / spec['config']
    present = [name for name in spec['files'] if (source / 'scripts' / name).exists()]
    code = {name: (source / 'scripts' / name).read_bytes() for name in present}
    code_hash = hashlib.sha256(b''.join(code[name] for name in present)).hexdigest()
    config = json.loads(config_path.read_text()) if config_path.exists() else json.loads((source / spec['example']).read_text())
    if not config_path.exists() and spec.get('pins'):
        pins = home / '.config/herdr-app/data/sixfold/workspace-pins.local.json'
        if pins.exists():
            config['fixed_spaces'] = json.loads(pins.read_text()).get('spaces', [])
    harness = detect_harness(home)
    if harness and not config.get('harness'):
        config['harness'] = harness
    if apply:
        state = json.loads((base / spec['state']).read_text())
        trial = state.get('trial', {})
        current = state.get('observer_sha256') == code_hash and not trial.get('error_count', 0) and time.time() - state.get('last_at', 0) <= 660
        if user_approved:
            if not current or trial.get('samples', 0) < 1:
                raise ValueError('one recorded dry-run of the current code is required before apply')
            config['user_approved_apply'] = True
        elif not current or trial.get('samples', 0) < 7 or time.time() - trial.get('started_at', time.time()) < 1800:
            raise ValueError('30-minute live dry-run with current code and 7 healthy samples is required')
        config['reviewed_dry_run_at'] = time.time()
        config['reviewed_observer_sha256'] = code_hash
    destination = base / spec['script']
    mode = '--apply' if apply else '--dry-run'
    plist_path = home / 'Library/LaunchAgents' / (spec['label'] + '.plist')
    plist = {'Label': spec['label'], 'ProgramArguments': [sys.executable, str(destination), '--config', str(config_path), mode],
             'StartInterval': 300, 'RunAtLoad': True, 'ProcessType': 'Background', 'WorkingDirectory': str(base),
             'EnvironmentVariables': {'HOME': str(home), 'PATH': f'{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'},
             'StandardOutPath': str(base / (spec['log'] + '.stdout.log')), 'StandardErrorPath': str(base / (spec['log'] + '.stderr.log'))}
    result = {'label': spec['label'], 'mode': mode, 'script': str(destination), 'plist': str(plist_path), 'execute': execute,
              'observer_sha256': code_hash, 'harness': bool(config.get('harness'))}
    if not execute:
        return result
    for name in present:
        write_changed(base / name, code[name])
    write_changed(config_path, (json.dumps(config, ensure_ascii=False, indent=2) + '\n').encode())
    changed = write_changed(plist_path, plistlib.dumps(plist))
    service = f'gui/{os.getuid()}/{spec["label"]}'
    loaded = subprocess.run(['launchctl', 'print', service], capture_output=True).returncode == 0
    if loaded and changed:
        subprocess.run(['launchctl', 'bootout', service], check=True)
        loaded = False
    if not loaded:
        subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist_path)], check=True)
        subprocess.run(['launchctl', 'kickstart', service], check=True)
    result['loaded'] = subprocess.run(['launchctl', 'print', service], capture_output=True).returncode == 0
    return result


def install(home, source, *, apply=False, user_approved=False, execute=False):
    return install_observer(home, source, CLEANUP, apply=apply, user_approved=user_approved, execute=execute)


def main(spec=CLEANUP):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path.home())
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--install', action='store_true', help='write files and register launchd; default is a plan')
    parser.add_argument('--enable-apply', action='store_true', help='review the saved trial and switch to real actions')
    parser.add_argument('--user-approved', action='store_true',
                        help='with --enable-apply: the person approved apply; one recorded dry-run of this code suffices')
    args = parser.parse_args()
    if args.user_approved and not args.enable_apply:
        parser.error('--user-approved only goes with --enable-apply')
    print(json.dumps(install_observer(args.home, args.source, spec, apply=args.enable_apply, user_approved=args.user_approved,
                                      execute=args.install), ensure_ascii=False))


if __name__ == '__main__':
    main()
