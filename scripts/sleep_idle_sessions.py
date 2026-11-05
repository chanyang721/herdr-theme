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
must show the pane gone, and `park --event closed`. If pane.close fails or the pane stays,
`park --event close_aborted` settles the request and every further action stops. Every space
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
BRIDGE = 'TUI bridge pane: always kept (its agent runs in the Herdr TUI)'
SLEEP_ONLY = (VISIBLE, NOT_SHELL)
KEEP_AWAKE = 'kept awake: the one pane of this fixed workspace takes instructions'
ASLEEP = 'already asleep'
TRIM_KEEP = 'kept: the one pane of this fixed workspace'
USER_CONTROLLED = 'user-controlled workspace: no automatic sleep, report request, trim or close'
# User rule (2026-11-05): Share is run by the person; observers never act there.
DEFAULT_USER_CONTROLLED = ('Share',)
PROMPT_END = re.compile(r'(?:[$%#❯>]|╰─)\s*$')
STUB_LAST = re.compile(r'^\s*직접 열기:')   # session_sleep_stub.py's last line; typed text is echoed after it


def stub_shown(ticket):
    """Every text a sleep stub version prints after '직접 열기:' for this ticket (older stubs showed
    the whole argv, newer ones the short resume command)."""
    import session_sleep_stub as stub
    out = []
    try:
        out.append(' '.join(ticket['argv']))
    except (KeyError, TypeError):
        pass
    try:
        out.append(stub.shown(stub.launch(ticket)))
    except Exception:   # noqa: BLE001 — a candidate less: no match means unverified, never closed
        pass
    return out


def stub_typed(text, ticket):
    """None only when the stub's screen ends exactly in its own last line for this ticket: nothing
    typed after it. Anything else (text after it, a screen that matches no stub version, no ticket)
    is input or unverified: the pane is not closed (re-review P1, 2026-11-05)."""
    lines = text.splitlines()
    marks = [i for i, line in enumerate(lines) if STUB_LAST.match(line)]
    if not marks or not isinstance(ticket, dict):
        return 'asleep screen unverified (stub prompt or ticket not found)'
    squeeze = lambda value: re.sub(r'\s+', '', value)  # noqa: E731 — wrapping and padding are not input
    tail = squeeze('\n'.join(lines[marks[-1]:]))
    shown = [squeeze('직접 열기:' + c) for c in stub_shown(ticket)]
    if VOICE.search(text):
        return 'voice input active'
    if tail in shown:
        return None
    if any(tail.startswith(c) for c in shown):
        return 'input not empty'
    return 'asleep screen unverified (does not match the stub screen)'


def stub_ticket(terminal):
    fg = terminal.get('foreground') or {}
    for value in fg.get('argv') or []:
        if str(value).endswith('.json'):
            try:
                return json.loads(Path(value).read_text(encoding='utf-8'))
            except (OSError, ValueError):
                return None
    return None


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
    if item.get('keeper'):
        return TRIM_KEEP
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


def user_controlled(space, config):
    names = config.get('user_controlled_names', DEFAULT_USER_CONTROLLED)
    return str(space.get('name') or '').casefold() in {str(n).casefold() for n in names}


def trim_keeper(space, snapshot, config):
    """The one pane a trimmed fixed workspace keeps, or None when the space is not trimmed.
    User rule (2026-11-05): a configured address, else a working agent pane, else the live agent
    pane used most recently, else an asleep agent pane (woken). Only agent panes keep a space: a
    shell, even a working one, is protected by its own reasons but never the keeper; a space with
    no agent pane has no keeper and is not trimmed (5th review). Other computers: never."""
    cfg = config.get('trim_fixed') or {}
    names = {str(n).casefold() for n in cfg.get('names', [])}
    if space.get('machine') is not None or str(space.get('name') or '').casefold() not in names \
            or user_controlled(space, config):
        return None
    addresses = [a for a, _ in space_panes(snapshot, space['id'])]
    terms = snapshot.get('terminals') or {}
    status = lambda a: (terms.get(a) or {}).get('status') or {}  # noqa: E731
    asleep = lambda a: bool(((terms.get(a) or {}).get('labels') or {}).get(SLEEP_LABEL))  # noqa: E731
    live = lambda a: status(a).get('app') in agent_sessions.AGENTS and not asleep(a)  # noqa: E731
    for address in cfg.get('keep_addresses', []):
        if address in addresses and (live(address) or asleep(address)):   # a configured shell is no keeper (6th review)
            return address
    # A live agent pane first (it takes instructions now); an asleep one only when none is live,
    # and it is then woken with its own session (user rule 2026-11-05).
    pool = ([a for a in addresses if live(a) and status(a).get('state') == 'working'] or [a for a in addresses if live(a)]
            or [a for a in addresses if asleep(a)])
    return max(pool, key=lambda a: ((terms.get(a) or {}).get('status_ms') or 0, a)) if pool else None


def trimmed_without_keeper(space, snapshot, config):
    cfg = config.get('trim_fixed') or {}
    names = {str(n).casefold() for n in cfg.get('names', [])}
    return (space.get('machine') is None and str(space.get('name') or '').casefold() in names
            and not user_controlled(space, config) and trim_keeper(space, snapshot, config) is None)


def bridge_term(terminal, processes):
    """The Herdr TUI terminal a tui_bridge.py pane is attached to, else None."""
    fg = terminal.get('foreground') or {}
    if not any(str(a).endswith('tui_bridge.py') for a in (fg.get('argv') or [])):
        return None
    root = terminal.get('pid')
    for info in processes.values():
        m = re.search(r'\bterminal attach (term_[0-9a-f]+)', str(info.get('args') or ''))
        if m and _descends(info, root, processes):
            return m.group(1)
    return None


def _descends(info, root, processes):
    seen = set()
    while info and info['pid'] not in seen:
        if info['pid'] == root:
            return True
        seen.add(info['pid'])
        info = processes.get(info.get('parent'))
    return False


def shell_children(terminal, processes):
    root = terminal.get('pid')
    return [i for i in processes.values() if i['pid'] != root and _descends(i, root, processes)]


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
    if user_controlled(space, config):
        reasons.append(USER_CONTROLLED)
        return item
    keeper = trim_keeper(space, snapshot, config)
    if keeper:
        item['keeper' if keeper == address else 'trim'] = True
    elif trimmed_without_keeper(space, snapshot, config):
        item['trim_note'] = 'fixed workspace has no agent pane to keep: not trimmed'
    if item.get('keeper'):
        reasons.append(KEEP_AWAKE)   # never slept, asked or closed; woken when it is asleep
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
    if address in (snapshot.get('lookup_errors') or {}):
        reasons.append(f"lookup failed: {snapshot['lookup_errors'][address]}")
        return item
    if not terminal:
        reasons.append('terminal evidence unavailable')
        return item
    labels = terminal.get('labels') or {}
    if labels.get(SLEEP_LABEL):
        item['asleep'] = True
        reasons.append(ASLEEP)
        slept = spaces.slept_session(terminal, space)
        if slept:
            # The session it holds: a finished (reported) one may have its pane closed (spare_close).
            item.update({k: slept[k] for k in ('app', 'session_id', 'title', 'cwd', 'turn', 'no_resume') if k in slept})
            # Typed but not sent yet is input too: the screen is checked and part of the evidence.
            text = adapter.screen(address)
            typed = stub_typed(text, stub_ticket(terminal))
            if typed:
                reasons.append(typed)
            item['fingerprint'] = hashlib.sha256(json.dumps([address, terminal.get('pid'), terminal.get('created_ms'),
                                                             labels.get(SLEEP_LABEL), hashlib.sha256(text.encode()).hexdigest()]).encode()).hexdigest()
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
    if bridge_term(terminal, snapshot['processes']):
        # Only in Share (user-controlled) today: never slept, asked or closed (t1 2026-11-05).
        reasons.append(BRIDGE)
        return item
    if item.get('trim') and app is None and not blockers(item):
        # An agent-less shell: whether something is typed but not sent cannot be read reliably
        # ('echo #' ends like a prompt), and what cannot be judged is never closed (3rd review).
        reasons.append('shell pane: unsent input cannot be verified')
        return item
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
    elif not blockers(item) and spaces.is_empty(adapter, terminal, config):
        # Never received input (hc turn 0 and no conversation file): no session to keep, report or
        # resume. It may only be closed while its space and tab keep another pane (spare_close).
        text = adapter.screen(address)
        if spaces.empty_prompt(text, app) or claude_suggestion(text, app, adapter, address):
            item['empty'] = True
            item['fingerprint'] = hashlib.sha256(json.dumps([address, terminal.get('pid'), terminal.get('created_ms'), 'empty',
                                                             hashlib.sha256(text.encode()).hexdigest()]).encode()).hexdigest()
            return item
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
    return screen_checks(item, address, app, terminal, pids, jobs_fp, adapter)


def screen_checks(item, address, app, terminal, pids, jobs_fp, adapter):
    """The screen-level protections (running work, decision, voice, typed input) and the fingerprint."""
    reasons = item['reasons']
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


def wake_keeper(item, adapter, config, attempts=15):
    """The fixed workspace's one pane, asleep: Enter in its sleep stub resumes the same session
    (the stub records `resumed`). Looked up again first; only an untouched stub screen is woken."""
    snap = adapter.snapshot()
    where = pane_of(snap).get(item['address'])
    latest = inspect(item['address'], where[0], snap, adapter, config, where[1]) if where else None
    if not latest or not latest.get('keeper') or not latest.get('asleep') or latest.get('session_id') != item.get('session_id') \
            or [r for r in latest['reasons'] if r not in (ASLEEP, KEEP_AWAKE, VISIBLE)]:
        item['reasons'].append('recheck before wake: ' + ('; '.join(latest['reasons']) if latest else 'pane moved or closed'))
        return 'asleep'
    ticket = stub_ticket(snap['terminals'].get(item['address']) or {})
    if latest.get('no_resume') or not isinstance(ticket, dict) or ticket.get('new_session') \
            or ticket.get('session_id') != item['session_id']:
        item['reasons'].append('not woken: the sleep ticket does not resume the same session')
        return 'asleep'
    adapter.keys(item['address'], 'enter')
    seen = None
    for _ in range(attempts):
        adapter.wait(1)
        mapping, _why = agent_sessions.session_mapping(adapter.terminal(item['address']), config)
        seen = (mapping or {}).get('session_id')
        if seen == item['session_id']:
            return 'woken'
        if seen:
            break
    if seen:
        # 5th review: a new session is not the same one; recorded, never counted as woken.
        item['reasons'].append(f'wake mismatch: session {seen} started, slept {item["session_id"]}')
        return 'wake_mismatch'
    item['reasons'].append('wake not confirmed: the same session was not seen in time')
    return 'wake_unconfirmed'


def note(item, notes_dir, now):
    """Local-only detail (screen tail, folder, git): never synced, kept beside the observer."""
    path = Path(notes_dir) / f"{dt.datetime.fromtimestamp(now):%Y%m%d}-{item['address']}-{(item.get('session_id') or 'empty')[:8]}.json"
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


def close_recheck(item, adapter, config, closed):
    """Why the pane may not close now, looked up again right before pane.close (the park and the
    report gate take time: the session may have resumed work, got input or focus meanwhile)."""
    snap = adapter.snapshot()
    where = pane_of(snap).get(item['address'])
    if not where:
        return ['pane moved or closed'], snap
    latest = inspect(item['address'], where[0], snap, adapter, config, where[1])
    why = spare_blockers(latest) if spare_kind(item) else list(blockers(latest))
    if spare_kind(item) and spare_kind(latest) != spare_kind(item):
        why.append(f"no longer {spare_kind(item)}")
    if latest.get('fingerprint') != item.get('fingerprint'):
        why.append('evidence changed')
    if where[0].get('id') != item['space_id']:
        why.append('pane moved to another space')
    blocked = close_blocker(latest, snap, where[1], closed)
    if blocked:
        why.append(blocked)
    if pane_id_of(pane_entry(snap, item['address'])) != pane_id_of(item.get('_pane') or {}):
        why.append('pane id changed')
    return why, snap


def pane_present(snapshot, address, pane_id):
    return address in pane_of(snapshot) or any(pane_id_of(t) == pane_id for s in snapshot['spaces']
                                               for tab in s.get('tabs', []) for t in tab.get('terminals', []))


def settle_pending(entries, adapter, config, snapshot, apply):
    """Earlier closes still owed a harness record. 'unrecorded': the pane is gone, write `closed`.
    'unconfirmed': pane.close's outcome was unknown; the layout now says closed or aborted.
    Returns the entries still owed (kept in the observer state)."""
    left = []
    for entry in entries:
        if not apply:
            left.append(entry)
            continue
        if entry.get('pending') == 'unconfirmed' and pane_present(snapshot, entry['address'], entry.get('_pane_id')):
            ok, _ = adapter.park(config, entry, 'close_aborted', reason='pane.close did not close the pane')
        else:
            ok, _ = adapter.park(config, entry, 'closed', reason='pane closed (record retried)')
        if not ok:
            left.append(entry)
    return left


def spare_kind(item):
    """'empty' (never received input) or 'asleep' (a slept session we know), else None: panes that
    hold no live work, closed while their space and tab keep another pane (user rule 2026-11-05)."""
    if item.get('empty'):
        return 'empty'
    if item.get('asleep') and item.get('session_id'):
        return 'asleep'
    return None


def spare_blockers(item):
    return [r for r in blockers(item) if r != ASLEEP]


def spare_ready(item, adapter, config):
    """(ok, why). An asleep pane closes only once its session's own final report is on record;
    an empty one has nothing to report."""
    if spare_kind(item) != 'asleep':
        return True, None
    ok, detail = adapter.close_status(config, item, '1970-01-01T00:00:00Z')
    if not ok and item.get('trim'):
        # Fixed-workspace trim: its suspended record already holds the session; closed and
        # close_requested are recorded with the session id (user rule 2026-11-05).
        item['close_why'] = 'fixed workspace trimmed: asleep session closed without a close report (lifecycle and session id kept)'
        return True, None
    if not ok:
        return False, f'asleep session without a close report ({detail}): kept asleep'
    item['close_report'], item['report_task_id'] = detail['report_id'], detail.get('task_id')
    return True, None


def close_one(item, adapter, config, paths, now, snapshot, closed=()):
    """Harness close_requested → local note → fresh recheck → pane.close by id → gone from a fresh
    snapshot → harness closed. Returns (action, the snapshot after the close or None).
    action: closed | keep (recheck refused; close_aborted recorded) | closed_unrecorded (the pane is
    gone but `park closed` failed; the caller keeps it to retry and stops further actions)."""
    item['_pane'] = pane_entry(snapshot, item['address'])
    pane_id = pane_id_of(item['_pane'])
    item['git'] = adapter.git(item.get('cwd'))
    if item.get('empty'):
        # No input ever reached it: nothing to keep, so no harness record (t1 2026-11-05, E).
        park = lambda config_, item_, event, reason=None: (True, 'empty pane: no session to record')  # noqa: E731
    else:
        park = adapter.park
    why_close = {'empty': 'empty agent pane (never received input): pane closed',
                 'asleep': 'finished session asleep while its space keeps another pane: pane closed'}.get(
                     spare_kind(item), 'finished harness session: pane closed')
    why_close = item.get('close_why') or why_close
    ok, detail = park(config, item, 'close_requested', reason=why_close)
    item['harness'] = detail
    if not ok:
        item['reasons'].append(f'harness record failed: {detail}')
        return 'keep', None
    item['note'] = note(item, paths['notes'], now)

    def aborted(why):
        # Settle the open close_requested so the harness never reads this session as half closed.
        ok_, detail_ = park(config, item, 'close_aborted', reason=f'pane close failed: {why}'[:200])
        item['harness_abort'] = detail_ if ok_ else f'close_aborted not recorded: {detail_}'

    try:
        why, _snap = close_recheck(item, adapter, config, closed)
    except Exception as exc:   # noqa: BLE001 — nothing was closed: settle the request, keep the pane
        why = [f'lookup failed: {str(exc)[:120]}']
    if why:
        aborted('recheck: ' + '; '.join(why))
        item['reasons'].append('recheck before close: ' + '; '.join(why))
        return 'keep', None
    item['_pane_id'] = pane_id
    try:
        adapter.close_pane(pane_id)
        failure = None
    except Exception as exc:   # noqa: BLE001 — the pane may be gone anyway: the layout decides
        failure = str(exc)[:120]
    after = None
    for _ in range(3):
        try:
            after = adapter.snapshot()
            break
        except Exception:   # noqa: BLE001
            adapter.wait(1)
    if after is None:
        # Closed or not is unknown: never recorded as aborted; the next cycle looks at the layout.
        item['reasons'].append('pane.close outcome unknown (layout unreadable); settled next cycle'
                               + (f' (pane.close: {failure})' if failure else ''))
        return 'close_unconfirmed', None
    if pane_present(after, item['address'], pane_id):
        aborted(f'pane.close: {failure}' if failure else 'pane still present after pane.close')
        raise RuntimeError(f"{item['address']}: pane still present after pane.close"
                           + (f' ({failure})' if failure else '') + '; further actions stopped')
    for _ in range(2):   # the pane is gone: its closed record must land, or be retried later
        ok, detail = park(config, item, 'closed', reason='pane closed')
        if ok:
            return 'closed', after
    item['reasons'].append(f'pane closed but the harness closed record failed: {detail}')
    return 'closed_unrecorded', after


def shlex_quote(value):
    import shlex
    return shlex.quote(value)


def lookup_failed(address, space, exc):
    """One pane's lookup failed (a timeout, an unreadable answer): only that pane is kept."""
    return {'address': address, 'space_id': space.get('id'), 'space_name': space.get('name'),
            'reasons': [f'lookup failed: {str(exc)[:160]}']}


def cycle(adapter, config, state, now, *, apply=False, paths=None):
    snapshot = agent_sessions.first_snapshot(adapter)   # unreadable: SkipCycle, not an error
    previous = state.get('sessions', {})
    gap = now - state.get('last_at', now)
    fresh = 0 <= gap <= config.get('max_sample_gap_seconds', 660)
    trial = agent_sessions.trial_of(state, now, fresh)
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
    # A pane closed earlier whose `park closed` failed: retry that record first; while one is
    # still missing, nothing else is closed or slept (fail-closed).
    pending = settle_pending(state.get('unrecorded_closes') or [], adapter, config, snapshot, apply)
    state['unrecorded_closes'] = pending   # saved even when this cycle raises (main saves state)
    if pending:
        stop_reason = f"{len(pending)} closed pane(s) still without a harness record; retried next cycle"
    for address, (space, tab) in sorted(pane_of(snapshot).items()):
        try:
            item = inspect(address, space, snapshot, adapter, config, tab)
        except Exception as exc:   # noqa: BLE001 — this pane only; the cycle goes on
            item = lookup_failed(address, space, exc)
        old = previous.get(address, {})
        if item.get('keeper') and item.get('asleep'):
            item.update(quiet_seconds=0, action='asleep')
            why_not = [r for r in item['reasons'] if r not in (ASLEEP, KEEP_AWAKE, VISIBLE)]
            if item.get('no_resume'):
                why_not.append('its sleep ticket starts a new session, not the same one')
            if not item.get('session_id') or why_not:
                item['reasons'].append('keeper asleep: not woken (' + ('; '.join(why_not) or 'session unknown') + ')')
            elif not apply:
                item['action'] = 'would_wake'
            elif not ready:
                item['reasons'].append('apply not approved for this observer code (one recorded dry-run first)')
            elif stop_reason:
                item['reasons'].append(stop_reason)
            else:
                item['action'] = wake_keeper(item, adapter, config)
            results.append(item)
            continue
        kind = spare_kind(item)
        if kind:
            same = fresh and not spare_blockers(item) and old.get('fingerprint') == item.get('fingerprint')
            since = old.get('since', now) if same else now
            quiet = now - since
            item.update(quiet_seconds=round(quiet), action='asleep' if kind == 'asleep' else 'keep')
            if not spare_blockers(item):
                tracking[address] = {'since': since, 'fingerprint': item.get('fingerprint')}
            why_not_close = close_blocker(item, snapshot, tab, closed) if close_on else 'close_finished_panes off'
            if spare_blockers(item) or why_not_close:
                if kind == 'empty':
                    item['reasons'].extend([why_not_close] if why_not_close and not spare_blockers(item) else [])
            elif quiet < idle:
                item['reasons'].append(f'{kind} pane unchanged for {int(quiet // 60)} of {idle // 60} minutes')
            elif not apply:
                item['action'] = f'would_close_{kind}'
            elif not ready:
                item['reasons'].append('apply not approved for this observer code (one recorded dry-run first)')
            elif acted >= config.get('max_per_cycle', 4):
                item['reasons'].append('per-cycle limit reached')
            elif stop_reason:
                item['reasons'].append(stop_reason)
            else:
                may, why = spare_ready(item, adapter, config)
                if not may:
                    item['reasons'].append(why)
                else:
                    check = adapter.snapshot()
                    before = spaces.focus(check['status'])
                    item['action'], after = close_one(item, adapter, config, paths, now, check, closed)
                    if item['action'] in ('closed', 'closed_unrecorded'):
                        acted += 1
                        closed.add(address)
                        tracking.pop(address, None)
                        if item['action'] == 'closed_unrecorded':
                            pending.append({**{k: v for k, v in item.items() if k not in ('_pane', 'screen_tail')}, 'pending': 'unrecorded'})
                            state['unrecorded_closes'] = pending
                            stop_reason = 'a close is still owed its harness record; settled next cycle'
                        after = after or adapter.snapshot()
                        if spaces.focus(after['status']) != before:
                            stop_reason = 'focus moved during the previous close; next cycle'
                            item['focus_moved'] = True
                    elif item['action'] == 'close_unconfirmed':
                        if kind == 'asleep':
                            pending.append({**{k: v for k, v in item.items() if k not in ('_pane', 'screen_tail')}, 'pending': 'unconfirmed'})
                            state['unrecorded_closes'] = pending
                        for k in ('argv', '_pane', '_pane_id'):
                            item.pop(k, None)
                        results.append(item)
                        break
            for k in ('argv', '_pane', '_pane_id'):
                item.pop(k, None)
            results.append(item)
            continue
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
                try:
                    check = adapter.snapshot()
                    where = pane_of(check).get(address)
                    latest = inspect(address, where[0], check, adapter, config, where[1]) if where else None
                except Exception as exc:   # noqa: BLE001 — nothing acted yet: keep it, try next cycle
                    check, where, latest = None, None, None
                    item['reasons'].append(f'recheck lookup failed: {str(exc)[:160]}')
                    stop_reason = 'a recheck lookup failed; next cycle'
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
                    unreported = decision == 'failed' and latest.get('trim') and may_close
                    if unreported:
                        # Fixed-workspace trim: asked, no report in time. Closed anyway with its
                        # lifecycle record and session id (user rule 2026-11-05).
                        item['close_why'] = 'fixed workspace trimmed: no close report in time; pane closed (lifecycle and session id kept)'
                    if (decision == 'ready' or unreported) and may_close:
                        item['action'], after = close_one(item, adapter, config, paths, now, check, closed)
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
                    if item['action'] in ('closed_unrecorded', 'close_unconfirmed'):
                        pending.append({**{k: v for k, v in item.items() if k not in ('_pane', 'screen_tail')},
                                        'pending': 'unrecorded' if item['action'] == 'closed_unrecorded' else 'unconfirmed'})
                        state['unrecorded_closes'] = pending   # in the state now, not only at the cycle's end
                        stop_reason = 'a close is still owed its harness record; settled next cycle'
                    if item['action'] == 'close_unconfirmed':
                        item.pop('_pane', None)
                        item.pop('_pane_id', None)
                        results.append(item)
                        break   # the layout cannot be read: nothing else acts this cycle
                    if item['action'] in ('slept', 'closed', 'closed_unrecorded'):
                        acted += 1
                        tracking.pop(address, None)
                        reports.pop(address, None)
                        if item['action'] != 'slept':
                            closed.add(address)
                        after = after or adapter.snapshot()
                        if focused_terminal(after) == address:
                            raise RuntimeError('focus moved to the slept pane; further sleeps stopped')
                        if spaces.focus(after['status']) != before:
                            stop_reason = 'focus moved during the previous sleep; next cycle'
                            item['focus_moved'] = True
        item.pop('argv', None)
        item.pop('_pane', None)
        item.pop('_pane_id', None)
        results.append(item)
    state.update(last_at=now, sessions=tracking, trial=trial, reports=reports, unrecorded_closes=pending)
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
        agent_sessions.settle_trial(state, config, ok=True)
    except agent_sessions.SkipCycle as exc:
        observation = {'at': dt.datetime.now().astimezone().isoformat(), 'mode': 'apply' if args.apply else 'dry-run',
                       'skipped': str(exc), 'results': []}
    except Exception as exc:
        agent_sessions.settle_trial(state, config, ok=False)
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
