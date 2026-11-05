"""Shared, read-only evidence about one agent terminal, plus the harness record call.

Used by close_finished_spaces.py (space cleanup) and sleep_idle_sessions.py (session
sleep). Everything here fails closed: when a fact cannot be read it is reported as
unverified, never as "no work".
"""
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import subprocess

AGENTS = {'codex', 'claude', 'claude-code'}
SHELLS = {'zsh', '-zsh', 'bash', '-bash', 'sh', 'fish', '-fish'}
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
# Long-lived helpers an idle agent keeps (MCP servers, REPL and computer-use hosts).
# They are matched on each process's own full command line.
# Anything else under the agent (shells, caffeinate, python, builds) is work in progress.
HELPERS = [re.compile(p, re.I) for p in (
    r'(?:^|/)node_repl(?:\s|$)', r'(?:^|/)codex-code-mode-host(?:\s|$)', r'/cua_node/bin/node\s',
    r'\s--mcp\b', r'\bmcp(?:\s|$)', r'\bmcp[-_]server\b', r'-mcp(?:\s|$|/)',
    # Claude Code keeps the Mac awake for a few minutes after a turn; it ends by itself.
    r'^(?:/usr/bin/)?caffeinate -i -t \d{1,4}$',
)]


def run(argv, *, timeout=12, env=None):
    result = subprocess.run([str(v) for v in argv], capture_output=True, text=True, timeout=timeout, env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise RuntimeError(f'{Path(str(argv[0])).name} {argv[1:2]} exited {result.returncode}: {result.stderr.strip()[:180]}')
    return result.stdout


def process_table():
    """{pid: {pid, parent, name, args}} from two ps reads (comm may hold spaces)."""
    rows = {}
    for line in run(['ps', '-axo', 'pid=,ppid=,comm=']).splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3:
            rows[int(parts[0])] = {'pid': int(parts[0]), 'parent': int(parts[1]), 'name': Path(parts[2]).name, 'args': ''}
    for line in run(['ps', '-axo', 'pid=,args=']).splitlines():
        parts = line.strip().split(None, 1)
        if parts and int(parts[0]) in rows:
            rows[int(parts[0])]['args'] = parts[1] if len(parts) > 1 else ''
    return rows


def is_helper(info):
    line = info.get('args') or info.get('name', '')
    return any(p.search(line) for p in HELPERS)


def process_evidence(terminal, processes):
    """(ok, reason, family pids): the terminal holds one agent and only idle helpers under it."""
    root = terminal.get('pid')
    if not isinstance(root, int) or root not in processes or not terminal.get('foreground'):
        return False, 'process evidence unavailable', []
    children = {}
    for pid, info in processes.items():
        children.setdefault(info['parent'], []).append(pid)
    # Every process must itself look like a helper: a command started from a helper
    # (a shell under the code-mode host, say) is still work.
    family, pending = set(), [root]
    while pending:
        pid = pending.pop()
        if pid in family:
            continue
        family.add(pid)
        pending.extend(children.get(pid, []))
    helpers = {pid for pid in family if pid != root and is_helper(processes[pid])}
    agents = [p for p in family if processes[p]['name'] in AGENTS]
    extra = [processes[p]['name'] for p in family if p != root and p not in helpers and processes[p]['name'] not in AGENTS | {'expect'}]
    if extra:
        return False, 'running/unknown child processes: ' + ', '.join(sorted(set(extra))), sorted(family)
    if not agents:
        return False, 'agent process identity unverified', sorted(family)
    return True, '', sorted(family)


def provider(app):
    return 'claude' if app in ('claude', 'claude-code') else 'codex' if app == 'codex' else None


def _held_rollouts(pid):
    try:
        out = run(['lsof', '-n', '-P', '-p', str(pid), '-Fn'], timeout=10)
    except (OSError, RuntimeError, subprocess.TimeoutExpired):
        return None
    return sorted({line[1:] for line in out.splitlines() if line.startswith('n') and re.search(r'/rollout-[^/]*\.jsonl$', line)})


def _codex_children(db):
    connection = sqlite3.connect(Path(db).expanduser().resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
    try:
        connection.execute('PRAGMA query_only=ON')
        children = {row[0] for row in connection.execute('select child_thread_id from thread_spawn_edges')}
        paths = dict(connection.execute('select rollout_path, id from threads').fetchall())
    finally:
        connection.close()
    return children, paths


def session_mapping(terminal, config=None):
    """(mapping, reason). mapping is what space_job_evidence.check_jobs expects:
    pid/created_ms of the terminal, the agent's own pid, its provider session id."""
    config = config or {}
    fg = terminal.get('foreground') or {}
    app = (terminal.get('status') or {}).get('app')
    fg_pid, argv = fg.get('pid'), fg.get('argv') or []
    if not isinstance(fg_pid, int) or app not in AGENTS:
        return None, 'session mapping unverified: agent foreground missing'
    base = {'pid': terminal.get('pid'), 'created_ms': terminal.get('created_ms'), 'agent': app, 'process_pid': fg_pid}
    if provider(app) == 'claude':
        home = Path(config.get('claude_home', Path.home() / '.claude')).expanduser()
        try:
            meta = json.loads((home / 'sessions' / f'{fg_pid}.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            if inherited_child_session(fg_pid):
                # Started from inside another Claude (space.new from a Claude turn) with its
                # CLAUDE_CODE_CHILD_SESSION marker: no session file and no transcript of its own,
                # so `--resume` cannot bring it back. It is never suspended.
                return None, 'cannot resume: Claude runs as an inherited child session (no session file or transcript)'
            return None, 'session mapping unverified: Claude session file missing'
        sid = meta.get('sessionId') if isinstance(meta, dict) else None
        if not isinstance(sid, str) or not UUID.match(sid) or meta.get('pid') != fg_pid:
            return None, 'session mapping unverified: Claude session file invalid'
        return {**base, 'session_id': sid}, ''
    # Codex: an explicit `resume <id>`, else the one top-level rollout the process holds open.
    sid = None
    if 'resume' in argv[1:]:
        nxt = argv[argv.index('resume') + 1:argv.index('resume') + 2]
        sid = nxt[0] if nxt and UUID.match(nxt[0]) else None
    held = _held_rollouts(fg_pid)
    if held is None:
        return None, 'session mapping unverified: open rollouts unreadable'
    try:
        children, paths = _codex_children(config.get('codex_db', Path.home() / '.codex/state_5.sqlite'))
    except (OSError, sqlite3.Error):
        return None, 'session mapping unverified: Codex state database unreadable'
    top = sorted({paths[p] for p in held if p in paths and paths[p] not in children})
    if sid and top and top != [sid]:
        return None, 'session mapping unverified: resume id and open rollout disagree'
    if not sid:
        if len(top) != 1:
            return None, f'session mapping unverified: {len(top)} top-level Codex rollouts open'
        sid = top[0]
    return {**base, 'session_id': sid}, ''


def pane_session_id(address, created_ms, agent_pid):
    """The stand-in session id of a Claude without a transcript (an inherited child session).

    The harness derives the same value (runtime/lifecycle.pane_session_id) when that session runs
    `harness.py close-report`, so park, close-status and the session's own report all match. It
    never resumes anything: the pane comes back as a new session reading the workspace memory."""
    import uuid
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f'herdr-pane-session:{address}:{created_ms}:{agent_pid}'))


def child_session(terminal, reader=None):
    """{session_id, no_resume} for a Claude that runs as an inherited child session, else None."""
    fg = terminal.get('foreground') or {}
    app = (terminal.get('status') or {}).get('app')
    pid, created = fg.get('pid') if isinstance(fg, dict) else None, terminal.get('created_ms')
    if provider(app) != 'claude' or not isinstance(pid, int) or not created or not terminal.get('address'):
        return None
    if not inherited_child_session(pid, reader):
        return None
    return {'session_id': pane_session_id(terminal['address'], created, pid), 'no_resume': True}


def inherited_child_session(pid, reader=None):
    """True when the process environment carries CLAUDE_CODE_CHILD_SESSION=1 (read with ps, never printed)."""
    reader = reader or (lambda p: run(['ps', 'eww', '-p', str(p), '-o', 'command=']))
    try:
        text = reader(pid)
    except (OSError, RuntimeError, subprocess.TimeoutExpired):
        return False
    return 'CLAUDE_CODE_CHILD_SESSION=1' in text.split()


SGR = re.compile(r'\x1b\[([0-9;:]*)m')
OTHER_ESC = re.compile(r'\x1b(?:\[[0-9;?:]*[A-Za-ln-z@`]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|[=>78])')


def prompt_cells(raw, marker='❯'):
    """[(char, dim)] of the input row after the last `marker` in an ANSI repaint, or None.

    Claude draws its prompt suggestion faint (SGR 2) and typed text plain. Any escape other than
    a colour change (a cursor move, say) ends the row: what follows is not this row.
    """
    i = raw.rfind(marker)
    if i < 0:
        return None
    row, dim, pos = [], False, i + len(marker)
    while pos < len(raw):
        ch = raw[pos]
        if ch in '\r\n':
            break
        if ch == '\x1b':
            m = SGR.match(raw, pos)
            if m:
                codes = [c for c in re.split('[;:]', m.group(1)) if c != ''] or ['0']
                for c in codes:
                    if c in ('0', '22'):
                        dim = False
                    elif c == '2':
                        dim = True
                pos = m.end()
                continue
            return row if OTHER_ESC.match(raw, pos) else None
        row.append((ch, dim))
        pos += 1
    return row


def suggestion_only(text_value, raw, marker='❯'):
    """True only when the row's every visible character is faint and spells exactly what the plain
    screen shows after the marker: a Claude prompt suggestion, not something the person typed."""
    cells = prompt_cells(raw, marker)
    if not cells or not text_value:
        return False
    shown = ''.join(c for c, _ in cells).replace('\xa0', ' ').strip()
    visible = [d for c, d in cells if not c.isspace() and c != '\xa0']
    return bool(visible) and all(visible) and shown == text_value.strip()


def styled_screen(core, address, env=None, limit=3.0, quiet=0.4):
    """The pane's repaint with colours, from a watch-only attach (never types or resizes)."""
    import select
    import time
    proc = subprocess.Popen([core, 'attach', '--observe', address], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
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


def new_session_argv(app, argv):
    """A new session of the same agent for a pane that cannot be resumed: the program alone, never
    the old first prompt (it would run the old task again)."""
    argv = list(argv or [])
    name = Path(argv[0]).name if argv else ''
    if provider(app) == 'claude':
        return [argv[0] if name == 'claude' else 'claude']
    if provider(app) == 'codex':
        return [argv[0] if name == 'codex' else 'codex']
    raise ValueError(f'unknown agent {app!r}')


def resume_argv(app, argv, session_id):
    """The original agent command with the same flags, resuming `session_id`."""
    argv = list(argv or [])
    name = Path(argv[0]).name if argv else ''
    if provider(app) == 'claude':
        out, skip = [argv[0] if name == 'claude' else 'claude'], False
        for i, arg in enumerate(argv[1:], 1):
            if skip:
                skip = False; continue
            if arg in ('--resume', '-r', '--session-id'):
                skip = True; continue
            if arg in ('--continue', '-c') or arg.startswith('--resume='):
                continue
            out.append(arg)
        return out + ['--resume', session_id]
    if provider(app) == 'codex':
        head = [argv[0] if name == 'codex' else 'codex']
        rest = argv[1:]
        if 'resume' in rest:
            rest = rest[:rest.index('resume')]
        return head + rest + ['resume', session_id]
    raise ValueError(f'unknown agent {app!r}')


def git_brief(folder):
    """Branch, uncommitted entries and worktrees; no paths. None values when not a git folder."""
    info = {'branch': None, 'uncommitted': None, 'worktrees': None, 'head': None}
    if not folder:
        return info
    try:
        info['branch'] = run(['git', '-C', folder, 'branch', '--show-current']).strip() or 'detached'
        info['head'] = run(['git', '-C', folder, 'rev-parse', '--short', 'HEAD']).strip()
        info['uncommitted'] = len([l for l in run(['git', '-C', folder, 'status', '--porcelain']).splitlines() if l.strip()])
        info['worktrees'] = run(['git', '-C', folder, 'worktree', 'list', '--porcelain']).count('\nworktree ') + 1
    except (OSError, RuntimeError, subprocess.TimeoutExpired):
        pass
    return info


def _clean(text, limit):
    text = re.sub(r'[\x00-\x1f\x7f]+', ' ', str(text or '')).strip()
    text = re.sub(r'(?i)(?<![\w.])/(?:users|home)/[^\s]+', '<path>', text)   # never an account path
    text = re.sub(r'(?<![\w.])~/[^\s]+', '<path>', text)
    return text[:limit]


MASK = '[가림]'


def denylist(config=None):
    """The harness's local denylist (company, customer and people names); [] when there is none.
    Read only to mask, never printed or copied anywhere."""
    harness = (config or {}).get('harness') or {}
    local = os.environ.get('HERDR_HARNESS_LOCAL') or str(Path(os.environ.get('HERDR_APP_HOME', Path.home() / '.config/herdr-app')) / 'data/sixfold/harness-local')
    path = Path(harness.get('denylist') or Path(local) / 'denylist.txt').expanduser()
    try:
        lines = path.read_text(encoding='utf-8').splitlines()
    except OSError:
        return []
    return [line.strip() for line in lines if line.strip() and not line.startswith('#')]


def mask_text(text, terms):
    """Every denylisted term as [가림] (case-insensitive, longest first), like the harness's spec.mask."""
    terms = sorted({t for t in terms or () if t}, key=len, reverse=True)
    if not terms or not text:
        return text
    return re.sub('|'.join(re.escape(t) for t in terms), MASK, text, flags=re.I)


def summary(item):
    """The harness summary for one session (no transcript, no path)."""
    git = item.get('git') or {}
    sid, app = item['session_id'], item['app']
    done = _clean(f"{item.get('space_name') or '?'} {item['address']}: {item.get('title') or '제목 없음'}", 280)
    if item.get('no_resume'):
        remaining = '다시 열기: 전사 없는 세션이라 이어 열 수 없음. 그 칸에서 Enter 또는 harness.py reopen 으로 새 세션이 워크스페이스 기억을 읽고 시작'
    else:
        command = f'claude --resume {sid}' if provider(app) == 'claude' else f'codex resume {sid}'
        remaining = f'다시 열기: 그 칸에서 Enter, 또는 {command}'
    if git.get('branch') is None:
        risks = 'git 상태 미확인 또는 git 폴더 아님'
    else:
        risks = _clean(f"git {git['branch']}@{git.get('head')}: 미커밋 {git.get('uncommitted')}개, worktree {git.get('worktrees')}개", 280)
    return {'done': done, 'remaining': remaining, 'risks': risks}


def harness_park(config, item, event, *, dry_run=False, reason=None, runner=None):
    """(ok, detail). Records the session's context with `harness.py park`; any failure is not ok."""
    harness = config.get('harness') or {}
    python, script = harness.get('python'), harness.get('script')
    if not python or not script:
        return False, 'harness not configured'
    s = summary(item)
    argv = [python, script, 'park', item['address'], '--provider', provider(item['app']), '--session-id', item['session_id'],
            '--event', event, '--done', s['done'], '--remaining', s['remaining'], '--risks', s['risks']]
    if item.get('space_id'):
        argv += ['--space-id', item['space_id']]
    if reason:
        argv += ['--reason', _clean(reason, 280)]
    if item.get('report_task_id'):
        argv += ['--task-id', item['report_task_id']]
    # Observer text names spaces and panes: denylisted terms become [가림] in the record.
    argv.append('--mask')
    if dry_run:
        argv.append('--dry-run')
    runner = runner or (lambda a: subprocess.run([str(v) for v in a], capture_output=True, text=True, timeout=60, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)))
    try:
        result = runner(argv)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f'harness call failed: {exc}'
    out = (result.stdout or '').strip().splitlines()
    if result.returncode != 0:
        detail = (result.stderr or '').strip().splitlines()[-1:] or out[-1:] or [f'exit {result.returncode}']
        if out and out[-1].startswith('{'):
            try:
                detail = ['; '.join(json.loads(out[-1]).get('problems', [])) or detail[0]]
            except ValueError:
                pass
        return False, 'harness refused: ' + detail[0][:240]
    try:
        value = json.loads(out[-1])
    except (ValueError, IndexError):
        return False, 'harness output unreadable'
    if dry_run:
        return bool(value.get('ok')), 'harness would accept' if value.get('ok') else 'harness refused'
    return (True, value['id']) if isinstance(value, dict) and value.get('id') else (False, 'harness record id missing')


# --- the session's own report before it is put to sleep or its space is closed ---------------
# HARNESS-MAPPING A3: the session that did the work writes its final report and experience
# (`harness.py close-report`); the observer only asks, waits within a limit and checks with
# `close-status`. No report in time → nothing is cleaned up (fail-closed). Nothing is accepted.

REPORT_MARK = '[세션 정리 보고 요청]'


def close_report_message(config):
    harness = config.get('harness') or {}
    python, script = harness.get('python', 'python3'), harness.get('script', 'harness.py')
    return (f"{REPORT_MARK} 관찰기가 이 세션을 곧 정리(절전)합니다. 새 작업은 시작하지 말고 아래만 하세요. "
            "1) 레포 밖 임시 파일(예: $TMPDIR/experience-close.json)에 experience JSON을 씁니다: "
            '{"judgments": [{"situation": "무엇을 판단했나", "expected": "예상", "actual": "실제", "error": "MATCHED|PARTIAL|WRONG"}]} '
            "(판단 1~5개, 선택: cause·surprise·pattern_candidates). "
            f"2) {python} {script} close-report --mask --done \"이 세션이 한 일\" --remaining \"남은 일\" --experience <그 파일> 를 실행합니다. "
            "확정한 결정은 --decision \"…\"(여러 번), 만들거나 고친 문서는 --doc <파일>(여러 번, 원본은 그대로)을 붙입니다. "
            "3) 고객·회사·제품 이름 대신 워크스페이스 id를 씁니다(--mask가 남은 이름을 [가림]으로 바꿉니다). 다른 이유로 거부되면 문장을 고쳐 다시 실행합니다. "
            "다른 세션에 보고하지 말고, 보고 id만 한 줄로 답하고 끝내세요. 승인은 사람이 기억함에서 합니다.")


def harness_close_status(config, item, since, *, runner=None):
    """(ok, detail): ok with {report_id, task_id} when the session wrote a final report since `since`."""
    harness = config.get('harness') or {}
    python, script = harness.get('python'), harness.get('script')
    if not python or not script:
        return False, 'harness not configured'
    argv = [python, script, 'close-status', item['address'], '--provider', provider(item['app']),
            '--session-id', item['session_id'], '--since', since]
    runner = runner or (lambda a: subprocess.run([str(v) for v in a], capture_output=True, text=True, timeout=60, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)))
    try:
        result = runner(argv)
        value = json.loads((result.stdout or '').strip().splitlines()[-1])
    except (OSError, subprocess.TimeoutExpired, ValueError, IndexError) as exc:
        return False, f'close-status unavailable: {exc}'[:240]
    if result.returncode != 0 or not isinstance(value, dict):
        return False, 'close-status refused'
    if value.get('ok') and value.get('report_id'):
        return True, {'report_id': value['report_id'], 'task_id': value.get('task_id')}
    return False, 'no close report yet'


def harness_close_gate(config, item, *, runner=None):
    """(ok, blockers): `harness.py close-gate` — the session's report accepted and learnt, nothing
    else open in its workspace. Any failure to ask is a blocker (fail-closed)."""
    harness = config.get('harness') or {}
    python, script = harness.get('python'), harness.get('script')
    if not python or not script:
        return False, ['harness not configured']
    argv = [python, script, 'close-gate', item['address'], '--provider', provider(item['app']),
            '--session-id', item['session_id']]
    if item.get('space_id'):
        argv += ['--space-id', item['space_id']]
    runner = runner or (lambda a: subprocess.run([str(v) for v in a], capture_output=True, text=True, timeout=60, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)))
    try:
        result = runner(argv)
        value = json.loads((result.stdout or '').strip().splitlines()[-1])
    except (OSError, subprocess.TimeoutExpired, ValueError, IndexError) as exc:
        return False, [f'close-gate unavailable: {exc}'[:200]]
    if result.returncode != 0 or not isinstance(value, dict):
        return False, ['close-gate refused']
    return bool(value.get('ok')), [str(b) for b in value.get('blockers') or []]


def self_core_id():
    """This computer's herdr-core id (the machine half of a harness workspace id)."""
    try:
        return json.loads(run(['hc', 'server', 'status', '--json']))['core']['id']
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.TimeoutExpired):
        return None


def harness_archive(config, data, *, runner=None):
    """(ok, detail): `harness.py archive --file F` keeps how the space looked (local only)."""
    import tempfile
    harness = config.get('harness') or {}
    python, script = harness.get('python'), harness.get('script')
    if not python or not script:
        return False, 'harness not configured'
    if not data.get('workspace_id') or data['workspace_id'].startswith('None-'):
        return False, 'machine id unknown'
    fd, path = tempfile.mkstemp(prefix='space-archive-', suffix='.json')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(data, stream, ensure_ascii=False)
        runner = runner or (lambda a: subprocess.run([str(v) for v in a], capture_output=True, text=True, timeout=60, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)))
        try:
            # Space names and pane titles may name a customer: [가림] in the archive (WORKSPACE-TREE).
            result = runner([python, script, 'archive', '--file', path, '--mask'])
        except (OSError, subprocess.TimeoutExpired) as exc:
            return False, f'harness call failed: {exc}'
        if result.returncode != 0:
            return False, 'harness refused: ' + ((result.stderr or result.stdout or '').strip().splitlines() or ['?'])[-1][:240]
        try:
            return True, json.loads((result.stdout or '').strip().splitlines()[-1])['archive']
        except (ValueError, IndexError, KeyError):
            return False, 'harness output unreadable'
    finally:
        os.unlink(path)


def utc_iso(epoch):
    import datetime as _dt
    return _dt.datetime.fromtimestamp(epoch, _dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def report_gate(entries, item, adapter, config, now):
    """(decision, detail) for one session about to be cleaned up; `entries` is the observer state
    {address: {...}} and is updated in place.

      off       close reports are switched off (config close_report.enabled false)
      requested the request was just typed into the session; wait for its answer
      waiting   asked, no report yet, still within timeout_seconds
      failed    no report within timeout_seconds: kept; asked again after retry_seconds
      ready     a final report since the request: detail = {report_id, task_id}

    A report counts only while the session has done at most `turns` turns since the request
    (the answer itself); work after it means the report is stale and a new one is asked."""
    cfg = config.get('close_report') or {}
    if cfg.get('enabled', True) is False:
        return 'off', None
    timeout, retry, turns = cfg.get('timeout_seconds', 900), cfg.get('retry_seconds', 3600), cfg.get('turns', 1)
    address, sid, turn = item['address'], item['session_id'], item.get('turn')
    entry = entries.get(address)
    if entry and entry.get('session_id') != sid:
        entry = None
    if entry and isinstance(turn, int) and isinstance(entry.get('turn'), int) and turn > entry['turn'] + turns:
        entry = None   # the person worked with it after the request
    if entry and entry.get('failed_at'):
        if now - entry['failed_at'] < retry:
            return 'failed', f"no close report (asked {int((now - entry['requested_at']) // 60)} minutes ago): kept, asks again later"
        entry = None
    if entry is None:
        entries.pop(address, None)
        adapter.request_report(address, close_report_message(config))
        # Only a report written after the request answers it: `since` is the request time rounded
        # up to the record's whole-second clock (Codex review 2026-11-05 P2).
        entries[address] = {'session_id': sid, 'requested_at': now, 'since': utc_iso(math.ceil(now)), 'turn': turn}
        return 'requested', None
    if entry.get('report'):
        return 'ready', entry['report']   # accepted in time on an earlier cycle
    if now - entry['requested_at'] >= timeout:
        # The limit comes first: a report that shows up after it does not count (fail-closed).
        entry['failed_at'] = now
        return 'failed', f'no close report within {timeout // 60} minutes: kept (fail-closed)'
    ok, detail = adapter.close_status(config, item, entry['since'])
    if ok:
        entry['report'] = detail
        return 'ready', detail
    return 'waiting', detail
