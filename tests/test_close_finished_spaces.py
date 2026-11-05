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

    archives = None
    archive_error = None

    def archive(self, config, data):
        assert not self.closed, 'archive must precede space.close'
        if self.archive_error:
            return False, self.archive_error
        self.archives = (self.archives or []) + [data]
        return True, 'ARCH.json'

    def machine(self):
        return 'm' * 32

    reported = False

    def request_report(self, address, text):
        self.notifications.append(('ask', address))

    gate_blockers = ()

    def close_gate(self, config, item):
        self.gates = getattr(self, 'gates', []) + [item['address']]
        assert not self.closed, 'the harness gate is asked before space.close'
        return (not self.gate_blockers), list(self.gate_blockers)

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
                       'fixed_names': ['Share', 'Project A', 'Project B'], 'fixed_spaces': [],
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
        for name in ['Share', 'PROJECT A', 'project b']:
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

    def test_an_empty_agent_pane_is_not_a_session_and_does_not_hold_the_space(self):
        # t4j·t4k·t4n (2026-11-05): never received input, kept for 'Claude log identity'.
        self.live.data['terminals']['t-test']['turn'] = 0
        self.live.empty = lambda terminal, config: terminal.get('turn') == 0
        self.live.backend = lambda *a, **k: (False, 'backend jobs unverified: Claude log identity', None)
        item = self.inspect()
        self.assertTrue(item['safe'], item['reasons'])
        self.assertEqual((item['sessions'], item['empty_panes']), ([], ['t-test']))

    def test_an_empty_pane_with_typed_input_still_blocks(self):
        self.live.data['terminals']['t-test']['turn'] = 0
        self.live.empty = lambda terminal, config: True
        self.live.text = 'Completed requested task.\n› 아직 보내지 않은 글\nGPT-6.1 · 80% context left\n'
        self.live.backend = lambda *a, **k: (False, 'backend jobs unverified: Claude log identity', None)
        item = self.inspect()
        self.assertFalse(item['safe'])
        self.assertEqual(item['empty_panes'], [])

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

    def test_focus_race_onto_the_space_immediately_before_close_blocks_operation(self):
        def race(live):
            if live.snapshots == 2:
                live.data['status']['space'] = 'temporary'
        self.live.before_snapshot = race
        self.assert_blocked('the person is viewing this space')
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

    def test_the_person_moving_elsewhere_does_not_stop_cleanup(self):
        def move(live):
            if live.snapshots == 2:
                live.data['status'].update(space='current', tab='tab-elsewhere', focused_pane='pane-elsewhere')
        self.live.before_snapshot = move
        result = self.cycle()
        self.assertEqual((result['results'][0]['action'], self.live.closed), ('closed', ['temporary']), result['results'][0]['reasons'])

    def test_the_space_the_person_is_viewing_is_kept(self):
        def look(live):
            if live.snapshots == 2:
                live.data['status'].update(space='temporary')
        self.live.before_snapshot = look
        result = self.cycle()
        self.assertEqual(self.live.closed, [])
        self.assertIn('the person is viewing this space', result['results'][0]['reasons'])

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


class ArchiveBeforeCloseTests(CleanupPolicyTests.__base__):
    """Archive → close: fixed spaces never, slept panes count as idle, the person's --now path."""
    setUp = CleanupPolicyTests.setUp
    target = CleanupPolicyTests.target
    inspect = CleanupPolicyTests.inspect
    ready_state = CleanupPolicyTests.ready_state
    cycle = CleanupPolicyTests.cycle

    def test_archive_names_tabs_sessions_and_git_before_close(self):
        result = self.cycle()
        self.assertEqual(result['results'][0]['action'], 'closed')
        a = self.live.archives[0]
        self.assertEqual((a['workspace_id'], a['name'], a['folder']), ('m' * 32 + '-temporary', 'Temporary work', '/fixture/worktree'))
        pane = a['tabs'][0]['panes'][0]
        self.assertEqual((pane['address'], pane['agent'], pane['session_id']), ('t-test', 'codex', '11111111-2222-3333-4444-555555555555'))
        self.assertEqual(pane['git']['uncommitted'], 1)
        self.assertEqual(result['results'][0]['archive'], 'ARCH.json')

    def test_failed_archive_keeps_the_space(self):
        self.live.archive_error = 'harness refused: x'
        result = self.cycle()
        self.assertEqual((result['results'][0]['action'], self.live.closed), ('keep', []))
        self.assertTrue(any('harness archive failed' in r for r in result['results'][0]['reasons']))

    def test_fixed_spaces_are_never_archived_or_closed_even_when_the_person_asks_now(self):
        for name in ('Share', 'share', 'PROJECT A'):
            self.live.data['spaces'][1]['name'] = name
            self.config['_manual'] = True
            result = self.cycle()
            self.assertEqual((result['results'][0]['action'], self.live.closed, self.live.archives), ('keep', [], None))
            self.assertIn('fixed workspace', result['results'][0]['reasons'])
        self.live.data['spaces'][1]['name'] = 'Renamed'
        self.config['fixed_spaces'] = [{'id': 'temporary', 'machine': None}]
        self.config['_manual'] = False
        self.assertEqual(self.cycle()['results'][0]['action'], 'keep')
        self.assertEqual(self.live.closed, [])

    def test_slept_pane_counts_as_idle_and_is_archived_with_its_session(self):
        sid = '22222222-3333-4444-5555-666666666666'
        self.live.data['terminals']['t-test'] = {
            'address': 't-test', 'state': 'live', 'pid': 100, 'reported': True, 'status': None, 'cwd': '/fixture/worktree',
            'labels': {'sixfold.sleep': f'claude:{sid}', 'sixfold.title': '절전 · 문서'},
            'foreground': {'pid': 300, 'argv': ['python3', '/x/session_sleep_stub.py', '/x/t.json']}}
        item = self.inspect()
        self.assertTrue(item['safe'], item['reasons'])
        result = self.cycle()
        self.assertEqual(result['results'][0]['action'], 'closed')
        pane = self.live.archives[0]['tabs'][0]['panes'][0]
        self.assertEqual((pane['agent'], pane['session_id'], pane['last_state']), ('claude-code', sid, 'slept'))

    def test_a_sleep_label_without_the_stub_is_not_trusted(self):
        self.live.data['terminals']['t-test']['labels'] = {'sixfold.sleep': 'claude:22222222-3333-4444-5555-666666666666'}
        self.live.data['terminals']['t-test']['status'] = {'app': 'claude-code', 'state': 'working'}
        self.assertFalse(self.inspect()['safe'])

    def test_now_skips_the_quiet_window_and_the_switch_but_not_the_safety_checks(self):
        self.config.update(space_close_enabled=False, _manual=True, reviewed_observer_sha256='other')
        result = self.cycle(self.ready_state(quiet=0))
        self.assertEqual(result['results'][0]['action'], 'closed')
        self.live.data = snapshot()
        self.live.closed = []
        self.live.data['terminals']['t-test']['status']['state'] = 'working'
        self.assertEqual(self.cycle(self.ready_state(quiet=0))['results'][0]['action'], 'keep')
        self.assertEqual(self.live.closed, [])

    def test_default_idle_window_is_six_hours(self):
        del self.config['idle_seconds']
        self.assertEqual(self.cycle(self.ready_state(quiet=21599))['results'][0]['action'], 'keep')
        self.assertEqual(self.cycle(self.ready_state(quiet=21600))['results'][0]['action'], 'closed')


class FinishedClaudeSpaceTests(CleanupPolicyTests.__base__):
    """Claude panes: a faint prompt suggestion is not input, and a session without a transcript
    (opened inside another agent) is reported, parked, archived and closed without a manual step."""
    setUp = CleanupPolicyTests.setUp
    target = CleanupPolicyTests.target
    inspect = CleanupPolicyTests.inspect
    ready_state = CleanupPolicyTests.ready_state
    cycle = CleanupPolicyTests.cycle
    BORDER = '─' * 30

    def claude(self, typed):
        t = self.live.data['terminals']['t-test']
        t['status']['app'] = 'claude-code'
        self.live.data['processes'][101]['name'] = 'claude'
        self.live.text = f'done\n{self.BORDER}\n❯ {typed}\n{self.BORDER}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n'

    def test_a_faint_suggestion_is_empty_input_but_typed_text_is_not(self):
        self.claude('push 완료했어, worktree 정리해')
        self.live.styled_screen = lambda address: f'❯\xa0\x1b[0m\x1b[2mpush 완료했어, worktree 정리해\x1b[0m\r\n'
        self.assertTrue(self.inspect()['safe'], self.inspect()['reasons'])
        for raw in ('❯\xa0\x1b[0mpush 완료했어, worktree 정리해\r\n', '❯\xa0\x1b[2mpush\x1b[22m 완료했어, worktree 정리해\r\n', ''):
            self.live.styled_screen = lambda address, raw=raw: raw
            self.assertIn('t-test: empty input unverified', self.inspect()['reasons'], raw)
        del self.live.styled_screen
        self.assertIn('t-test: empty input unverified', self.inspect()['reasons'])

    def child(self):
        self.claude('')
        self.live.session_known = False
        why = 'backend jobs unverified: cannot resume: Claude runs as an inherited child session (no session file or transcript)'
        self.live.backend = lambda terminal, config, clean=False: (False, why, '')
        self.live.child = lambda terminal: {'session_id': 'aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee', 'no_resume': True}

    def test_answering_the_report_request_keeps_the_idle_window(self):
        # Without this, every report request restarted the window at 0 and nothing ever closed.
        self.claude('')
        state = self.ready_state(quiet=300)
        self.live.text = (f'done\n❯ [세션 정리 보고 요청] 관찰기가 이 세션을 곧 정리합니다.\n⏺ 01REPORT\n'
                          f'{self.BORDER}\n❯ \n{self.BORDER}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n')
        self.cycle(state)
        self.assertEqual(state['spaces']['temporary']['since'], NOW - 300)
        self.live.text = f'done\n❯ 다른 일\n⏺ ok\n{self.BORDER}\n❯ \n{self.BORDER}\n  ⏵⏵ auto mode on\n'
        self.cycle(state, now=NOW + 60)
        self.assertEqual(state['spaces']['temporary']['since'], NOW + 60)   # real new work restarts it

    def test_a_description_mentioning_check_needed_is_not_a_decision(self):
        text = "- 툴팁 첫 줄에는 '모두 정상' 또는 '확인 필요 n개'가 나옵니다.\n❯ \n"
        self.assertFalse(cleanup.decision_pending(text))
        self.assertTrue(cleanup.decision_pending('배포 전에 사용자 확인 필요\n'))
        self.assertTrue(cleanup.decision_pending('진행하려면 확인이 필요합니다.\n'))

    def test_a_session_without_a_transcript_is_reported_parked_archived_and_closed(self):
        self.child()
        self.config['close_report'] = {'enabled': True}
        state = self.ready_state()
        first = self.cycle(state)               # no report yet: it is asked once
        self.assertEqual(first['results'][0]['action'], 'keep')
        self.assertIn(('ask', 't-test'), self.live.notifications)
        self.live.reported = True                # it answers
        result = self.cycle(state)
        self.assertEqual(result['results'][0]['action'], 'closed', result['results'][0]['reasons'])
        self.assertEqual([(e, sid) for e, _, sid in self.live.parks],
                         [('close_requested', 'aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee'), ('closed', 'aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee')])
        pane = self.live.archives[0]['tabs'][0]['panes'][0]
        self.assertTrue(pane['no_transcript'])
        self.assertNotIn('session_id', pane)

    def test_a_child_session_with_a_running_process_is_kept(self):
        self.child()
        self.live.data['processes'][102] = {'pid': 102, 'parent': 101, 'name': 'npm'}
        reasons = self.inspect()['reasons']
        self.assertTrue(any('child processes' in r for r in reasons), reasons)
        self.assertTrue(any('inherited child session' in r for r in reasons), reasons)

    def test_the_workspace_record_masks_denylisted_names(self):
        item = {'id': 'sp1', 'name': 'Acme 정리', 'summary': 'acme 배포 확인', 'folders': []}
        path = Path(cleanup.record_space(item, self.reports, NOW, ['acme']))
        text = path.read_text(encoding='utf-8')
        self.assertNotIn('acme', (path.name + text).lower())
        self.assertIn('[가림]', path.name)


class DecisionScreenTests(unittest.TestCase):
    """2026-11-04 false alarm: 'Blocked by auto mode' while a Monitor ran was reported as a user decision."""
    SCREEN = ('⏺ Bash(kill 4242)\n  ⎿  Blocked by auto mode · /permissions to review\n'
              '⏺ Monitor(Slack collector health)\n  ⎿  Monitor started · task bfpugik7k · timeout 1800s\n  ⎿  Allowed by auto mode\n'
              '✻ Worked for 3m 42s · done 오후 5:29 · 1 monitor still running\n'
              '────────\n❯ \n────────\n  ⏵⏵ auto mode on · 1 monitor\n')

    def test_auto_mode_lines_are_not_a_user_decision(self):
        self.assertFalse(cleanup.decision_pending(self.SCREEN))
        self.assertFalse(cleanup.decision_pending('⎿  Blocked by auto mode · /permissions to review\n❯ \n'))

    def test_a_running_monitor_or_shell_is_in_progress(self):
        self.assertTrue(cleanup.background_running(self.SCREEN))
        self.assertTrue(cleanup.background_running('done · 2 shells still running\n❯ \n'))
        self.assertFalse(cleanup.background_running('✻ Worked for 3s · done 오후 5:29\n❯ \n'))

    def test_real_questions_still_count(self):
        self.assertTrue(cleanup.decision_pending('Do you want to proceed?\n❯ 1. Yes\n  2. No\n'))
        self.assertTrue(cleanup.decision_pending('사용자 승인 대기: 배포 범위\n'))


class DecisionCycleTests(CleanupPolicyTests.__base__):
    setUp = CleanupPolicyTests.setUp
    target = CleanupPolicyTests.target
    inspect = CleanupPolicyTests.inspect
    ready_state = CleanupPolicyTests.ready_state
    cycle = CleanupPolicyTests.cycle

    def test_monitor_running_keeps_the_space_in_progress_without_a_notice(self):
        self.config.update(user_approved_apply=True, reviewed_observer_sha256='test')
        self.live.text = DecisionScreenTests.SCREEN
        result = self.cycle()
        reasons = result['results'][0]['reasons']
        self.assertEqual((result['results'][0]['action'], self.live.closed), ('keep', []))
        self.assertTrue(any('in progress' in r for r in reasons), reasons)
        self.assertFalse(any('user decision pending' in r for r in reasons), reasons)
        self.assertEqual(self.live.notifications, [])


class HelperProcessTests(unittest.TestCase):
    def test_claude_keep_awake_timer_is_a_helper_but_other_caffeinate_is_not(self):
        h = cleanup.agent_sessions.is_helper
        self.assertTrue(h({'args': 'caffeinate -i -t 300'}))
        self.assertFalse(h({'args': 'caffeinate -i make build'}))
        self.assertFalse(h({'args': 'caffeinate -dims'}))


class HarnessCloseGateTests(CleanupPolicyTests.__base__):
    """Only a space whose sessions' reports were accepted (and learnt) closes."""
    setUp = CleanupPolicyTests.setUp
    target = CleanupPolicyTests.target
    inspect = CleanupPolicyTests.inspect
    ready_state = CleanupPolicyTests.ready_state
    cycle = CleanupPolicyTests.cycle

    def test_not_accepted_keeps_the_space_and_writes_nothing(self):
        self.live.gate_blockers = ('final report not accepted by a trusted actor',)
        result = self.cycle()
        item = result['results'][0]
        self.assertEqual((item['action'], self.live.closed, self.live.parks, self.live.archives), ('keep', [], [], None))
        self.assertTrue(any('harness close gate' in r and 'not accepted' in r for r in item['reasons']), item['reasons'])
        self.assertFalse(self.reports.exists())

    def test_accepted_closes_after_the_gate(self):
        result = self.cycle()
        self.assertEqual(result['results'][0]['action'], 'closed')
        self.assertEqual(self.live.gates, ['t-test'])

    def test_open_task_or_escalation_keeps_it(self):
        for why in ('open task in this workspace: 모델 분배 (pending)', 'open escalation in this workspace (decision)'):
            self.live.gate_blockers = (why,)
            item = self.cycle()['results'][0]
            self.assertEqual((item['action'], self.live.closed), ('keep', []))
            self.assertTrue(any(why in r for r in item['reasons']))

    def test_an_adapter_without_the_gate_never_closes(self):
        del FakeLive.close_gate
        try:
            item = self.cycle()['results'][0]
        finally:
            FakeLive.close_gate = HarnessCloseGateTests._gate
        self.assertEqual((item['action'], self.live.closed), ('keep', []))
        self.assertIn('harness close gate: close gate unavailable', item['reasons'])


HarnessCloseGateTests._gate = FakeLive.close_gate


class HarnessCloseGateCallTests(unittest.TestCase):
    def test_the_gate_command_and_fail_closed_answers(self):
        A = cleanup.agent_sessions
        config = {'harness': {'python': 'py', 'script': 'harness.py'}}
        item = {'address': 't3', 'app': 'claude-code', 'session_id': '11111111-2222-3333-4444-555555555555', 'space_id': 'sp1'}
        seen = []
        ok = lambda out, code=0: (lambda a: (seen.append(a), subprocess.CompletedProcess(a, code, out, ''))[1])
        self.assertEqual(A.harness_close_gate(config, item, runner=ok('{"ok": true, "blockers": []}')), (True, []))
        self.assertEqual(seen[0][2:], ['close-gate', 't3', '--provider', 'claude', '--session-id', item['session_id'], '--space-id', 'sp1'])
        self.assertEqual(A.harness_close_gate(config, item, runner=ok('{"ok": false, "blockers": ["x"]}')), (False, ['x']))
        self.assertFalse(A.harness_close_gate(config, item, runner=ok('not json'))[0])
        self.assertFalse(A.harness_close_gate(config, item, runner=ok('{"ok": true}', 2))[0])
        self.assertFalse(A.harness_close_gate({}, item)[0])


class LookupFailureTests(CleanupPolicyTests):
    """t1 decision 2026-11-05: one lookup timing out keeps only that space; an unreadable app at the
    start skips the cycle; neither is an observer error that stops apply."""

    def test_an_unreadable_app_at_the_start_skips_the_cycle(self):
        def boom(live):
            raise TimeoutError("Command ['herdr-core', 'ls', '--all', '--json'] timed out after 12 seconds")
        self.live.before_snapshot = boom
        with self.assertRaises(cleanup.agent_sessions.SkipCycle):
            self.cycle()
        self.assertEqual(self.live.closed, [])

    def test_a_failing_space_lookup_keeps_that_space_only(self):
        real = cleanup.inspect
        def inspect(space, snapshot, adapter, config):
            if space['id'] == 'temporary':
                raise TimeoutError('herdr-core get t2f timed out')
            return real(space, snapshot, adapter, config)
        state = self.ready_state()
        with patch.object(cleanup, 'inspect', inspect):
            result = cleanup.cycle(self.live, self.config, state, NOW, apply=True, report_dir=self.reports)
        got = {r['id']: r for r in result['results']}
        self.assertEqual(got['temporary']['action'], 'keep')
        self.assertIn('lookup failed: herdr-core get t2f timed out', got['temporary']['reasons'])
        self.assertEqual(self.live.closed, [])
        self.assertGreater(len(got), 1)   # the other spaces were still looked at

    def test_a_failing_recheck_keeps_the_space_without_an_error(self):
        state = self.ready_state()
        calls = {'n': 0}
        def second(live):
            calls['n'] += 1
            if calls['n'] == 2:
                raise TimeoutError('status timed out')
        self.live.before_snapshot = second
        got = self.cycle(state)['results'][0]
        self.assertEqual(got['action'], 'keep')
        self.assertTrue(any(r.startswith('recheck lookup failed') for r in got['reasons']), got['reasons'])
        self.assertEqual(self.live.closed, [])


class TrialRecoveryTests(unittest.TestCase):
    def test_an_error_stops_apply_until_three_healthy_cycles_in_a_row(self):
        settle = cleanup.agent_sessions.settle_trial
        state = {'trial': {'started_at': 1, 'samples': 5, 'error_count': 0}}
        settle(state, {}, ok=False)
        self.assertEqual(state['trial']['error_count'], 1)
        settle(state, {}, ok=True); settle(state, {}, ok=True)
        self.assertEqual(state['trial']['error_count'], 1)
        settle(state, {}, ok=False)                      # a new error restarts the streak
        for _ in range(2):
            settle(state, {}, ok=True)
        self.assertEqual(state['trial']['error_count'], 2)
        settle(state, {}, ok=True)
        self.assertEqual(state['trial']['error_count'], 0)
        state = {'trial': {'error_count': 1, 'healthy': 0}}
        settle(state, {'error_reset_after': 1}, ok=True)
        self.assertEqual(state['trial']['error_count'], 0)

    def test_the_streak_survives_the_next_cycle(self):
        trial = cleanup.agent_sessions.trial_of({'trial': {'started_at': 5, 'samples': 2, 'error_count': 1, 'healthy': 2}}, 9, True)
        self.assertEqual((trial['error_count'], trial['healthy'], trial['samples']), (1, 2, 3))


class LiveSnapshotLookupTests(unittest.TestCase):
    """Re-review P2 (1), its fixture: the real Live.snapshot with run() replaced, `get t-bad` timing out."""

    def test_one_terminal_timing_out_is_marked_and_the_others_are_read(self):
        import subprocess
        def run(argv, **kw):
            argv = [str(a) for a in argv]
            if argv[1:] == ['status']:
                return json.dumps({'space': 's1', 'tab': 'tb1', 'focused_pane': 'p1'})
            if argv[1:] == ['ls']:
                return json.dumps({'spaces': []})
            if argv[1:3] == ['ls', '--all']:
                return json.dumps({'terminals': [{'address': 't-ok', 'state': 'live'}, {'address': 't-bad', 'state': 'live'}]})
            if argv[1:3] == ['get', 't-bad']:
                raise subprocess.TimeoutExpired(argv, 12)
            if argv[1:3] == ['get', 't-ok']:
                return json.dumps({'address': 't-ok', 'pid': 1})
            raise AssertionError(argv)
        with patch.object(cleanup, 'run', run), patch.object(cleanup, 'process_rows', lambda: {}):
            snap = cleanup.Live('herdr-app', 'herdr-core').snapshot()
        self.assertEqual(list(snap['terminals']), ['t-ok'])
        self.assertIn('t-bad', snap['lookup_errors'])
        space = {'id': 'sp', 'name': 'Temp', 'machine': None, 'tabs': [{'id': 'tb', 'terminals': [{'terminal': 't-bad'}]}]}
        got = cleanup.inspect(space, {**snap, 'status': {**snap['status'], 'space': 'other'}}, None, {'fixed_names': [], 'fixed_spaces': []})
        self.assertFalse(got['safe'])
        self.assertTrue(any(r.startswith('t-bad: lookup failed') for r in got['reasons']), got['reasons'])


class RecheckTimeoutTests(CleanupPolicyTests):
    def test_a_recheck_inspect_timing_out_keeps_only_that_space(self):
        # Re-review P2 (2), its fixture: the first inspect works, the one right before acting times out.
        state = self.ready_state()
        real, calls = cleanup.inspect, {'n': 0}
        def inspect(space, snapshot, adapter, config):
            if space['id'] == 'temporary':
                calls['n'] += 1
                if calls['n'] == 2:
                    raise TimeoutError("Command ['herdr-core', 'get', 't2f', '--json'] timed out after 12 seconds")
            return real(space, snapshot, adapter, config)
        with patch.object(cleanup, 'inspect', inspect):
            got = self.cycle(state)['results'][0]
        self.assertEqual(calls['n'], 2)
        self.assertEqual(got['action'], 'keep')
        self.assertTrue(any(r.startswith('recheck lookup failed') for r in got['reasons']), got['reasons'])
        self.assertEqual(self.live.closed, [])


class SpaceLookupHoldTests(CleanupPolicyTests):
    """t1 (2026-11-05): the space observer holds its judgment the same way on a failed lookup."""

    def test_a_failed_lookup_keeps_the_space_idle_window(self):
        state = self.ready_state(quiet=300)
        since = state['spaces']['temporary']['since']
        real = cleanup.inspect
        def failing(space, snapshot, adapter, config):
            if space['id'] == 'temporary':
                raise TimeoutError('herdr-core get t2f timed out')
            return real(space, snapshot, adapter, config)
        with patch.object(cleanup, 'inspect', failing):
            got = self.cycle(state)['results'][0]
        self.assertIn(cleanup.agent_sessions.HOLD, got['reasons'])
        self.assertEqual(state['spaces']['temporary']['since'], since)
        self.assertEqual(self.live.closed, [])
        got = self.cycle(state, now=NOW + 400)['results'][0]               # 700 s unchanged in all
        self.assertGreaterEqual(got['quiet_seconds'], 600)
        self.assertEqual(self.live.closed, ['temporary'], got)

    def test_a_pane_lookup_error_in_the_space_is_held(self):
        state = self.ready_state(quiet=300)
        since = state['spaces']['temporary']['since']
        address = next(t['terminal'] for tab in self.target()['tabs'] for t in tab['terminals'])
        self.live.data['lookup_errors'] = {address: 'timed out'}
        got = self.cycle(state)['results'][0]
        self.assertIn(cleanup.agent_sessions.HOLD, got['reasons'])
        self.assertEqual(state['spaces']['temporary']['since'], since)
