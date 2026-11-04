#!/usr/bin/env python3
"""Start an agent without the identity markers of the agent that opened its pane.

A pane opened from inside Claude or Codex (`herdr-app do space.new/tab.new/pane.split`,
a session-sleep resume typed into an inherited shell) gets the caller's environment.
Observed 2026-11-04:
  - CLAUDECODE / CLAUDE_CODE_CHILD_SESSION make the new Claude a "child": transcript
    saving is off, so usage, sleep-resume and harness mapping all lose it.
  - HERDR_PANE_ID still names the parent's native pane, so the Herdr SessionStart hook
    reports the new session to the parent's pane and overwrites its agent_session.

Use:  agent_env.py <program> [args...]   exec the program with a cleaned environment
In argv given to Herdr, use launch_argv(): `env -u NAME ... <program>` (no installed path needed).
"""
import os
import sys

# Claude Code's own per-session markers, and Codex's thread marker its hooks compare against.
AGENT_MARKERS = (
    'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CODEX_THREAD_ID',
)
# A Herdr Theme terminal (hc) is never a native Herdr pane: an inherited native pane identity
# there is always the parent's. Herdr sets these itself in a native pane.
PANE_MARKERS = ('HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID')
INHERITED = AGENT_MARKERS + PANE_MARKERS


def clean_env(env):
    """A copy of env without the parent's markers. Native pane identity is kept outside hc terminals."""
    drop = INHERITED if env.get('HC_TERMINAL_ID') else AGENT_MARKERS
    return {key: value for key, value in env.items() if key not in drop}


def launch_argv(argv):
    """argv for Herdr's space.new/tab.new/pane.split: the program runs in an hc terminal."""
    argv = list(argv)
    if not argv or not all(isinstance(part, str) and part for part in argv):
        raise ValueError('argv must be non-empty strings')
    if sys.platform == 'win32':
        # No env(1) there; Windows panes start from the app's own environment.
        return argv
    unset = [part for name in INHERITED for part in ('-u', name)]
    return ['env', *unset, *argv]


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if not argv:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    os.execvpe(argv[0], argv, clean_env(os.environ))


if __name__ == '__main__':
    sys.exit(main())
