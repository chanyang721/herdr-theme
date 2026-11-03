#!/usr/bin/env python3
"""Conservatively observe idle temporary spaces. Dry-run by default; never deletes worktrees."""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import unicodedata

BASE = Path.home() / 'Library/Application Support/LukukuWatch'
DECISION = re.compile(r'승인\s*대기|확인\s*필요|결정\s*대기|사용자.{0,12}(?:확인|승인).{0,8}(?:대기|기다)|awaiting\s+(?:approval|confirmation)|waiting\s+for\s+(?:your|user)\s+(?:approval|confirmation)|allow\s+(?:once|always)', re.I)
PLACEHOLDERS = {'', 'Ask Codex to do anything', 'Write tests for @filename', 'Implement {feature}', 'Find and fix a bug in @filename', 'Explain this codebase', 'Improve documentation in @filename', 'Summarize recent commits', 'Use /skills to list available skills'}
AGENTS = {'codex', 'claude', 'claude-code'}


def run(argv, *, timeout=12):
    result = subprocess.run([str(v) for v in argv], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'{Path(str(argv[0])).name} {argv[1:2]} exited {result.returncode}: {result.stderr.strip()[:180]}')
    return result.stdout


def load(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return default


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f'.{os.getpid()}.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
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
    footer = re.compile(r'^(?:GPT-|Claude|[←↳]|voice\b|mic\b|codex\b|[▁▂▃▄▅▆▇█]|⚠|⏵|\?\s|\d+%\s+context|f\d+\b|for agents|.*weekly limit|.*auto mode|.*shift\+tab|.*esc to interrupt)', re.I)
    return all(not line.strip() or footer.match(line.strip()) for line in lines[i + 1:])


def process_rows():
    rows = {}
    for line in run(['ps', '-axo', 'pid=,ppid=,comm=']).splitlines():
        pid, parent, name = line.strip().split(None, 2)
        rows[int(pid)] = {'pid': int(pid), 'parent': int(parent), 'name': Path(name).name}
    return rows


def process_evidence(terminal, processes):
    root = terminal.get('pid')
    if not isinstance(root, int) or root not in processes or not terminal.get('foreground'):
        return False, 'process evidence unavailable', []
    family, pending = set(), [root]
    while pending:
        pid = pending.pop()
        if pid in family:
            continue
        family.add(pid)
        pending.extend(p for p, info in processes.items() if info['parent'] == pid)
    # The parent shell and idle CLI/wrapper are expected. Every other descendant
    # (including shells, tool servers and unknown helpers) blocks cleanup.
    extra = [processes[p]['name'] for p in family if p != root and processes[p]['name'] not in AGENTS | {'expect'}]
    if extra:
        return False, 'running/unknown child processes: ' + ', '.join(sorted(set(extra))), sorted(family)
    if not any(processes[p]['name'] in AGENTS for p in family):
        return False, 'agent process identity unverified', sorted(family)
    return True, '', sorted(family)


class Live:
    def __init__(self, app, core):
        self.app, self.core = app, core

    def snapshot(self):
        status = json.loads(run([self.app, 'status']))
        spaces = json.loads(run([self.app, 'ls']))['spaces']
        listing = json.loads(run([self.core, 'ls', '--all', '--json']))['terminals']
        terminals = {item['address']: json.loads(run([self.core, 'get', item['address'], '--json'])) for item in listing if item.get('state') == 'live'}
        return {'status': status, 'spaces': spaces, 'terminals': terminals, 'processes': process_rows()}

    def screen(self, address):
        value = json.loads(run([self.core, 'read', address, '--json', '--lines', '0']))
        if not value.get('complete') or value.get('how') != 'screen' or not isinstance(value.get('text'), str):
            raise RuntimeError('complete visible screen unavailable')
        return value['text']

    def backend(self, terminal, config):
        from space_job_evidence import check_jobs
        return check_jobs(terminal, config)

    def close(self, space_id):
        return run([self.app, 'do', 'space.close', json.dumps({'id': space_id, 'confirmed': True})])

    def notify(self, address, message):
        return run([self.core, 'send', address, message])


def focus(status):
    return tuple(status.get(k) for k in ('space', 'tab', 'focused_pane'))


def fixed(space, config):
    if space.get('name', '').casefold() in {x.casefold() for x in config.get('fixed_names', [])}:
        return True
    return any(item.get('id') == space.get('id') and item.get('machine') == space.get('machine') for item in config.get('fixed_spaces', []))


def inspect(space, snapshot, adapter, config):
    reasons, evidence, screens = [], [], []
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
        jobs_ok, jobs_reason, jobs_fingerprint = adapter.backend(terminal, config)
        if not jobs_ok:
            reasons.append(f'{address}: {jobs_reason}')
        text = adapter.screen(address)
        if DECISION.search(text):
            reasons.append(f'{address}: user decision pending')
        if not empty_prompt(text, agent):
            reasons.append(f'{address}: empty input unverified')
        screens.append(text)
        evidence.append([address, terminal.get('pid'), terminal.get('status_ms'), terminal.get('turn'), pids, jobs_fingerprint, hashlib.sha256(text.encode()).hexdigest()])
    fingerprint = hashlib.sha256(json.dumps(evidence, sort_keys=True).encode()).hexdigest()
    return {'id': space['id'], 'name': space['name'], 'safe': not reasons, 'reasons': reasons, 'fingerprint': fingerprint,
            'folders': sorted({t.get('cwd') for a, t in all_terms.items() if a in addresses and t.get('cwd')} | ({space['folder']} if space.get('folder') else set())),
            'summary': '\n'.join('\n'.join(s.splitlines()[-8:]) for s in screens)[:2400]}


def git_info(folder):
    info = {'folder': folder}
    for key, args in [('branch', ['branch', '--show-current']), ('commits', ['log', '-3', '--oneline']), ('remaining_uncommitted', ['status', '--short']), ('worktrees', ['worktree', 'list', '--porcelain'])]:
        try:
            info[key] = run(['git', '-C', folder, *args]).strip()[:16000]
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
            info[key] = f'unverified: {exc}'
    return info


def record_space(item, report_dir, now):
    stamp = dt.datetime.fromtimestamp(now).astimezone()
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '-', unicodedata.normalize('NFC', item['name'])).replace(' ', '-')[:90] or 'workspace'
    path = Path(report_dir) / f'{stamp:%Y%m%d}_{name}.md'
    path.parent.mkdir(parents=True, exist_ok=True)
    line = f'\n- 자동 정리 시각: {stamp.isoformat()} · space {item["id"]}\n'
    if path.exists():
        with path.open('a') as file:
            file.write(line)
    else:
        details = [git_info(folder) for folder in item.get('folders', [])]
        with path.open('x') as file:
            file.write(f'# {item["name"]} 자동 정리 기록\n\n- 공간: {item["id"]}\n')
            file.write('\n마지막 화면 일부(관측 자료):\n\n' + '\n'.join('> ' + v for v in item.get('summary', '').splitlines()) + '\n')
            file.write('\n폴더·브랜치·최근 커밋·남은 미커밋·worktree 목록(삭제하지 않음):\n\n```json\n' + json.dumps(details, ensure_ascii=False, indent=2) + '\n```\n' + line)
    return str(path)


def cycle(adapter, config, state, now, *, apply=False, only_space=None, report_dir=None):
    snapshot = adapter.snapshot()
    previous = state.get('spaces', {})
    gap = now - state.get('last_at', now)
    fresh = 0 <= gap <= config.get('max_sample_gap_seconds', 660)
    trial = state.get('trial', {}) if fresh else {}
    trial = {'started_at': trial.get('started_at', now), 'samples': trial.get('samples', 0) + 1,
             'error_count': trial.get('error_count', 0)}
    trial_ok = now - trial['started_at'] >= config.get('trial_seconds', 1800) and trial['samples'] >= 7 and trial['error_count'] == 0
    reviewed = isinstance(config.get('reviewed_dry_run_at'), (int, float)) and config['reviewed_dry_run_at'] >= trial['started_at'] + config.get('trial_seconds', 1800) and config.get('reviewed_observer_sha256') == state.get('observer_sha256')
    result, tracking = [], {}
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
        if item['safe'] and quiet >= config.get('idle_seconds', 600):
            item['action'] = 'would_close'
            if apply and not trial_ok:
                item['action'] = 'keep'
                item['reasons'].append('30-minute dry-run review not complete')
            elif apply and not reviewed:
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
                        item['record'] = record_space(item, report_dir, now)
                        adapter.close(space['id'])
                        after = adapter.snapshot()
                        if any(s['id'] == space['id'] for s in after['spaces']):
                            raise RuntimeError('space.close not confirmed')
                        if focus(after['status']) != initial_focus:
                            raise RuntimeError('focus changed after close; further cleanup stopped')
                        item['action'] = 'closed'
                        del tracking[space['id']]
        elif item['safe']:
            item['reasons'].append('idle/output-stable observation window incomplete')
        if apply and trial_ok and reviewed and any('user decision pending' in r for r in item['reasons']):
            notified = old.get('decision_notified_at', 0)
            if config.get('notify_terminal') and now - notified >= 86400:
                adapter.notify(config['notify_terminal'], f'[자동 정리 보류·사용자 결정 필요] {item["name"]}: 승인/확인 대기 문구가 있어 공간을 유지했습니다. 직접 확인해 주세요.')
                tracking[space['id']]['decision_notified_at'] = now
        result.append(item)
    state.update(last_at=now, spaces=tracking, trial=trial)
    return {'at': dt.datetime.fromtimestamp(now).astimezone().isoformat(), 'mode': 'apply' if apply else 'dry-run', 'trial': trial,
            'trial_ready': trial_ok, 'results': result, 'focus': initial_focus}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=BASE / 'close-finished-spaces.json')
    parser.add_argument('--state', type=Path, default=BASE / 'close-finished-spaces-state.json')
    parser.add_argument('--log', type=Path, default=BASE / 'close-finished-spaces.jsonl')
    parser.add_argument('--report-dir', type=Path, default=Path.home() / 'Documents/LukukuReports/워크스페이스-기록')
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--dry-run', action='store_true')
    group.add_argument('--apply', action='store_true')
    parser.add_argument('--only-space')
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
    state = load(args.state, {})
    observer_hash = hashlib.sha256(Path(__file__).read_bytes() + Path(__file__).with_name('space_job_evidence.py').read_bytes()).hexdigest()
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
    main()
