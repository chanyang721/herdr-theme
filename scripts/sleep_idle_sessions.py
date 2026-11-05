#!/usr/bin/env python3
"""Suspend idle agent sessions, fixed workspaces included, to free CPU and memory.

A session sleeps only when every check holds and has held, unchanged, for
idle_seconds (default 20 minutes): an idle/done agent, empty input, no approval
or decision text, no voice input, no subagent terminal, only idle helper
processes, no background job, outside the visible workspace and focused pane,
and not an excluded address. Then, in order, with a fresh recheck first:

  0. the session writes its own final report and experience: the observer types a
     `[세션 정리 보고 요청]` message, and sleeps it only after `harness.py close-status`
     finds that report (within close_report.timeout_seconds; otherwise it is kept and
     asked again after retry_seconds). The report waits for the person's acceptance in
     the memory window; nothing here accepts. close_report.enabled false skips this step.
  1. the harness keeps its context (`harness.py park --event suspended --task-id …`);
     no record, no sleep
  2. `/exit` is typed into the agent and the shell must come back
  3. the pane runs session_sleep_stub.py: Enter resumes the same session
     with its original flags, and a message sent to the pane resumes it and
     delivers the message (so `hc send` never reaches a bare shell)
  4. labels mark the pane: sixfold.sleep and the header title '절전 · …'

A session that finished through the harness (step 0 found its final report) is closed instead
of slept when its space keeps another pane (user rule, 2026-11-05; close_finished_panes, default
true): harness `park --event close_requested` first (no record, no close), the local note, then
`herdr-app do pane.close {"pane": <its pane id>}` (never "the focused pane"), a fresh snapshot
must show the pane gone (else every further action stops), and `park --event closed`. Every space
keeps at least one pane and every tab keeps one (pane.close on a tab's last pane closes the tab;
same as the harness close gate, t1 decision 2026-11-05), fixed workspaces included: such a pane
sleeps as above instead, or is kept when its terminal program is not a shell. Closing does not need a shell
(pane.close removes the terminal) and a pane in the shown tab may close, but the focused pane,
a float/overlay, typed input, voice, a pending decision, work, subagents and jobs still block it,
rechecked on a fresh snapshot right before.

Knowledge capture does not wait for a close or a sleep: a session idle/done for
close_report.collect_after_seconds (default idle_seconds) is asked for its close report even when
it will be kept (last pane, not a shell, shown tab), once per session and turn; a request that got
no answer is not repeated for a session that would be kept anyway.

Dry-run by default and a dry run types nothing: it says would_close (a report is already known),
would_sleep or would_collect_report, with close_if_finished from the space's pane count. Never
closes a tab on purpose or a space.
"""
import argparse
import datetime as dt
import file_lock as fcntl
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
import site_config  # noqa: E402

BASE = site_config.folder('state_dir')
VOICE = re.compile(r'(?:🎙|🎤|\bListening\b|\brecording\b|녹음\s*중|받아쓰는\s*중|음성\s*입력\s*중)', re.I)
OBSERVER_FILES = ('sleep_idle_sessions.py', 'agent_sessions.py', 'space_job_evidence.py', 'close_finished_spaces.py', 'session_sleep_stub.py',
                  'site_config.py')
SLEEP_LABEL, TITLE_LABEL, NEW_LABEL = 'sixfold.sleep', 'sixfold.title', 'sixfold.sleep.new'
VISIBLE = 'shown on screen (visible tab)'
NOT_SHELL = 'terminal program is not a shell: the pane would not survive /exit'
FLOAT = 'shown in a float or overlay'
# Block only the /exit sleep; a finished session's pane may still be closed or asked for its report.
SLEEP_ONLY = (VISIBLE, NOT_SHELL)


def blockers(item):
    """The reasons that block every action (closing and the report request too)."""
    return [r for r in item['reasons'] if r not in SLEEP_ONLY]


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
        return agent_sessions.styled_screen(self.core, address, env=self._env(), limit=limit, quiet=quiet)


    def request_report(self, address, text):
        return self.type_line(address, text)

    def close_status(self, config, item, since):
        return agent_sessions.harness_close_status(config, item, since)

    def park_check(self, config, item):
        return agent_sessions.harness_park(config, item, 'suspended', dry_run=True)

    def close_pane(self, pane_id):
        """Closes exactly this pane by id (never "the focused pane")."""
        if not pane_id:
            raise RuntimeError('pane.close refused: no pane id')
        return spaces.run([self.app, 'do', 'pane.close', json.dumps({'pane': pane_id})], timeout=60)

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


def pane_id_of(entry):
    return entry.get('pane') or entry.get('pane_id') or entry.get('id')


def space_panes(snapshot, space_id):
    """[(address, tab id)] for every terminal pane of one space, across all its tabs."""
    return [(t.get('terminal'), tab.get('id')) for space in snapshot['spaces'] if space.get('id') == space_id
            for tab in space.get('tabs', []) for t in tab.get('terminals', [])]


def close_blocker(item, snapshot, tab, closed):
    """Why this pane may not be closed (None = it may), counted on `snapshot` minus `closed`."""
    panes = [(a, t) for a, t in space_panes(snapshot, item['space_id']) if a not in closed]
    others = [a for a, t in panes if a != item['address']]
    if not others:
        return 'last pane in its space'
    # pane.close on a tab's last pane closes the tab: every tab keeps one too, like the harness
    # close gate (runtime/gate.py, t1 decision 2026-11-05).
    if not [a for a, t in panes if t == tab and a != item['address']]:
        return 'last pane in its tab'
    if not pane_id_of(pane_entry(snapshot, item['address'])):
        return 'pane id unavailable'
    return None


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
    return in_float(address, status)


def in_float(address, status):
    shown = json.dumps([status.get('floats') or {}, status.get('overlays') or []], ensure_ascii=False)
    return re.search(r'(?<![\w/])' + re.escape(address) + r'(?![\w])', shown) is not None


claude_suggestion = spaces.claude_suggestion


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
        reasons.append(VISIBLE)
    if in_float(address, status):
        reasons.append(FLOAT)   # a float is in front of the person: it blocks closing too
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
    item.update(app=app, title=terminal.get('title'), cwd=terminal.get('cwd'), status_ms=terminal.get('status_ms'),
                turn=terminal.get('turn'))
    shell = Path(str((terminal.get('argv') or [''])[0])).name
    if shell not in agent_sessions.SHELLS:
        # /exit would end the terminal program itself and could take the pane (and a space's
        # last pane) with it. Sleep only ever leaves a shell and the stub behind; closing a
        # finished session's pane and asking for its report do not need one.
        reasons.append(NOT_SHELL)
    if not terminal.get('reported') or app not in agent_sessions.AGENTS or state not in ('done', 'idle'):
        reasons.append('not a confirmed idle/done agent' if state != 'blocked' else 'user decision pending (blocked agent)')
        return item
    if blockers(item):
        return item
    if pane_entry(snapshot, address).get('sub_agents'):
        reasons.append('subagents shown in the pane')
    if any(t.get('parent') == address and t.get('state') == 'live' for t in snapshot['terminals'].values()):
        reasons.append('live subagent terminals')
    valid, why, pids = agent_sessions.process_evidence(terminal, snapshot['processes'])
    if not valid:
        reasons.append(why)
    mapping, why = agent_sessions.session_mapping(terminal, config)
    child = adapter.child(terminal) if mapping is None and 'inherited child session' in why and hasattr(adapter, 'child') else None
    if mapping is None and not child:
        reasons.append(why)
        return item
    item['session_id'] = (mapping or child)['session_id']
    item['argv'] = (terminal.get('foreground') or {}).get('argv') or []
    if child:
        # Opened inside another agent: no transcript to read jobs from, and nothing to resume. Its
        # clean process tree is the job evidence; it sleeps after its report and wakes as a new
        # session that reads the workspace memory.
        item['no_resume'] = True
        jobs_ok, jobs_reason, jobs_fp = valid, why, 'no-transcript'
    else:
        jobs_ok, jobs_reason, jobs_fp = adapter.backend(terminal, config, valid)
    if not jobs_ok:
        reasons.append(jobs_reason)
    text = adapter.screen(address)
    if spaces.background_running(text):
        reasons.append('in progress: a monitor or background shell is still running')
    elif spaces.decision_pending(text):
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
                                                     pids, jobs_fp, item['session_id'], hashlib.sha256(text.encode()).hexdigest()],
                                                    sort_keys=True).encode()).hexdigest()
    return item


def note(item, notes_dir, now):
    """Local-only detail (screen tail, folder, git): never synced, kept beside the observer."""
    path = Path(notes_dir) / f"{dt.datetime.fromtimestamp(now):%Y%m%d}-{item['address']}-{item['session_id'][:8]}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    keep = {k: item.get(k) for k in ('address', 'space_name', 'space_id', 'app', 'session_id', 'title', 'cwd', 'git', 'screen_tail', 'harness', 'argv', 'close_report')}
    keep['at'] = dt.datetime.fromtimestamp(now).astimezone().isoformat()
    path.write_text(json.dumps(keep, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    path.chmod(0o600)
    return str(path)


def ticket(item, tickets_dir):
    """What the stub needs to resume: the original command, folder and session."""
    path = Path(tickets_dir) / f"{item['address']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    argv = (agent_sessions.new_session_argv(item['app'], item.get('argv')) if item.get('no_resume')
            else agent_sessions.resume_argv(item['app'], item.get('argv'), item['session_id']))
    value = {'address': item['address'], 'app': item['app'], 'session_id': item['session_id'], 'cwd': item.get('cwd'),
             'argv': argv, 'new_session': bool(item.get('no_resume')),
             'title': item.get('title') or '', 'space_id': item['space_id'], 'space_name': item.get('space_name')}
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
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
    labels = {SLEEP_LABEL: f"{agent_sessions.provider(item['app'])}:{item['session_id']}",
              TITLE_LABEL: f'절전 · {title}' if title else '절전'}
    if item.get('no_resume'):
        labels[NEW_LABEL] = '1'   # wakes as a new session: the space archive must not try to resume it
    adapter.label(item['address'], **labels)
    return 'slept'


def close_one(item, adapter, config, paths, now, snapshot):
    """Harness close_requested → local note → pane.close by id → gone from a fresh snapshot →
    harness closed. Returns (action, the snapshot after the close or None)."""
    pane_id = pane_id_of(pane_entry(snapshot, item['address']))
    item['git'] = adapter.git(item.get('cwd'))
    ok, detail = adapter.park(config, item, 'close_requested', reason='finished harness session: pane closed')
    item['harness'] = detail
    if not ok:
        item['reasons'].append(f'harness record failed: {detail}')
        return 'keep', None
    item['note'] = note(item, paths['notes'], now)

    adapter.close_pane(pane_id)
    after = adapter.snapshot()
    if item['address'] in pane_of(after) or any(pane_id_of(t) == pane_id for s in after['spaces']
                                                for tab in s.get('tabs', []) for t in tab.get('terminals', [])):
        raise RuntimeError(f"{item['address']}: pane still present after pane.close; further actions stopped")
    adapter.park(config, item, 'closed', reason='pane closed')
    return 'closed', after


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
    report_cfg = config.get('close_report') or {}
    report_on = report_cfg.get('enabled', True) is not False
    close_on = report_on and config.get('close_finished_panes', True) is not False
    collect_after = report_cfg.get('collect_after_seconds', idle) if report_on else idle
    threshold = min(idle, collect_after)
    reports = {a: e for a, e in (state.get('reports') or {}).items() if a in pane_of(snapshot)}
    settle = report_cfg.get('settle_seconds', 120)
    initial_focus = spaces.focus(snapshot['status'])
    results, tracking, acted, closed = [], {}, 0, set()
    stop_reason = None
    for address, (space, tab) in sorted(pane_of(snapshot).items()):
        item = inspect(address, space, snapshot, adapter, config, tab)
        old = previous.get(address, {})
        safe = not blockers(item)          # nothing blocks closing or asking for the report
        sleepable = not item['reasons']    # nothing blocks the /exit sleep either
        same = fresh and safe and old.get('fingerprint') == item.get('fingerprint')
        since = old.get('since', now) if same else now
        quiet = now - since
        item.update(quiet_seconds=round(quiet), action='asleep' if item.get('asleep') else 'keep')
        if safe and not sleepable and not report_on:
            pass   # only the sleep could act, and it is blocked
        elif safe:
            tracking[address] = {'since': since, 'fingerprint': item.get('fingerprint')}
            status_age = (now * 1000 - (item.get('status_ms') or now * 1000)) / 1000
            asked = reports.get(address) or {}
            answering = (asked.get('session_id') == item.get('session_id') and not asked.get('failed_at')
                         and quiet >= settle and status_age >= settle)
            # Idle long enough to close or sleep: now, or before the report request it is answering.
            idle_ok = (quiet >= idle and status_age >= idle) or (answering and asked.get('idle_ok', True))
            collect = report_on and (answering or (quiet >= collect_after and status_age >= collect_after))
            item['close_if_finished'] = bool(close_on and close_blocker(item, snapshot, tab, closed) is None)
            if not idle_ok and not collect:
                item['reasons'].append(f'unchanged for {int(min(quiet, status_age) // 60)} of {threshold // 60} minutes')
            elif not apply:
                known = asked.get('session_id') == item.get('session_id') and asked.get('report')
                if idle_ok and item['close_if_finished'] and known:
                    item['action'] = 'would_close'
                elif idle_ok and sleepable:
                    item['action'] = 'would_sleep'
                elif report_on:
                    item['action'] = 'would_collect_report'
                if item['action'] in ('would_close', 'would_sleep') and hasattr(adapter, 'park_check'):
                    item['harness_check'] = adapter.park_check(config, {**item, 'git': adapter.git(item.get('cwd'))})
            elif not ready:
                item['reasons'].append('apply not approved for this observer code (one recorded dry-run first)')
            elif acted >= config.get('max_per_cycle', 4):
                item['reasons'].append('per-cycle limit reached')
            elif stop_reason:
                item['reasons'].append(stop_reason)
            else:
                # The person moves around while a cycle runs. A fresh recheck of this pane
                # (shown tab, focused pane, evidence) is what matters, not where the focus
                # was when the cycle began.
                check = adapter.snapshot()
                where = pane_of(check).get(address)
                latest = inspect(address, where[0], check, adapter, config, where[1]) if where else None
                if not latest:
                    item['reasons'].append('pane moved or closed before sleep')
                elif blockers(latest):
                    item['reasons'].append('recheck: ' + '; '.join(blockers(latest)))
                elif latest.get('fingerprint') != item.get('fingerprint'):
                    item['reasons'].append('evidence changed before sleep')
                else:
                    before = spaces.focus(check['status'])
                    sleepable = not latest['reasons']
                    why_not_close = close_blocker(latest, check, where[1], closed) if close_on else 'close_finished_panes off'
                    may_close = idle_ok and why_not_close is None
                    may_sleep = idle_ok and sleepable
                    kept_anyway = not may_close and not may_sleep
                    if kept_anyway and asked.get('session_id') == item.get('session_id') and asked.get('failed_at') \
                            and asked.get('turn') == item.get('turn'):
                        # Nothing would close or sleep it: one unanswered request per session and turn.
                        decision, detail = 'failed', 'no close report for this turn: kept, not asked again'
                    else:
                        decision, detail = agent_sessions.report_gate(reports, item, adapter, config, now)
                    if decision in ('requested', 'ready') and 'idle_ok' not in reports.get(address, {'idle_ok': 0}):
                        # A report taken before idle_seconds (collect_after_seconds) does not make it closable.
                        reports[address]['idle_ok'] = quiet >= idle and status_age >= idle
                    after = None
                    if decision == 'ready':
                        item['close_report'], item['report_task_id'] = detail['report_id'], detail.get('task_id')
                    if decision == 'ready' and may_close:
                        item['action'], after = close_one(item, adapter, config, paths, now, check)
                    elif decision in ('ready', 'off') and may_sleep:
                        if decision == 'ready' and close_on and why_not_close:
                            item['reasons'].append(f'{why_not_close}: slept instead of closed')
                        item['action'] = sleep_one(item, adapter, config, paths, now)
                    elif decision == 'ready':
                        item['action'] = 'reported'
                        item['reasons'].append('close report collected; kept: ' + '; '.join(
                            [r for r in [why_not_close if close_on else None] if r] + latest['reasons']
                            + ([] if idle_ok else ['not idle long enough to close or sleep'])))
                    elif decision == 'off':
                        item['reasons'].extend(latest['reasons'])
                    else:
                        item['action'] = 'report_requested' if decision == 'requested' else 'keep'
                        item['reasons'].append({'requested': 'asked the session for its close report',
                                                'waiting': 'waiting for the session close report'}.get(decision, detail))
                    if item['action'] in ('slept', 'closed'):
                        acted += 1
                        tracking.pop(address, None)
                        reports.pop(address, None)
                        if item['action'] == 'closed':
                            closed.add(address)
                        after = after or adapter.snapshot()
                        if focused_terminal(after) == address:
                            raise RuntimeError('focus moved to the slept pane; further sleeps stopped')
                        if spaces.focus(after['status']) != before:
                            stop_reason = 'focus moved during the previous sleep; next cycle'
                            item['focus_moved'] = True
        item.pop('argv', None)
        results.append(item)
    state.update(last_at=now, sessions=tracking, trial=trial, reports=reports)
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
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    main()
