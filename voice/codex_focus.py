"""Codex microphone routing independent of the optional sidebar.

Never starts/stops voice or edits a composer. Unknown focus is muted; only a
microphone muted by this controller may be resumed automatically.
"""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def run(*args):
    return json.loads(subprocess.check_output(args, text=True, timeout=3))


def tui_panes(queue):
    try:
        return {p['pane_id']: p for p in run(queue.HERDR, 'pane', 'list')['result']['panes']}
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return {}


def targets(queue):
    current = tui_panes(queue)
    listed = run(queue.CORE, 'ls', '--json')['terminals']
    bridged = {t['address'] for t in run(queue.CORE, 'ls', '--json', '--label',
                                       'sixfold.source-session=default')['terminals']}
    for terminal in listed:
        if terminal.get('agent') == 'codex' and terminal['address'] not in bridged:
            pid = 'app:' + terminal['address']
            current[pid] = {'pane_id': pid, 'agent': 'codex'}
    return {pid: p for pid, p in current.items() if p.get('agent') == 'codex'}


def selected(queue):
    """Ask the window, not a cached sidebar/TUI focus when Herdr App is front."""
    try:
        front = subprocess.check_output(['lsappinfo', 'front'], text=True, timeout=2).strip()
        if not front:
            return None
        bundle = subprocess.check_output(['lsappinfo', 'info', '-only', 'bundleid', front],
                                         text=True, timeout=2)
        if 'dev.herdr.app' in bundle:
            terminal = run(queue.app_backend.APP, 'status').get('agent')
            if not terminal:
                return None
            labels = run(queue.CORE, 'get', terminal).get('labels') or {}
            return labels.get('sixfold.source-pane') or 'app:' + terminal
        # An iTerm foreground app does not identify its active window/tab.
        # Without a verified attach mapping it grants no microphone permission.
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        pass
    return None


def known_identity(value):
    return isinstance(value, str) and value.rsplit(':', 1)[-1].isdigit() and int(value.rsplit(':', 1)[-1]) > 0


def reconcile(current, focus, voice, toggle, identity, owned, report):
    """Break before make. Re-read focus and exact footer immediately before F9."""
    safe = True
    for pid, pane in current.items():
        try:
            live, muted = voice(pid)
            if not live and not muted:
                owned.pop(pid, None)  # no observed voice call: never resume a new one
                continue
            if focus() == pid:
                continue
            if live and muted:
                safe = False
                continue
            if muted:
                continue
            session = identity(pane)
            if focus() == pid or voice(pid) != (True, False):
                safe = False
                continue
            changed = toggle(pid, False)
            if changed:
                if known_identity(session):
                    owned[pid] = session
                else:
                    owned.pop(pid, None)
                report(f'codex focus guard muted {pid}')
            else:
                safe = False
                # Outcome is unknown: do not retry a toggle until a future
                # screen observation. Never claim ownership without acknowledgment.
                report(f'codex focus guard mute unconfirmed {pid}')
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            safe = False
    if not safe:
        return
    pid = focus()
    if pid not in current or pid not in owned:
        return  # an initially/manual-muted focused session stays muted
    pane = current[pid]
    if not known_identity(owned[pid]) or owned[pid] != identity(pane):
        owned.pop(pid, None)
        return
    status = voice(pid)
    if status == (True, False):
        owned.pop(pid, None)  # user already resumed it
    elif status == (False, True) and focus() == pid and voice(pid) == (False, True):
        # All background microphones were checked first. Focus is checked
        # again after this toggle, so a move during delivery is repaired.
        if toggle(pid, True):
            owned.pop(pid, None)
            report(f'codex focus guard resumed {pid}')
            if focus() != pid and voice(pid) == (True, False):
                if toggle(pid, False):
                    owned[pid] = identity(pane)
                    report(f'codex focus guard remuted after focus race {pid}')


def sync(queue):
    folder = Path(queue.STATE_DIR)
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / 'codex-focus.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = folder / 'codex-focus.json'
        try:
            owned = json.loads(path.read_text())
        except (OSError, ValueError):
            owned = {}
        current = targets(queue)
        owned = {pid: session for pid, session in owned.items() if pid in current}
        def toggle(pid, on):
            footer = queue.footer(queue.screen(pid), '›').lower()
            if ('f9 unmute' if on else 'f9 mute') not in footer:
                return False  # never guess a customized shortcut
            return queue.press(pid, 'f9', lambda: queue.codex_voice(pid) ==
                               ((True, False) if on else (False, True)), wait=1.5)
        reconcile(current, lambda: selected(queue), queue.codex_voice, toggle,
                  queue.session_of, owned, queue.log)
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(owned))
        temporary.replace(path)


def serve(queue):
    folder = Path(queue.STATE_DIR)
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / 'codex-focus-monitor.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        queue.log('codex focus guard started; manual mute preserved; sidebar independent')
        while True:
            try:
                sync(queue)
            except Exception as error:
                queue.log(f'codex focus guard observation failed: {type(error).__name__}')
            time.sleep(0.5)


if __name__ == '__main__':
    import focus_queue
    if '--serve' in sys.argv:
        serve(focus_queue)
    else:
        sync(focus_queue)
