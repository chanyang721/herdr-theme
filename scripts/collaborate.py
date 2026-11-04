#!/usr/bin/env python3
"""Explicit independent-task ledger and at-most-once same-project overload collaboration."""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time
import uuid

import route
import site_config

APP_HOME = Path(os.environ.get('HERDR_APP_HOME', Path.home() / '.config/herdr-app'))
DATA = APP_HOME / 'data/sixfold'
DEFAULTS = {'enabled': True, 'pending_count': 2, 'oldest_seconds': 600, 'active_count': 3,
            'exclude_spaces': ['share', '공통', 'common']}
ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')


def call(argv, source=None):
    return route.call(argv, env={**os.environ, **({'HC_TERMINAL_ID': source} if source else {})})


def config():
    path = DATA / 'collaboration.json'
    value = json.loads(path.read_text()) if path.exists() else {}
    if not isinstance(value, dict):
        raise ValueError('collaboration.json은 객체여야 합니다.')
    result = {**DEFAULTS, **value}
    if not isinstance(result['enabled'], bool):
        raise ValueError('enabled는 boolean이어야 합니다.')
    if not isinstance(result['exclude_spaces'], list) or not all(isinstance(x, str) for x in result['exclude_spaces']):
        raise ValueError('exclude_spaces는 문자열 배열이어야 합니다.')
    result['exclude_spaces'] = sorted(set(DEFAULTS['exclude_spaces']) | set(site_config.load().get('hub_space_ids', []))
                                      | {x.casefold() for x in result['exclude_spaces']})
    for key in ('pending_count', 'oldest_seconds', 'active_count'):
        if not isinstance(result[key], int) or isinstance(result[key], bool) or result[key] < 1:
            raise ValueError(f'invalid {key}')
    return result


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    fd = os.open(temporary, os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


@contextmanager
def locked():
    DATA.mkdir(parents=True, exist_ok=True)
    with (DATA / 'collaboration.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def load():
    path = DATA / 'collaboration-tasks.json'
    value = json.loads(path.read_text()) if path.exists() else {'version': 1, 'tasks': {}}
    if value.get('version') != 1 or not isinstance(value.get('tasks'), dict):
        raise ValueError('손상된 협업 원장: 자동 초기화하지 않습니다.')
    return value


def save(ledger):
    atomic(DATA / 'collaboration-tasks.json', ledger)


def event(task, state, **facts):
    task['state'] = state
    task.setdefault('events', []).append({'state': state, 'at': time.time(), **facts})


def state(fact):
    value = fact.get('status')
    return value.get('state') if isinstance(value, dict) else value


def snapshot():
    code, app = call(['herdr-app', 'ls'])
    if code or not isinstance(app.get('spaces'), list):
        raise ValueError('워크스페이스 확인 실패')
    code, core = call(['hc', 'ls', '--json'])
    if code or not isinstance(core.get('terminals'), list):
        raise ValueError('세션 상태 확인 실패')
    return app['spaces'], {item['address']: item for item in core['terminals']}


def space_for(spaces, actor):
    matches = [s for s in spaces if any(t.get('terminal') == actor for tab in s.get('tabs', [])
                                      for t in tab.get('terminals', []))]
    if len(matches) != 1:
        raise ValueError('세션의 프로젝트 공간을 하나로 확인하지 못했습니다.')
    space = matches[0]
    cfg = config()
    if space.get('name', '').casefold() in cfg['exclude_spaces'] or space.get('id') in cfg['exclude_spaces']:
        raise ValueError('Share 공간에서는 과부하 협업을 받거나 보내지 않습니다.')
    return space


def actor(explicit=None):
    current = os.environ.get('HC_TERMINAL_ID')
    if current and explicit and current != explicit:
        raise ValueError('--from과 실제 HC_TERMINAL_ID가 다릅니다.')
    value = current or explicit
    if not value:
        raise ValueError('HC_TERMINAL_ID 또는 --from이 필요합니다.')
    return value


def authorized(task, who, role):
    if who != task.get(role):
        raise ValueError(f'{role} 세션만 이 작업 상태를 바꿀 수 있습니다.')


def enqueue(args):
    who = actor(args.source)
    spaces, live = snapshot()
    space = space_for(spaces, who)
    if live.get(who, {}).get('state') != 'live':
        raise ValueError('실행 중인 발신 세션이 아닙니다.')
    if not ID.fullmatch(args.id):
        raise ValueError('작업 ID 형식 오류')
    if args.mode == 'worktree' and not args.owns:
        raise ValueError('worktree 작업은 --owns 파일 영역을 반드시 명시하세요.')
    if any(part.strip().replace('\\', '/').startswith('/') or '..' in part.replace('\\', '/').split('/')
           for part in args.owns.split(',')):
        raise ValueError('--owns는 .. 없는 저장소 상대 경로를 쉼표로 구분해 쓰세요.')
    with locked():
        ledger = load()
        existing = ledger['tasks'].get(args.id)
        if existing:
            authorized(existing, who, 'source')
            if any(existing[key] != value for key, value in (
                    ('text', args.text), ('mode', args.mode), ('owns', args.owns), ('batch', args.batch or args.id))):
                raise ValueError('기존 ID를 다른 작업에 재사용할 수 없습니다.')
            return existing
        if who + ':' + (args.batch or args.id) in ledger.get('reports', {}):
            raise ValueError('이미 보고한 batch에는 작업을 추가할 수 없습니다.')
        task = {'id': args.id, 'source': who, 'space': space['id'], 'project': space['name'],
                'text': args.text, 'mode': args.mode, 'owns': args.owns, 'created': time.time(),
                'batch': args.batch or args.id, 'state': 'pending', 'events': []}
        event(task, 'pending', evidence='explicit source declaration')
        ledger['tasks'][args.id] = task
        save(ledger)
        return task


def thresholds(tasks, source, cfg, now):
    pending = [t for t in tasks if t['source'] == source and t['state'] == 'pending']
    active = [t for t in tasks if t['source'] == source and t['state'] == 'local_active']
    oldest = max([now - t['created'] for t in pending], default=0)
    return {'overloaded': len(pending) >= cfg['pending_count'] or oldest >= cfg['oldest_seconds']
            or len(active) >= cfg['active_count'], 'pending': len(pending), 'oldest_seconds': oldest,
            'active': len(active), 'evidence': 'collaboration-tasks.json explicit task states'}


def lease_path(task_id):
    if not ID.fullmatch(task_id):
        raise ValueError('작업 ID 형식 오류')
    return DATA / 'collaboration-leases' / (task_id + '.json')


def instruction(task, target, token):
    command = 'python3 ' + shlex.quote(str(Path(__file__).resolve()))
    safety = ('읽기 전용: 파일/설정/저장소 변경 금지.' if task['mode'] == 'read-only' else
              f'별도 worktree 사용 필수. 소유 파일 영역: {task["owns"]}. 다른 세션의 작업 폴더 수정 금지.')
    return (f'[과부하 협업 {task["id"]}] 원 세션 {task["source"]}, 프로젝트 {task["project"]}\n'
            f'{safety}\n{task["text"]}\n\n'
            f'실행 전에 수락 기록: {command} accept {shlex.quote(task["id"])} --lease {token}\n'
            '수락 명령이 실패하면 실행하지 마세요. 같은 작업 재분배 금지.\n'
            f'완료 기록: {command} complete {shlex.quote(task["id"])} --lease {token} --result "직접 확인한 결과"\n'
            'hc로 개별 완료 회신하지 마세요. 결과는 원 세션이 모아 한 번만 보고합니다. Share 보고 금지.')


def ownership_conflict(task, others):
    """Conservative path-prefix ownership; ambiguous globs reserve their prefix."""
    if task['mode'] == 'read-only':
        return False
    def prefixes(value):
        parts = [p.strip().replace('\\', '/').removeprefix('./') for p in value.split(',') if p.strip()]
        result = []
        for part in parts:
            pieces = re.split(r'[*?\[]', part, maxsplit=1)
            prefix = pieces[0]
            if len(pieces) > 1 and not prefix.endswith('/'):
                prefix = prefix.rsplit('/', 1)[0] if '/' in prefix else ''
            result.append(prefix.rstrip('/'))
        return result or ['']
    for other in others:
        if other['id'] == task['id'] or other['space'] != task['space'] or other['mode'] == 'read-only':
            continue
        for left in prefixes(task['owns']):
            for right in prefixes(other['owns']):
                if not left or not right or left == right or left.startswith(right + '/') or right.startswith(left + '/'):
                    return True
    return False


def receiver(target, space, facts, reserved):
    fact = facts.get(target, {})
    if target in reserved or fact.get('state') != 'live' or state(fact) not in ('idle', 'done'):
        return False
    if not fact.get('agent'):
        return False
    code, current = call(['hc', 'get', target, '--json'])
    # List 'done' can be the app's unread-completion synthesis over raw idle.
    # Recheck raw get status and always use the native atomic idle guard.

    if code or current.get('state') != 'live' or state(current) != 'idle':
        return False
    code, screen = call(['hc', 'read', target, '--json'])
    return not code and route.receiver_available(screen.get('text', ''))


def drain():
    cfg = config()
    if not cfg['enabled']:
        return []
    with locked():
        ledger = load()
        tasks = list(ledger['tasks'].values())
        if not any(t['state'] == 'pending' for t in tasks):
            return []
        spaces, facts = snapshot()
        reserved = {t['target'] for t in tasks if t['state'] in ('sending', 'sent', 'accepted', 'uncertain')
                    and t.get('target')}
        ownership = [t for t in tasks if t['state'] in ('local_active', 'sending', 'sent', 'accepted', 'uncertain')]
        results = []
        # Freeze overload evidence for this drain so two queued tasks can go to
        # two helpers; sending the first must not erase the trigger for the second.
        pressure = {t['source']: thresholds(tasks, t['source'], cfg, time.time()) for t in tasks}
        for task in sorted(tasks, key=lambda t: t['created']):
            if task['state'] != 'pending' or not pressure[task['source']]['overloaded']:
                continue
            if ownership_conflict(task, ownership):
                continue
            try:
                space = space_for(spaces, task['source'])
            except ValueError:
                continue
            if space['id'] != task['space'] or facts.get(task['source'], {}).get('state') != 'live':
                continue
            peers = [t['terminal'] for tab in space.get('tabs', []) for t in tab.get('terminals', [])
                     if t.get('terminal') != task['source']]
            for target in peers:
                if not receiver(target, space, facts, reserved):
                    continue
                token = uuid.uuid4().hex
                path = lease_path(task['id'])
                if path.exists():
                    event(task, 'uncertain', reason='orphan lease exists; do not resend')
                    save(ledger)
                    break
                path.parent.mkdir(parents=True, exist_ok=True)
                lease = {'id': task['id'], 'source': task['source'], 'target': target,
                         'token': token, 'created': time.time(), 'mode': task['mode'], 'owns': task['owns']}
                # Exclusive creation + global ledger lock. Never expire/reassign an
                # uncertain lease: at-most-once takes precedence over availability.
                fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                with os.fdopen(fd, 'w') as stream:
                    json.dump(lease, stream)
                    stream.flush()
                    os.fsync(stream.fileno())
                task.update(target=target, lease=token)
                event(task, 'sending', pressure=pressure[task['source']])
                save(ledger)
                try:
                    code, result = call(['hc', 'send', target, '--json', '--if', 'idle',
                                         instruction(task, target, token)], source=task['source'])
                except (OSError, subprocess.SubprocessError) as error:
                    code, result = 1, {'error': str(error)}
                if not code and 'error' in result:
                    code = 1  # Parsed transport output is not an acknowledged successful send.
                kind = result.get('error', {}).get('kind') if isinstance(result.get('error'), dict) else None
                if code and kind in ('status_mismatch', 'blocked', 'finished', 'not_found'):
                    # Core guarantees no input in these cases. Keep task pending,
                    # but do not attempt another target within this drain.
                    path.unlink()
                    task.pop('lease', None)
                    task.pop('target', None)
                    event(task, 'pending', rejected=result)
                else:
                    event(task, 'uncertain' if code else 'sent', delivery=result)
                    reserved.add(target)
                    ownership.append(task)
                save(ledger)
                results.append({'id': task['id'], 'target': target, 'state': task['state']})
                break
        return results


def transition(args):
    who = actor(args.source)
    with locked():
        ledger = load()
        if args.id not in ledger['tasks']:
            raise ValueError('알 수 없는 작업 ID')
        task = ledger['tasks'][args.id]
        if args.action == 'start':
            authorized(task, who, 'source')
            if task['state'] == 'local_active':
                return task
            if task['state'] != 'pending' or lease_path(args.id).exists():
                raise ValueError('임대된 작업은 원 세션에서 실행할 수 없습니다.')
            if ownership_conflict(task, [t for t in ledger['tasks'].values()
                    if t['state'] in ('local_active', 'sending', 'sent', 'accepted', 'uncertain')]):
                raise ValueError('이미 진행 중인 작업과 파일 소유 영역이 겹칩니다.')
            event(task, 'local_active')
        elif args.action in ('accept', 'complete') and task['state'] != 'local_active':
            authorized(task, who, 'target')
            if args.lease != task.get('lease') or not args.lease:
                raise ValueError('임대 토큰 불일치')
            persisted = json.loads(lease_path(args.id).read_text())
            if persisted['token'] != args.lease or persisted['target'] != who:
                raise ValueError('임대 파일 불일치')
            if args.action == 'accept':
                if task['state'] == 'accepted':
                    return task
                if task['state'] not in ('sent', 'uncertain', 'sending'):
                    raise ValueError('수락 가능한 상태가 아닙니다.')
                spaces, _ = snapshot()
                if space_for(spaces, who)['id'] != task['space']:
                    raise ValueError('수신 세션이 원 프로젝트 공간에서 이동했습니다.')
                event(task, 'accepted', actor=who)
                persisted['accepted_at'] = time.time()
                atomic(lease_path(args.id), persisted)
            else:
                if task['state'] == 'completed':
                    return task
                if task['state'] != 'accepted':
                    raise ValueError('수락 전에 완료할 수 없습니다.')
                event(task, 'completed', actor=who)
                task['result'] = args.result
        elif args.action == 'complete':
            authorized(task, who, 'source')
            event(task, 'completed', actor=who)
            task['result'] = args.result
        else:
            raise ValueError('지원하지 않는 상태 전환')
        save(ledger)
        return task


def report(args):
    who = actor(args.source)
    with locked():
        ledger = load()
        tasks = [t for t in ledger['tasks'].values() if t['source'] == who and t['batch'] == args.batch]
        if not tasks or any(t['state'] != 'completed' for t in tasks):
            raise ValueError('이 batch의 모든 작업이 완료돼야 보고할 수 있습니다.')
        batch_key = who + ':' + args.batch
        previous = ledger.setdefault('reports', {}).get(batch_key)
        if previous:
            return {'state': 'already_reported', 'source': who, 'batch': args.batch, 'at': previous['at']}
        summary = '\n'.join(f'{t["id"]}: {t.get("result", "")}' for t in tasks)
        # Persist first. Crash/timeout cannot cause a second report. The origin
        # reads results locally and alone owns the user-facing aggregate report.
        value = {'state': 'reported', 'source': who, 'batch': args.batch, 'at': time.time(), 'text': summary}
        ledger['reports'][batch_key] = value
        save(ledger)
        return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--drain', action='store_true', help='compatibility with sidebar timer')
    sub = parser.add_subparsers(dest='action')
    sub.add_parser('enable')
    sub.add_parser('drain')
    sub.add_parser('status')
    p = sub.add_parser('enqueue')
    p.add_argument('--id', required=True)
    p.add_argument('--text', required=True)
    p.add_argument('--mode', choices=['read-only', 'worktree'], required=True)
    p.add_argument('--owns', default='')
    p.add_argument('--batch')
    p.add_argument('--from', dest='source')
    for name in ('start', 'accept', 'complete'):
        p = sub.add_parser(name)
        p.add_argument('id')
        p.add_argument('--from', dest='source')
        p.add_argument('--lease')
        if name == 'complete':
            p.add_argument('--result', required=True)
    p = sub.add_parser('report')
    p.add_argument('--batch', required=True)
    p.add_argument('--from', dest='source')
    args = parser.parse_args()
    if args.action == 'enable':
        with locked():
            atomic(DATA / 'collaboration.json', {**config(), 'script': str(Path(__file__).resolve()), 'enabled': True})
        result = {'enabled': True, 'config': str(DATA / 'collaboration.json')}
    elif args.drain or args.action == 'drain':
        result = drain()
    elif args.action == 'enqueue':
        result = enqueue(args)
    elif args.action in ('start', 'accept', 'complete'):
        result = transition(args)
    elif args.action == 'report':
        result = report(args)
    elif args.action == 'status':
        with locked():
            result = load()
    else:
        parser.error('명령을 지정하세요.')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))
        raise SystemExit(1)
