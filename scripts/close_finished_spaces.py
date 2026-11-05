#!/usr/bin/env python3
"""Conservatively observe idle temporary spaces. Dry-run by default; never deletes worktrees."""
import argparse
import datetime as dt
import file_lock as fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import unicodedata
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent_sessions  # noqa: E402
import site_config  # noqa: E402

BASE = site_config.folder('state_dir')
DECISION = re.compile(r'승인\s*대기|확인\s*필요|결정\s*대기|사용자.{0,12}(?:확인|승인).{0,8}(?:대기|기다)|awaiting\s+(?:approval|confirmation)|waiting\s+for\s+(?:your|user)\s+(?:approval|confirmation)|allow\s+(?:once|always)', re.I)
# The agent's own command refused or let through by Claude's auto mode: a log line, not a question.
AUTO_MODE = re.compile(r'(?:Blocked|Allowed)\s+by\s+auto\s+mode|/permissions\s+to\s+review', re.I)
# A real question for the person: Claude's permission dialog or a question with numbered choices.
PROMPTED = re.compile(r'Do you want to (?:proceed|make this edit|create|run|allow)\b|❯\s*1\.\s*Yes\b', re.I)
# Background work the agent still owns (Claude footer "· 1 monitor still running", "· 2 shells").
RUNNING = re.compile(r'\b\d+\s+(?:monitors?|shells?|background\s+(?:tasks?|shells?|jobs?))(?:\s+still\s+running)?\b', re.I)


def decision_pending(text):
    """A question, approval or input the person must answer; auto-mode log lines are not one."""
    lines = [l for l in text.splitlines() if not AUTO_MODE.search(l)]
    rest = '\n'.join(lines)
    return bool(DECISION.search(rest) or PROMPTED.search(rest))


def background_running(text):
    """The agent's footer still counts a monitor or background shell: the session is in progress."""
    tail = '\n'.join(text.splitlines()[-8:])
    return bool(RUNNING.search(tail))


PLACEHOLDERS = {'', 'Ask Codex to do anything', 'Write tests for @filename', 'Implement {feature}', 'Find and fix a bug in @filename', 'Explain this codebase', 'Improve documentation in @filename', 'Summarize recent commits', 'Use /skills to list available skills'}
AGENTS = agent_sessions.AGENTS


def run(argv, *, timeout=12):
    result = subprocess.run([str(v) for v in argv], capture_output=True, text=True, timeout=timeout, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise RuntimeError(f'{Path(str(argv[0])).name} {argv[1:2]} exited {result.returncode}: {result.stderr.strip()[:180]}')
    return result.stdout


def load(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return default


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f'.{os.getpid()}.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    tmp.chmod(0o600)
    tmp.replace(path)


def empty_prompt(text, agent):
    """Only recognized visible empty input/placeholder rows count as evidence."""
    marker = '›' if agent == 'codex' else '❯' if agent in ('claude', 'claude-code') else None
    if marker is None:
        return False
    lines = text.splitlines()
    matches = [i for i, line in enumerate(lines) if line.lstrip().startswith(marker)]
    if not matches:
        return False
    i = matches[-1]
    value = lines[i].strip()[len(marker):].strip()
    if value not in PLACEHOLDERS:
        return False
    # A wrapped/multiline input is not empty. Only known footer chrome may follow.
    footer = re.compile(r'^(?:[─━═]{3,}$|GPT-|Claude|[←↳]|voice\b|mic\b|codex\b|[▁▂▃▄▅▆▇█]|⚠|⏵|\?\s|\d+%\s+context|f\d+\b|for agents|.*weekly limit|.*auto mode|.*shift\+tab|.*esc to interrupt)', re.I)
    return all(not line.strip() or footer.match(line.strip()) for line in lines[i + 1:])


def claude_suggestion(text, app, adapter, address):
    """True when the only thing in Claude's input row is its faint prompt suggestion (SGR 2 in the
    pane's colour repaint). Text the person typed is drawn plain and is never treated as empty."""
    if agent_sessions.provider(app) != 'claude' or not hasattr(adapter, 'styled_screen'):
        return False
    lines = text.splitlines()
    rows = [i for i, line in enumerate(lines) if line.lstrip().startswith('❯')]
    if not rows:
        return False
    i = rows[-1]
    value = lines[i].strip()[1:].strip()
    blank = '\n'.join(lines[:i] + ['❯'] + lines[i + 1:])
    if not value or not empty_prompt(blank, app):
        return False
    try:
        raw = adapter.styled_screen(address)
    except (OSError, RuntimeError, ValueError):
        return False
    return agent_sessions.suggestion_only(value, raw)


def process_rows():
    return agent_sessions.process_table()


def process_evidence(terminal, processes):
    return agent_sessions.process_evidence(terminal, processes)


class Live:
    def __init__(self, app, core):
        self.app, self.core = app, core

    def snapshot(self):
        status = json.loads(run([self.app, 'status']))
        spaces = json.loads(run([self.app, 'ls']))['spaces']
        listing = json.loads(run([self.core, 'ls', '--all', '--json']))['terminals']
        terminals = {item['address']: json.loads(run([self.core, 'get', item['address'], '--json'])) for item in listing if item.get('state') == 'live'}
        return {'status': status, 'spaces': spaces, 'terminals': terminals, 'processes': process_rows()}

    def styled_screen(self, address):
        return agent_sessions.styled_screen(self.core, address, env=self._env())

    @staticmethod
    def _env():
        # Without a caller terminal, hc pastes the text as it is (no <hc> wrapper).
        return {k: v for k, v in os.environ.items() if k not in ('HC_TERMINAL_ID', 'HC_SCOPE')}

    def screen(self, address):
        value = json.loads(run([self.core, 'read', address, '--json', '--lines', '0']))
        if not value.get('complete') or value.get('how') != 'screen' or not isinstance(value.get('text'), str):
            raise RuntimeError('complete visible screen unavailable')
        return value['text']

    def backend(self, terminal, config, process_tree_clean=False):
        from space_job_evidence import check_jobs
        mapping, why = agent_sessions.session_mapping(terminal, config)
        configured = (config.get('sessions') or {}).get(terminal.get('address'))
        if mapping is None and not configured:
            return False, f'backend jobs unverified: {why}', ''
        return check_jobs(terminal, config, mapping, process_tree_clean)

    def mapping(self, terminal, config):
        configured = (config.get('sessions') or {}).get(terminal.get('address'))
        return configured or agent_sessions.session_mapping(terminal, config)[0]

    def child(self, terminal):
        return agent_sessions.child_session(terminal)

    def park(self, config, item, event, reason=None):
        return agent_sessions.harness_park(config, item, event, reason=reason)

    def git(self, folder):
        return agent_sessions.git_brief(folder)

    def request_report(self, address, text):
        return agent_sessions.run([self.core, 'send', address, text], env=self._env(), timeout=30)

    def close_status(self, config, item, since):
        return agent_sessions.harness_close_status(config, item, since)

    def close_gate(self, config, item):
        return agent_sessions.harness_close_gate(config, item)

    def archive(self, config, data):
        return agent_sessions.harness_archive(config, data)

    def machine(self):
        return agent_sessions.self_core_id()

    def close(self, space_id, config=None):
        if not (config or {}).get('space_close_enabled'):
            raise RuntimeError('space.close refused: workspaces are kept (space_close_enabled is off)')
        return run([self.app, 'do', 'space.close', json.dumps({'id': space_id, 'confirmed': True})])

    def notify(self, address, message):
        return run([self.core, 'send', address, message])


def focus(status):
    return tuple(status.get(k) for k in ('space', 'tab', 'focused_pane'))


def fixed(space, config):
    if space.get('name', '').casefold() in {x.casefold() for x in config.get('fixed_names', [])}:
        return True
    return any(item.get('id') == space.get('id') and item.get('machine') == space.get('machine') for item in config.get('fixed_spaces', []))


SLEEP_LABEL = 'sixfold.sleep'


def slept_session(terminal, space):
    """The session a slept pane holds (sleep label + the resume stub in the foreground), else None."""
    label = (terminal.get('labels') or {}).get(SLEEP_LABEL) or ''
    fg = terminal.get('foreground')
    argv = (fg.get('argv') or []) if isinstance(fg, dict) else []
    if ':' not in label or not any(str(a).endswith('session_sleep_stub.py') for a in argv):
        return None
    provider, sid = label.split(':', 1)
    if provider not in ('claude', 'codex') or not re.fullmatch(r'[0-9a-f-]{36}', sid):
        return None
    labels = terminal.get('labels') or {}
    return {'address': terminal.get('address'), 'app': 'claude-code' if provider == 'claude' else 'codex', 'session_id': sid,
            'space_id': space['id'], 'space_name': space.get('name'), 'title': labels.get('sixfold.title'),
            'cwd': terminal.get('cwd'), 'turn': terminal.get('turn'), 'slept': True,
            # slept without a transcript: it wakes as a new session, so nothing is resumed on reopen
            **({'no_resume': True} if labels.get('sixfold.sleep.new') else {})}


def inspect(space, snapshot, adapter, config):
    reasons, evidence, screens, sessions = [], [], [], []
    status = snapshot['status']
    if not all(focus(status)) or status.get('errors'):
        reasons.append('app focus/health unverified')
    if fixed(space, config):
        reasons.append('fixed workspace')
    if space.get('id') == status.get('space') or space.get('active'):
        reasons.append('currently visible workspace')
    if space.get('machine') is not None:
        reasons.append('remote process/input evidence unavailable')
    if reasons:
        return {'id': space['id'], 'name': space['name'], 'reasons': reasons, 'safe': False}
    addresses = sorted({t['terminal'] for tab in space.get('tabs', []) for t in tab.get('terminals', [])})
    if not addresses:
        reasons.append('no observable agent terminals')
    all_terms = snapshot['terminals']
    for address in addresses:
        terminal = all_terms.get(address)
        if not terminal:
            reasons.append(f'{address}: terminal evidence unavailable')
            continue
        slept = slept_session(terminal, space)
        if slept:
            # Already suspended by the sleep observer: the agent exited after its own park record,
            # the pane runs only the resume stub. Nothing can be pending in it.
            sessions.append(slept)
            evidence.append([address, terminal.get('pid'), 'slept', slept['session_id']])
            continue
        agent = (terminal.get('status') or {}).get('app')
        state = (terminal.get('status') or {}).get('state')
        if terminal.get('reported') and agent in AGENTS and state == 'blocked':
            reasons.append(f'{address}: user decision pending (blocked agent)')
        if not terminal.get('reported') or agent not in AGENTS or state not in ('done', 'idle'):
            reasons.append(f'{address}: not a confirmed idle/done agent')
            continue
        children = [t for t in all_terms.values() if t.get('parent') == address and t.get('state') == 'live']
        if children:
            reasons.append(f'{address}: live subagent terminals')
        valid, why, pids = process_evidence(terminal, snapshot['processes'])
        if not valid:
            reasons.append(f'{address}: {why}')
        jobs_ok, jobs_reason, jobs_fingerprint = adapter.backend(terminal, config, valid)
        child = adapter.child(terminal) if 'inherited child session' in (jobs_reason or '') and hasattr(adapter, 'child') else None
        # A Claude opened inside another agent has no transcript to read its jobs from. Its process
        # tree (no shell, build or other child) and the footer below are the evidence instead.
        if not jobs_ok and not (child and valid):
            reasons.append(f'{address}: {jobs_reason}')
        text = adapter.screen(address)
        if background_running(text):
            reasons.append(f'{address}: in progress: a monitor or background shell is still running')
        elif decision_pending(text):
            reasons.append(f'{address}: user decision pending')
        if not empty_prompt(text, agent) and not claude_suggestion(text, agent, adapter, address):
            reasons.append(f'{address}: empty input unverified')
        screens.append(text)
        mapping = adapter.mapping(terminal, config) if hasattr(adapter, 'mapping') else None
        if mapping and mapping.get('session_id'):
            sessions.append({'address': address, 'app': agent, 'session_id': mapping['session_id'], 'space_id': space['id'],
                             'space_name': space.get('name'), 'title': terminal.get('title'), 'cwd': terminal.get('cwd'),
                             'turn': terminal.get('turn')})
        elif child:
            # No session file or transcript (started inside another agent): it still reports and is
            # parked under its pane session id, and reopens as a new session reading the workspace memory.
            sessions.append({'address': address, 'app': agent, 'session_id': child['session_id'], 'space_id': space['id'],
                             'space_name': space.get('name'), 'title': terminal.get('title'), 'cwd': terminal.get('cwd'),
                             'turn': terminal.get('turn'), 'no_resume': True})
        else:
            reasons.append(f'{address}: session id unverified (harness record impossible)')
        evidence.append([address, terminal.get('pid'), terminal.get('status_ms'), terminal.get('turn'), pids, jobs_fingerprint, hashlib.sha256(text.encode()).hexdigest()])
    fingerprint = hashlib.sha256(json.dumps(evidence, sort_keys=True).encode()).hexdigest()
    return {'id': space['id'], 'name': space['name'], 'safe': not reasons, 'reasons': reasons, 'fingerprint': fingerprint,
            'folders': sorted({t.get('cwd') for a, t in all_terms.items() if a in addresses and t.get('cwd')} | ({space['folder']} if space.get('folder') else set())),
            'summary': '\n'.join('\n'.join(s.splitlines()[-8:]) for s in screens)[:2400], 'sessions': sessions}


def close_gate_blockers(item, adapter, config):
    """['tX: why', …] from `harness.py close-gate` for every agent session in the space; empty
    means the space may close. Off only with config close_gate.enabled false; any error keeps it."""
    if (config.get('close_gate') or {}).get('enabled', True) is False:
        return []
    if not hasattr(adapter, 'close_gate'):
        return ['close gate unavailable']
    out = []
    for session in item.get('sessions', []):
        if not session.get('session_id'):
            out.append(f"{session['address']}: no session id for the harness gate")
            continue
        ok, blockers = adapter.close_gate(config, session)
        if not ok:
            out.append(f"{session['address']}: " + ', '.join(blockers or ['refused'])[:300])
    return out


def archive_of(space, item, parked, snapshot, adapter):
    """The harness archive of a space about to close: what reopening needs, nothing more."""
    machine = adapter.machine() if hasattr(adapter, 'machine') else agent_sessions.self_core_id()
    sessions = {s['address']: s for s, _ in parked}
    tabs = []
    for tab in space.get('tabs', []):
        panes = []
        for t in tab.get('terminals', []):
            address = t.get('terminal')
            s = sessions.get(address, {})
            term = snapshot['terminals'].get(address) or {}
            pane = {'address': address, 'agent': s.get('app') or t.get('app'), 'cwd': s.get('cwd') or term.get('cwd'),
                    'last_state': 'slept' if s.get('slept') else t.get('status'),
                    'git': s.get('git') or (adapter.git(term.get('cwd')) if hasattr(adapter, 'git') else None)}
            if s.get('no_resume'):
                pane['no_transcript'] = True   # reopen starts a new session; the pane id is not resumable
            elif s.get('session_id'):
                pane['session_id'] = s['session_id']
            if s.get('title'):
                pane['title'] = str(s['title'])[:120]
            panes.append(pane)
        tabs.append({'name': tab.get('name'), 'panes': panes})
    return {'workspace_id': f"{machine}-{space['id'].split('/')[-1]}", 'name': space.get('name'), 'space_id': space['id'],
            'folder': space.get('folder'), 'tabs': tabs, 'reason': 'unused: every pane idle/done/slept and reported'}


def git_info(folder):
    info = {'folder': folder}
    for key, args in [('branch', ['branch', '--show-current']), ('commits', ['log', '-3', '--oneline']), ('remaining_uncommitted', ['status', '--short']), ('worktrees', ['worktree', 'list', '--porcelain'])]:
        try:
            info[key] = run(['git', '-C', folder, *args]).strip()[:16000]
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
            info[key] = f'unverified: {exc}'
    return info


def record_space(item, report_dir, now, terms=()):
    """The workspace record (~/…/워크스페이스-기록/<YYYYMMDD>_<이름>.md). Denylisted names become
    [가림] in its name and text, like every other record the cleanup writes."""
    stamp = dt.datetime.fromtimestamp(now).astimezone()
    mask = lambda text: agent_sessions.mask_text(text, terms)  # noqa: E731
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '-', mask(unicodedata.normalize('NFC', item['name']))).replace(' ', '-')[:90] or 'workspace'
    path = Path(report_dir) / f'{stamp:%Y%m%d}_{name}.md'
    path.parent.mkdir(parents=True, exist_ok=True)
    line = f'\n- 자동 정리 시각: {stamp.isoformat()} · space {item["id"]}\n'
    if path.exists():
        with path.open('a', encoding='utf-8') as file:
            file.write(line)
    else:
        details = [git_info(folder) for folder in item.get('folders', [])]
        body = (f'# {item["name"]} 자동 정리 기록\n\n- 공간: {item["id"]}\n'
                + (f'- 하네스 보관: {item["archive"]}\n' if item.get('archive') else '')
                + '\n마지막 화면 일부(관측 자료):\n\n' + '\n'.join('> ' + v for v in item.get('summary', '').splitlines()) + '\n'
                + '\n폴더·브랜치·최근 커밋·남은 미커밋·worktree 목록(삭제하지 않음):\n\n```json\n'
                + json.dumps(details, ensure_ascii=False, indent=2) + '\n```\n' + line)
        with path.open('x', encoding='utf-8') as file:
            file.write(mask(body))
    return str(path)


def cycle(adapter, config, state, now, *, apply=False, only_space=None, report_dir=None):
    snapshot = adapter.snapshot()
    previous = state.get('spaces', {})
    gap = now - state.get('last_at', now)
    fresh = 0 <= gap <= config.get('max_sample_gap_seconds', 660)
    trial = state.get('trial', {}) if fresh else {}
    trial = {'started_at': trial.get('started_at', now), 'samples': trial.get('samples', 0) + 1,
             'error_count': trial.get('error_count', 0)}
    # The person may approve apply after one recorded dry-run of this exact code
    # (user_approved_apply), instead of the 30-minute trial review.
    approved = bool(config.get('user_approved_apply')) and config.get('reviewed_observer_sha256') == state.get('observer_sha256')
    trial_ok = (now - trial['started_at'] >= config.get('trial_seconds', 1800) and trial['samples'] >= 7 or approved and trial['samples'] >= 2) and trial['error_count'] == 0
    reviewed = approved or isinstance(config.get('reviewed_dry_run_at'), (int, float)) and config['reviewed_dry_run_at'] >= trial['started_at'] + config.get('trial_seconds', 1800) and config.get('reviewed_observer_sha256') == state.get('observer_sha256')
    result, tracking = [], {}
    reports = dict(state.get('reports') or {})
    initial_focus = focus(snapshot['status'])
    for space in snapshot['spaces']:
        if only_space and space['id'] != only_space:
            continue
        item = inspect(space, snapshot, adapter, config)
        old = previous.get(space['id'], {})
        same = fresh and item['safe'] and old.get('fingerprint') == item.get('fingerprint')
        since = old.get('since', now) if same else now
        quiet = now - since
        item.update(quiet_seconds=quiet, action='keep')
        tracking[space['id']] = {'since': since, 'fingerprint': item.get('fingerprint'), 'decision_notified_at': old.get('decision_notified_at', 0)}
        manual = bool(config.get('_manual'))
        if item['safe'] and (quiet >= config.get('idle_seconds', 21600) or manual):
            item['action'] = 'would_close'
            # manual: the person asked for this space by name (--only-space --now): no quiet window,
            # trial or switch; every safety check, close report and the archive still apply.
            if apply and not config.get('space_close_enabled') and not manual:
                # User rule (2026-11-04): a workspace is never removed and always keeps a pane.
                # Closing even a temporary space waits for the person's explicit answer
                # (`space_close_enabled: true`); until then the candidate is only reported.
                item['action'] = 'keep'
                item['reasons'].append('space close held: workspaces are kept until the person enables it')
            elif apply and not trial_ok and not manual:
                item['action'] = 'keep'
                item['reasons'].append('30-minute dry-run review not complete')
            elif apply and not reviewed and not manual:
                item['action'] = 'keep'
                item['reasons'].append('dry-run review not recorded')
            elif apply:
                # Immediately recheck every prerequisite and the original user focus.
                check = adapter.snapshot()
                target = next((s for s in check['spaces'] if s['id'] == space['id']), None)
                if target is None or focus(check['status']) != initial_focus:
                    item['action'] = 'keep'; item['reasons'].append('space/focus changed before close')
                else:
                    latest = inspect(target, check, adapter, config)
                    if not latest['safe'] or latest.get('fingerprint') != item.get('fingerprint'):
                        item['action'] = 'keep'; item['reasons'].append('evidence changed before close')
                    else:
                        # Each session reports itself first (close-report); any session without a
                        # report in time keeps the whole space (fail-closed).
                        waiting = []
                        for session in item.get('sessions', []):
                            if session.get('slept'):
                                continue   # it reported (or was parked) when it was put to sleep
                            # a session without a transcript cannot be resumed, but it answers like any other
                            decision, detail = agent_sessions.report_gate(reports, session, adapter, config, now)
                            if decision == 'ready':
                                session['report_task_id'] = detail.get('task_id')
                            elif decision != 'off':
                                waiting.append(f"{session['address']}: {decision}" + (f' ({detail})' if isinstance(detail, str) else ''))
                        if waiting:
                            item['action'] = 'keep'; item['reasons'].append('close report: ' + '; '.join(waiting))
                            result.append(item); continue
                        # The harness decides: each session's report must be accepted (and learnt) by a
                        # trusted actor, with no other open task or escalation in the workspace.
                        held = close_gate_blockers(item, adapter, config)
                        if held:
                            item['action'] = 'keep'; item['reasons'].append('harness close gate: ' + '; '.join(held))
                            result.append(item); continue
                        # Harness first: no record, no close (each agent session in the space).
                        parked, refused = [], None
                        for session in item.get('sessions', []):
                            session = {**session, 'git': adapter.git(session.get('cwd'))} if hasattr(adapter, 'git') else session
                            if not session.get('session_id'):
                                parked.append((session, 'no session id: archived only'))
                                continue
                            ok, detail = adapter.park(config, session, 'close_requested', reason='space closed: idle and finished')
                            if not ok:
                                refused = f"{session['address']}: {detail}"; break
                            parked.append((session, detail))
                        if refused or not parked:
                            item['action'] = 'keep'; item['reasons'].append(f'harness record failed: {refused or "no session"}')
                            item['harness'] = [d for _, d in parked]
                            result.append(item); continue
                        item['harness'] = [d for _, d in parked]
                        # How to bring the space back (name, folder, tabs, sessions, git) goes to the
                        # harness before anything closes; no archive, no close.
                        ok, detail = adapter.archive(config, archive_of(space, item, parked, check, adapter))
                        if not ok:
                            item['action'] = 'keep'; item['reasons'].append(f'harness archive failed: {detail}')
                            result.append(item); continue
                        item['archive'] = detail
                        item['record'] = record_space(item, report_dir, now, agent_sessions.denylist(config))
                        adapter.close(space['id'], {**config, 'space_close_enabled': True} if manual else config)
                        after = adapter.snapshot()
                        if any(s['id'] == space['id'] for s in after['spaces']):
                            raise RuntimeError('space.close not confirmed')
                        if focus(after['status']) != initial_focus:
                            raise RuntimeError('focus changed after close; further cleanup stopped')
                        item['action'] = 'closed'
                        del tracking[space['id']]
                        for session, _ in parked:
                            if session.get('session_id'):
                                adapter.park(config, session, 'closed', reason='space closed')
        elif item['safe']:
            item['reasons'].append('idle/output-stable observation window incomplete')
        if item['action'] == 'would_close' and not apply and hasattr(adapter, 'park'):
            item['harness_check'] = [agent_sessions.harness_park(config, {**x, 'git': adapter.git(x.get('cwd'))}, 'close_requested', dry_run=True)
                                     for x in item.get('sessions', [])]
        if apply and trial_ok and reviewed and any('user decision pending' in r for r in item['reasons']):
            notified = old.get('decision_notified_at', 0)
            if config.get('notify_terminal') and now - notified >= 86400:
                adapter.notify(config['notify_terminal'], f'[자동 정리 보류·사용자 결정 필요] {item["name"]}: 승인/확인 대기 문구가 있어 공간을 유지했습니다. 직접 확인해 주세요.')
                tracking[space['id']]['decision_notified_at'] = now
        result.append(item)
    live = {t['terminal'] for sp in snapshot['spaces'] for tab in sp.get('tabs', []) for t in tab.get('terminals', [])}
    state.update(last_at=now, spaces=tracking, trial=trial, reports={a: e for a, e in reports.items() if a in live})
    return {'at': dt.datetime.fromtimestamp(now).astimezone().isoformat(), 'mode': 'apply' if apply else 'dry-run', 'trial': trial,
            'trial_ready': trial_ok, 'results': result, 'focus': initial_focus}


OBSERVER_FILES = ('close_finished_spaces.py', 'space_job_evidence.py', 'agent_sessions.py', 'site_config.py')


def observer_sha256(folder):
    return hashlib.sha256(b''.join((Path(folder) / name).read_bytes() for name in OBSERVER_FILES)).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=BASE / 'close-finished-spaces.json')
    parser.add_argument('--state', type=Path, default=BASE / 'close-finished-spaces-state.json')
    parser.add_argument('--log', type=Path, default=BASE / 'close-finished-spaces.jsonl')
    parser.add_argument('--report-dir', type=Path, default=site_config.folder('reports_dir') / '워크스페이스-기록')
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--dry-run', action='store_true')
    group.add_argument('--apply', action='store_true')
    parser.add_argument('--only-space')
    parser.add_argument('--now', action='store_true',
                        help='with --apply --only-space: the person asked to archive and close this space now '
                             '(no quiet window or trial; every safety check, the close reports and the archive still apply)')
    parser.add_argument('--app', default=shutil.which('herdr-app') or 'herdr-app')
    parser.add_argument('--core', default=shutil.which('herdr-core') or shutil.which('hc') or 'hc')
    args = parser.parse_args()
    config = load(args.config)
    if not isinstance(config, dict) or not (config.get('fixed_names') or config.get('fixed_spaces')):
        parser.error('explicit fixed workspace configuration required')
    if config.get('idle_seconds', 600) <= 0 or config.get('trial_seconds', 1800) < 1800:
        parser.error('idle_seconds must be positive; live trial minimum is 1800 seconds')
    args.state.parent.mkdir(parents=True, exist_ok=True)
    lock = args.state.with_suffix('.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(json.dumps({'action': 'skip', 'reason': 'another cleanup observer is running'})); return
    if args.now:
        if not (args.apply and args.only_space):
            parser.error('--now needs --apply and --only-space')
        config = {**config, '_manual': True}
    state = load(args.state, {})
    observer_hash = observer_sha256(Path(__file__).parent)
    if state.get('observer_sha256') != observer_hash:
        state = {'observer_sha256': observer_hash}
    try:
        observation = cycle(Live(args.app, args.core), config, state, time.time(), apply=args.apply, only_space=args.only_space, report_dir=args.report_dir)
    except Exception as exc:
        state.setdefault('trial', {})['error_count'] = state.get('trial', {}).get('error_count', 0) + 1
        observation = {'at': dt.datetime.now().astimezone().isoformat(), 'mode': 'apply' if args.apply else 'dry-run', 'error': str(exc), 'results': []}
    save(args.state, state)
    args.log.parent.mkdir(parents=True, exist_ok=True)
    if args.log.exists() and args.log.stat().st_size > 8 * 1024 * 1024:
        args.log.replace(args.log.with_suffix('.previous.jsonl'))
    with args.log.open('a') as file:
        file.write(json.dumps(observation, ensure_ascii=False) + '\n')
    args.log.chmod(0o600)
    print(json.dumps({k: v if k != 'results' else [{field: item.get(field) for field in ('id', 'name', 'action', 'reasons', 'quiet_seconds')} for item in v] for k, v in observation.items()}, ensure_ascii=False))
    if 'error' in observation:
        raise SystemExit(1)


if __name__ == '__main__':
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    main()
