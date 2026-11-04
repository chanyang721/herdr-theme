import importlib.util
from pathlib import Path
import json
import sys
import tempfile
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('route', Path(__file__).parents[1] / 'scripts/route.py')
route = importlib.util.module_from_spec(spec)
spec.loader.exec_module(route)
# Machine-local names come from site.local.json; tests never read this computer's file.
SITE = {**route.site_config.DEFAULTS, 'hub_space_ids': ['sp-share'], 'project_aliases': {'비': 'project b'}}


def setUpModule():
    patcher = patch.object(route.site_config, 'load', return_value=SITE)
    patcher.start()
    unittest.addModuleCleanup(patcher.stop)


def fixture():
    spaces = [
        {'id': 'common', 'name': '공통', 'folder': '/common', 'tabs': [
            {'active': True, 'terminals': [{'terminal': 's0'}, {'terminal': 's1'}, {'terminal': 's2'}]}]},
        {'id': 'project', 'name': 'Project B', 'folder': '/project-b', 'tabs': [
            {'active': True, 'terminals': [{'terminal': 'p0'}, {'terminal': 'p1'}, {'terminal': 'p2'}]}]},
    ]
    live = [{'address': address, 'agent': agent, 'state': 'live', 'status': status}
            for address, agent, status in [('s2', 'codex', 'working'), ('p0', 'claude-code', 'idle'),
                                           ('p1', 'codex', 'idle'), ('p2', 'codex', 'idle')]]
    return spaces, live


class RouteTests(unittest.TestCase):
    def test_share_and_stable_space_id_survive_workspace_rename(self):
        for space_id, name in [('common', 'Share'), ('sp-share', 'Renamed')]:
            spaces, live = fixture()
            spaces[0].update(id=space_id, name=name)
            self.assertEqual(route.candidates(spaces, live, 's2', 'Project B')[1], 'p2')

    def test_same_position_wins_then_busy_falls_back_to_same_agent_kind(self):
        spaces, live = fixture()
        self.assertEqual(route.candidates(spaces, live, 's2', '비'),
                         ('Project B', 'p2', ['p2', 'p1', 'p0']))
        live[-1]['status'] = 'working'
        self.assertEqual(route.candidates(spaces, live, 's2', 'Project B')[2], ['p1', 'p0'])

    def test_all_busy_or_blocked_returns_no_target_instead_of_interrupting(self):
        spaces, live = fixture()
        for entry in live:
            entry['status'] = 'blocked' if entry['address'] == 'p0' else 'working'
        self.assertEqual(route.candidates(spaces, live, 's2', 'Project B')[2], [])
        with patch.object(route, 'call') as call:
            result = route.dispatch({'id': 'test', 'source': 's2', 'project': 'Project B', 'text': 'hi'}, spaces, live)
        self.assertEqual(result['state'], 'queued')
        call.assert_not_called()

    def test_agent_became_busy_after_selection_is_never_sent_the_message(self):
        spaces, live = fixture()
        sent = []

        def call(argv, env=None):
            if argv[1] == 'read':
                return 0, {'text': '• completed\n\n› Ask Codex to do anything'}
            if argv[1] == 'get':
                return 0, {'state': 'live', 'status': {'state': 'working' if argv[2] == 'p2' else 'idle'}}
            sent.append((argv[2], env['HC_TERMINAL_ID']))
            return 0, {'started': True}

        with patch.object(route, 'call', side_effect=call):
            result = route.dispatch({'id': 'test', 'source': 's2', 'project': 'Project B', 'text': 'hi'}, spaces, live)
        self.assertEqual(sent, [('p1', 's2')])
        self.assertTrue(result['fallback'])

    def test_drafts_recording_and_pending_questions_are_protected(self):
        for screen in ('❯ 보내지 않은 초안', '● REC · tap to send\n❯',
                       'voice ● listening\n› Ask Codex to do anything',
                       '• 이대로 진행할까요?\n\n› Ask Codex to do anything'):
            with self.subTest(screen=screen):
                self.assertFalse(route.receiver_available(screen))
        self.assertTrue(route.receiver_available('• 완료했습니다.\n\n› Ask Codex to do anything'))
        spaces, live = fixture()
        live[-1]['status'] = 'done'
        self.assertNotIn('p2', route.candidates(spaces, live, 's2', 'Project B')[2])

    def test_voice_and_recording_below_composer_are_protected(self):
        for screen in ('❯\nvoice ● listening', '❯\n● REC',
                       '› Ask Codex to do anything\nvoice ● listening'):
            self.assertFalse(route.receiver_available(screen))

    def test_only_explicit_reply_requests_add_a_completion_report(self):
        spaces, live = fixture()
        for reply in (False, True):
            sent = []
            def call(argv, env=None):
                if argv[1] == 'get':
                    return 0, {'state': 'live', 'status': {'state': 'idle'}}
                if argv[1] == 'read':
                    return 0, {'text': '• completed\n\n› Ask Codex to do anything'}
                sent.append(argv[-1])
                return 0, {'started': True}
            with patch.object(route, 'call', side_effect=call):
                route.dispatch({'id': 'test', 'source': 's2', 'project': 'Project B',
                                'text': 'hi', 'reply': reply}, spaces, live)
            self.assertEqual('한 번 회신하세요' in sent[0], reply)
            self.assertEqual('진행·완료 보고는 보내지 마세요' in sent[0], not reply)

    def test_claude_question_remains_protected_below_timing_lines(self):
        for verb in ('Churned', 'Brewed', 'Sautéed', 'Worked', 'Cogitated'):
            self.assertFalse(route.receiver_available(f'이대로 진행할까요?\n✻ {verb} for 3s done...\n❯'))
        self.assertTrue(route.receiver_available('완료했습니다.\n✻ Churned for 3s\n❯'))

    def test_sent_request_is_removed_before_a_failed_refresh(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            request = {'id': 'one', 'source': 's2', 'project': 'Project B', 'text': 'hi'}
            (data / 'routing-queue.json').write_text(json.dumps({'requests': [request]}))
            with patch.object(route, 'DATA', data), patch.object(route, 'QUEUE', data / 'routing-queue.json'), \
                 patch.object(sys, 'argv', ['route.py', '--drain']), \
                 patch.object(route, 'snapshot', side_effect=[fixture(), ValueError('refresh failed')]), \
                 patch.object(route, 'dispatch', return_value={'state': 'sent'}) as dispatch:
                with self.assertRaisesRegex(ValueError, 'refresh failed'):
                    route.main()
                route.main()  # An empty queue must not send again or need a snapshot.
                self.assertEqual(dispatch.call_count, 1)
            self.assertEqual(json.loads((data / 'routing-queue.json').read_text())['requests'], [])

    def test_new_uncertain_request_is_held_and_never_automatically_retried(self):
        for error in (ValueError('uncertain'), subprocess.TimeoutExpired('hc', 30)):
            with self.subTest(error=error), tempfile.TemporaryDirectory() as directory:
                data = Path(directory)
                queue = data / 'routing-queue.json'
                def uncertain(*args):
                    # Hold must be durable before dispatch starts, including process crashes.
                    self.assertTrue(json.loads(queue.read_text())['requests'][0]['hold'])
                    raise error
                with patch.object(route, 'DATA', data), patch.object(route, 'QUEUE', queue), \
                     patch.object(sys, 'argv', ['route.py', 'Project B', 'hi', '--from', 's2']), \
                     patch.object(route, 'snapshot', return_value=fixture()), \
                     patch.object(route, 'dispatch', side_effect=uncertain) as dispatch:
                    with self.assertRaises(type(error)):
                        route.main()
                    with patch.object(sys, 'argv', ['route.py', '--drain']):
                        route.main()
                    self.assertEqual(dispatch.call_count, 1)
                stored = json.loads(queue.read_text())['requests'][0]
                self.assertTrue(stored['hold'])
                self.assertEqual(stored['text'], 'hi')

    def test_busy_request_clears_attempt_hold_for_a_later_drain(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(route, 'QUEUE', Path(directory) / 'queue.json'), \
                 patch.object(route, 'dispatch', return_value={'state': 'queued'}):
                request = {'id': 'busy'}
                pending = [request]
                route.deliver_pending(request, pending, [], [])
                self.assertNotIn('hold', request)
                self.assertEqual(json.loads(route.QUEUE.read_text())['requests'], [request])

    def test_unknown_project_or_non_common_source_is_not_guessed(self):
        spaces, live = fixture()
        with self.assertRaises(ValueError):
            route.candidates(spaces, live, 's2', 'another project')
        with self.assertRaises(ValueError):
            route.candidates(spaces, live, 'p2', 'Project B')

    def test_uncertain_send_is_not_retried_to_a_second_agent(self):
        spaces, live = fixture()
        with patch.object(route, 'call', side_effect=[
            (0, {'state': 'live', 'status': {'state': 'idle'}}),
            (0, {'text': '• completed\n\n› Ask Codex to do anything'}),
            (1, {'error': {'kind': 'connection_lost'}}),
        ]) as call:
            with self.assertRaisesRegex(ValueError, '중복 전송'):
                route.dispatch({'id': 'test', 'source': 's2', 'project': 'Project B', 'text': 'hi'}, spaces, live)
        self.assertEqual(call.call_count, 3)


if __name__ == '__main__':
    unittest.main()
