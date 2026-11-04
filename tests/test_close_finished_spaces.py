"""Isolated cleanup policy tests: no real app, HOME, launchd, or terminal calls."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('close_finished_spaces', Path(__file__).parents[1]/'scripts/close_finished_spaces.py')
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)
NOW = 100_000


def snapshot():
    return {
        'status': {'space': 'current', 'tab': 'tab-current', 'focused_pane': 'pane-current', 'errors': []},
        'spaces': [
            {'id': 'current', 'name': 'Current', 'machine': None, 'active': True, 'tabs': []},
            {'id': 'temporary', 'name': 'Temporary work', 'machine': None, 'active': False, 'folder': '/fixture/worktree',
             'tabs': [{'terminals': [{'terminal': 't-test'}]}]},
        ],
        'terminals': {'t-test': {'address': 't-test', 'state': 'live', 'pid': 100, 'foreground': True,
                                 'reported': True, 'status': {'app': 'codex', 'state': 'done'},
                                 'status_ms': 10, 'turn': 1, 'cwd': '/fixture/worktree'}},
        'processes': {100: {'pid': 100, 'parent': 1, 'name': 'zsh'}, 101: {'pid': 101, 'parent': 100, 'name': 'codex'}},
    }


class FakeLive:
    def __init__(self):
        self.data = snapshot()
        self.text = 'Completed requested task.\n› Ask Codex to do anything\nGPT-6.1 · 80% context left\n'
        self.closed = []
        self.notifications = []
        self.reads = []
        self.snapshots = 0
        self.before_snapshot = None
        self.keep_after_close = False
        self.focus_after_close = False
        self.close_error = None
        self.report_dir = None
        self.parks = []
        self.park_error = None
        self.session_known = True

    def snapshot(self):
        self.snapshots += 1
        if self.before_snapshot:
            self.before_snapshot(self)
        return copy.deepcopy(self.data)

    def screen(self, address):
        self.reads.append(address)
        return self.text

    def backend(self, terminal, config, process_tree_clean=False):
        return True, '', 'verified-test-jobs'

    def mapping(self, terminal, config):
        return {'session_id': '11111111-2222-3333-4444-555555555555'} if self.session_known else None

    def park(self, config, item, event, reason=None):
        self.parks.append((event, item['address'], item['session_id']))
        if self.report_dir is not None and event == 'close_requested':
            assert not self.closed, 'harness record must precede space.close'
        return (True, f'record-{len(self.parks)}') if not self.park_error else (False, self.park_error)

    def git(self, folder):
        return {'branch': 'main', 'head': 'abc1234', 'uncommitted': 1, 'worktrees': 1}

    def close(self, space_id, config=None):
        if self.report_dir is not None:
            assert list(self.report_dir.glob('*.md')), 'record must exist before space.close'
        self.closed.append(space_id)
        if self.close_error:
            raise self.close_error
        if not self.keep_after_close:
            self.data['spaces'] = [s for s in self.data['spaces'] if s['id'] != space_id]
        if self.focus_after_close:
            self.data['status']['focused_pane'] = 'unexpected-pane'

    def notify(self, address, message):
        self.notifications.append((address, message))

    reported = False

    def request_report(self, address, text):
        self.notifications.append(('ask', address))

    def close_status(self, config, item, since):
        return (True, {'report_id': 'REP1', 'task_id': 'TASK1'}) if self.reported else (False, 'no close report yet')


class CleanupPolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.reports = Path(self.tmp.name)/'reports'
        self.live = FakeLive()
        self.live.report_dir = self.reports
        self.config = {'idle_seconds': 600, 'trial_seconds': 1800, 'max_sample_gap_seconds': 660,
                       'fixed_names': ['Share', 'PeaceMinusOne', 'Medihomes'], 'fixed_spaces': [],
                       'reviewed_dry_run_at': NOW, 'reviewed_observer_sha256': 'test', 'notify_terminal': 'review-session',
                       'space_close_enabled': True,   # the close path itself; the default hold is tested below
                       'close_report': {'enabled': False}}   # the session's own report is tested in CloseReportSpaceTests
        self.git_mock = patch.object(cleanup, 'git_info', lambda folder: {'folder': folder, 'remaining_uncommitted': ' M work.py', 'worktrees': 'fixture worktree'})
        self.git_mock.start()
        self.addCleanup(self.git_mock.stop)

    def target(self):
        return next(s for s in self.live.data['spaces'] if s['id'] == 'temporary')

    def inspect(self):
        return cleanup.inspect(self.target(), self.live.data, self.live, self.config)

    def ready_state(self, quiet=600):
        fingerprint = self.inspect().get('fingerprint')
        return {'observer_sha256': 'test', 'last_at': NOW-300,
                'trial': {'started_at': NOW-1800, 'samples': 6, 'error_count': 0},
                'spaces': {'temporary': {'since': NOW-quiet, 'fingerprint': fingerprint}}}

    def cycle(self, state=None, now=NOW, apply=True):
        return cleanup.cycle(self.live, self.config, state if state is not None else self.ready_state(), now,
                             apply=apply, only_space='temporary', report_dir=self.reports)

    def assert_blocked(self, reason):
        result = self.cycle()
        self.assertEqual(self.live.closed, [])
        self.assertEqual(result['results'][0]['action'], 'keep')
        self.assertTrue(any(reason in r for r in result['results'][0]['reasons']), result)

    def test_by_default_no_space_is_ever_closed(self):
        # User rule (2026-11-04): workspaces are never removed; closing waits for an explicit answer.
        del self.config['space_close_enabled']
        result = self.cycle()
        self.assertEqual(self.live.closed, [])
        item = result['results'][0]
        self.assertEqual(item['action'], 'keep')
        self.assertIn('space close held: workspaces are kept until the person enables it', item['reasons'])
        self.assertFalse(any(c[1] == 'close_requested' for c in getattr(self.live, 'parks', [])))

    def test_the_live_close_refuses_without_the_switch(self):
        live = cleanup.Live('herdr-app-not-run', 'hc-not-run')
        with self.assertRaisesRegex(RuntimeError, 'workspaces are kept'):
            live.close('sp-any', {})
        with self.assertRaisesRegex(RuntimeError, 'workspaces are kept'):
            live.close('sp-any')

    def test_idle_boundary_is_600_seconds_and_record_precedes_close(self):
        result = self.cycle(self.ready_state(599))
        self.assertEqual(result['results'][0]['action'], 'keep')
        self.assertFalse(self.reports.exists())
        result = self.cycle(self.ready_state(600))
        self.assertEqual(result['results'][0]['action'], 'closed')
        self.assertEqual(self.live.closed, ['temporary'])
        self.assertTrue(Path(result['results'][0]['record']).exists())

    def test_dry_run_never_records_closes_or_notifies(self):
        result = self.cycle(apply=False)
        self.assertEqual(result['results'][0]['action'], 'would_close')
        self.assertEqual(self.live.closed, [])
        self.assertEqual(self.live.notifications, [])
        self.assertFalse(self.reports.exists())

    def test_requires_both_30_minutes_and_seven_samples(self):
        for elapsed, samples in [(1799, 6), (1800, 5)]:
            with self.subTest(elapsed=elapsed, samples=samples):
                state = self.ready_state()
                state['trial'].update(started_at=NOW-elapsed, samples=samples)
                self.assertEqual(self.cycle(state)['results'][0]['action'], 'keep')
        self.assertFalse(self.live.closed)
        self.assertEqual(self.cycle(self.ready_state())['results'][0]['action'], 'closed')

    def test_seven_real_dry_run_samples_reach_trial_readiness_only_at_30_minutes(self):
        state = {'observer_sha256': 'test'}
        for index in range(7):
            result = self.cycle(state, now=NOW+index*300, apply=False)
            self.assertEqual(result['trial_ready'], index == 6)
        self.assertEqual(result['trial']['samples'], 7)
        self.assertFalse(self.live.closed)

    def test_review_gate_is_required(self):
        self.config.pop('reviewed_dry_run_at')
        self.assert_blocked('review')

    def test_review_of_different_observer_is_rejected(self):
        self.config['reviewed_observer_sha256'] = 'different-observer'
        self.assert_blocked('review')

    def test_review_before_30_minute_trial_is_rejected(self):
        self.config['reviewed_dry_run_at'] = NOW-1
        self.assert_blocked('review')

    def test_trial_with_previous_error_never_applies(self):
        state = self.ready_state()
        state['trial']['error_count'] = 1
        self.assertEqual(self.cycle(state)['results'][0]['action'], 'keep')
        self.assertFalse(self.live.closed)

    def test_current_space_is_never_inspected_or_closed(self):
        self.live.data['status']['space'] = 'temporary'
        self.assertFalse(self.inspect()['safe'])
        self.assertEqual(self.live.reads, [])

    def test_active_flag_alone_prevents_cleanup(self):
        self.target()['active'] = True
        self.assert_blocked('currently visible')

    def test_fixed_names_ignore_case_and_fixed_ids_are_machine_specific(self):
        for name in ['Share', 'PEACEMINUSONE', 'medihomes']:
            with self.subTest(name=name):
                self.target()['name'] = name
                self.assertFalse(self.inspect()['safe'])
        self.target()['name'] = 'Renamed fixed workspace'
        self.config['fixed_spaces'] = [{'id': 'temporary', 'machine': None}]
        self.assertFalse(self.inspect()['safe'])
        self.config['fixed_spaces'] = [{'id': 'temporary', 'machine': 'remote'}]
        self.assertTrue(self.inspect()['safe'])

    def test_remote_workspaces_are_never_assumed_safe(self):
        self.target()['machine'] = 'remote'
        self.assert_blocked('remote')
        self.assertFalse(self.live.reads)

    def test_working_or_unreported_agent_blocks_cleanup(self):
        for status in ['working', 'blocked', None]:
            with self.subTest(status=status):
                self.live.data['terminals']['t-test']['status']['state'] = status
                self.assert_blocked('not a confirmed')
        self.live.data['terminals']['t-test']['status']['state'] = 'done'
        self.live.data['terminals']['t-test']['reported'] = False
        self.assert_blocked('not a confirmed')

    def test_pending_input_or_wrapped_multiline_input_blocks_cleanup(self):
        for text in ['› please continue\n', '›\nwrapped pending input\n']:
            with self.subTest(text=text):
                self.live.text = text
                self.assert_blocked('empty input unverified')

    def test_approval_wait_blocks_and_is_notified_once_per_day_after_review(self):
        self.live.text = '사용자 승인 대기\n› Ask Codex to do anything\n'
        state = self.ready_state()
        self.cycle(state)
        self.assertFalse(self.live.closed)
        self.assertEqual(len(self.live.notifications), 1)
        self.assertEqual(self.live.notifications[0][0], 'review-session')
        self.cycle(state, now=NOW+300)
        self.assertEqual(len(self.live.notifications), 1)

    def test_running_child_shell_or_unknown_process_blocks_cleanup(self):
        for name in ['sh', 'bash', 'sleep', 'unknown-helper']:
            with self.subTest(name=name):
                self.live.data['processes'][102] = {'pid': 102, 'parent': 101, 'name': name}
                self.assert_blocked('child processes')

    def test_live_subagent_terminal_blocks_cleanup(self):
        self.live.data['terminals']['child'] = {'address': 'child', 'parent': 't-test', 'state': 'live'}
        self.assert_blocked('live subagent')

    def test_missing_process_or_terminal_evidence_blocks_cleanup(self):
        self.live.data['processes'].clear()
        self.assert_blocked('process evidence unavailable')
        self.live.data['terminals'].clear()
        self.assert_blocked('terminal evidence unavailable')

    def test_output_change_resets_observation_window(self):
        state = self.ready_state()
        self.live.text = 'New output\n› Ask Codex to do anything\n'
        result = self.cycle(state)
        self.assertEqual(result['results'][0]['quiet_seconds'], 0)
        self.assertFalse(self.live.closed)

    def test_old_or_future_sample_resets_trial_and_idle_window(self):
        for gap in [661, -1]:
            with self.subTest(gap=gap):
                state = self.ready_state()
                state['last_at'] = NOW-gap
                result = self.cycle(state)
                self.assertEqual(result['results'][0]['quiet_seconds'], 0)
                self.assertEqual(result['trial']['samples'], 1)
        self.assertFalse(self.live.closed)

    def test_focus_race_immediately_before_close_blocks_operation(self):
        def race(live):
            if live.snapshots == 2:
                live.data['status']['focused_pane'] = 'user-changed-pane'
        self.live.before_snapshot = race
        self.assert_blocked('focus changed')
        self.assertFalse(self.reports.exists())

    def test_evidence_race_immediately_before_close_blocks_operation(self):
        def race(live):
            if live.snapshots == 2:
                live.text = 'Changed at the last moment\n› Ask Codex to do anything\n'
        self.live.before_snapshot = race
        self.assert_blocked('evidence changed')
        self.assertFalse(self.reports.exists())

    def test_failed_close_confirmation_keeps_record_and_raises(self):
        self.live.keep_after_close = True
        with self.assertRaisesRegex(RuntimeError, 'not confirmed'):
            self.cycle()
        self.assertEqual(self.live.closed, ['temporary'])
        self.assertEqual(len(list(self.reports.glob('*.md'))), 1)

    def test_focus_change_after_close_stops_further_cleanup(self):
        state = self.ready_state()
        other = copy.deepcopy(self.target())
        other.update(id='other', name='Other temporary')
        self.live.data['spaces'].append(other)
        state['spaces']['other'] = copy.deepcopy(state['spaces']['temporary'])
        self.live.focus_after_close = True
        with self.assertRaisesRegex(RuntimeError, 'focus changed after close'):
            cleanup.cycle(self.live, self.config, state, NOW, apply=True, report_dir=self.reports)
        self.assertEqual(self.live.closed, ['temporary'])

    def test_close_exception_is_not_reported_as_success(self):
        self.live.close_error = RuntimeError('close failed')
        with self.assertRaisesRegex(RuntimeError, 'close failed'):
            self.cycle()
        self.assertEqual(len(list(self.reports.glob('*.md'))), 1)

    def test_existing_record_is_appended_without_destroying_previous_content(self):
        item = self.inspect()
        path = Path(cleanup.record_space(item, self.reports, NOW))
        path.write_text('Existing human report\n')
        second = cleanup.record_space(item, self.reports, NOW+60)
        self.assertEqual(str(path), second)
        text = path.read_text()
        self.assertTrue(text.startswith('Existing human report\n'))
        self.assertIn('자동 정리 시각', text)
        self.assertIn('temporary', text)

    def test_uncommitted_work_is_recorded_before_close_but_worktree_is_not_deleted(self):
        self.git_mock.stop()
        root = Path(self.tmp.name)/'repo'
        root.mkdir()
        subprocess.run(['git', 'init', '-q', '-b', 'main'], cwd=root, check=True)
        (root/'committed.txt').write_text('saved')
        subprocess.run(['git', 'add', '.'], cwd=root, check=True)
        subprocess.run(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture saved work'], cwd=root, check=True)
        worktree = Path(self.tmp.name)/'worktree'
        subprocess.run(['git', 'worktree', 'add', '--detach', str(worktree)], cwd=root, check=True, capture_output=True)
        (worktree/'pending.txt').write_text('Uncommitted work must remain on disk')
        self.target()['folder'] = str(worktree)
        self.live.data['terminals']['t-test']['cwd'] = str(worktree)
        result = self.cycle()
        self.assertEqual(result['results'][0]['action'], 'closed')
        self.assertTrue(worktree.exists())
        self.assertEqual((worktree/'pending.txt').read_text(), 'Uncommitted work must remain on disk')
        report = Path(result['results'][0]['record']).read_text()
        self.assertIn('pending.txt', report)
        self.assertIn('fixture saved work', report)
        self.assertIn('worktrees', report)


class PromptEvidenceTests(unittest.TestCase):
    def test_only_recognized_empty_agent_prompts_count(self):
        self.assertTrue(cleanup.empty_prompt('› Ask Codex to do anything\nGPT-6.1\n', 'codex'))
        self.assertTrue(cleanup.empty_prompt('❯\nClaude\n', 'claude'))
        self.assertFalse(cleanup.empty_prompt('$\n', 'codex'))
        self.assertFalse(cleanup.empty_prompt('›\nunknown continuation\n', 'codex'))
        self.assertFalse(cleanup.empty_prompt('› pending instruction\n', 'codex'))
        self.assertFalse(cleanup.empty_prompt('❯\n', 'unknown-agent'))


class HarnessRecordTests(CleanupPolicyTests):
    """Temporary spaces: harness record → workspace record document → space close."""

    def test_harness_record_precedes_document_and_close_and_closed_follows(self):
        result = self.cycle()
        self.assertEqual(result['results'][0]['action'], 'closed')
        self.assertEqual([e for e, *_ in self.live.parks], ['close_requested', 'closed'])
        self.assertEqual(result['results'][0]['harness'], ['record-1'])

    def test_refused_harness_record_keeps_the_space_and_writes_no_document(self):
        self.live.park_error = 'harness refused: org: work records need a local denylist'
        result = self.cycle()
        self.assertEqual((result['results'][0]['action'], self.live.closed), ('keep', []))
        self.assertTrue(any('harness record failed' in r for r in result['results'][0]['reasons']))
        self.assertFalse(self.reports.exists())

    def test_unknown_session_id_is_a_reason_to_keep(self):
        self.live.session_known = False
        self.assert_blocked('session id unverified')

    def test_user_approval_replaces_the_30_minute_review_after_one_recorded_dry_run(self):
        self.config.pop('reviewed_dry_run_at')
        self.config['user_approved_apply'] = True
        state = self.ready_state()
        state['trial'].update(started_at=NOW-300, samples=1)   # one dry-run seen; this apply cycle is the second
        self.assertEqual(self.cycle(state)['results'][0]['action'], 'closed')

    def test_user_approval_is_tied_to_the_reviewed_code(self):
        self.config.pop('reviewed_dry_run_at')
        self.config.update(user_approved_apply=True, reviewed_observer_sha256='other-code')
        state = self.ready_state()
        state['trial'].update(started_at=NOW-300, samples=1)
        self.assertEqual(self.cycle(state)['results'][0]['action'], 'keep')

    def test_claude_input_box_borders_do_not_hide_an_empty_prompt(self):
        border = '─' * 40
        empty = f'done\n{border}\n❯ \n{border}\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents\n'
        typed = f'done\n{border}\n❯ 예시값도 하나 넣어줘\n{border}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n'
        self.assertTrue(cleanup.empty_prompt(empty, 'claude-code'))
        self.assertFalse(cleanup.empty_prompt(typed, 'claude-code'))


# The harness tests share CleanupPolicyTests' fixtures; attach them there so nothing runs twice.
for _name, _test in list(vars(HarnessRecordTests).items()):
    if _name.startswith('test_'):
        setattr(CleanupPolicyTests, _name, _test)
del HarnessRecordTests
