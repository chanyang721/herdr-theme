#!/usr/bin/env python3
"""Install the voice plugin from this checkout and point every entry point at it.

  python3 voice/install.py            install or update, then check
  python3 voice/install.py --enroll   also enroll your voice (run in a shell pane)
  python3 voice/install.py --check    only check that everything runs the installed copy

The plugin is copied to ~/.local/share/herdr-focus-queue/plugin, not run from
the checkout, so editing or switching a worktree never changes what is running.
The copy is swapped in as one directory: a herdr event that starts during the
update runs either the old copy or the new one, never a half-written mix.
`focusq install` from that copy then links it as the herdr plugin and points
the Claude Code submit hook, the Codex focus LaunchAgent and the Herdr app's
focus routing at it, replacing links to any earlier folder in the same step.

Your voice data stays where it was (~/.local/state/herdr/plugins/local.focus-
queue) and your own settings in voice.local.json (see voice_settings.py).
Running voice connections are not stopped; listeners started before the
update finish on the code they started with.

Safe to run again. Exit 0 means installed and checked.
"""
import argparse
import ctypes
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

SOURCE = Path(__file__).resolve().parent
SKIP = {'__pycache__', '.DS_Store', '.git'}
RENAME_SWAP = 0x2


def target_dir(home):
    return home / '.local/share/herdr-focus-queue/plugin'


def copy_tree(source, destination):
    shutil.copytree(source, destination, ignore=lambda _, names: [n for n in names
                                                                   if n in SKIP or n.endswith('.pyc')])


def swap(left, right):
    """Exchange two directories in one call (macOS renamex_np)."""
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.renamex_np(os.fsencode(left), os.fsencode(right), RENAME_SWAP) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(left))


def place(source, target):
    """Put a copy of source at target. Returns True if anything changed."""
    target.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.plugin-stage-', dir=target.parent))
    try:
        new = stage / 'plugin'
        copy_tree(source, new)
        if target.is_dir() and not target.is_symlink():
            if same_tree(new, target):
                return False
            swap(new, target)  # `new` now holds the previous copy
        else:
            if target.is_symlink() or target.exists():
                raise SystemExit(f'Not a plugin folder, refusing to replace: {target}')
            new.rename(target)
        return True
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def same_tree(left, right):
    def files(root):
        return {p.relative_to(root): p for p in root.rglob('*') if p.is_file()
                and not (set(p.relative_to(root).parts) & SKIP) and p.suffix != '.pyc'}
    a, b = files(left), files(right)
    return a.keys() == b.keys() and all(a[k].read_bytes() == b[k].read_bytes()
                                         and (a[k].stat().st_mode & 0o777) == (b[k].stat().st_mode & 0o777)
                                         for k in a)


def focusq(target, *args):
    return subprocess.run([sys.executable, str(target / 'focusq'), *args]).returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--home', type=Path, default=Path.home(),
                        help='home folder to install into (another home implies --no-start)')
    parser.add_argument('--enroll', action='store_true', help='also enroll your voice for the current microphone')
    parser.add_argument('--check', action='store_true', help='only check the installed copy')
    parser.add_argument('--no-start', action='store_true', help='write files only; start no LaunchAgent or download')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.exit(0, 'Voice plugin skipped: macOS only.\n')
    home = args.home.expanduser().resolve()
    if home != Path.home().resolve():
        # Everything below reads HOME; another home must not touch this one.
        os.environ['HOME'] = str(home)
        os.environ.setdefault('HERDR_APP_HOME', str(home / '.config/herdr-app'))
        args.no_start = True
    if args.no_start:
        os.environ['HERDR_VOICE_NO_START'] = '1'
    target = target_dir(home)
    if args.check:
        if not (target / 'focusq').is_file():
            print(f'not this copy - voice plugin not installed at {target}')
            sys.exit(1)
        sys.exit(focusq(target, 'check'))
    changed = place(SOURCE, target)
    print(f"voice plugin {'updated' if changed else 'already current'}: {target}")
    if focusq(target, 'install') != 0:
        sys.exit('voice install failed')
    if args.enroll and focusq(target, 'voice-enroll') != 0:
        sys.exit('voice enrollment failed')
    sys.exit(focusq(target, 'check'))


if __name__ == '__main__':
    main()
