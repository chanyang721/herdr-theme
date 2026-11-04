#!/usr/bin/env python3
"""Suspend idle agent sessions, fixed workspaces included, to free CPU and memory.

A session sleeps only when every check holds and has held, unchanged, for
idle_seconds (default 20 minutes): an idle/done agent, empty input, no approval
or decision text, no voice input, no subagent terminal, only idle helper
processes, no background job, outside the visible workspace and focused pane,
and not an excluded address. Then, in order, with a fresh recheck first:

  1. the harness keeps its context (`harness.py park --event suspended`);
     no record, no sleep
  2. `/exit` is typed into the agent and the shell must come back
  3. the pane runs session_sleep_stub.py: Enter resumes the same session
     with its original flags, and a message sent to the pane resumes it and
     delivers the message (so `hc send` never reaches a bare shell)
  4. labels mark the pane: sixfold.sleep and the header title '절전 · …'

Dry-run by default. Never closes a pane, a tab or a space.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent_sessions  # noqa: E402
import close_finished_spaces as spaces  # noqa: E402

BASE = Path.home() / 'Library/Application Support/LukukuWatch'
VOICE = re.compile(r'(?:🎙|🎤|\bListening\b|\brecording\b|녹음\s*중|받아쓰는\s*중|음성\s*입력\s*중)', re.I)
OBSERVER_FILES = ('sleep_idle_sessions.py', 'agent_sessions.py', 'space_job_evidence.py', 'close_finished_spaces.py', 'session_sleep_stub.py')
SLEEP_LABEL, TITLE_LABEL = 'sixfold.sleep', 'sixfold.title'


def observer_sha256(folder):
    return hashlib.sha256(b''.join((Path(folder) / name).read_bytes() for name in OBSERVER_FILES)).hexdigest()


class Live(spaces.Live):
    """The live app and core. Every call that changes something is here, so tests replace it."""

    def keys(self, address, *keys):
        return agent_sessions.run([self.core, 'keys', address, *keys], env=self._env())

    def type_line(self, address, text):
        return agent_sessions.run([self.core, 'send', address, text], env=self._env(), timeout=30)

    def label(self, address, **labels):
        return agent_sessions.run([self.core, 'label', address, *[f'{k}={v}' for k, v in labels.items()]], env=self._env())

    def terminal(self, address):
        return json.loads(agent_sessions.run([self.core, 'get', address, '--json']))

    def wait(self, seconds):
        time.sleep(seconds)

    def styled_screen(self, address, limit=3.0, quiet=0.4):
        """The pane's repaint with colours, from a watch-only attach (never types or resizes)."""
        import select
        import subprocess
        proc = subprocess.Popen([self.core, 'attach', '--observe', address], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=self._env())
        data, end, last = b'', time.time() + limit, None
        try:
            while time.time() < end:
                ready, _, _ = select.select([proc.stdout], [], [], 0.1)
                if ready:
                    chunk = os.read(proc.stdout.fileno(), 65536)
                    if not chunk:
                        break
                    data, last = data + chunk, time.time()
                elif last and time.time() - last >= quiet:
                    break
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
        if not data:
            raise RuntimeError('styled screen unavailable')
        return data.decode('utf-8', 'replace')

    def park_check(self, config, item):
        return agent_sessions.harness_park(config, item, 'suspended', dry_run=True)

    @staticmethod
    def _env():
        # Without a caller terminal, hc pastes the text as it is (no <hc> wrapper).
        return {k: v for k, v in os.environ.items() if k not in ('HC_TERMINAL_ID', 'HC_SCOPE')}


def pane_of(snapshot):
    """{address: (space, tab id)} for every terminal shown in a pane."""
    out = {}
    for space in snapshot['spaces']:
        for tab in space.get('tabs', []):
            for t in tab.get('terminals', []):
                out[t['terminal']] = (space, tab.get('id'))
    return out


def pane_entry(snapshot, address):
    for space in snapshot['spaces']:
        for tab in space.get('tabs', []):
            for t in tab.get('terminals', []):
                if t.get('terminal') == address:
                    return t
    return {}


def focused_terminal(snapshot):
    pane = snapshot['status'].get('focused_pane')
    for space in snapshot['spaces']:
        for tab in space.get('tabs', []):
            for t in tab.get('terminals', []):
                if pane and pane in (t.get('pane'), t.get('id'), t.get('pane_id')):
                    return t['terminal']
    return None


def on_screen(address, space, tab, status):
    """The person can see this pane: it is in the shown tab of the shown space, or in a float/overlay.
    Other tabs of the shown space are out of sight (only the focused pane and the shown tab count)."""
    if space.get('id') == status.get('space') and (tab is None or tab == status.get('tab')):
        return True
    shown = json.dumps([status.get('floats') or {}, status.get('overlays') or []], ensure_ascii=False)
    return re.search(r'(?<![\w/])' + re.escape(address) + r'(?![\w])', shown) is not None


def claude_suggestion(text, app, adapter, address):
    """True when the only thing in Claude's input row is its faint prompt suggestion."""
    if agent_sessions.provider(app) != 'claude' or not hasattr(adapter, 'styled_screen'):
        return False
    lines = text.splitlines()
    rows = [i for i, line in enumerate(lines) if line.lstrip().startswith('❯')]
    if not rows:
        return False
    i = rows[-1]
    value = lines[i].strip()[1:].strip()
    blank = '\n'.join(lines[:i] + ['❯'] + lines[i + 1:])
    if not value or not spaces.empty_prompt(blank, app):
        return False
    try:
        raw = adapter.styled_screen(address)
    except (OSError, RuntimeError, ValueError):
        return False
    return agent_sessions.suggestion_only(value, raw)


def inspect(address, space, snapshot, adapter, config, tab=None):
    """Every reason this terminal may not sleep now, and its evidence fingerprint."""
    reasons = []
    status = snapshot['status']
    terminal = snapshot['terminals'].get(address)
    item = {'address': address, 'space_id': space['id'], 'space_name': space.get('name'), 'reasons': reasons}
    if not all(spaces.focus(status)) or status.get('errors'):
        reasons.append('app focus/health unverified')
    if address in set(config.get('exclude_addresses', [])):
        reasons.append('excluded address')
    if on_screen(address, space, tab, status):
        reasons.append('shown on screen (visible tab)')
    if focused_terminal(snapshot) == address:
        reasons.append('focused pane')
    if space.get('machine') is not None:
        reasons.append('remote process/input evidence unavailable')
    if not terminal:
        reasons.append('terminal evidence unavailable')
        return item
    labels = terminal.get('labels') or {}
    if labels.get(SLEEP_LABEL):
        item['asleep'] = True
        reasons.append('already asleep')
        return item
    app = (terminal.get('status') or {}).get('app')
    state = (terminal.get('status') or {}).get('state')
    item.update(app=app, title=terminal.get('title'), cwd=terminal.get('cwd'), status_ms=terminal.get('status_ms'))
    if not terminal.get('reported') or app not in agent_sessions.AGENTS or state not in ('done', 'idle'):
        reasons.append('not a confirmed idle/done agent' if state != 'blocked' else 'user decision pending (blocked agent)')
        return item
    if reasons:
        return item
    if pane_entry(snapshot, address).get('sub_agents'):
        reasons.append('subagents shown in the pane')
    if any(t.get('parent') == address and t.get('state') == 'live' for t in snapshot['terminals'].values()):
        reasons.append('live subagent terminals')
    valid, why, pids = agent_sessions.process_evidence(terminal, snapshot['processes'])
    if not valid:
        reasons.append(why)
    mapping, why = agent_sessions.session_mapping(terminal, config)
    if mapping is None:
        reasons.append(why)
        return item
    item['session_id'] = mapping['session_id']
    item['argv'] = (terminal.get('foreground') or {}).get('argv') or []
    jobs_ok, jobs_reason, jobs_fp = adapter.backend(terminal, config, valid)
    if not jobs_ok:
        reasons.append(jobs_reason)
    text = adapter.screen(address)
    if spaces.DECISION.search(text):
        reasons.append('user decision pending')
    if VOICE.search('\n'.join(text.splitlines()[-6:])):
        reasons.append('voice input active')
    if not spaces.empty_prompt(text, app):
        if claude_suggestion(text, app, adapter, address):
            item['prompt_suggestion'] = True   # faint Claude suggestion only; typed text stays protected
        else:
            reasons.append('input not empty')
    item['screen_tail'] = '\n'.join(text.splitlines()[-12:])[:2000]
    item['fingerprint'] = hashlib.sha256(json.dumps([address, terminal.get('pid'), terminal.get('status_ms'), terminal.get('turn'),
                                                     pids, jobs_fp, mapping['session_id'], hashlib.sha256(text.encode()).hexdigest()],
                                                    sort_keys=True).encode()).hexdigest()
    return item


def note(item, notes_dir, now):
    """Local-only detail (screen tail, folder, git): never synced, kept beside the observer."""
    path = Path(notes_dir) / f"{dt.datetime.fromtimestamp(now):%Y%m%d}-{item['address']}-{item['session_id'][:8]}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    keep = {k: item.get(k) for k in ('address', 'space_name', 'space_id', 'app', 'session_id', 'title', 'cwd', 'git', 'screen_tail', 'harness', 'argv')}
    keep['at'] = dt.datetime.fromtimestamp(now).astimezone().isoformat()
    path.write_text(json.dumps(keep, ensure_ascii=False, indent=2) + '\n')
    path.chmod(0o600)
    return str(path)


def ticket(item, tickets_dir):
    """What the stub needs to resume: the original command, folder and session."""
    path = Path(tickets_dir) / f"{item['address']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    value = {'address': item['address'], 'app': item['app'], 'session_id': item['session_id'], 'cwd': item.get('cwd'),
             'argv': agent_sessions.resume_argv(item['app'], item.get('argv'), item['session_id']),
             'title': item.get('title') or '', 'space_id': item['space_id'], 'space_name': item.get('space_name')}
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    path.chmod(0o600)
    return path


def wait_for_shell(adapter, address, attempts=20):
    for _ in range(attempts):
        adapter.wait(1)
        fg = (adapter.terminal(address).get('foreground') or {})
        name = Path((fg.get('argv') or [''])[0]).name or fg.get('name', '')
        if name in agent_sessions.SHELLS or fg.get('name') in agent_sessions.SHELLS:
            return True
    return False


def sleep_one(item, adapter, config, paths, now):
    """Harness record → /exit → stub → labels. Returns the action taken."""
    item['git'] = adapter.git(item.get('cwd'))
    ok, detail = adapter.park(config, item, 'suspended', reason='idle session suspended to free memory')
    item['harness'] = detail
    if not ok:
        item['reasons'].append(f'harness record failed: {detail}')
        return 'keep'
    item['note'] = note(item, paths['notes'], now)
    path = ticket(item, paths['tickets'])
    adapter.keys(item['address'], *'/exit', 'enter')
    if not wait_for_shell(adapter, item['address']):
        adapter.park(config, item, 'resumed', reason='sleep aborted: the agent did not exit')
        raise RuntimeError(f"{item['address']}: agent did not exit after /exit; further sleeps stopped")
    stub = paths['stub']
    adapter.type_line(item['address'], f'{shlex_quote(sys.executable)} {shlex_quote(str(stub))} {shlex_quote(str(path))}')
    title = (item.get('title') or '')[:60]
    adapter.label(item['address'], **{SLEEP_LABEL: f"{agent_sessions.provider(item['app'])}:{item['session_id']}",
                                      TITLE_LABEL: f'절전 · {title}' if title else '절전'})
    return 'slept'


def shlex_quote(value):
    import shlex
    return shlex.quote(value)


def cycle(adapter, config, state, now, *, apply=False, paths=None):
    snapshot = adapter.snapshot()
    previous = state.get('sessions', {})
    gap = now - state.get('last_at', now)
    fresh = 0 <= gap <= config.get('max_sample_gap_seconds', 660)
    trial = state.get('trial', {}) if fresh else {}
    trial = {'started_at': trial.get('started_at', now), 'samples': trial.get('samples', 0) + 1, 'error_count': trial.get('error_count', 0)}
    approved = bool(config.get('user_approved_apply')) and config.get('reviewed_observer_sha256') == state.get('observer_sha256')
    ready = approved and trial['samples'] >= 2 and trial['error_count'] == 0
    idle = config.get('idle_seconds', 1200)
    initial_focus = spaces.focus(snapshot['status'])
    results, tracking, slept = [], {}, 0
    stop_reason = None
    for address, (space, tab) in sorted(pane_of(snapshot).items()):
        item = inspect(address, space, snapshot, adapter, config, tab)
        old = previous.get(address, {})
        safe = not item['reasons']
        same = fresh and safe and old.get('fingerprint') == item.get('fingerprint')
        since = old.get('since', now) if same else now
        quiet = now - since
        item.update(quiet_seconds=round(quiet), action='asleep' if item.get('asleep') else 'keep')
        if safe:
            tracking[address] = {'since': since, 'fingerprint': item.get('fingerprint')}
            status_age = (now * 1000 - (item.get('status_ms') or now * 1000)) / 1000
            if quiet < idle or status_age < idle:
                item['reasons'].append(f'unchanged for {int(min(quiet, status_age) // 60)} of {idle // 60} minutes')
            else:
                item['action'] = 'would_sleep'
                if not apply and hasattr(adapter, 'park_check'):
                    item['harness_check'] = adapter.park_check(config, {**item, 'git': adapter.git(item.get('cwd'))})
                if apply and not ready:
                    item['action'] = 'keep'
                    item['reasons'].append('apply not approved for this observer code (one recorded dry-run first)')
                elif apply and slept >= config.get('max_per_cycle', 4):
                    item['action'] = 'keep'
                    item['reasons'].append('per-cycle limit reached')
                elif apply and stop_reason:
                    item['action'] = 'keep'
                    item['reasons'].append(stop_reason)
                elif apply:
                    # The person moves around while a cycle runs. A fresh recheck of this pane
                    # (shown tab, focused pane, evidence) is what matters, not where the focus
                    # was when the cycle began.
                    check = adapter.snapshot()
                    where = pane_of(check).get(address)
                    latest = inspect(address, where[0], check, adapter, config, where[1]) if where else None
                    if not latest:
                        item['action'] = 'keep'; item['reasons'].append('pane moved or closed before sleep')
                    elif latest['reasons']:
                        item['action'] = 'keep'; item['reasons'].append('recheck: ' + '; '.join(latest['reasons']))
                    elif latest.get('fingerprint') != item.get('fingerprint'):
                        item['action'] = 'keep'; item['reasons'].append('evidence changed before sleep')
                    else:
                        before = spaces.focus(check['status'])
                        item['action'] = sleep_one(item, adapter, config, paths, now)
                        if item['action'] == 'slept':
                            slept += 1
                            tracking.pop(address, None)
                            after = adapter.snapshot()
                            if focused_terminal(after) == address:
                                raise RuntimeError('focus moved to the slept pane; further sleeps stopped')
                            if spaces.focus(after['status']) != before:
                                stop_reason = 'focus moved during the previous sleep; next cycle'
                                item['focus_moved'] = True
        item.pop('argv', None)
        results.append(item)
    state.update(last_at=now, sessions=tracking, trial=trial)
    return {'at': dt.datetime.fromtimestamp(now).astimezone().isoformat(), 'mode': 'apply' if apply else 'dry-run',
            'trial': trial, 'apply_ready': ready, 'focus': initial_focus, 'results': results}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--config', type=Path, default=BASE / 'sleep-idle-sessions.json')
    parser.add_argument('--state', type=Path, default=BASE / 'sleep-idle-sessions-state.json')
    parser.add_argument('--log', type=Path, default=BASE / 'sleep-idle-sessions.jsonl')
    parser.add_argument('--data', type=Path, default=BASE / 'session-sleep')
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--dry-run', action='store_true')
    group.add_argument('--apply', action='store_true')
    parser.add_argument('--app', default=shutil.which('herdr-app') or 'herdr-app')
    parser.add_argument('--core', default=shutil.which('herdr-core') or shutil.which('hc') or 'hc')
    args = parser.parse_args()
    config = spaces.load(args.config)
    if not isinstance(config, dict):
        parser.error('configuration required (see config/sleep-idle-sessions.example.json)')
    if config.get('idle_seconds', 1200) < 300:
        parser.error('idle_seconds must be at least 300')
    args.state.parent.mkdir(parents=True, exist_ok=True)
    lock = args.state.with_suffix('.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(json.dumps({'action': 'skip', 'reason': 'another sleep observer is running'})); return
    state = spaces.load(args.state, {})
    observer_hash = observer_sha256(Path(__file__).parent)
    if state.get('observer_sha256') != observer_hash:
        state = {'observer_sha256': observer_hash}
    paths = {'notes': args.data / 'notes', 'tickets': args.data / 'tickets', 'stub': Path(__file__).with_name('session_sleep_stub.py')}
    try:
        observation = cycle(Live(args.app, args.core), config, state, time.time(), apply=args.apply, paths=paths)
    except Exception as exc:
        state.setdefault('trial', {})['error_count'] = state.get('trial', {}).get('error_count', 0) + 1
        observation = {'at': dt.datetime.now().astimezone().isoformat(), 'mode': 'apply' if args.apply else 'dry-run', 'error': str(exc), 'results': []}
    spaces.save(args.state, state)
    if args.log.exists() and args.log.stat().st_size > 8 * 1024 * 1024:
        args.log.replace(args.log.with_suffix('.previous.jsonl'))
    with args.log.open('a') as file:
        file.write(json.dumps({**observation, 'results': [{k: v for k, v in r.items() if k != 'screen_tail'} for r in observation['results']]}, ensure_ascii=False) + '\n')
    args.log.chmod(0o600)
    print(json.dumps({k: v if k != 'results' else [{f: r.get(f) for f in ('address', 'space_name', 'action', 'reasons', 'quiet_seconds')} for r in v]
                      for k, v in observation.items()}, ensure_ascii=False))
    if 'error' in observation:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
