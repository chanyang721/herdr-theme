#!/usr/bin/env python3
"""Exercise the real mod in an existing disposable session (never user documents).

The session directory must contain env.json, app/, pins.json, project/, and the
doc-tabs-native-driver.js mod. Usage: python3 tests/native_doc_tabs.py /tmp/...
Receipts and native shots stay in that disposable directory.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def main():
    base = Path(sys.argv[1]).resolve()
    if base.parent != Path('/tmp').resolve() or not base.name.startswith('docs-tabs-'):
        raise ValueError('Use only the disposable docs-tabs session')
    env = {**os.environ, **json.loads((base/'env.json').read_text())}
    if Path(env['HERDR_APP_HOME']).resolve() != base/'app':
        raise ValueError('Disposable app home required')
    receipts = []

    def wait(label, predicate):
        start = time.monotonic()
        while time.monotonic() - start < 12:
            try:
                state = json.loads((base/'state.json').read_text())
                if predicate(state):
                    receipts.append({'case': label, 'seconds': round(time.monotonic()-start, 3)})
                    return state
            except (OSError, ValueError):
                pass
            time.sleep(.1)
        raise AssertionError(label)

    def shot(name):
        subprocess.run(['herdr-app', 'shot', str(base/f'{name}.png')], env=env, check=True, capture_output=True)

    def command(**value):
        (base/'command.json').write_text(json.dumps({'sequence': time.time_ns(), **value}))

    source = base/'project/table.md'
    original = source.read_text()
    wait('initial native Markdown and image staging', lambda s: s.get('blocks') == 3 and not s.get('error'))
    shot('native-table-image')
    temporary = source.with_suffix('.next')
    temporary.write_text(original + '\n\nATOMIC-SAVE-VERIFIED\n')
    temporary.replace(source)
    wait('atomic rename reload', lambda s: 'ATOMIC-SAVE-VERIFIED' in (s.get('text') or ''))
    source.unlink()
    wait('missing source keeps last successful body', lambda s: s.get('error') and 'ATOMIC-SAVE-VERIFIED' in (s.get('text') or ''))
    shot('native-missing')
    source.write_text(original)
    wait('source restore recovers', lambda s: not s.get('error') and s.get('text') == original)
    first = base/'project/20261101_결정요청.md'; first.write_text('# 이전 결정 요청\n')
    config = json.loads((base/'pins.json').read_text())
    config['spaces']['test']['pins'].append({'id':'latest','kind':'latest','label':'결정 요청','root':str(first.parent),'topic':'결정요청.md','recursive':False})
    (base/'pins.json').write_text(json.dumps(config))
    command(refresh=True)
    wait('new topic tab appears', lambda s: any(d['id']=='latest' for d in s.get('documents', [])))
    command(select='latest')
    wait('select dated topic', lambda s: s.get('text') == first.read_text())
    latest = first.parent/'20261102_결정요청.md'; latest.write_text('# 최신 결정 요청\n')
    wait('new date follows stable topic', lambda s: s.get('text') == latest.read_text() and s.get('selected')=='latest')
    shot('native-latest')
    collision = first.parent/'2026-11-02_결정요청.md'; collision.write_text('# 충돌\n')
    wait('same date conflict preserves successful body', lambda s: s.get('error')=='same_date_conflict' and s.get('text')==latest.read_text())
    shot('native-conflict')
    collision.unlink()
    wait('conflict removal recovers', lambda s: not s.get('error') and s.get('text')==latest.read_text())
    latest.write_text('# 긴 문서\n' + 'x'*400001)
    wait('large document is truncated explicitly', lambda s: s.get('truncated') is True)
    # Restore fixtures before the restart/persistence check.
    latest.write_text('# 최신 결정 요청\n')
    state = wait('restored latest', lambda s: not s.get('truncated') and s.get('text')==latest.read_text())
    subprocess.run(['herdr-app','do','app.quit'],env=env,check=True,capture_output=True)
    cmd = ['/usr/bin/open','-n','-g','-a','/Applications/Herdr.app']
    for key, value in json.loads((base/'env.json').read_text()).items():
        cmd += ['--env', f'{key}={value}']
    cmd += ['--stdout', str(base/'restart.log'), '--stderr', str(base/'restart.log')]
    subprocess.run(cmd,check=True)
    wait('app restart restores selection and content', lambda s: s.get('selected')=='latest' and s.get('lastSuccess',0)>state['lastSuccess'])
    shot('native-restarted')
    (base/'receipt.json').write_text(json.dumps(receipts,indent=2))
    print(json.dumps({'passed':len(receipts),'receipt':str(base/'receipt.json')},ensure_ascii=False))


if __name__ == '__main__':
    main()
