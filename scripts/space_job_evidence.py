"""Read-only evidence for backend jobs which may live outside a terminal's PID tree.

Absence of evidence is never evidence that a backend job has stopped. This module
reads complete, bounded session logs and returns a stable observation fingerprint;
it never contacts an app, sends input, kills a process, or changes a state file.
"""
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3

MAX_ROLLOUT_BYTES = 64 * 1024 * 1024
MAX_THREADS = 1000
RUNNING_CELL = re.compile(r'^Script running with cell ID\s+([A-Za-z0-9:_-]+)', re.M)
COMPLETED_CELL = re.compile(r'^Script completed(?:\s|$)')
EXEC_NAMES = {'exec_command', 'write_stdin', 'exec', 'wait', 'shell', 'bash'}
TERMINAL_EVENTS = {'task_complete', 'turn_aborted'}


class Unverified(Exception):
    pass


class OpenExecSessions(Unverified):
    """Exec sessions the log started and never saw end. They are child processes of the Codex
    process, so a caller that verified that process tree holds no command may accept them."""


def _hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode()).hexdigest()


def _identifier(value):
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        return None
    return str(value) if str(value) else None


def _arguments(payload):
    raw = payload.get('arguments', payload.get('input', payload.get('call_args', {})))
    if isinstance(raw, dict):
        return raw, ''
    if not isinstance(raw, str):
        return {}, ''
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed, raw
    except (ValueError, TypeError):
        pass
    # functions.exec uses raw JavaScript instead of JSON arguments. Only an
    # unambiguous literal ID can associate a poll with the session it observes.
    args = {}
    for key in ('session_id', 'cell_id'):
        values = re.findall(r'\b'+key+r'\s*:\s*("[^"\n]+"|\'[^\'\n]+\'|\d+)', raw)
        normalized = {v[1:-1] if v[:1] in ('"', "'") else v for v in values}
        if len(normalized) == 1:
            args[key] = normalized.pop()
        elif len(normalized) > 1:
            raise Unverified('ambiguous backend poll session')
    return args, raw


def _truncated_host_result(value):
    # A host output-budget warning can truncate stdout while its preceding
    # process result metadata remains complete. Parse only that prefix, never
    # JSON printed inside a process's stdout.
    warning = re.match(r'\AWarning: truncated output \(original token count: \d+\)\nTotal output lines: \d+\n\n', value)
    if not warning:
        return None
    text = value[warning.end():]
    boundary = re.search(r',\s*"output"\s*:', text)
    if not boundary:
        return None
    try:
        prefix = json.loads(text[:boundary.start()] + '}')
    except ValueError:
        return None
    if not isinstance(prefix, dict) or not isinstance(prefix.get('chunk_id'), str) or not re.fullmatch(r'[0-9a-f]+', prefix['chunk_id']) or not isinstance(prefix.get('wall_time_seconds'), (int, float)):
        return None
    return prefix if 'exit_code' in prefix or 'session_id' in prefix else None


def _output(value, depth=0):
    if depth > 32:
        raise Unverified('backend output nesting unverified')
    dictionaries, texts = [], []
    if isinstance(value, str):
        texts.append(value)
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            partial = _truncated_host_result(value)
            return ([partial] if partial is not None else dictionaries), texts
        nested, words = _output(parsed, depth+1)
        return nested, texts+words
    if isinstance(value, list):
        for part in value:
            nested, words = _output(part, depth+1)
            dictionaries.extend(nested)
            texts.extend(words)
    elif isinstance(value, dict):
        dictionaries.append(value)
        # stdout belongs to the launched program. A command printing JSON with
        # a session_id/exit_code must never terminate an unrelated backend job.
        if 'session_id' in value or 'exit_code' in value:
            return dictionaries, texts
        for key in ('text', 'output', 'content', 'result', 'structuredContent'):
            if key in value:
                nested, words = _output(value[key], depth+1)
                dictionaries.extend(nested)
                texts.extend(words)
    return dictionaries, texts


def _wrapper_texts(value):
    # Host execution-cell status is a top-level text block, never arbitrary
    # text inside a command's stdout JSON.
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except ValueError:
            return [value]
        return _wrapper_texts(parsed)
    if isinstance(value, list):
        return [part['text'] for part in value if isinstance(part, dict) and isinstance(part.get('text'), str)]
    if isinstance(value, dict):
        if isinstance(value.get('text'), str):
            return [value['text']]
        if isinstance(value.get('content'), list):
            return _wrapper_texts(value['content'])
    return []


def _read_jsonl(path, session_id, observations):
    path = Path(path)
    before = path.stat()
    if before.st_size + sum(item.get('bytes', 0) for item in observations) > MAX_ROLLOUT_BYTES:
        raise Unverified('rollout exceeds 64 MiB read budget; backend jobs unverified')
    with path.open('rb') as file:
        data = file.read(MAX_ROLLOUT_BYTES+1)
    after = path.stat()
    if len(data) > MAX_ROLLOUT_BYTES:
        raise Unverified('rollout exceeds 64 MiB; backend jobs unverified')
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise Unverified('rollout changed during read')
    if not data or not data.endswith(b'\n'):
        raise Unverified('incomplete rollout history')
    records = []
    for line in data.decode('utf-8').split('\n'):
        if not line.strip():
            continue
        item = json.loads(line)
        if not isinstance(item, dict):
            raise Unverified('invalid rollout history')
        records.append(item)
    if not records or records[0].get('type') != 'session_meta' or not isinstance(records[0].get('payload'), dict) or records[0]['payload'].get('id') != session_id:
        raise Unverified('rollout session identity/history unverified')
    observations.append({'session': session_id, 'sha256': hashlib.sha256(data).hexdigest(), 'mtime_ns': after.st_mtime_ns, 'bytes': len(data)})
    return records, after.st_mtime * 1000


def _codex_log(records):
    calls, pending, sessions, cells = {}, set(), set(), set()
    lifecycle = None
    for record in records:
        if record.get('history_truncated') or record.get('truncated_history'):
            raise Unverified('truncated rollout history')
        payload = record.get('payload', {})
        if not isinstance(payload, dict):
            raise Unverified('invalid rollout payload')
        if payload.get('history_truncated') or payload.get('truncated_history'):
            raise Unverified('truncated rollout history')
        if record.get('type') == 'event_msg':
            event = payload.get('type')
            if event == 'task_started':
                lifecycle = 'working'
            elif event in TERMINAL_EVENTS:
                lifecycle = 'finished'
        if record.get('type') != 'response_item':
            continue
        kind = payload.get('type')
        if kind in ('function_call', 'custom_tool_call', 'tool_call'):
            call_id = payload.get('call_id', payload.get('id'))
            if not isinstance(call_id, str) or not call_id or call_id in calls:
                raise Unverified('tool call identity/history unverified')
            args, raw = _arguments(payload)
            name = str(payload.get('name', '')).split('.')[-1].lower()
            relevant = name in EXEC_NAMES or bool(re.search(r'\b(?:exec_command|write_stdin)\s*\(', raw))
            calls[call_id] = {'name': name, 'args': args, 'relevant': relevant, 'raw': raw}
            pending.add(call_id)
        elif kind in ('function_call_output', 'custom_tool_call_output', 'tool_result'):
            call_id = payload.get('call_id', payload.get('tool_call_id'))
            if call_id not in calls or call_id not in pending:
                raise Unverified('tool output without its complete call history')
            pending.remove(call_id)
            call = calls[call_id]
            if not call['relevant']:
                continue
            output = payload.get('output', payload.get('content'))
            objects, _ = _output(output)
            host_texts = _wrapper_texts(output)
            running = [match for text in host_texts for match in RUNNING_CELL.findall(text)]
            cells.update(running)
            cell_id = _identifier(call['args'].get('cell_id'))
            if cell_id and any(COMPLETED_CELL.match(text) for text in host_texts):
                if cell_id not in cells:
                    raise Unverified('execution cell completion has no matching start')
                cells.remove(cell_id)
            session_id = _identifier(call['args'].get('session_id'))
            saw_result = False
            for result in objects:
                result_session = _identifier(result.get('session_id'))
                exit_code = result.get('exit_code')
                exited = isinstance(exit_code, int) and not isinstance(exit_code, bool)
                if result_session:
                    saw_result = True
                    # One code-mode cell may poll one session and start another; only a direct
                    # tool call names exactly the session its result belongs to.
                    if session_id and session_id != result_session and call['name'] != 'exec':
                        raise Unverified('backend poll session identity mismatch')
                    if exited:
                        sessions.discard(result_session)
                    else:
                        sessions.add(result_session)
                elif exited:
                    saw_result = True
                    if session_id:
                        # An exit for a session whose start was not parsed still means it ended.
                        sessions.discard(session_id)
            shell_call = call['name'] in {'exec_command', 'write_stdin', 'shell', 'bash'} or 'exec_command' in call['raw'] or 'write_stdin' in call['raw']
            # A code-mode cell the host reports as completed has returned: anything it left
            # running would have printed a session_id (tracked above) or a running cell.
            completed = any(COMPLETED_CELL.match(text) for text in host_texts)
            if shell_call and not saw_result and not running and not completed:
                raise Unverified('backend command result unverified')
    # After the task ended, a call that never got its output (a refused spawn_agent, say) is not
    # running. A command call without output is, until proven otherwise.
    if any(calls[c]['relevant'] for c in pending) or (pending and lifecycle != 'finished'):
        raise Unverified('pending backend tool calls')
    if cells:
        raise Unverified('running backend execution cells')
    if sessions:
        raise OpenExecSessions('running backend exec sessions')
    return lifecycle


def _codex_finished(records):
    phase = None
    for record in records:
        payload = record.get('payload') if isinstance(record.get('payload'), dict) else {}
        if record.get('type') == 'event_msg' and payload.get('type') == 'task_started':
            phase = 'working'
        elif record.get('type') == 'event_msg' and payload.get('type') in TERMINAL_EVENTS:
            phase = 'finished'
    return phase == 'finished'


def _codex(terminal, mapping, config, observations):
    db = Path(config.get('codex_db', Path.home()/'.codex/state_5.sqlite')).expanduser()
    if not db.is_file():
        raise Unverified('backend jobs unverified: Codex state database missing')
    connection = sqlite3.connect(db.resolve().as_uri()+'?mode=ro', uri=True, timeout=1)
    try:
        connection.execute('PRAGMA query_only=ON')
        seen, active = set(), set()
        def visit(session_id, main=False, edge=None):
            if session_id in active or session_id in seen:
                raise Unverified('child session graph cycle/alias unverified')
            if len(seen) >= MAX_THREADS:
                raise Unverified('child session graph too large')
            seen.add(session_id)
            active.add(session_id)
            row = connection.execute('select rollout_path from threads where id = ?', (session_id,)).fetchone()
            if not row or not isinstance(row[0], str) or not row[0]:
                raise Unverified('backend jobs unverified: rollout path missing')
            records, mtime_ms = _read_jsonl(row[0], session_id, observations)
            if main and mtime_ms <= terminal['status_ms']-5000:
                raise Unverified('stale main rollout/session mapping')
            try:
                phase = _codex_log(records)
            except OpenExecSessions:
                if not config.get('_process_tree_clean'):
                    raise
                observations.append({'open_exec_sessions_without_processes': session_id})
                phase = 'finished' if _codex_finished(records) else None
            # A thread its parent closed runs no more turns; what it left running is still checked.
            if phase != 'finished' and edge != 'closed':
                raise Unverified('open child task working/unknown' if not main else 'main backend task working/unknown')
            rows = connection.execute('select child_thread_id, status from thread_spawn_edges where parent_thread_id = ? order by child_thread_id', (session_id,)).fetchall()
            observations.append({'parent': session_id, 'children': rows})
            for child_id, child_edge in rows:
                if not isinstance(child_id, str) or child_edge not in ('open', 'closed'):
                    raise Unverified('child session link status unverified')
                visit(child_id, edge=child_edge)
            active.remove(session_id)
        visit(mapping['session_id'], main=True)
    finally:
        connection.close()


def _claude_records(path, observations):
    path = Path(path)
    before = path.stat()
    if before.st_size > MAX_ROLLOUT_BYTES:
        raise Unverified('backend jobs unverified: Claude history too large')
    data = path.read_bytes()
    after = path.stat()
    if len(data) > MAX_ROLLOUT_BYTES or not data.endswith(b'\n') or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise Unverified('backend jobs unverified: Claude history incomplete')
    lines = [line for line in data.decode('utf-8').split('\n') if line.strip()]
    records = [json.loads(line) for line in lines]
    observations.append({'claude_log': str(path), 'sha256': hashlib.sha256(data).hexdigest(), 'mtime_ns': after.st_mtime_ns})
    return records, after.st_mtime*1000


# Copies of API requests repeat earlier tool results; they are not conversation events.
CLAUDE_COPIES = {'api-request', 'api-request-blob', 'api-request-shape'}
NOTICE = re.compile(r'<task-notification>(.*?)</task-notification>', re.S)
NOTICE_IDS = re.compile(r'<(?:task-id|tool-use-id)>([A-Za-z0-9_-]+)</(?:task-id|tool-use-id)>')
NOTICE_ENDED = re.compile(r'<status>(?:completed|failed|killed|stopped|cancelled)</status>')


def _ended_tasks(text):
    """Task and tool-use ids that a task notification reports as ended."""
    return {i for block in NOTICE.findall(text) if NOTICE_ENDED.search(block) for i in NOTICE_IDS.findall(block)}
STOPPED_TEXT = re.compile(r'Successfully (?:stopped task|killed shell):?\s*([A-Za-z0-9_-]+)')
BACKGROUND_TEXT = re.compile(r'running in (?:the )?background with ID:\s*([A-Za-z0-9_-]+)', re.I)


def _real_prompt(item, message):
    """A user turn the person (or hc) typed, not a tool result, command echo or meta note."""
    if item.get('isMeta') or item.get('toolUseResult') is not None:
        return False
    if item.get('isCompactSummary'):
        return False   # the summary Claude writes when it compacts (also while idle), not a prompt
    content = message.get('content')
    if isinstance(content, list):
        if any(isinstance(p, dict) and p.get('type') == 'tool_result' for p in content):
            return False
        content = ' '.join(p.get('text', '') for p in content if isinstance(p, dict))
    text = (content or '').lstrip() if isinstance(content, str) else ''
    return bool(text) and not text.startswith(('<local-command-', '<command-name>', '<command-message>', '<task-notification>', '<system-reminder>'))


def _claude_log(records, session_id, finished_by_meta=False):
    """Fail closed on: unknown identity, a tool call without its result, a background task
    (shell or async agent) started with no completed/failed/killed notice after it, and a turn
    that has not ended. Compaction keeps the file append-only, so it is read through."""
    pending, started, ended = set(), set(), set()
    alias = {}   # a background task id <-> the tool call that started it: one task
    background_calls = set()
    finished = False
    identified = False
    for item in records:
        if not isinstance(item, dict):
            raise Unverified('backend jobs unverified: Claude history invalid')
        message = item.get('message') if isinstance(item.get('message'), dict) else {}
        kind = item.get('type') or message.get('role')
        if kind in CLAUDE_COPIES or str(kind).startswith('api-request'):
            continue
        if item.get('sessionId'):
            if item['sessionId'] != session_id:
                raise Unverified('backend jobs unverified: Claude session identity mismatch')
            identified = True
        raw = json.dumps(item, ensure_ascii=False)
        if '<task-notification>' in raw:
            ended.update(_ended_tasks(raw.replace('\\n', '\n')))
        if kind not in ('assistant', 'user'):
            continue
        result = item.get('toolUseResult')
        launched = set()
        if isinstance(result, dict):
            if result.get('backgroundTaskId'):
                launched.add(str(result['backgroundTaskId']))
            if result.get('agentId') and (result.get('isAsync') or result.get('status') == 'async_launched'):
                launched.add(str(result['agentId']))
        started.update(launched)
        content = message.get('content', [])
        for part in content if isinstance(content, list) else []:
            if not isinstance(part, dict):
                continue
            if part.get('type') == 'tool_use':
                tool_id = part.get('id')
                if not tool_id or tool_id in pending:
                    raise Unverified('backend jobs unverified: Claude tool identity')
                pending.add(tool_id)
                if (part.get('input') or {}).get('run_in_background'):
                    background_calls.add(tool_id)
            elif part.get('type') == 'tool_result':
                tool_id = part.get('tool_use_id')
                if tool_id not in pending:
                    raise Unverified('backend jobs unverified: Claude tool history')
                text = json.dumps(part.get('content', ''), ensure_ascii=False)
                background = set(BACKGROUND_TEXT.findall(text)) | launched
                if tool_id in background_calls and not background and not part.get('is_error'):
                    background = {tool_id}   # asked for the background, no id seen: assume it runs
                started.update(background)
                for task in background:
                    alias[task] = tool_id
                    alias[tool_id] = task
                ended.update(STOPPED_TEXT.findall(text))
                pending.remove(tool_id)
        if message.get('role') == 'assistant':
            finished = message.get('stop_reason') == 'end_turn'
        elif _real_prompt(item, message):
            finished = False
    if not identified:
        raise Unverified('backend jobs unverified: Claude session identity')
    if pending & background_calls or any(task not in ended and alias.get(task) not in ended for task in started):
        raise Unverified('backend jobs unverified: Claude background job running')
    if finished_by_meta:
        return   # a subagent ends on its result tool call; its meta says it finished
    if pending:
        raise Unverified('backend jobs unverified: Claude tool call without result')
    if not finished:
        raise Unverified('backend jobs unverified: Claude turn not ended')


def _claude(terminal, mapping, config, observations):
    home = Path(config.get('claude_home', Path.home()/'.claude')).expanduser()
    process_pid = mapping.get('process_pid', mapping['pid'])
    if not isinstance(process_pid, int) or isinstance(process_pid, bool):
        raise Unverified('backend jobs unverified: Claude process identity')
    meta_path = home/'sessions'/f'{process_pid}.json'
    meta = json.loads(meta_path.read_text())
    if not isinstance(meta, dict) or meta.get('sessionId') != mapping['session_id']:
        raise Unverified('backend jobs unverified: Claude session mapping')
    observations.append({'claude_meta': meta})
    log = meta.get('transcriptPath') or meta.get('logPath')
    if not log:
        candidates = list((home/'projects').glob(f'*/{mapping["session_id"]}.jsonl'))
        if len(candidates) != 1:
            raise Unverified('backend jobs unverified: Claude log identity')
        log = candidates[0]
    records, mtime = _claude_records(log, observations)
    if mtime <= terminal['status_ms']-5000:
        raise Unverified('backend jobs unverified: stale Claude log')
    _claude_log(records, mapping['session_id'])
    for child_meta in sorted((home/'projects').glob(f'*/{mapping["session_id"]}/subagents/*.meta.json')):
        child = json.loads(child_meta.read_text())
        # `finished` is written by newer Claude Code only: false blocks, missing defers to the log.
        if not isinstance(child, dict) or child.get('finished') is False:
            raise Unverified('backend jobs unverified: Claude child working/unknown')
        log_path = child.get('logPath') or child_meta.with_name(child_meta.name.replace('.meta.json', '.jsonl'))
        child_records, _ = _claude_records(log_path, observations)
        # A subagent's log carries its parent's session id (and its own agentId).
        child_session = child.get('sessionId') or mapping['session_id']
        if not isinstance(child_session, str) or not child_session:
            raise Unverified('backend jobs unverified: Claude child session identity')
        _claude_log(child_records, child_session, finished_by_meta=child.get('finished') is True)
        observations.append({'claude_child_meta': child})


def check_jobs(terminal, config, mapping=None, process_tree_clean=False):
    """Return (verified_no_jobs, reason, fingerprint), conservatively read-only.

    mapping: the terminal's session (agent_sessions.session_mapping) when the config has none.
    process_tree_clean: the caller saw no command process under the agent (only helpers)."""
    config = {**config, '_process_tree_clean': bool(process_tree_clean)}
    observations = [{'terminal': {k: terminal.get(k) for k in ('address', 'pid', 'created_ms', 'status_ms', 'status')}}]
    try:
        address = terminal.get('address')
        sessions = config.get('sessions', {})
        mapping = (sessions.get(address) if isinstance(sessions, dict) else None) or mapping
        if not isinstance(mapping, dict):
            raise Unverified('backend jobs unverified: session mapping missing')
        observations.append({'mapping': mapping})
        for key in ('pid', 'created_ms'):
            value = terminal.get(key)
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0 or mapping.get(key) != value:
                raise Unverified('backend jobs unverified: terminal/session mapping mismatch')
        status_ms = terminal.get('status_ms')
        if isinstance(status_ms, bool) or not isinstance(status_ms, (int, float)) or not math.isfinite(status_ms) or status_ms <= 0:
            raise Unverified('backend jobs unverified: status timestamp missing')
        session_id, agent = mapping.get('session_id'), mapping.get('agent')
        actual_agent = (terminal.get('status') or {}).get('app')
        if not isinstance(session_id, str) or not session_id or agent not in ('codex', 'claude', 'claude-code') or actual_agent != agent:
            raise Unverified('backend jobs unverified: agent/session mapping mismatch')
        if agent == 'codex':
            _codex(terminal, mapping, config, observations)
        else:
            _claude(terminal, mapping, config, observations)
    except (Unverified, OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError, sqlite3.Error) as exc:
        reason = str(exc) if isinstance(exc, Unverified) else 'backend jobs unverified: evidence unreadable or invalid'
        return False, reason, _hash(observations)
    return True, '', _hash(observations)
