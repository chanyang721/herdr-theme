#!/usr/bin/env python3
"""Display one existing Herdr TUI terminal in a core terminal, without restarting it."""
import argparse
import fcntl
import hashlib
import json
import os
import pty
import select
import signal
import subprocess
import sys
import termios
import time
import tty
from pathlib import Path


def source_pane(binary, session, pane):
    result = subprocess.run([binary, '--session', session, 'pane', 'get', pane],
                            capture_output=True, text=True, timeout=2, check=True)
    return json.loads(result.stdout)['result']['pane']


def status_report(pane):
    # Never infer completion from a missing source or from screen text.
    state = pane.get('agent_status')
    if state not in ('working', 'blocked', 'done', 'idle'):
        return b''
    agent = ''.join(c for c in pane.get('agent', 'agent') if c.isalnum() or c in '-_')
    return f'\x1b]7501;state={state}:app={agent}\x1b\\'.encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pane', required=True)
    parser.add_argument('--session', default='default')
    parser.add_argument('--herdr', default='herdr')
    args = parser.parse_args()
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        parser.error('run this inside a Herdr app terminal')
    pane = source_pane(args.herdr, args.session, args.pane)
    terminal = pane['terminal_id']
    lock_dir = Path.home() / '.local/state/herdr-sixfold'
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock_id = hashlib.sha256(f'{args.session}/{terminal}'.encode()).hexdigest()[:24]
    lock = (lock_dir / (lock_id + '.lock')).open('w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('This source terminal already has a Sixfold bridge.')
    lock.write(str(os.getpid())); lock.flush()
    old = termios.tcgetattr(0)
    child, master = pty.fork()
    if child == 0:
        os.execvp(args.herdr, [args.herdr, '--session', args.session, 'terminal',
                              'attach', terminal, '--takeover'])

    def resize(*_):
        try:
            size = fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8)
            fcntl.ioctl(master, termios.TIOCSWINSZ, size)
            os.kill(child, signal.SIGWINCH)
        except OSError:
            pass

    def stop(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGWINCH, resize)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)
    last_report = None
    last_title = None
    next_check = 0
    try:
        tty.setraw(0)
        resize()
        while True:
            ready, _, _ = select.select([0, master], [], [], 0.1)
            if master in ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                os.write(1, data)
            if 0 in ready:
                data = os.read(0, 65536)
                if not data:
                    break
                os.write(master, data)
            if time.monotonic() >= next_check:
                next_check = time.monotonic() + 1
                try:
                    current = source_pane(args.herdr, args.session, args.pane)
                    if current['terminal_id'] != terminal:
                        raise RuntimeError('source terminal changed')
                    report = status_report(current)
                    title = ''.join(c for c in current.get('terminal_title_stripped', '') if c.isprintable())
                    if title and title != last_title:
                        os.write(1, f'\x1b]0;{title}\x07'.encode())
                        last_title = title
                    if report and report != last_report:
                        os.write(1, report)
                        last_report = report
                except (OSError, ValueError, KeyError, subprocess.SubprocessError, RuntimeError):
                    # A lost source is a blocker, never a fabricated success.
                    report = b'\x1b]7501;state=blocked:app=sixfold-bridge\x1b\\'
                    if report != last_report:
                        os.write(1, report)
                        last_report = report
    except KeyboardInterrupt:
        pass
    finally:
        termios.tcsetattr(0, termios.TCSADRAIN, old)
        os.close(master)
        try:
            os.kill(child, signal.SIGHUP)
        except ProcessLookupError:
            pass
        lock.close()


if __name__ == '__main__':
    main()
