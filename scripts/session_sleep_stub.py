#!/usr/bin/env python3
"""What a suspended agent's pane runs: a note, and the same session back on demand.

  Enter on its own   resume the session (original flags, same folder)
  a message          resume it and hand the message over as its first prompt
                     (an `hc send` to the pane lands here, never in a bare shell)
  ctrl+c             leave to the shell

Resuming clears the pane's sleep labels and, when the harness is configured,
records `resumed`. It then replaces itself with the agent (exec), so the agent
runs in this terminal exactly as before.
"""
import json
import os
from pathlib import Path
import select
import subprocess
import sys

LABELS = ('sixfold.sleep', 'sixfold.title')


def gather(stream, first, settle=0.6, limit=64 * 1024):
    """A pasted message arrives as several lines: keep reading until it settles."""
    lines = [first]
    while sum(map(len, lines)) < limit:
        ready, _, _ = select.select([stream], [], [], settle)
        if not ready:
            break
        line = stream.readline()
        if not line:
            break
        lines.append(line)
    return ''.join(lines).strip()


def clear_labels(address):
    if not address:
        return
    try:
        subprocess.run(['hc', 'label', address, *[f'{k}=' for k in LABELS]], capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        pass


def record_resumed(ticket):
    """Best effort: a failed record never keeps the person from their session."""
    # The installed stub sits in the observer's state folder next to its config.
    config = Path(ticket.get('config') or Path(__file__).resolve().parent / 'sleep-idle-sessions.json')
    try:
        harness = json.loads(config.read_text()).get('harness') or {}
        if harness.get('python') and harness.get('script'):
            provider = 'claude' if ticket['app'] in ('claude', 'claude-code') else 'codex'
            subprocess.run([harness['python'], harness['script'], 'park', ticket['address'], '--provider', provider,
                            '--session-id', ticket['session_id'], '--space-id', ticket['space_id'], '--event', 'resumed',
                            '--done', f"{ticket.get('space_name') or '?'} {ticket['address']}: resumed from sleep"],
                           capture_output=True, timeout=30)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        pass


def command(ticket, message):
    argv = list(ticket['argv'])
    return argv + [message] if message else argv


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    ticket = json.loads(Path(argv[0]).read_text())
    title = ticket.get('title') or ''
    resume = ' '.join(ticket['argv'])
    print(f"\n  절전 중 — {ticket.get('space_name') or ''} {ticket['address']} {title}".rstrip())
    print('  Enter: 이어 열기 · 메시지를 보내면 이어 열고 그대로 전달 · ctrl+c: 셸로 나가기')
    print(f'  직접 열기: {resume}\n', flush=True)
    try:
        first = sys.stdin.readline()
    except KeyboardInterrupt:
        clear_labels(ticket.get('address'))
        return 130
    if not first:
        return 0
    message = gather(sys.stdin, first)
    clear_labels(ticket.get('address'))
    record_resumed(ticket)
    if ticket.get('cwd') and Path(ticket['cwd']).is_dir():
        os.chdir(ticket['cwd'])
    args = command(ticket, message)
    os.execvp(args[0], args)


if __name__ == '__main__':
    sys.exit(main())
