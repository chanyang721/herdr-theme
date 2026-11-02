import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('route', Path(__file__).parents[1] / 'scripts/route.py')
route = importlib.util.module_from_spec(spec)
spec.loader.exec_module(route)


def fixture():
    spaces = [
        {'id': 'common', 'name': '공통', 'folder': '/common', 'tabs': [
            {'active': True, 'terminals': [{'terminal': 's0'}, {'terminal': 's1'}, {'terminal': 's2'}]}]},
        {'id': 'project', 'name': 'Medihomes', 'folder': '/medihomes', 'tabs': [
            {'active': True, 'terminals': [{'terminal': 'p0'}, {'terminal': 'p1'}, {'terminal': 'p2'}]}]},
    ]
    live = [{'address': address, 'agent': agent, 'state': 'live', 'status': status}
            for address, agent, status in [('s2', 'codex', 'working'), ('p0', 'claude-code', 'idle'),
                                           ('p1', 'codex', 'idle'), ('p2', 'codex', 'idle')]]
    return spaces, live


class RouteTests(unittest.TestCase):
    def test_same_position_wins_then_busy_falls_back_to_same_agent_kind(self):
        spaces, live = fixture()
        self.assertEqual(route.candidates(spaces, live, 's2', '메디홈즈'),
                         ('Medihomes', 'p2', ['p2', 'p1', 'p0']))
        live[-1]['status'] = 'working'
        self.assertEqual(route.candidates(spaces, live, 's2', 'Medihomes')[2], ['p1', 'p0'])

    def test_all_busy_or_blocked_returns_no_target_instead_of_interrupting(self):
        spaces, live = fixture()
        for entry in live:
            entry['status'] = 'blocked' if entry['address'] == 'p0' else 'working'
        self.assertEqual(route.candidates(spaces, live, 's2', 'Medihomes')[2], [])
        with patch.object(route, 'call') as call:
            result = route.dispatch({'id': 'test', 'source': 's2', 'project': 'Medihomes', 'text': 'hi'}, spaces, live)
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
            result = route.dispatch({'id': 'test', 'source': 's2', 'project': 'Medihomes', 'text': 'hi'}, spaces, live)
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
        self.assertNotIn('p2', route.candidates(spaces, live, 's2', 'Medihomes')[2])

    def test_unknown_project_or_non_common_source_is_not_guessed(self):
        spaces, live = fixture()
        with self.assertRaises(ValueError):
            route.candidates(spaces, live, 's2', 'another project')
        with self.assertRaises(ValueError):
            route.candidates(spaces, live, 'p2', 'Medihomes')

    def test_uncertain_send_is_not_retried_to_a_second_agent(self):
        spaces, live = fixture()
        with patch.object(route, 'call', side_effect=[
            (0, {'state': 'live', 'status': {'state': 'idle'}}),
            (0, {'text': '• completed\n\n› Ask Codex to do anything'}),
            (1, {'error': {'kind': 'connection_lost'}}),
        ]) as call:
            with self.assertRaisesRegex(ValueError, '중복 전송'):
                route.dispatch({'id': 'test', 'source': 's2', 'project': 'Medihomes', 'text': 'hi'}, spaces, live)
        self.assertEqual(call.call_count, 3)


if __name__ == '__main__':
    unittest.main()
