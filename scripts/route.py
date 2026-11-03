#!/usr/bin/env python3
"""Route Common workspace tasks to the same project slot, with idle fallback."""
import argparse
import fcntl
import json
import os
import re
from pathlib import Path
import subprocess
import time
import uuid

APP_HOME = Path(os.environ.get('HERDR_APP_HOME', Path.home() / '.config/herdr-app'))
DATA = APP_HOME / 'data/sixfold'
QUEUE = DATA / 'routing-queue.json'
HC = 'hc'
ALIASES = {'pmo': 'peaceminusone', '피마원': 'peaceminusone', '메디홈즈': 'medihomes'}
# Only idle has an atomic hc send guard. Done may be awaiting a user answer.
READY = {'idle'}


def call(argv, env=None):
    result = subprocess.run([str(x) for x in argv], capture_output=True, text=True,
                            timeout=30, env=env)
    try:
        data = json.loads(result.stdout or result.stderr)
    except ValueError:
        data = {'error': {'message': result.stderr.strip() or result.stdout.strip()}}
    return result.returncode, data


def family(agent):
    return 'claude' if agent in ('claude', 'claude-code') else agent


def locate(spaces, address):
    for space in spaces:
        for tab in space['tabs']:
            for index, terminal in enumerate(tab['terminals']):
                if terminal['terminal'] == address:
                    return space, tab, index
    raise ValueError(f'발신 에이전트를 찾지 못했습니다: {address}')


def candidates(spaces, live, source, project):
    origin, _, slot = locate(spaces, source)
    if origin['id'] != 'sp5b1f0e5ae362facabc5ac1ece5d08277' and origin['name'].casefold() not in ('share', '공통', 'common'):
        raise ValueError('Share 워크스페이스에서만 프로젝트 작업을 전달합니다.')
    key = ALIASES.get(project.casefold(), project.casefold())
    targets = [s for s in spaces if s['name'].casefold() == key
               or Path(s.get('folder') or '').name.casefold() == key]
    if len(targets) != 1 or targets[0]['id'] == origin['id']:
        raise ValueError(f'대상 프로젝트를 하나로 확인할 수 없습니다: {project}')
    target = targets[0]
    tabs = [tab for tab in target['tabs'] if tab.get('active')]
    if len(tabs) != 1:
        raise ValueError('대상 프로젝트의 활성 탭을 확인할 수 없습니다.')
    terminals = tabs[0]['terminals']
    facts = {t['address']: t for t in live}
    source_kind = family(facts.get(source, {}).get('agent'))
    preferred = terminals[slot]['terminal'] if slot < len(terminals) else None
    ranked = []
    for index, terminal in enumerate(terminals):
        address = terminal['terminal']
        fact = facts.get(address, {})
        status = fact.get('status')
        if isinstance(status, dict):
            status = status.get('state')
        if fact.get('state') != 'live' or status not in READY or not fact.get('agent'):
            continue
        rank = (address != preferred, family(fact.get('agent')) != source_kind, abs(index-slot), index)
        ranked.append((rank, address))
    return target['name'], preferred, [address for _, address in sorted(ranked)]


def snapshot():
    code, app = call(['herdr-app', 'ls'])
    if code:
        raise ValueError('Herdr App 워크스페이스 목록을 읽지 못했습니다.')
    code, core = call([HC, 'ls', '--json'])
    if code:
        raise ValueError('에이전트 상태를 읽지 못했습니다.')
    return app['spaces'], core['terminals']


def receiver_available(text):
    """Protect the current composer and pending questions, not old user prompts."""
    text = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]|\r', '', text)
    lines = text.splitlines()
    prompts = [i for i, line in enumerate(lines) if line.lstrip().startswith(('❯', '›'))]
    if not prompts:
        return False
    index = prompts[-1]
    draft = lines[index].lstrip()[1:].strip(' ▁▂▃▄▅▆▇█')
    if draft and not draft.startswith(('Ask Codex to do anything', 'Ask a follow-up question', 'Try "')):
        return False
    footer = '\n'.join(lines[max(0, index-4):index])
    if 'REC' in footer or 'voice ● listening' in footer:
        return False
    # Ignore UI footer/timing lines; a question at the end of the last assistant
    # response means the user still owns the next turn, even if core says idle.
    content = [line.strip() for line in lines[:index] if line.strip()
               and not re.match(r'^[─━│┌└]+', line.strip())
               and not re.match(r'^[✻✽✶✳✢·]\s+.*\bfor\s+\d', line.strip())
               and not any(word in line for word in ('Worked for ', 'Brewed for ', 'Sautéed for ', 'voice ', 'mic ▁'))]
    return not content or not re.search(r'[?？]\s*$', content[-1])


def dispatch(request, spaces, live):
    project, preferred, ranked = candidates(spaces, live, request['source'], request['project'])
    for target in ranked:
        # Recheck immediately before sending. Serialize routing clients with the
        # queue lock, and use hc's atomic idle guard wherever it is supported.
        code, observed = call([HC, 'get', target])
        status = (observed.get('status') or {}).get('state')
        if code or observed.get('state') != 'live' or status not in READY:
            continue
        screen_code, screen = call([HC, 'read', target, '--json'])
        if screen_code or not receiver_available(screen.get('text', '')):
            continue
        source = request['source']
        report = (f'이 작업의 결과 또는 막힌 점을 hc send {source} 명령으로 한 번 회신하세요.'
                  if request.get('reply') else
                  f'여러 갈래 작업은 이 세션의 서브에이전트로 처리하고, 사용자가 직접 결정해야 할 일이 생겼을 때만 hc send {source}로 알리세요. 진행·완료 보고는 보내지 마세요.')
        text = (f'[Share 작업 전달 {request["id"]}] {source} → {project} / {target}\n'
                f'{request["text"]}\n\n{report}\n'
                '다른 pane으로 재배분하지 마세요.')
        argv = [HC, 'send', target, '--json', '--if', 'idle']
        argv.append(text)
        code, result = call(argv, env={**os.environ, 'HC_TERMINAL_ID': source})
        if not code:
            return {'state': 'sent', 'id': request['id'], 'source': source,
                    'project': project, 'preferred': preferred, 'target': target,
                    'fallback': target != preferred, 'result': result}
        kind = result.get('error', {}).get('kind')
        if kind not in ('status_mismatch', 'blocked', 'finished', 'not_found'):
            # A transport timeout/error is not proof that nothing arrived.
            raise ValueError(f'전달 결과 불명확, 중복 전송을 피하려고 중단합니다: {result}')
    return {'state': 'queued', 'id': request['id'], 'source': request['source'],
            'project': project, 'preferred': preferred, 'reason': '모든 수신 pane이 작업 중이거나 확인 대기입니다.'}


def source_address(explicit):
    if explicit:
        return explicit
    if os.environ.get('HC_TERMINAL_ID'):
        return os.environ['HC_TERMINAL_ID']
    pane = os.environ.get('HERDR_PANE_ID')
    if pane:
        path = Path.home() / '.local/state/herdr-sixfold/migration-map.local.json'
        for item in json.loads(path.read_text()).get('panes', []):
            if item.get('source') == pane:
                return item['terminal']
    raise ValueError('발신 위치가 없습니다. Share 세션에서 실행하거나 --from 실제터미널ID를 지정하세요.')


def save_queue(requests):
    temporary = QUEUE.with_suffix('.tmp')
    temporary.write_text(json.dumps({'requests': requests}, ensure_ascii=False))
    temporary.chmod(0o600)
    temporary.replace(QUEUE)


def deliver_pending(request, pending, spaces, live):
    """Persist an at-most-once hold before any possibly successful send."""
    request['hold'] = True
    request['error'] = '전달 시도 중 종료되면 결과를 직접 확인하세요. 자동 재전송하지 않습니다.'
    save_queue(pending)
    try:
        result = dispatch(request, spaces, live)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        request['error'] = str(error)
        save_queue(pending)
        raise
    if result['state'] == 'queued':
        request.pop('hold', None)
        request.pop('error', None)
    else:
        pending.remove(request)
    save_queue(pending)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('project', nargs='?')
    parser.add_argument('text', nargs='?')
    parser.add_argument('--from', dest='source')
    parser.add_argument('--drain', action='store_true')
    parser.add_argument('--reply', action='store_true', help='request one explicit result reply')
    parser.add_argument('--enable', action='store_true', help='enable the sidebar queue drain for this checkout')
    args = parser.parse_args()
    if args.enable:
        DATA.mkdir(parents=True, exist_ok=True)
        (DATA / 'routing.json').write_text(json.dumps({'script': str(Path(__file__).resolve())}))
        print(json.dumps({'state': 'enabled', 'script': str(Path(__file__).resolve())}))
        return
    if not args.drain and (not args.project or not args.text):
        parser.error('project 와 작업 메시지가 필요합니다.')
    DATA.mkdir(parents=True, exist_ok=True)
    with (DATA / 'routing.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if args.drain:
                return
            raise ValueError('다른 작업을 전달 중입니다. 전송하지 않았으니 잠시 후 다시 실행하세요.')
        pending = json.loads(QUEUE.read_text()).get('requests', []) if QUEUE.exists() else []
        if args.drain and not pending:
            return
        spaces, live = snapshot()
        if args.drain:
            for request in list(pending):
                if request.get('hold'):
                    continue
                try:
                    result = deliver_pending(request, pending, spaces, live)
                except (ValueError, OSError, subprocess.SubprocessError):
                    continue
                print(json.dumps(result, ensure_ascii=False), flush=True)
                if result['state'] == 'sent':
                    # The sent request is already removed on disk, even if this fails.
                    spaces, live = snapshot()
        else:
            request = {'id': uuid.uuid4().hex[:10], 'source': source_address(args.source),
                       'project': args.project, 'text': args.text, 'reply': args.reply, 'at': int(time.time()*1000)}
            if len(pending) >= 64:
                raise ValueError('대기 요청 64건이 차 있어 새 요청을 넣지 않았습니다.')
            pending.append(request)
            result = deliver_pending(request, pending, spaces, live)
            print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))
        raise SystemExit(1)
