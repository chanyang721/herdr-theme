#!/usr/bin/env python3
"""Update explicitly selected Herdr files under one lock, or roll them back."""
import argparse
import contextlib
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parent))
import workspace_mods  # noqa: E402

if sys.platform == 'win32':
    import msvcrt
else:
    import fcntl


class InstallError(RuntimeError):
    pass


def atomic_write(path, data, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        rename_with_retry(temporary, path, replace=True)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


def lock_exclusive(stream):
    """Take the install lock without waiting; BlockingIOError when another installer holds it."""
    if sys.platform == 'win32':
        stream.seek(0)
        try:
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as error:
            raise BlockingIOError(str(error)) from error
    else:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)


def rename_with_retry(source, target, attempts=25, replace=False):
    """Windows refuses a rename while a reader holds a file open; wait briefly for it."""
    for attempt in range(attempts):
        try:
            (os.replace if replace else os.rename)(source, target)
            return
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(.04)


def exchange_directories_windows(left, right):
    """Swap two directories with three renames on one volume.

    Windows has no directory-swap call, so `right` is missing for the moment
    between the first two renames. A failed second rename puts `right` back.
    """
    aside = left.parent / (left.name + '.exchange-aside')
    if aside.exists():
        raise InstallError(f'Exchange scratch path already exists: {aside}')
    rename_with_retry(right, aside)
    try:
        rename_with_retry(left, right)
    except BaseException:
        rename_with_retry(aside, right)
        raise
    rename_with_retry(aside, left)


def exchange_directories(left, right):
    """Exchange two directories in one filesystem operation (no missing-path gap)."""
    if sys.platform == 'win32':
        return exchange_directories_windows(Path(left), Path(right))
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'darwin':
        call = libc.renamex_np
        call.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        result = call(os.fsencode(left), os.fsencode(right), 2)  # RENAME_SWAP
    elif sys.platform.startswith('linux') and hasattr(libc, 'renameat2'):
        call = libc.renameat2
        call.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        result = call(-100, os.fsencode(left), -100, os.fsencode(right), 2)  # RENAME_EXCHANGE
    else:
        raise InstallError('Directory exchange requires macOS, Linux renameat2 or Windows; no unsafe fallback')
    if result:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def tree_digest(directory):
    entries = []
    for item in sorted(directory.rglob('*')):
        if any(part in ('__pycache__', '.cache') for part in item.relative_to(directory).parts):
            continue  # Python imports and rendered previews are runtime data, not another code writer.
        if item.is_symlink():
            entries.append((str(item.relative_to(directory)), 'symlink', os.readlink(item)))
        elif item.is_file():
            entries.append((str(item.relative_to(directory)), digest(item.read_bytes())))
    return digest(json.dumps(entries).encode())


def digest(data):
    return hashlib.sha256(data).hexdigest()


CONFIG_TARGETS = {
    Path('config/templates/settings.json'): Path('settings.json'),
    Path('config/templates/shared.json'): Path('shared.json'),
    Path('config/templates/data/sixfold/collaboration.json'): Path('data/sixfold/collaboration.json'),
    Path('config/templates/data/sixfold/project-docs-pins.json'): Path('data/sixfold/project-docs-pins.json'),
}


def fill_missing(current, defaults):
    if not isinstance(current, dict) or not isinstance(defaults, dict):
        raise InstallError('Portable JSON settings must be objects')
    result = dict(current)
    for key, value in defaults.items():
        if key not in result:
            result[key] = value
        elif isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = fill_missing(result[key], value)
    return result


def read_status(cli, env):
    result = subprocess.run([cli, 'status'], env=env, check=True, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=15, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    status = json.loads(result.stdout)
    if not isinstance(status, dict) or not isinstance(status.get('errors'), list):
        raise InstallError('status must contain an errors array')
    return status


def input_files(repo, home, names):
    files = []
    for name in names:
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts or (len(relative.parts) < 2 and relative != Path('keys.json')):
            raise InstallError(f'Use explicit repository-relative file paths: {name}')
        if relative.parts[0] not in ('mods', 'layouts', 'themes', 'scripts', 'bin', 'config', 'keys.json') or any(part.startswith('.') for part in relative.parts):
            raise InstallError(f'Unsupported installation target: {name}')
        if relative.parts[0] == 'mods' and ('recovery' in relative.parts[1] or len(relative.parts) < 3):
            raise InstallError('Do not clone mod directories into recovery mods')
        target_relative = relative
        if relative.parts[0] == 'scripts':
            if len(relative.parts) < 2:
                raise InstallError(f'Use scripts/<file>; installed destination is scripts/sixfold/<file>: {name}')
            target_relative = Path('scripts/sixfold', *relative.parts[1:])
        elif relative.parts[0] == 'bin':
            if len(relative.parts) < 2:
                raise InstallError(f'Use bin/<file>; installed destination is bin/sixfold/<file>: {name}')
            target_relative = Path('bin/sixfold', *relative.parts[1:])
        elif relative == Path('keys.json'):
            target_relative = Path('keys.json')
        elif relative.parts[0] == 'config':
            if relative not in CONFIG_TARGETS:
                raise InstallError(f'Only portable config templates may be installed: {name}')
            target_relative = CONFIG_TARGETS[relative]
        source, target = repo / relative, home / target_relative
        if not source.is_file() or source.is_symlink() or not source.resolve().is_relative_to(repo.resolve()):
            raise InstallError(f'Not a regular repository file: {name}')
        if any(parent.is_symlink() for parent in [target, *target.parents] if parent != home.parent):
            raise InstallError(f'Symlink installation targets are refused: {name}')
        if target.exists() and not target.is_file():
            raise InstallError(f'Not a regular installation target: {name}')
        payload = source.read_bytes()
        if source.suffix == '.json':
            value = json.loads(payload)
            def validate(node):
                if isinstance(node, dict):
                    if isinstance(node.get('mod'), str) and 'recovery' in node['mod']:
                        raise InstallError('Layouts must not reference recovery mod clones')
                    for child in node.values():
                        validate(child)
                elif isinstance(node, list):
                    for child in node:
                        validate(child)
            validate(value)
        if (relative.parts[0] == 'config' or relative == Path('keys.json')) and target.exists():
            try:
                current = json.loads(target.read_text(encoding='utf-8'))
                defaults = json.loads(payload)
            except (OSError, UnicodeError, json.JSONDecodeError) as error:
                raise InstallError(f'Could not seed portable config {target_relative}: {error}') from error
            seeded = fill_missing(current, defaults)
            if seeded != current:
                payload = (json.dumps(seeded, ensure_ascii=False, indent=2) + '\n').encode()
        if target_relative not in [item[0] for item in files]:
            files.append((target_relative, payload, source.stat().st_mode & 0o777))
    return files


def is_junction(path):
    """A Windows junction redirects like a symlink but is not reported as one before Python 3.12."""
    check = getattr(os.path, 'isjunction', None)
    return bool(check and check(path))


def pinned_inputs(pairs, home):
    """Pinned Workspace Mods files ((source, Path('mods/<name>/...'))) as update entries, with the
    same target checks as listed files: no symlinked or junctioned path inside the app home."""
    out = []
    for source, relative in pairs:
        if relative.parts[0] != 'mods' or len(relative.parts) < 3 or '..' in relative.parts or relative.is_absolute():
            raise InstallError(f'Unsupported Workspace Mods target: {relative}')
        if not source.is_file() or source.is_symlink():
            raise InstallError(f'Not a regular Workspace Mods file: {source}')
        target = home / relative
        if any(parent.is_symlink() or is_junction(parent) for parent in [target, *target.parents] if parent != home.parent):
            raise InstallError(f'Symlink installation targets are refused: {relative}')
        if target.exists() and not target.is_file():
            raise InstallError(f'Not a regular installation target: {relative}')
        out.append((relative, source.read_bytes(), source.stat().st_mode & 0o777))
    return out


def update(repo, home, names, cli='herdr-app', verify_timeout=10, allow_unhealthy_before=False, extra=()):
    repo, home = repo.resolve(), home.resolve()
    if not home.is_dir():
        raise InstallError('Existing app home required; use install.py for the initial install')
    lock_path = home / 'data/sixfold/install.lock'
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open('a+') as lock:
        try:
            lock_exclusive(lock)
        except BlockingIOError as error:
            raise InstallError('Another installation holds the lock; do not copy files manually') from error
        env = {**os.environ, 'HERDR_APP_HOME': str(home)}
        files = input_files(repo, home, names)
        theirs = pinned_inputs(extra, home)
        clash = {relative for relative, _, _ in files} & {relative for relative, _, _ in theirs}
        if clash:
            raise InstallError(f'Listed files clash with the pinned Workspace Mods: {sorted(map(str, clash))}')
        files += theirs
        before = read_status(cli, env)
        if before['errors'] and not allow_unhealthy_before:
            raise InstallError('App already reports errors; diagnose first or use --allow-unhealthy-before for an authorized repair')
        files = [(relative, payload, mode) for relative, payload, mode in files
                 if not (home / relative).exists() or (home / relative).read_bytes() != payload
                 or (home / relative).stat().st_mode & 0o777 != mode]
        if not files:
            if before['errors']:
                raise InstallError('No changed files; the unhealthy app still requires diagnosis')
            backup = home / 'backups' / ('sixfold-update-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ'))
            backup.mkdir(parents=True)
            atomic_write(backup / 'receipt.json', json.dumps({'phase': 'unchanged', 'before': before, 'files': []}).encode())
            return backup
        # Build one candidate per affected mod. Native check sees the complete
        # installed dependency tree plus only the selected replacement files.
        (home / 'backups').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='.sixfold-install-stage-', dir=home / 'backups') as temporary:
            stage = Path(temporary)
            mods = sorted({relative.parts[1] for relative, _, _ in files if relative.parts[0] == 'mods'})
            initial_mod_digests = {name: tree_digest(home / 'mods' / name) if (home / 'mods' / name).exists() else None for name in mods}
            for name in mods:
                installed = home / 'mods' / name
                if installed.exists():
                    shutil.copytree(installed, stage / name, symlinks=True)
                else:
                    (stage / name).mkdir()
            for name in mods:
                if initial_mod_digests[name] is not None and tree_digest(stage / name) != initial_mod_digests[name]:
                    raise InstallError(f'Mod changed while staging: {name}')
            for relative, payload, mode in files:
                if relative.parts[0] == 'mods':
                    atomic_write(stage / Path(*relative.parts[1:]), payload, mode)
            for name in mods:
                checked = subprocess.run([cli, 'check', str(stage / name)], env=env, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                if checked.returncode:
                    raise InstallError(f'Native check failed for {name}: {checked.stdout.strip()} {checked.stderr.strip()}')
            # Validate before touching installed code; backups never live in mods/.
            stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
            backup = home / 'backups' / ('sixfold-update-' + stamp)
            backup.mkdir(parents=True)
            for name in mods:
                installed = home / 'mods' / name
                if installed.exists():
                    shutil.copytree(installed, backup / 'mods' / name, symlinks=True)
            originals = {}
            for relative, _, _ in files:
                target = home / relative
                originals[relative] = (target.read_bytes(), target.stat().st_mode & 0o777) if target.exists() else None
                if originals[relative] is not None and relative.parts[0] != 'mods':
                    atomic_write(backup / relative, *originals[relative])
            receipt = {'phase': 'backed_up', 'source_worktree': str(repo), 'pid': os.getpid(), 'before': before, 'files': [str(item[0]) for item in files],
                       'candidate_sha256': {str(relative): digest(payload) for relative, payload, _ in files},
                       'original_sha256': {str(relative): digest(value[0]) if value else None for relative, value in originals.items()}}
            def save_receipt():
                atomic_write(backup / 'receipt.json', (json.dumps(receipt, ensure_ascii=False, indent=2) + '\n').encode())
            save_receipt()
            written = []
            swapped = []
            candidate_mod_digests = {name: tree_digest(stage / name) for name in mods}
            try:
                for name in mods:
                    target = home / 'mods' / name
                    current = tree_digest(target) if target.exists() else None
                    if current != initial_mod_digests[name]:
                        raise InstallError(f'Mod changed concurrently: {name}')
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if target.exists():
                        exchange_directories(stage / name, target)
                    else:
                        rename_with_retry(stage / name, target)
                    swapped.append(name)
                for relative, payload, mode in files:
                    if relative.parts[0] == 'mods':
                        continue
                    target = home / relative
                    original = originals[relative]
                    current = target.read_bytes() if target.exists() else None
                    if current != (original[0] if original else None):
                        raise InstallError(f'Installation changed concurrently: {relative}')
                    atomic_write(target, payload, mode)
                    written.append(relative)
                receipt['phase'] = 'installed_pending_verification'
                save_receipt()
                deadline = time.monotonic() + verify_timeout
                last_error = None
                while True:
                    try:
                        after = read_status(cli, env)
                        receipt['after'] = after
                        for name in swapped:
                            target = home / 'mods' / name
                            if not target.exists() or tree_digest(target) != candidate_mod_digests[name]:
                                raise InstallError(f'Mod changed during verification: {name}')
                        for relative in written:
                            target = home / relative
                            expected = next(payload for item, payload, _ in files if item == relative)
                            if not target.exists() or target.read_bytes() != expected:
                                raise InstallError(f'File changed during verification: {relative}')
                        if any(after.get(key) != before.get(key) for key in ('space', 'tab', 'focused_pane')):
                            raise InstallError('Workspace/tab/focus changed during installation; no focus commands were sent')
                        if not after['errors']:
                            # Allow hot reload to run before accepting a clean sample.
                            if receipt.get('first_clean_at') is not None and time.monotonic() - receipt['first_clean_at'] >= 1:
                                break
                            receipt.setdefault('first_clean_at', time.monotonic())
                        else:
                            receipt.pop('first_clean_at', None)
                            last_error = f"App reports {len(after['errors'])} errors"
                    except (subprocess.SubprocessError, OSError, ValueError) as error:
                        receipt.pop('first_clean_at', None)
                        last_error = str(error)
                    if time.monotonic() >= deadline:
                        raise InstallError(last_error or 'App did not remain error-free during verification')
                    time.sleep(.2)
                receipt.pop('first_clean_at', None)
                receipt['phase'] = 'verified'
                save_receipt()
                return backup
            except BaseException as error:
                receipt['phase'], receipt['failure'] = 'rolling_back', str(error)
                conflicts = []
                for name in reversed(swapped):
                    target = home / 'mods' / name
                    if not target.exists() or tree_digest(target) != candidate_mod_digests[name]:
                        conflicts.append('mods/' + name)
                        continue
                    if initial_mod_digests[name] is None:
                        rename_with_retry(target, stage / name)
                    else:
                        exchange_directories(stage / name, target)
                candidate = {relative: payload for relative, payload, _ in files}
                for relative in reversed(written):
                    target = home / relative
                    # Never overwrite an uncooperative writer's later change.
                    if not target.exists() or target.read_bytes() != candidate[relative]:
                        conflicts.append(str(relative))
                        continue
                    original = originals[relative]
                    if original is None:
                        target.unlink()
                    else:
                        atomic_write(target, *original)
                receipt['phase'] = 'rollback_conflict' if conflicts else 'rolled_back'
                receipt['rollback_conflicts'] = conflicts
                with contextlib.suppress(Exception):
                    receipt['rollback_status'] = read_status(cli, env)
                save_receipt()
                raise InstallError(f'{error}; {receipt["phase"]}; receipt: {backup / "receipt.json"}') from error


def install_voice(repo, home):
    """The voice plugin is a herdr plugin with its own entry points (hook,
    LaunchAgent, app routing), so it installs as one unit and checks itself."""
    script = repo / 'voice/install.py'
    if not script.is_file():
        raise InstallError(f'Voice plugin missing in {repo}')
    env = {**os.environ, 'HERDR_APP_HOME': str(home)}
    if subprocess.run([sys.executable, str(script)], env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).returncode != 0:
        raise InstallError('Voice plugin install or check failed (see above)')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('files', nargs='*', help='Explicit repository-relative files; existing unlisted files are preserved. '
                        '"voice" (or any voice/... file) installs the voice plugin as one unit with voice/install.py')
    parser.add_argument('--without-workspace-mods', action='store_true',
                        help='Leave Herdr Workspace Mods as installed (default: bring them to the version pinned in workspace-mods.lock.json)')
    parser.add_argument('--workspace-mods-source', type=Path,
                        help='A local Herdr Workspace Mods checkout already at the pinned commit (default: fetch it)')
    parser.add_argument('--home', type=Path, default=Path(os.environ.get('HERDR_APP_HOME', Path.home() / '.config/herdr-app')))
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1], help='Reviewed source worktree (required when running an installed copy)')
    parser.add_argument('--cli', default='herdr-app')
    parser.add_argument('--verify-timeout', type=float, default=10)
    parser.add_argument('--allow-unhealthy-before', action='store_true', help='Authorized repair only; post-install status must still become error-free')
    args = parser.parse_args()
    if args.verify_timeout < 1.5:
        parser.error('--verify-timeout must be at least 1.5 seconds')
    try:
        if not (args.repo / 'mods').is_dir() or not (args.repo / 'layouts').is_dir():
            raise InstallError('Run from a source worktree, or pass --repo /path/to/reviewed-worktree')
        app_files = [name for name in args.files if Path(name).parts[:1] != ('voice',)]
        voice = len(app_files) != len(args.files)
        pin, extra = None, []
        # The voice plugin installs as its own unit: a voice-only run leaves the app's mods alone.
        if not args.without_workspace_mods and (app_files or not voice):
            try:
                pin, _, extra = workspace_mods.pinned_files(args.repo, args.workspace_mods_source)
            except workspace_mods.PinError as error:
                raise InstallError(f'Herdr Workspace Mods: {error}; pass --without-workspace-mods to skip them') from error
        if not app_files and not extra and not voice:
            parser.error('list files to install (or leave out --without-workspace-mods)')
        backup = update(args.repo, args.home, app_files, args.cli,
                        args.verify_timeout, args.allow_unhealthy_before, extra) if app_files or extra else None
        if pin:
            workspace_mods.record(args.home, pin)
        if voice:
            install_voice(args.repo, args.home)
    except (InstallError, subprocess.SubprocessError, OSError, ValueError) as error:
        parser.exit(1, f'Install failed: {error}\n')
    if backup:
        print(f'Installed and verified errors=0; backup/receipt: {backup}')


if __name__ == '__main__':
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    main()
