import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location('collaborate', SCRIPTS / 'collaborate.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def fixture():
    return ([{'id': 'share', 'name': 'Share', 'tabs': [{'terminals': [{'terminal': 's'}]}]},
             {'id': 'p', 'name': 'FutureProject', 'tabs': [{'terminals': [
                 {'terminal': who} for who in ('origin', 'helper1', 'helper2')]}]}],
            {who: {'address': who, 'state': 'live', 'agent': 'codex', 'status': 'idle'}
             for who in ('origin', 'helper1', 'helper2', 's')})


class CollaborateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        self.patchers = [patch.object(c, 'DATA', self.data), patch.object(c, 'snapshot', side_effect=fixture),
                         patch.dict(os.environ, {'HC_TERMINAL_ID': 'origin'}),
                         patch.object(c.site_config, 'load', return_value={**c.site_config.DEFAULTS, 'hub_space_ids': ['sp-share']})]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)
        self.sent = []
        def fake_call(argv, source=None):
            if argv[1] == 'get':
                return 0, {'state': 'live', 'status': {'state': 'idle'}}
            if argv[1] == 'read':
                return 0, {'text': '• 완료했습니다.\n› Ask Codex to do anything'}
            self.sent.append(argv)
            return 0, {'started': True}
        p = patch.object(c, 'call', side_effect=fake_call)
        p.start()
        self.addCleanup(p.stop)

    def add(self, task_id, mode='read-only', owns=''):
        return c.enqueue(argparse.Namespace(id=task_id, source=None, text='Count README lines', mode=mode,
                                            owns=owns, batch='one'))

    def transition(self, task, action, who, **kwargs):
        with patch.dict(os.environ, {'HC_TERMINAL_ID': who}):
            return c.transition(argparse.Namespace(id=task['id'], source=None, action=action,
                lease=kwargs.get('lease', task.get('lease')), result='42 lines'))

    def test_thresholds_each_independently_and_unknown_is_not_inferred(self):
        now = time.time()
        tasks = [self.add('a')]
        self.assertFalse(c.thresholds(tasks, 'origin', c.DEFAULTS, now)['overloaded'])
        self.assertTrue(c.thresholds(tasks, 'origin', c.DEFAULTS, now + 601)['overloaded'])
        tasks.append(self.add('b'))
        self.assertTrue(c.thresholds(tasks, 'origin', c.DEFAULTS, now)['overloaded'])
        tasks = [{'source': 'origin', 'state': 'local_active'} for _ in range(3)]
        self.assertTrue(c.thresholds(tasks, 'origin', c.DEFAULTS, now)['overloaded'])

    def test_share_excluded_new_projects_included(self):
        self.add('a')
        with patch.dict(os.environ, {'HC_TERMINAL_ID': 's'}), self.assertRaises(ValueError):
            self.add('b')

    def test_same_task_id_idempotent_and_no_source_steal(self):
        original = self.add('a')
        self.assertEqual(original, self.add('a'))
        with patch.dict(os.environ, {'HC_TERMINAL_ID': 'helper1'}), self.assertRaises(ValueError):
            self.add('a')

    def test_write_requires_ownership_and_message_protects_shared_checkout(self):
        with self.assertRaises(ValueError):
            self.add('a', 'worktree')
        task = self.add('a', 'worktree', 'src/feature/**')
        body = c.instruction(task, 'helper1', 'token')
        self.assertIn('별도 worktree 사용 필수', body)
        self.assertIn('src/feature/**', body)
        self.assertIn('실행 전에 수락', body)

    def test_two_helpers_protocol_to_single_origin_report_no_duplicates(self):
        self.add('a')
        self.add('b')
        self.assertEqual(len(c.drain()), 2)
        self.assertEqual({a[2] for a in self.sent}, {'helper1', 'helper2'})
        for _ in range(3):
            self.assertEqual(c.drain(), [])
        for task in c.load()['tasks'].values():
            self.transition(task, 'accept', task['target'])
            self.transition(task, 'complete', task['target'])
        args = argparse.Namespace(source=None, batch='one')
        self.assertEqual(c.report(args)['state'], 'reported')
        self.assertEqual(c.report(args)['state'], 'already_reported')
        self.assertEqual(len(self.sent), 2)
        self.assertEqual(len(c.load()['reports']), 1)

    def test_only_leased_receiver_can_accept_complete(self):
        self.add('a'); self.add('b'); c.drain()
        task = c.load()['tasks']['a']
        with self.assertRaises(ValueError):
            self.transition(task, 'accept', 'origin')
        with self.assertRaises(ValueError):
            self.transition(task, 'accept', task['target'], lease='bad')
        with self.assertRaises(ValueError):
            self.transition(task, 'complete', task['target'])
        self.transition(task, 'accept', task['target'])
        self.transition(task, 'complete', task['target'])
        self.transition(task, 'complete', task['target'])

    def test_leased_task_cannot_start_locally(self):
        self.add('a'); self.add('b'); c.drain()
        with self.assertRaises(ValueError):
            self.transition(c.load()['tasks']['a'], 'start', 'origin')

    def test_local_start_reduces_pending_and_completes_as_source(self):
        task = self.add('a')
        self.transition(task, 'start', 'origin')
        self.transition(task, 'complete', 'origin')
        self.assertEqual(c.load()['tasks']['a']['state'], 'completed')

    def test_ambiguous_send_never_retries_or_expires(self):
        self.add('a'); self.add('b')
        old_call = c.call.side_effect
        def unknown(argv, source=None):
            if argv[1] == 'send':
                self.sent.append(argv)
                raise subprocess.TimeoutExpired(argv, 1)
            return old_call(argv, source)
        c.call.side_effect = unknown
        c.drain()
        self.assertEqual({t['state'] for t in c.load()['tasks'].values()}, {'uncertain'})
        c.drain()
        self.assertEqual(len(self.sent), 2)

    def test_draft_voice_question_or_busy_is_never_sent(self):
        for screen in ('› unfinished draft', '● REC\n❯', 'voice ● listening\n❯', '진행할까요?\n❯'):
            self.assertFalse(c.route.receiver_available(screen))
        facts = fixture()[1]
        facts['helper1']['status'] = 'working'
        self.assertFalse(c.receiver('helper1', {}, facts, set()))

    def test_done_without_atomic_guard_is_held(self):
        c.call.side_effect = lambda argv, source=None: (0, {'state': 'live', 'status': {'state': 'done'}})
        self.assertFalse(c.receiver('helper1', {}, fixture()[1], set()))

    def test_done_list_with_raw_idle_is_delivered_guarded(self):
        spaces, facts = fixture()
        facts['helper1']['status'] = 'done'
        self.add('a'); self.add('b')
        with patch.object(c, 'snapshot', return_value=(spaces, facts)):
            c.drain()
        self.assertIn('helper1', {item[2] for item in self.sent})
        self.assertTrue(all(item[4:6] == ['--if', 'idle'] for item in self.sent))

    def test_overlapping_ownership_waits_while_distinct_files_can_run(self):
        self.add('a', 'worktree', 'src/feature/**')
        self.add('b', 'worktree', 'src/feature/sub/file.py')
        c.drain()
        ledger = c.load()['tasks']
        self.assertEqual(ledger['a']['state'], 'sent')
        self.assertEqual(ledger['b']['state'], 'pending')
        self.assertEqual(len(self.sent), 1)
        left = dict(ledger['a'], owns='src/feat*')
        self.assertTrue(c.ownership_conflict(left, [dict(ledger['b'], owns='src/feature.py')]))
        self.assertFalse(c.ownership_conflict(left, [dict(ledger['b'], owns='tests/test.py')]))
        with self.assertRaises(ValueError):
            self.add('c', 'worktree', 'src/../escape')

    def test_no_helper_keeps_queue_without_new_session(self):
        self.add('a'); self.add('b')
        spaces, facts = fixture()
        for fact in facts.values():
            fact['status'] = 'working'
        with patch.object(c, 'snapshot', return_value=(spaces, facts)):
            self.assertEqual(c.drain(), [])
        self.assertEqual(len(self.sent), 0)
        self.assertEqual({t['state'] for t in c.load()['tasks'].values()}, {'pending'})

    def test_corrupt_ledger_and_orphan_lease_fail_closed(self):
        self.add('a'); self.add('b')
        c.lease_path('a').parent.mkdir()
        c.lease_path('a').write_text('{}')
        c.drain()
        self.assertEqual(c.load()['tasks']['a']['state'], 'uncertain')
        (self.data / 'collaboration-tasks.json').write_text('broken')
        with self.assertRaises(ValueError):
            c.drain()

    def test_custom_exclusions_cannot_allow_share(self):
        c.atomic(self.data / 'collaboration.json', {'exclude_spaces': []})
        with patch.dict(os.environ, {'HC_TERMINAL_ID': 's'}), self.assertRaises(ValueError):
            self.add('share-task')
        self.assertIn('sp-share', c.config()['exclude_spaces'])

    def test_closed_batch_rejects_new_tasks_but_existing_id_remains_idempotent(self):
        task = self.add('a')
        self.transition(task, 'start', 'origin')
        self.transition(task, 'complete', 'origin')
        c.report(argparse.Namespace(source=None, batch='one'))
        self.assertEqual(self.add('a')['state'], 'completed')
        with self.assertRaises(ValueError):
            self.add('b')
        self.assertEqual(set(c.load()['tasks']), {'a'})

    def test_existing_id_cannot_move_to_another_batch(self):
        self.add('a')
        with self.assertRaises(ValueError):
            c.enqueue(argparse.Namespace(id='a', source=None, text='Count README lines',
                mode='read-only', owns='', batch='different'))
        self.assertEqual(c.load()['tasks']['a']['batch'], 'one')

    def test_cli_identity_mismatch_rejected(self):
        with self.assertRaises(ValueError):
            c.actor('helper1')


class SubprocessProtocolTests(unittest.TestCase):
    def test_persisted_cli_e2e_two_receivers(self):
        with tempfile.TemporaryDirectory(prefix='collaboration-e2e-') as directory:
            home = Path(directory)
            tools = home / 'bin'; tools.mkdir()
            fake = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args=sys.argv[1:]
if Path(sys.argv[0]).name=='herdr-app':
 print(json.dumps({'spaces':[{'id':'p','name':'FixtureProject','tabs':[{'terminals':[{'terminal':x} for x in ['origin','helper1','helper2']]}]}]}))
elif args[0]=='ls':
 print(json.dumps({'terminals':[{'address':x,'state':'live','agent':'codex','status':'idle'} for x in ['origin','helper1','helper2']]}))
elif args[0]=='get': print(json.dumps({'state':'live','status':{'state':'idle'}}))
elif args[0]=='read': print(json.dumps({'text':'완료했습니다.\\n› Ask Codex to do anything'}))
elif args[0]=='send':
 with open(os.environ['SEND_LOG'],'a') as f: f.write(json.dumps({'target':args[1],'text':args[-1]})+'\\n')
 print(json.dumps({'started':True,'turn':1}))
else: sys.exit(2)
'''
            for name in ('hc', 'herdr-app'):
                p = tools / name; p.write_text(fake); p.chmod(0o755)
            env = {**os.environ, 'PATH': str(tools) + os.pathsep + os.environ['PATH'],
                   'HERDR_APP_HOME': str(home), 'HC_TERMINAL_ID': 'origin', 'SEND_LOG': str(home / 'sends.jsonl')}
            script = str(SCRIPTS / 'collaborate.py')
            history = []
            def cli(*args, who='origin'):
                result = subprocess.run([sys.executable, script, *args], env={**env, 'HC_TERMINAL_ID': who},
                                        text=True, capture_output=True, check=True)
                value = json.loads(result.stdout)
                history.append({'actor': who, 'argv': list(args), 'result': value})
                return value
            for task_id in ('count1', 'count2'):
                cli('enqueue', '--id', task_id, '--batch', 'counts', '--mode', 'read-only', '--text', 'count lines')
            self.assertEqual(len(cli('drain')), 2)
            cli('drain')
            tasks = cli('status')['tasks']
            for task in tasks.values():
                cli('accept', task['id'], '--lease', task['lease'], who=task['target'])
                cli('complete', task['id'], '--lease', task['lease'], '--result', '12 lines', who=task['target'])
            first = cli('report', '--batch', 'counts')
            second = cli('report', '--batch', 'counts')
            self.assertEqual(first['state'], 'reported')
            self.assertEqual(second['state'], 'already_reported')
            self.assertNotIn('text', second)
            sends = [json.loads(line) for line in (home / 'sends.jsonl').read_text().splitlines()]
            self.assertEqual(len(sends), 2)
            self.assertEqual(len({s['target'] for s in sends}), 2)
            self.assertEqual(len(cli('status')['reports']), 1)
            evidence = os.environ.get('COLLABORATION_E2E_EVIDENCE')
            if evidence:
                Path(evidence).write_text(json.dumps({'transport': 'isolated subprocess CLI fixture; not live user sessions',
                    'history': history, 'sends': sends, 'send_count': 2, 'duplicate_count': 0,
                    'origin_report_count': 1}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    unittest.main()
