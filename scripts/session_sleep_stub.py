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

LABELS = ('sixfold.sleep', 'sixfold.title', 'sixfold.sleep.new')


PASTE = ('\x1b[200~', '\x1b[201~')   # bracketed-paste markers around a pasted message
ENTER = (b'\r', b'\n')


def tty_input(fd):
    """Put the terminal in a known state for reading: byte at a time, echo and ctrl+c on.

    An agent that exits can leave the terminal with CR→NL translation off, so Enter arrives as a
    bare CR (shown as ^M) and a line reader never returns; macOS also caps a canonical line at
    1024 bytes. Reading bytes ourselves avoids both. Returns the attributes to restore, or None
    when stdin is not a terminal."""
    try:
        import termios
        saved = termios.tcgetattr(fd)
    except (ImportError, OSError, ValueError):
        return None
    attrs = termios.tcgetattr(fd)
    attrs[0] = (attrs[0] | termios.ICRNL) & ~(termios.IGNCR | termios.INLCR)
    attrs[3] = (attrs[3] | termios.ECHO | termios.ISIG) & ~termios.ICANON
    attrs[6][termios.VMIN], attrs[6][termios.VTIME] = 1, 0
    termios.tcsetattr(fd, termios.TCSANOW, attrs)
    return saved


def restore(fd, saved):
    if saved is not None:
        import termios
        try:
            termios.tcsetattr(fd, termios.TCSANOW, saved)
        except OSError:
            pass


def read_message(fd, settle=0.6, limit=64 * 1024):
    """Wait for input, then keep reading until it ends in Enter and has settled.

    b'' on end of input. CR or NL ends a line; a paste may hold several lines. Backspace
    removes the last character typed."""
    data = b''
    while len(data) < limit:
        if data.endswith(ENTER):
            ready, _, _ = select.select([fd], [], [], settle)
            if not ready:
                break
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        for byte in chunk:
            if byte in (0x7f, 0x08):
                data = data[:-1]
            else:
                data += bytes([byte])
    return data


def message_of(data):
    text = data.decode('utf-8', 'replace').replace('\r\n', '\n').replace('\r', '\n')
    for marker in PASTE:
        text = text.replace(marker, '')
    return text.strip()


def clear_labels(address):
    if not address:
        return
    try:
        subprocess.run(['hc', 'label', address, *[f'{k}=' for k in LABELS]], capture_output=True, timeout=10, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (OSError, subprocess.SubprocessError):
        pass


def record_resumed(ticket):
    """Best effort: a failed record never keeps the person from their session."""
    # The installed stub sits in the observer's state folder next to its config.
    config = Path(ticket.get('config') or Path(__file__).resolve().parent / 'sleep-idle-sessions.json')
    try:
        harness = json.loads(config.read_text(encoding='utf-8')).get('harness') or {}
        if harness.get('python') and harness.get('script'):
            provider = 'claude' if ticket['app'] in ('claude', 'claude-code') else 'codex'
            subprocess.run([harness['python'], harness['script'], 'park', ticket['address'], '--provider', provider,
                            '--session-id', ticket['session_id'], '--space-id', ticket['space_id'], '--event', 'resumed',
                            '--done', f"{ticket.get('space_name') or '?'} {ticket['address']}: resumed from sleep", '--mask'],
                           capture_output=True, timeout=30, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        pass


def command(ticket, message):
    argv = list(ticket['argv'])
    return argv + [message] if message else argv


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    ticket = json.loads(Path(argv[0]).read_text(encoding='utf-8'))
    title = ticket.get('title') or ''
    resume = ' '.join(ticket['argv'])
    fd = sys.stdin.fileno()
    saved = tty_input(fd)   # before the note, so nothing typed meanwhile is read the old way
    print(f"\n  절전 중 — {ticket.get('space_name') or ''} {ticket['address']} {title}".rstrip())
    print('  Enter: 이어 열기 · 메시지를 보내면 이어 열고 그대로 전달 · ctrl+c: 셸로 나가기')
    print(f'  직접 열기: {resume}\n', flush=True)
    try:
        data = read_message(fd)
    except KeyboardInterrupt:
        restore(fd, saved)
        clear_labels(ticket.get('address'))
        return 130
    restore(fd, saved)
    if not data:
        return 0
    message = message_of(data)
    clear_labels(ticket.get('address'))
    record_resumed(ticket)
    if ticket.get('cwd') and Path(ticket['cwd']).is_dir():
        os.chdir(ticket['cwd'])
    args = command(ticket, message)
    os.execvpe(args[0], args, agent_env(os.environ))


def agent_env(env):
    """The agent starts without the markers of whatever agent opened this pane's shell: an
    inherited CLAUDE_CODE_CHILD_SESSION would turn transcript saving off again."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        import agent_env as cleaner
        return cleaner.clean_env(env)
    except ImportError:
        drop = ('CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CODEX_THREAD_ID')
        return {k: v for k, v in env.items() if k not in drop}
    finally:
        sys.path.pop(0)


if __name__ == '__main__':
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    sys.exit(main())
