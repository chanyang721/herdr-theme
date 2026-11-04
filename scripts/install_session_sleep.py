#!/usr/bin/env python3
"""Register the 5-minute session-sleep observer (sleep_idle_sessions.py) in dry-run mode;
switch it to apply with --enable-apply --user-approved after one recorded dry-run."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import install_space_cleanup as common  # noqa: E402

SLEEP = {
    'label': 'co.lukuku.sleep-idle-sessions',
    'script': 'sleep_idle_sessions.py',
    # The order matches sleep_idle_sessions.OBSERVER_FILES (the reviewed hash).
    'files': ('sleep_idle_sessions.py', 'agent_sessions.py', 'space_job_evidence.py', 'close_finished_spaces.py', 'session_sleep_stub.py'),
    'config': 'sleep-idle-sessions.json',
    'example': 'config/sleep-idle-sessions.example.json',
    'state': 'sleep-idle-sessions-state.json',
    'log': 'sleep-idle-sessions',
    'pins': False,
}


def install(home, source, *, apply=False, user_approved=False, execute=False):
    return common.install_observer(home, source, SLEEP, apply=apply, user_approved=user_approved, execute=execute)


if __name__ == '__main__':
    common.main(SLEEP)
