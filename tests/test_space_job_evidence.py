import copy
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('space_job_evidence', Path(__file__).parents[1]/'scripts/space_job_evidence.py')
jobs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jobs)
STAMP = 1_790_000_000_000


def event(kind):
    return {'type': 'event_msg', 'payload': {'type': kind}}


def call(identity, name, arguments):
    return {'type': 'response_item', 'payload': {'type': 'function_call', 'call_id': identity, 'name': name, 'arguments': arguments}}


def output(identity, value):
    return {'type': 'response_item', 'payload': {'type': 'function_call_output', 'call_id': identity, 'output': value}}


def completed():
    return [event('task_started'), event('task_complete')]


class CodexJobEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.db = self.root/'state.sqlite'
        with sqlite3.connect(self.db) as c:
            c.execute('create table threads(id text primary key, rollout_path text)')
            c.execute('create table thread_spawn_edges(parent_thread_id text, child_thread_id text, status text)')
        self.terminal = {'address': 'fixture-terminal', 'pid': 100, 'created_ms': STAMP-100_000, 'status_ms': STAMP,
                         'status': {'app': 'codex', 'state': 'done'}}
        self.config = {'codex_db': str(self.db), 'sessions': {'fixture-terminal': {
            'pid': 100, 'created_ms': STAMP-100_000, 'session_id': 'main-session', 'agent': 'codex'}}}
        self.log('main-session', completed())

    def log(self, session, records):
        path = self.root/(session+'.jsonl')
        path.write_text(''.join(json.dumps(r)+'\n' for r in [
            {'type': 'session_meta', 'payload': {'id': session}}, *records]))
        os.utime(path, (STAMP/1000, STAMP/1000))
        with sqlite3.connect(self.db) as c:
            c.execute('insert or replace into threads values(?,?)', (session, str(path)))
        return path

    def child(self, records=None, edge='open', name='child-session', parent='main-session'):
        self.log(name, completed() if records is None else records)
        with sqlite3.connect(self.db) as c:
            c.execute('insert into thread_spawn_edges values(?,?,?)', (parent, name, edge))

    def check(self):
        return jobs.check_jobs(self.terminal, self.config)

    def hold(self, reason=None):
        safe, why, fingerprint = self.check()
        self.assertFalse(safe, why)
        self.assertTrue(why)
        self.assertEqual(len(fingerprint), 64)
        if reason:
            self.assertIn(reason, why)

    def test_complete_main_without_children_has_stable_fingerprint(self):
        result = self.check()
        self.assertTrue(result[0], result)
        self.assertEqual(result, self.check())
        self.log('main-session', [*completed(), {'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant', 'content': []}}])
        self.assertNotEqual(result[2], self.check()[2])

    def test_missing_or_reused_pid_created_session_agent_mapping_holds(self):
        for key, value in [('pid', 101), ('created_ms', STAMP), ('session_id', 'other-session'), ('agent', 'claude')]:
            with self.subTest(key=key):
                original = copy.deepcopy(self.config)
                self.config['sessions']['fixture-terminal'][key] = value
                self.hold()
                self.config = original
        self.config['sessions'].clear()
        self.hold('mapping missing')

    def test_missing_db_schema_rollout_or_status_timestamp_holds(self):
        original = self.config['codex_db']
        self.config['codex_db'] = str(self.root/'absent.sqlite')
        self.hold('database missing')
        self.config['codex_db'] = original
        (self.root/'main-session.jsonl').unlink()
        self.hold('unreadable')
        self.log('main-session', completed())
        self.terminal.pop('status_ms')
        self.hold('timestamp missing')

    def test_freshness_rejects_five_second_old_main_mapping(self):
        path = self.root/'main-session.jsonl'
        os.utime(path, ((STAMP-5000)/1000, (STAMP-5000)/1000))
        self.hold('stale')
        os.utime(path, ((STAMP-4999)/1000, (STAMP-4999)/1000))
        self.assertTrue(self.check()[0])

    def test_incomplete_oversized_wrong_identity_or_truncated_history_holds(self):
        path = self.root/'main-session.jsonl'
        data = path.read_bytes()
        for value in [data.rstrip(b'\n'), b'{invalid\n', json.dumps(event('task_complete')).encode()+b'\n']:
            path.write_bytes(value)
            self.hold()
        self.log('main-session', [{'type': 'event_msg', 'payload': {'type': 'task_complete', 'history_truncated': True}}])
        self.hold('truncated')
        with path.open('wb') as file:
            file.truncate(jobs.MAX_ROLLOUT_BYTES+1)
        self.hold('64 MiB')

    def test_main_or_open_child_working_or_unknown_holds(self):
        for records in [[], [event('task_started')], [*completed(), event('task_started')]]:
            self.log('main-session', records)
            self.hold('main backend task')
        self.log('main-session', completed())
        self.child([event('task_started')])
        self.hold('child task')
        self.log('child-session', [])
        self.hold('child task')

    def test_completed_or_aborted_child_can_be_verified_even_with_open_edge(self):
        self.child()
        self.assertTrue(self.check()[0])
        self.log('child-session', [event('task_started'), event('turn_aborted')])
        self.assertTrue(self.check()[0])

    def test_closed_child_background_exec_still_blocks_parent(self):
        self.child([event('task_started'), call('shell', 'exec_command', '{}'),
                    output('shell', {'session_id': 123, 'exit_code': None}), event('task_complete')], edge='closed')
        self.hold('exec sessions')

    def test_running_exec_session_requires_matched_poll_exit_not_task_completion(self):
        records = [event('task_started'), call('launch', 'exec_command', '{}'),
                   output('launch', {'session_id': 94887, 'exit_code': None}), event('task_complete')]
        self.log('main-session', records)
        self.hold('exec sessions')
        records += [call('poll', 'write_stdin', json.dumps({'session_id': 94887})),
                    output('poll', [{'type': 'input_text', 'text': json.dumps({'exit_code': 0, 'output': 'finished'})}])]
        self.log('main-session', records)
        self.assertTrue(self.check()[0], self.check())

    def test_raw_javascript_write_stdin_and_array_text_json_are_correlated(self):
        records = [event('task_started'), call('launch', 'functions.exec', 'text(await tools.exec_command({cmd:"sleep 5"}));'),
                   output('launch', [{'type': 'input_text', 'text': 'Script completed\n'},
                                     {'type': 'input_text', 'text': '{"session_id":94887,"exit_code":null}'}]),
                   call('poll', 'functions.exec', 'text(await tools.write_stdin({session_id:94887,chars:""}));'),
                   output('poll', [{'type': 'input_text', 'text': 'Script completed\n'},
                                   {'type': 'input_text', 'text': '{"exit_code":0,"output":"done"}'}]), event('task_complete')]
        self.log('main-session', records)
        self.assertTrue(self.check()[0], self.check())

    def test_unrelated_sync_exit_does_not_close_an_open_session(self):
        self.log('main-session', [event('task_started'), call('launch', 'exec_command', '{}'),
                                 output('launch', {'session_id': 1}), call('other', 'exec_command', '{}'),
                                 output('other', {'exit_code': 0}), event('task_complete')])
        self.hold('exec sessions')

    def test_program_stdout_cannot_forge_completion_of_an_unrelated_session(self):
        self.log('main-session', [event('task_started'), call('launch', 'exec_command', '{}'),
                                 output('launch', {'session_id': 1}), call('other', 'exec_command', '{}'),
                                 output('other', {'exit_code': 0, 'output': '{"session_id":1,"exit_code":0}'}),
                                 event('task_complete')])
        self.hold('exec sessions')

    def test_backend_cell_must_finish_via_matching_wait(self):
        records = [event('task_started'), call('launch', 'functions.exec', 'await tools.exec_command({cmd:"work"})'),
                   output('launch', [{'type': 'input_text', 'text': 'Script running with cell ID g32:51\n'}]), event('task_complete')]
        self.log('main-session', records)
        self.hold('execution cells')
        records += [call('wait', 'functions.wait', '{"cell_id":"g32:51"}'),
                    output('wait', [{'type': 'input_text', 'text': 'Script completed\n'},
                                    {'type': 'input_text', 'text': '{"exit_code":0}'}])]
        self.log('main-session', records)
        self.assertTrue(self.check()[0], self.check())

    def test_wait_can_finish_cell_but_reveal_still_running_exec_session(self):
        self.log('main-session', [event('task_started'), call('launch', 'functions.exec', 'await tools.exec_command({cmd:"work"})'),
                                 output('launch', 'Script running with cell ID cell-a'),
                                 call('wait', 'functions.wait', '{"cell_id":"cell-a"}'),
                                 output('wait', [{'type': 'input_text', 'text': 'Script completed\n'},
                                                 {'type': 'input_text', 'text': '{"session_id":77,"exit_code":null}'}]),
                                 event('task_complete')])
        self.hold('exec sessions')

    def test_wrong_poll_or_wait_identity_and_missing_output_hold(self):
        self.log('main-session', [event('task_started'), call('one', 'exec_command', '{}'),
                                 output('one', {'session_id': 1}), call('poll', 'write_stdin', '{"session_id":2}'),
                                 output('poll', {'session_id': 1, 'exit_code': 0}), event('task_complete')])
        self.hold('mismatch')
        self.log('main-session', [*completed(), call('missing', 'exec_command', '{}')])
        self.hold('pending')
        self.log('main-session', [*completed(), output('absent-call', {'exit_code': 0})])
        self.hold('history')

    def test_unknown_shell_output_and_closed_child_missing_log_hold(self):
        self.log('main-session', [event('task_started'), call('shell', 'exec_command', '{}'),
                                 output('shell', 'The command may still be running'), event('task_complete')])
        self.hold('result unverified')
        self.log('main-session', completed())
        self.child(edge='closed')
        (self.root/'child-session.jsonl').unlink()
        self.hold('unreadable')

    def test_completed_code_cell_mentioning_exec_command_is_a_result(self):
        self.log('main-session', [event('task_started'), call('c', 'exec', 'text(await tools.exec_command({cmd:"ls"}));'),
                                 output('c', [{'type': 'input_text', 'text': 'Script completed\nWall time 0.1 seconds\n'},
                                              {'type': 'input_text', 'text': 'Warning: truncated output (original token count: 9)\nTotal output lines: 2\n\n[{"name":"x"}]'}]),
                                 event('task_complete')])
        self.assertTrue(self.check()[0], self.check())

    def test_refused_spawn_without_output_after_task_end_is_not_work(self):
        self.child([event('task_started'), call('s', 'spawn_agent', '{}'), event('task_complete')])
        self.assertTrue(self.check()[0], self.check())
        self.child([event('task_started'), call('x', 'exec_command', '{}'), event('task_complete')], name='other-child')
        self.hold('pending backend tool calls')

    def test_open_exec_sessions_pass_only_with_a_clean_process_tree(self):
        self.log('main-session', [event('task_started'), call('l', 'exec_command', '{}'),
                                 output('l', {'session_id': 5, 'exit_code': None}), event('task_complete')])
        self.hold('exec sessions')
        self.assertTrue(jobs.check_jobs(self.terminal, self.config, process_tree_clean=True)[0])

    def test_closed_child_needs_no_finished_turn_but_its_commands_still_count(self):
        self.child([event('task_started')], edge='closed')
        self.assertTrue(self.check()[0], self.check())

    def test_child_graph_cycle_cannot_be_accepted(self):
        self.child()
        with sqlite3.connect(self.db) as c:
            c.execute('insert into thread_spawn_edges values(?,?,?)', ('child-session', 'main-session', 'open'))
        self.hold('cycle')

    def test_no_file_database_or_process_writes_are_performed(self):
        before = {p.name: p.read_bytes() for p in self.root.iterdir() if p.is_file()}
        with patch('subprocess.run', side_effect=AssertionError('must not invoke any live process')):
            self.assertTrue(self.check()[0])
        after = {p.name: p.read_bytes() for p in self.root.iterdir() if p.is_file()}
        self.assertEqual(before, after)


class ClaudeJobEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        (self.home/'sessions').mkdir()
        (self.home/'projects/fixture').mkdir(parents=True)
        self.log = self.home/'projects/fixture/claude-main.jsonl'
        (self.home/'sessions/100.json').write_text(json.dumps({'sessionId': 'claude-main', 'transcriptPath': str(self.log)}))
        self.terminal = {'address': 'claude-terminal', 'pid': 100, 'created_ms': STAMP-10000, 'status_ms': STAMP,
                         'status': {'app': 'claude', 'state': 'done'}}
        self.config = {'claude_home': str(self.home), 'sessions': {'claude-terminal': {
            'pid': 100, 'created_ms': STAMP-10000, 'session_id': 'claude-main', 'agent': 'claude'}}}
        self.write([{'sessionId': 'claude-main', 'message': {'role': 'assistant', 'stop_reason': 'end_turn', 'content': []}}])

    def write(self, records):
        self.log.write_text(''.join(json.dumps(r)+'\n' for r in records))
        os.utime(self.log, (STAMP/1000, STAMP/1000))

    def check(self):
        return jobs.check_jobs(self.terminal, self.config)

    def test_verified_completed_log_can_be_accepted(self):
        self.assertTrue(self.check()[0], self.check())

    def test_missing_process_meta_or_unknown_completion_is_unverified(self):
        (self.home/'sessions/100.json').unlink()
        self.assertFalse(self.check()[0])
        self.assertIn('backend jobs unverified', self.check()[1])

    def test_background_bash_blocks_even_after_end_turn(self):
        self.write([{'sessionId': 'claude-main', 'message': {'role': 'assistant', 'stop_reason': 'tool_use', 'content': [
            {'type': 'tool_use', 'id': 'bash', 'name': 'Bash', 'input': {'run_in_background': True}}]}},
                    {'sessionId': 'claude-main', 'message': {'role': 'assistant', 'stop_reason': 'end_turn', 'content': []}}])
        self.assertFalse(self.check()[0])
        self.assertIn('background', self.check()[1])

    def test_unfinished_or_unidentified_subagent_blocks(self):
        child_dir = self.home/'projects/fixture/claude-main/subagents'
        child_dir.mkdir(parents=True)
        (child_dir/'agent.meta.json').write_text('{"finished":false}')
        self.assertFalse(self.check()[0])
        self.assertIn('child working/unknown', self.check()[1])

    # Real Claude Code logs (2.1.x): what made every idle session "unverified" before.
    def use(self, tool_id, background=False):
        part = {'type': 'tool_use', 'id': tool_id, 'name': 'Bash', 'input': {'run_in_background': True} if background else {}}
        return {'type': 'assistant', 'sessionId': 'claude-main', 'message': {'role': 'assistant', 'stop_reason': 'tool_use', 'content': [part]}}

    def result(self, tool_id, text='ok', extra=None, error=False):
        return {'type': 'user', 'sessionId': 'claude-main', 'toolUseResult': extra or {},
                'message': {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': tool_id, 'content': text, 'is_error': error}]}}

    def end(self):
        return {'type': 'assistant', 'sessionId': 'claude-main', 'message': {'role': 'assistant', 'stop_reason': 'end_turn', 'content': []}}

    def notice(self, task, tool_id, status='completed', kind='queue-operation'):
        return {'type': kind, 'sessionId': 'claude-main',
                'content': f'<task-notification> <task-id>{task}</task-id> <tool-use-id>{tool_id}</tool-use-id> <status>{status}</status> </task-notification>'}

    def test_api_request_copies_of_tool_results_are_not_events(self):
        blob = {'type': 'api-request-blob', 'sessionId': 'claude-main', 'message': {'role': 'user', 'content': [
            {'type': 'tool_result', 'tool_use_id': 'a'}]}}
        self.write([self.use('a'), blob, self.result('a'), self.end()])
        self.assertTrue(self.check()[0], self.check())

    def test_compaction_is_read_through(self):
        self.write([self.use('a'), self.result('a'), {'type': 'user', 'isCompactSummary': True, 'sessionId': 'claude-main',
                                                   'message': {'role': 'user', 'content': 'summary'}}, self.end()])
        self.assertTrue(self.check()[0], self.check())

    def test_background_job_blocks_until_its_completion_notice(self):
        started = [self.use('a', True), self.result('a', 'Command running in background with ID: b1.', {'backgroundTaskId': 'b1'}), self.end()]
        self.write(started)
        self.assertIn('background job running', self.check()[1])
        self.write(started + [self.notice('b1', 'a')])
        self.assertTrue(self.check()[0], self.check())
        self.write(started + [self.notice('b1', 'a', status='running')])
        self.assertIn('background job running', self.check()[1])

    def test_stopped_background_job_and_denied_launch_do_not_block(self):
        self.write([self.use('a', True), self.result('a', 'Command running in background with ID: b1.'),
                    self.use('s'), self.result('s', 'Successfully stopped task: b1 (sleep 99)'),
                    self.use('d', True), self.result('d', 'Permission for this action was denied', error=True), self.end()])
        self.assertTrue(self.check()[0], self.check())

    def test_async_agent_blocks_until_notified(self):
        started = [self.use('a'), self.result('a', 'launched', {'isAsync': True, 'status': 'async_launched', 'agentId': 'ag1'}), self.end()]
        self.write(started)
        self.assertIn('background job running', self.check()[1])
        self.write(started + [self.notice('ag1', 'a', kind='attachment')])
        self.assertTrue(self.check()[0], self.check())

    def test_unicode_line_separators_inside_strings_do_not_split_records(self):
        records = [self.use('a'), self.result('a', 'line\u2028still the same record'), self.end()]
        self.log.write_text(''.join(json.dumps(r, ensure_ascii=False)+'\n' for r in records))
        os.utime(self.log, (STAMP/1000, STAMP/1000))
        self.assertIn('\u2028', self.log.read_text())
        self.assertTrue(self.check()[0], self.check())

    def test_finished_subagent_ending_on_its_result_tool_is_accepted(self):
        child_dir = self.home/'projects/fixture/claude-main/subagents'
        child_dir.mkdir(parents=True)
        (child_dir/'agent-x.meta.json').write_text('{"finished":true}')
        (child_dir/'agent-x.jsonl').write_text(json.dumps(self.use('final')) + '\n')
        self.assertTrue(self.check()[0], self.check())
        (child_dir/'agent-x.meta.json').write_text('{}')   # no `finished`: the log must show an ended turn
        self.assertFalse(self.check()[0])


class TruncatedHostMetadataTests(unittest.TestCase):
    def test_complete_exit_metadata_before_truncated_stdout_is_evidence(self):
        text='Warning: truncated output (original token count: 123)\nTotal output lines: 1\n\n{"chunk_id":"abc123","wall_time_seconds":0.1,"exit_code":0,"original_token_count":999,"output":"cut off'
        objects,_=jobs._output([{'type':'input_text','text':text}])
        self.assertTrue(any(item.get('exit_code')==0 for item in objects))

    def test_unframed_or_incomplete_result_remains_unknown(self):
        self.assertIsNone(jobs._truncated_host_result('{"exit_code":0,"output":"cut'))
        self.assertIsNone(jobs._truncated_host_result('Warning: truncated output (original token count: 123)\nTotal output lines: 1\n\n{"chunk_id":"abc123","output":"cut'))

    def test_stdout_cannot_forge_truncated_host_exit(self):
        fake='Warning: truncated output (original token count: 123)\nTotal output lines: 1\n\n{"chunk_id":"abc123","wall_time_seconds":0.1,"exit_code":0,"output":"cut'
        objects,_=jobs._output({'exit_code':None,'session_id':7,'output':fake})
        self.assertEqual(len(objects),1)
        self.assertIsNone(objects[0]['exit_code'])
