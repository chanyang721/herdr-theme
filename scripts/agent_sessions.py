"""Shared, read-only evidence about one agent terminal, plus the harness record call.

Used by close_finished_spaces.py (space cleanup) and sleep_idle_sessions.py (session
sleep). Everything here fails closed: when a fact cannot be read it is reported as
unverified, never as "no work".
"""
import json
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
)]


def run(argv, *, timeout=12, env=None):
    result = subprocess.run([str(v) for v in argv], capture_output=True, text=True, timeout=timeout, env=env)
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
            meta = json.loads((home / 'sessions' / f'{fg_pid}.json').read_text())
        except (OSError, ValueError):
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


def summary(item):
    """The harness summary for one session (no transcript, no path)."""
    git = item.get('git') or {}
    sid, app = item['session_id'], item['app']
    done = _clean(f"{item.get('space_name') or '?'} {item['address']}: {item.get('title') or '제목 없음'}", 280)
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
    if dry_run:
        argv.append('--dry-run')
    runner = runner or (lambda a: subprocess.run([str(v) for v in a], capture_output=True, text=True, timeout=60))
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
