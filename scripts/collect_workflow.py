#!/usr/bin/env python3
"""Write data/sixfold/workflow.json: each agent's sub-agents, from recorded facts only."""
import argparse
from functools import lru_cache
import json
import os
from pathlib import Path
import re
import sqlite3
import shutil
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import site_config  # noqa: E402

WINDOWS = os.name == 'nt'
BASE = (Path(os.environ.get('LOCALAPPDATA', Path.home())) / 'HerdrSixfold') if WINDOWS else site_config.folder('state_dir')
DATA = Path(os.environ.get('HERDR_APP_HOME', Path.home() / '.config' / 'herdr-app')) / 'data' / 'sixfold'
OUTPUT = DATA / 'workflow.json'
HC = shutil.which('hc') or str(Path.home() / '.local/share/herdr-sixfold/bin/hc')
HERDR = shutil.which('herdr') or '/opt/homebrew/bin/herdr'
BRIDGES = Path.home() / '.local' / 'state' / 'herdr-sixfold' / 'migration-map.local.json'
CLAUDE = Path.home() / '.claude'
CODEX_DB = Path.home() / '.codex' / 'state_5.sqlite'
ROLLOUT = re.compile(r'rollout-[\dT-]+-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl')
RECENT_SECONDS = 30
ESTIMATE = 'recent-activity-estimate'  # Never shown as a confirmed state.
KEEP_SECONDS = 6 * 3600  # A finished helper leaves the tree after this long.
EVENT_LIMIT = 32
INTERVAL = 3


def hc(*args):
    result = subprocess.run([HC, *args], capture_output=True, text=True, encoding='utf-8', timeout=10,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    return json.loads(result.stdout or '{}')


def family(agent):
    return 'claude' if agent in ('claude', 'claude-code') else agent


def child_pids(pid):
    if WINDOWS:
        return [child for child, parent in windows_processes().items() if parent == pid]
    children = subprocess.run(['/usr/bin/pgrep', '-P', str(pid)], capture_output=True, text=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    return [int(line) for line in children.stdout.split()]


def process_tree(pid):
    found, queue = [], [pid]
    while queue and len(found) < 12:
        current = queue.pop(0)
        found.append(current)
        queue += child_pids(current)
    return found


def claude_session(pids):
    for pid in pids:
        try:
            return json.loads((CLAUDE / 'sessions' / f'{pid}.json').read_text(encoding='utf-8'))['sessionId']
        except (OSError, ValueError, KeyError):
            continue
    return None


def codex_thread(pids):
    if WINDOWS:
        return windows_codex_thread(pids)
    for pid in pids:
        files = subprocess.run(['/usr/sbin/lsof', '-p', str(pid)], capture_output=True, text=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).stdout
        match = ROLLOUT.search(files)
        if match:
            return match.group(1)
    return None


CODEX_SCAN_LIMIT = 64
CODEX_RESCAN_SECONDS = 30
_codex_holders = {}  # codex pid -> the root thread whose rollout it holds open
_codex_scanned = {}  # agent pids -> when a scan last found nothing for them
_processes = (0.0, {})


def windows_processes():
    """pid -> parent pid from one Toolhelp snapshot, reused for a second."""
    global _processes
    if time.time() - _processes[0] < 1:
        return _processes[1]
    import ctypes
    from ctypes import wintypes

    class Entry(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('usage', wintypes.DWORD), ('pid', wintypes.DWORD),
                    ('heap', ctypes.c_size_t), ('module', wintypes.DWORD), ('threads', wintypes.DWORD),
                    ('parent', wintypes.DWORD), ('priority', ctypes.c_long), ('flags', wintypes.DWORD),
                    ('exe', ctypes.c_wchar * 260)]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    snapshot = kernel.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    if snapshot in (None, wintypes.HANDLE(-1).value):
        return {}
    parents, entry = {}, Entry()
    entry.size = ctypes.sizeof(Entry)
    try:
        more = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        while more:
            parents[entry.pid] = entry.parent
            more = kernel.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel.CloseHandle(snapshot)
    _processes = (time.time(), parents)
    return parents


def file_holders(path):
    """Processes holding `path` open, from the Restart Manager (no lsof on Windows)."""
    import ctypes
    from ctypes import wintypes

    class Process(ctypes.Structure):
        _fields_ = [('pid', wintypes.DWORD), ('started', wintypes.FILETIME)]

    class Info(ctypes.Structure):
        _fields_ = [('process', Process), ('app', ctypes.c_wchar * 256), ('service', ctypes.c_wchar * 64),
                    ('type', ctypes.c_int), ('status', wintypes.DWORD), ('session', wintypes.DWORD),
                    ('restartable', wintypes.BOOL)]
    manager = ctypes.WinDLL('rstrtmgr')
    session, key = wintypes.DWORD(), ctypes.create_unicode_buffer(64)
    if manager.RmStartSession(ctypes.byref(session), 0, key):
        return set()
    try:
        if manager.RmRegisterResources(session, 1, (ctypes.c_wchar_p * 1)(str(path)), 0, None, 0, None):
            return set()
        needed, count, reasons, infos = wintypes.UINT(), wintypes.UINT(16), wintypes.DWORD(), (Info * 16)()
        if manager.RmGetList(session, ctypes.byref(needed), ctypes.byref(count), infos, ctypes.byref(reasons)):
            return set()
        return {infos[i].process.pid for i in range(count.value)}
    finally:
        manager.RmEndSession(session)


def windows_codex_thread(pids):
    """The root Codex thread whose rollout one of `pids` holds open.

    Each lookup costs ~60 ms a file, so a known holder is only rechecked and a
    full scan of recent rollouts runs at most every CODEX_RESCAN_SECONDS."""
    if not CODEX_DB.exists():
        return None
    connection = sqlite3.connect(f'file:{CODEX_DB}?mode=ro', uri=True, timeout=1)
    try:
        for pid in pids:
            thread = _codex_holders.get(pid)
            if not thread:
                continue
            row = connection.execute('select rollout_path from threads where id = ?', (thread,)).fetchone()
            if row and pid in file_holders(row[0]):
                return thread
            del _codex_holders[pid]
        key = tuple(pids)
        if time.time() - _codex_scanned.get(key, 0) < CODEX_RESCAN_SECONDS:
            return None
        # Forget processes that are gone. A thread another holder had is still
        # scanned: a restarted Codex can resume it under a new pid.
        alive = windows_processes()
        for pid in [pid for pid in _codex_holders if pid not in alive]:
            del _codex_holders[pid]
        # Sub-agent threads can share their parent's process; only a root names the session.
        rows = connection.execute(
            'select id, rollout_path from threads where archived = 0 '
            'and id not in (select child_thread_id from thread_spawn_edges) '
            'order by updated_at desc limit ?', (CODEX_SCAN_LIMIT,)).fetchall()
        for thread, rollout in rows:
            holders = file_holders(rollout)
            for pid in holders:
                _codex_holders[pid] = thread
            if holders & set(pids):
                return thread
        _codex_scanned[key] = time.time()
        return None
    finally:
        connection.close()


def bridged_session(address, kind):
    """Common terminals only attach to a herdr pane, so the agent's process lives there."""
    try:
        panes = json.loads(BRIDGES.read_text(encoding='utf-8')).get('panes', [])
        pane = next(p['source'] for p in panes if p['terminal'] == address)
    except (OSError, ValueError, KeyError, StopIteration):
        return None
    if kind == 'claude':
        output = subprocess.run([HERDR, 'pane', 'get', pane], capture_output=True, text=True, timeout=10,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).stdout
        result = json.loads(output or '{}').get('result', {})
        return ((result.get('pane') or result).get('agent_session') or {}).get('value')
    output = subprocess.run([HERDR, 'pane', 'process-info', '--pane', pane], capture_output=True, text=True, timeout=10,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).stdout
    pids = [int(pid) for pid in re.findall(r'"pid":\s*(\d+)', output)]
    return codex_thread(pids)


def identify(terminal, cache):
    """Resolve the live session every pass: PTY and agent PIDs can outlive /new."""
    address = terminal['address']
    facts = hc('get', address)
    pid = facts.get('pid')
    # A machine/ address runs on another computer: its pid means nothing here.
    pids = process_tree(pid) if pid and '/' not in address else []
    kind = family(terminal.get('agent'))
    session = claude_session(pids) if kind == 'claude' else codex_thread(pids) if kind == 'codex' else None
    session = session or bridged_session(address, kind)
    cache[address] = {'pid': pid, 'session': session, 'parent': facts.get('parent'), 'created': facts.get('created_ms')}
    return cache[address]


def transcript_facts(path, kind, thread=None):
    try:
        info = Path(path).stat()
    except OSError:
        return None, None, ''
    return _transcript_facts(str(path), kind, thread, info.st_mtime_ns, info.st_size)


@lru_cache(maxsize=256)
def _transcript_facts(path, kind, thread, modified, size):
    """Read lifecycle facts, never treat a spawn link or silence as running."""
    status, source, task = None, None, ''
    try:
        with Path(path).open(encoding='utf-8', errors='replace') as stream:
            for line in stream:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                payload = row.get('payload', {})
                if kind == 'codex':
                    if row.get('type') == 'event_msg':
                        event = payload.get('type')
                        # Forked transcripts include the parent's history. Reset at
                        # the child's own settings marker before reading its turn.
                        if event == 'thread_settings_applied' and payload.get('thread_id') == thread:
                            status, source, task = None, None, ''
                        if event in ('task_started', 'task_complete', 'turn_aborted'):
                            status = {'task_started':'working', 'task_complete':'finished', 'turn_aborted':'interrupted'}[event]
                            source = 'codex.' + event
                        if event == 'user_message':
                            task = payload.get('message') or task
                    if row.get('type') == 'response_item' and payload.get('role') == 'user':
                        text = '\n'.join(c.get('text', '') for c in payload.get('content', []) if isinstance(c, dict))
                        if text and not text.startswith(('# AGENTS.md', '<environment_context>')):
                            task = text
                else:
                    message = row.get('message', {})
                    if row.get('type') == 'user' and not task:
                        content = message.get('content', '')
                        if isinstance(content, str):
                            task = content
                    if row.get('type') == 'assistant':
                        reason = message.get('stop_reason')
                        if reason == 'end_turn':
                            status, source = 'finished', 'claude.end_turn'
                        elif reason == 'tool_use':
                            status, source = None, None
                    if row.get('attachment', {}).get('hookEvent') == 'SubagentStop':
                        status, source = 'finished', 'claude.SubagentStop'
    except (OSError, TypeError):
        pass
    return status, source, next((line.strip()[:160] for line in task.splitlines() if line.strip()), '')


def born(path):
    info = path.stat()
    return getattr(info, 'st_birthtime', info.st_ctime)  # Windows before Python 3.12: ctime is creation.


def lock_once(stream):
    """True when this process holds the collector lock."""
    try:
        if WINDOWS:
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:  # BlockingIOError on POSIX, PermissionError from msvcrt.
        return False
    return True


def claude_children(session, terminal, now):
    nodes = []
    for meta in CLAUDE.glob(f'projects/*/{session}/subagents/*.meta.json'):
        try:
            data = json.loads(meta.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        log = meta.with_name(meta.name.replace('.meta.json', '.jsonl'))
        active = (log if log.exists() else meta).stat().st_mtime
        observed, observed_source, task = transcript_facts(log, 'claude')
        if data.get('finished') or observed == 'finished':
            status, source = 'finished', 'meta.finished' if data.get('finished') else observed_source
            if now - active > KEEP_SECONDS:
                continue
        else:
            status, source = ('recent' if now - active < RECENT_SECONDS else 'quiet'), ESTIMATE
        nodes.append({'id': f'sub:{terminal}:{log.stem}', 'parent': terminal, 'terminal': terminal,
                      'label': data.get('description') or data.get('agentType') or log.stem,
                      'task': data.get('description') or task, 'agentType': data.get('agentType') or '',
                      'status': status, 'statusSource': source, 'at': int(born(meta) * 1000)})
    return nodes


def codex_children(connection, thread, parent, terminal, now):
    nodes = []
    rows = connection.execute(
        'select e.child_thread_id, e.status, t.agent_nickname, t.agent_role, t.title, t.updated_at_ms, t.created_at_ms, t.rollout_path, t.first_user_message '
        'from thread_spawn_edges e left join threads t on t.id = e.child_thread_id '
        'where e.parent_thread_id = ?', (thread,)).fetchall()
    for child, edge, nickname, role, title, updated, created, rollout, first_message in rows:
        active = (updated or 0) / 1000
        observed, source, task = transcript_facts(rollout, 'codex', child) if rollout else (None, None, '')
        status = 'closed' if edge != 'open' else observed or 'open'
        child_id = f'sub:{terminal}:{child}'
        descendants = codex_children(connection, child, child_id, terminal, now)
        if status in ('closed', 'finished', 'interrupted') and now - active > KEEP_SECONDS and not descendants:
            continue
        nodes.append({'id': child_id, 'parent': parent, 'terminal': terminal,
                      'label': nickname or role or (title or child)[:60],
                      'task': task or (first_message or title or '').split('\n')[0][:160],
                      'status': status, 'statusSource': source if edge == 'open' and source else 'spawn-edge',
                      'at': created or 0})
        nodes += descendants
    return nodes


def collect(cache):
    now = time.time()
    listing = [t for t in hc('ls').get('terminals', []) if t.get('state') == 'live']
    live = {t['address'] for t in listing}
    for address in set(cache) - live:
        del cache[address]
    connection = None
    if CODEX_DB.exists():
        connection = sqlite3.connect(f'file:{CODEX_DB}?mode=ro', uri=True, timeout=1)
    nodes = []
    try:
        for terminal in listing:
            address = terminal['address']
            facts = identify(terminal, cache)
            owner = facts.get('parent')
            if owner in live:
                nodes.append({'id': f'sub:{owner}:{address}', 'parent': owner, 'terminal': owner,
                              'label': terminal.get('agent') or address, 'status': terminal.get('status'),
                              'statusSource': 'hc', 'at': facts.get('created') or 0})
            kind = family(terminal.get('agent'))
            if kind == 'claude' and facts['session']:
                nodes += claude_children(facts['session'], address, now)
            elif kind == 'codex' and facts['session'] and connection:
                nodes += codex_children(connection, facts['session'], address, address, now)
    finally:
        if connection:
            connection.close()
    return sorted(nodes, key=lambda node: (node['terminal'], node['at']))


def publish(nodes, events):
    text = json.dumps({'nodes': nodes, 'events': events}, ensure_ascii=False, separators=(',', ':'))
    try:
        if OUTPUT.read_text(encoding='utf-8') == text:  # An unchanged tree must not wake the sidebar.
            return
    except OSError:
        pass
    temporary = OUTPUT.with_name(f'.{OUTPUT.name}.tmp')
    temporary.write_text(text, encoding='utf-8')
    temporary.chmod(0o600)
    os.replace(temporary, OUTPUT)


def step(cache, seen, events):
    nodes = collect(cache)
    current = {node['id']: node for node in nodes}
    if seen is None:  # The first pass is history: nothing was delegated just now.
        seen = set(current)
    now_ms = int(time.time() * 1000)
    for node_id in current.keys() - seen:
        node = current[node_id]
        events.append({'id': uuid.uuid4().hex, 'source': node['parent'], 'target': node_id,
                       'at': now_ms, 'kind': 'delegate'})
    seen |= set(current)
    del events[:-EVENT_LIMIT]
    publish(nodes, events)
    return seen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    BASE.mkdir(parents=True, exist_ok=True)
    DATA.mkdir(parents=True, exist_ok=True)
    lock = (BASE / 'workflow.lock').open('w')
    if not lock_once(lock):
        return 0
    seen = None  # Every start is a new baseline, so old delegations never replay.
    cache, events = {}, []
    while True:
        try:
            seen = step(cache, seen, events)
        except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
            print(f'workflow: {error}', file=sys.stderr, flush=True)
        if args.once:
            return 0
        time.sleep(INTERVAL)


if __name__ == '__main__':
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    sys.exit(main())
