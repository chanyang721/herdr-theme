#!/usr/bin/env python3
"""Exercise real isolated hc delivery with deterministic read-only protocol workers.

The workspace inventory is a fixture; hc send/get/read and worker receipt are real.
Never connects to the user's core, app, or agent sessions.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    repo = Path(__file__).resolve().parents[1]
    output = Path(sys.argv[1])
    real_hc = shutil.which('hc')
    with tempfile.TemporaryDirectory(prefix='hcc-', dir='/tmp') as temporary:
        base = Path(temporary)
        tools = base / 'bin'; tools.mkdir()
        env = {**os.environ, 'HC_SESSION': 'c',
               'XDG_STATE_HOME': str(base / 'state'), 'XDG_CONFIG_HOME': str(base / 'config'),
               'XDG_RUNTIME_DIR': str(base / 'run'), 'HERDR_APP_HOME': str(base / 'app'),
               'PATH': str(tools) + os.pathsep + os.environ['PATH']}
        env.pop('HC_TERMINAL_ID', None)
        env.pop('HERDR_PANE_ID', None)
        (base / 'run').mkdir(mode=0o700)
        (base / 'app').mkdir()
        worker = base / 'worker.py'
        worker.write_text('''import json,os,re,subprocess,sys,termios,tty
from pathlib import Path
fd=sys.stdin.fileno();tty.setraw(fd)
def emit(state):
 sys.stdout.write('\\x1b]7501;state='+state+':app=codex\\x1b\\\\');sys.stdout.flush()
emit('idle');sys.stdout.write('\\x1b[?2004h\\r\\n› Ask Codex to do anything');sys.stdout.flush()
data=b''
while True:
 data+=os.read(fd,65536)
 if b'\\x1b[201~' not in data:continue
 text=data.split(b'\\x1b[200~')[-1].split(b'\\x1b[201~')[0].decode()
 data=b'';emit('working')
 match=re.search(r'\\[과부하 협업 ([^]]+)\\]',text)
 token=re.search(r'--lease ([a-f0-9]+)',text)
 if not match or not token:continue
 task=match.group(1);lease=token.group(1)
 cmd=[sys.executable,os.environ['COLLAB_SCRIPT']]
 accepted=subprocess.run(cmd+['accept',task,'--lease',lease],capture_output=True,text=True)
 result={'id':task,'accepted':accepted.returncode==0,'actor':os.environ.get('HC_TERMINAL_ID')}
 if accepted.returncode==0:
  count=len(Path(os.environ['COUNT_FILE']).read_text().splitlines())
  completed=subprocess.run(cmd+['complete',task,'--lease',lease,'--result',str(count)+' lines'],capture_output=True,text=True)
  result.update(lines=count,completed=completed.returncode==0)
 with open(os.environ['WORKER_LOG'],'a') as f:f.write(json.dumps(result)+'\\n')
 emit('idle');sys.stdout.write('\\r\\n완료했습니다.\\r\\n› Ask Codex to do anything');sys.stdout.flush()
''')
        env.update(COLLAB_SCRIPT=str(repo / 'scripts/collaborate.py'), COUNT_FILE=str(repo / 'README.md'),
                   WORKER_LOG=str(base / 'receipts.jsonl'))
        inventory = tools / 'herdr-app'
        inventory.write_text('#!' + sys.executable + '\nfrom pathlib import Path\nprint(Path(' + repr(str(base / 'inventory.json')) + ').read_text())\n')
        inventory.chmod(0o755)
        history = []
        def run(argv, actor=None):
            result = subprocess.run(argv, env={**env, **({'HC_TERMINAL_ID': actor} if actor else {})},
                                    capture_output=True, text=True, timeout=20)
            if result.returncode:
                raise RuntimeError(str(argv[:4]) + ': ' + result.stderr + result.stdout)
            return json.loads(result.stdout)
        addresses = []
        try:
            run([real_hc, 'server', 'start'])
            for name in ('origin', 'helper1', 'helper2'):
                value = run([real_hc, 'run', '--bg', '--no-parent', '--no-notify', '--name', name,
                             sys.executable, str(worker)])
                address = value.get('address') or value.get('terminal', {}).get('address')
                if not address:
                    raise RuntimeError('Unknown run result: ' + repr(value))
                addresses.append(address)
            (base / 'inventory.json').write_text(json.dumps({'spaces': [{'id': 'isolated-project',
                'name': 'IsolatedProject', 'tabs': [{'terminals': [{'terminal': a} for a in addresses]}]}]}))
            for address in addresses:
                run([real_hc, 'wait', address, '--timeout', '5'])
                fact = run([real_hc, 'get', address])
                if fact.get('status', {}).get('state') != 'idle':
                    raise RuntimeError('Worker is not idle: ' + repr(fact))
            origin = addresses[0]
            def cli(*args):
                result = run([sys.executable, str(repo / 'scripts/collaborate.py'), *args], origin)
                history.append({'argv': list(args), 'result': result})
                return result
            for task in ('native-count-1', 'native-count-2'):
                cli('enqueue', '--id', task, '--batch', 'native-counts', '--mode', 'read-only',
                    '--text', 'Read README.md and count its lines. No file modifications.')
            delivered = cli('drain')
            assert len(delivered) == 2, delivered
            # Waiting on these isolated workers never touches user sessions.
            for address in addresses[1:]:
                run([real_hc, 'wait', address, '--timeout', '10'])
            ledger = cli('status')
            assert all(t['state'] == 'completed' for t in ledger['tasks'].values()), ledger
            assert cli('drain') == []
            first = cli('report', '--batch', 'native-counts')
            second = cli('report', '--batch', 'native-counts')
            assert first['state'] == 'reported' and second['state'] == 'already_reported'
            receipts = [json.loads(line) for line in (base / 'receipts.jsonl').read_text().splitlines()]
            assert len(receipts) == 2 and all(r['accepted'] and r['completed'] for r in receipts), receipts
            evidence = {'kind': 'real isolated hc; fixture workspace inventory; deterministic protocol workers',
                        'session': env['HC_SESSION'], 'addresses': addresses, 'history': history,
                        'worker_receipts': receipts, 'expected_lines': len((repo / 'README.md').read_text().splitlines()),
                        'send_count': 2, 'duplicate_count': 0, 'origin_report_count': 1}
            output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
            print(json.dumps({'evidence': str(output), 'duplicate_count': 0, 'origin_report_count': 1}))
        finally:
            for address in addresses:
                subprocess.run([real_hc, 'kill', address], env=env, capture_output=True, timeout=10)
                subprocess.run([real_hc, 'rm', address], env=env, capture_output=True, timeout=10)
            subprocess.run([real_hc, 'server', 'stop'], env=env, capture_output=True, timeout=10)


if __name__ == '__main__':
    main()
