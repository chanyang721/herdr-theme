"""Session sleep: who may sleep, the order of its steps, and how the pane comes back.
Isolated: no real app, core, harness, launchd or terminal is touched."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / 'scripts'))
import agent_sessions  # noqa: E402
import session_sleep_stub as stub  # noqa: E402
import sleep_idle_sessions as sleep  # noqa: E402

NOW = 1_800_000_000
SID = '11111111-2222-3333-4444-555555555555'
BORDER = '─' * 30
EMPTY = f'Done.\n{BORDER}\n❯ \n{BORDER}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n'


def snapshot():
    def pane(address, pane_id):
        return {'terminal': address, 'pane': pane_id, 'sub_agents': []}
    terminal = lambda address, pid: {  # noqa: E731
        'address': address, 'state': 'live', 'pid': pid, 'created_ms': 5, 'reported': True, 'title': 'PR 검토 마무리',
        'status': {'app': 'claude-code', 'state': 'done'}, 'status_ms': (NOW - 3600) * 1000, 'turn': 3,
        'cwd': '/fixture/repo', 'labels': {}, 'argv': ['/bin/zsh', '-l'], 'foreground': {'pid': pid + 1, 'argv': ['claude', '--dangerously-skip-permissions'], 'name': 'claude'}}
    return {
        'status': {'space': 'seen', 'tab': 'tab-seen', 'focused_pane': 'p-focus', 'errors': []},
        'spaces': [
            {'id': 'seen', 'name': 'Share', 'machine': None, 'active': True,
             'tabs': [{'id': 'tab-seen', 'terminals': [pane('t1', 'p-focus')]}]},
            {'id': 'fixed', 'name': 'Project B', 'machine': None, 'active': False,
             'tabs': [{'id': 'tab-fixed', 'terminals': [pane('t12', 'p12'), pane('t3', 'p3')]}]},
        ],
        'terminals': {'t1': terminal('t1', 100), 't12': terminal('t12', 200), 't3': terminal('t3', 300)},
        'processes': {pid: {'pid': pid, 'parent': parent, 'name': name, 'args': name} for pid, parent, name in
                      [(100, 1, 'zsh'), (101, 100, 'claude'), (200, 1, 'zsh'), (201, 200, 'claude'), (300, 1, 'zsh'), (301, 300, 'claude')]},
    }


class FakeLive:
    def __init__(self):
        self.data = snapshot()
        self.text = EMPTY
        self.calls = []
        self.park_ok = True
        self.exits = True
        self.jobs = (True, '', 'jobs')
        self.raw = ''
        self.reported = False

    def snapshot(self):
        return copy.deepcopy(self.data)

    def screen(self, address):
        return self.text

    def styled_screen(self, address):
        self.calls.append(('styled', address))
        return self.raw

    def backend(self, terminal, config, process_tree_clean=False):
        return self.jobs

    def git(self, folder):
        return {'branch': 'main', 'head': 'abc1234', 'uncommitted': 2, 'worktrees': 1}

    def park(self, config, item, event, reason=None):
        self.calls.append(('park', event, item['address']))
        return (True, 'REC1') if self.park_ok else (False, 'harness refused: denylist')

    def request_report(self, address, text):
        self.calls.append(('ask', address, text))

    def close_status(self, config, item, since):
        self.calls.append(('status', item['address'], since))
        return (True, {'report_id': 'REP1', 'task_id': 'TASK1'}) if self.reported else (False, 'no close report yet')

    def keys(self, address, *keys):
        self.calls.append(('keys', address, ''.join(k if len(k) == 1 else f'<{k}>' for k in keys)))

    def terminal(self, address):
        name = 'zsh' if self.exits else 'claude'
        return {'foreground': {'argv': [name], 'name': name}}

    def wait(self, seconds):
        pass

    def type_line(self, address, text):
        self.calls.append(('type', address, text))

    def label(self, address, **labels):
        self.calls.append(('label', address, labels))


class SleepTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.paths = {'notes': root / 'notes', 'tickets': root / 'tickets', 'stub': root / 'session_sleep_stub.py'}
        self.live = FakeLive()
        self.config = {'idle_seconds': 1200, 'exclude_addresses': ['t3'], 'user_approved_apply': True,
                       'reviewed_observer_sha256': 'code', 'close_report': {'enabled': False}}
        self.mapping = patch.object(agent_sessions, 'session_mapping', lambda t, c=None: ({'session_id': SID}, ''))
        self.mapping.start()
        self.addCleanup(self.mapping.stop)

    def state(self, quiet=1200):
        first = sleep.cycle(self.live, self.config, {'observer_sha256': 'code'}, NOW - quiet, apply=False, paths=self.paths)
        state = {'observer_sha256': 'code', 'last_at': NOW - 300, 'trial': {'started_at': NOW - 600, 'samples': 1, 'error_count': 0},
                 'sessions': {}}
        for r in first['results']:
            if r.get('fingerprint') and not [x for x in r['reasons'] if not x.startswith('unchanged')]:
                state['sessions'][r['address']] = {'since': NOW - quiet, 'fingerprint': r['fingerprint']}
        return state

    def run_cycle(self, state=None, apply=True):
        result = sleep.cycle(self.live, self.config, state if state is not None else self.state(), NOW, apply=apply, paths=self.paths)
        return {r['address']: r for r in result['results']}

    def test_visible_workspace_focused_pane_and_excluded_address_never_sleep(self):
        got = self.run_cycle()
        self.assertIn('shown on screen (visible tab)', got['t1']['reasons'])
        self.assertIn('focused pane', got['t1']['reasons'])
        self.assertIn('excluded address', got['t3']['reasons'])
        self.assertEqual(got['t12']['action'], 'slept')

    def test_other_tabs_of_the_shown_space_may_sleep_but_the_shown_tab_may_not(self):
        self.live.data['spaces'][0]['tabs'].append({'id': 'tab-other', 'terminals': [{'terminal': 't7', 'pane': 'p7', 'sub_agents': []}]})
        self.live.data['terminals']['t7'] = copy.deepcopy(self.live.data['terminals']['t12'])
        self.live.data['terminals']['t7'].update(address='t7', pid=700, foreground={'pid': 701, 'argv': ['claude'], 'name': 'claude'})
        self.live.data['processes'].update({700: {'pid': 700, 'parent': 1, 'name': 'zsh', 'args': 'zsh'},
                                           701: {'pid': 701, 'parent': 700, 'name': 'claude', 'args': 'claude'}})
        got = self.run_cycle()
        self.assertEqual(got['t7']['action'], 'slept')
        self.assertIn('shown on screen (visible tab)', got['t1']['reasons'])

    def test_a_pane_shown_in_a_float_never_sleeps(self):
        self.live.data['status']['floats'] = {'f1': {'terminal': 't12'}}
        got = self.run_cycle()
        self.assertIn('shown on screen (visible tab)', got['t12']['reasons'])
        self.assertNotIn(('keys', 't12', '/exit<enter>'), self.live.calls)

    def test_a_faint_claude_suggestion_is_not_input_but_typed_text_is(self):
        self.live.text = EMPTY.replace('❯ \n', '❯ 앱 다시 띄워서 반영해줘\n')
        self.live.raw = f'{BORDER}\r\n❯\xa0\x1b[0m\x1b[2m앱 다시 띄워서 반영해줘\x1b[0m\r\n{BORDER}'
        got = self.run_cycle()
        self.assertEqual(got['t12']['action'], 'slept')
        self.assertTrue(got['t12']['prompt_suggestion'])
        for raw in (f'❯\xa0\x1b[0m앱 다시 띄워서 반영해줘\r\n',                 # typed: plain
                    f'❯\xa0\x1b[2m앱 다시\x1b[22m 띄워서 반영해줘\r\n',          # partly typed
                    f'❯\xa0\x1b[2m다른 글\x1b[0m\r\n',                         # does not match the screen
                    ''):                                                          # attach gave nothing
            self.setUp()
            self.live.text = EMPTY.replace('❯ \n', '❯ 앱 다시 띄워서 반영해줘\n')
            self.live.raw = raw
            got = self.run_cycle()
            self.assertEqual(got['t12']['action'], 'keep', raw)
            self.assertIn('input not empty', got['t12']['reasons'])

    def test_a_suggestion_with_text_below_the_input_row_is_still_input(self):
        self.live.text = EMPTY.replace('❯ \n', '❯ 첫 줄\n  둘째 줄\n')
        self.live.raw = '❯\xa0\x1b[2m첫 줄\x1b[0m\r\n'
        got = self.run_cycle()
        self.assertIn('input not empty', got['t12']['reasons'])
        self.assertNotIn(('styled', 't12'), self.live.calls)

    def test_focus_moving_elsewhere_during_a_cycle_does_not_block_sleep(self):
        real = self.live.snapshot
        calls = {'n': 0}
        def moving():
            calls['n'] += 1
            data = real()
            if calls['n'] > 1:   # the person switched to another tab of Share after the cycle began
                data['status']['tab'] = 'tab-elsewhere'; data['status']['focused_pane'] = 'p-else'
            return data
        self.live.snapshot = moving
        got = self.run_cycle(state=self.state())
        self.assertEqual(got['t12']['action'], 'slept')

    def test_focus_moving_onto_the_candidate_keeps_it(self):
        state = self.state()
        real = self.live.snapshot
        def onto():
            data = real()
            data['status'].update(space='fixed', tab='tab-fixed', focused_pane='p12')
            return data
        self.live.snapshot = onto
        got = self.run_cycle(state=state)
        self.assertEqual(got['t12']['action'], 'keep')

    def test_a_child_session_without_a_session_file_is_named_and_kept(self):
        self.mapping.stop()
        with tempfile.TemporaryDirectory() as home, \
                patch.object(agent_sessions, 'inherited_child_session', lambda pid, reader=None: True):
            mapping, why = agent_sessions.session_mapping(self.live.data['terminals']['t12'], {'claude_home': home})
        self.mapping.start()
        self.assertIsNone(mapping)
        self.assertIn('cannot resume', why)
        env = 'claude CLAUDECODE=1 CLAUDE_CODE_CHILD_SESSION=1 HOME=/x'
        self.assertTrue(agent_sessions.inherited_child_session(1, reader=lambda p: env))
        self.assertFalse(agent_sessions.inherited_child_session(1, reader=lambda p: 'claude HOME=/x'))

    def test_a_child_session_reports_sleeps_and_wakes_as_a_new_session(self):
        # Opened inside another agent: no transcript, nothing to resume. It is parked under its pane
        # session id and its stub starts a new session (never the old first prompt again).
        self.mapping.stop()
        self.live.data['terminals']['t12']['foreground']['argv'] = ['claude', '사용자 요청: 오래된 첫 지시']
        self.live.jobs = (False, 'should not be asked', '')
        with patch.object(agent_sessions, 'session_mapping', lambda t, c=None: (None, 'cannot resume: Claude runs as an inherited child session (no session file or transcript)')), \
                patch.object(agent_sessions, 'inherited_child_session', lambda pid, reader=None: True):
            self.live.child = agent_sessions.child_session
            got = self.run_cycle()
        self.mapping.start()
        pane_sid = agent_sessions.pane_session_id('t12', 5, 201)
        self.assertEqual(got['t12']['action'], 'slept', got['t12']['reasons'])
        ticket = json.loads((self.paths['tickets'] / 't12.json').read_text())
        self.assertEqual((ticket['argv'], ticket['session_id'], ticket['new_session']), (['claude'], pane_sid, True))
        label = [c for c in self.live.calls if c[0] == 'label' and c[1] == 't12'][0][2]
        self.assertEqual((label['sixfold.sleep'], label['sixfold.sleep.new']), (f'claude:{pane_sid}', '1'))

    def test_an_agent_that_is_the_terminal_program_never_sleeps(self):
        # /exit would end the terminal and could remove the pane, maybe a space's last one.
        self.live.data['terminals']['t12']['argv'] = ['claude', '--resume', SID]
        got = self.run_cycle()
        self.assertIn('terminal program is not a shell: the pane would not survive /exit', got['t12']['reasons'])
        self.assertNotIn(('keys', 't12', '/exit<enter>'), self.live.calls)

    def test_sleep_never_closes_panes_tabs_or_spaces(self):
        self.run_cycle()
        self.assertIn(('keys', 't12', '/exit<enter>'), self.live.calls)
        self.assertFalse([c for c in self.live.calls if c[0] in ('close', 'kill', 'rm', 'pane.close', 'space.close')])
        with self.assertRaisesRegex(RuntimeError, 'workspaces are kept'):   # inherited close refuses too
            sleep.Live('herdr-app-not-run', 'hc-not-run').close('sp-any', self.config)

    def test_order_is_harness_then_exit_then_stub_then_labels(self):
        self.run_cycle()
        steps = [c for c in self.live.calls if c[1] == 't12' or (c[0] == 'park' and c[2] == 't12')]
        self.assertEqual([c[0] for c in steps], ['park', 'keys', 'type', 'label'])
        self.assertEqual(steps[1][2], '/exit<enter>')
        self.assertIn('session_sleep_stub.py', steps[2][2])
        self.assertEqual(steps[3][2]['sixfold.sleep'], f'claude:{SID}')
        self.assertTrue(steps[3][2]['sixfold.title'].startswith('절전'))
        ticket = json.loads((self.paths['tickets'] / 't12.json').read_text())
        self.assertEqual(ticket['argv'], ['claude', '--dangerously-skip-permissions', '--resume', SID])

    def test_no_harness_record_no_sleep(self):
        self.live.park_ok = False
        got = self.run_cycle()
        self.assertEqual(got['t12']['action'], 'keep')
        self.assertFalse([c for c in self.live.calls if c[0] in ('keys', 'type', 'label')])

    def test_dry_run_types_nothing(self):
        got = self.run_cycle(apply=False)
        self.assertEqual(got['t12']['action'], 'would_sleep')
        self.assertEqual(self.live.calls, [])

    def test_twenty_minutes_unchanged_is_required(self):
        got = self.run_cycle(self.state(quiet=1100))
        self.assertEqual(got['t12']['action'], 'keep')
        self.assertTrue(any(r.startswith('unchanged for 18 of 20') for r in got['t12']['reasons']), got['t12']['reasons'])

    def test_each_blocking_condition(self):
        cases = {
            'typed input': (lambda l: setattr(l, 'text', EMPTY.replace('❯ ', '❯ 이어서 확인해')), 'input not empty'),
            'approval text': (lambda l: setattr(l, 'text', 'waiting for your approval\n' + EMPTY), 'user decision pending'),
            'voice': (lambda l: setattr(l, 'text', EMPTY + '  🎙 Listening…\n'), 'voice input active'),
            'working': (lambda l: l.data['terminals']['t12']['status'].update(state='working'), 'not a confirmed idle/done agent'),
            'background job': (lambda l: setattr(l, 'jobs', (False, 'backend jobs unverified: Claude background job running', 'x')), 'background job running'),
            'child command': (lambda l: l.data['processes'].update({202: {'pid': 202, 'parent': 201, 'name': 'caffeinate', 'args': 'caffeinate -i'}}), 'caffeinate'),
            'subagent pane': (lambda l: l.data['spaces'][1]['tabs'][0]['terminals'][0].update(sub_agents=['x']), 'subagents shown'),
        }
        for name, (change, reason) in cases.items():
            with self.subTest(name):
                self.live = FakeLive()
                state = self.state()
                change(self.live)
                got = self.run_cycle(state)['t12']
                self.assertEqual(got['action'], 'keep')
                self.assertTrue(any(reason in r for r in got['reasons']), got['reasons'])
                self.assertFalse([c for c in self.live.calls if c[0] in ('keys', 'type', 'label')])

    def test_apply_needs_approval_of_this_exact_code(self):
        self.config['reviewed_observer_sha256'] = 'older-code'
        got = self.run_cycle()
        self.assertEqual(got['t12']['action'], 'keep')
        self.assertTrue(any('apply not approved' in r for r in got['t12']['reasons']))

    def test_agent_that_does_not_exit_is_recorded_back_and_stops_the_cycle(self):
        self.live.exits = False
        with self.assertRaises(RuntimeError):
            self.run_cycle()
        self.assertEqual([c[1] for c in self.live.calls if c[0] == 'park'], ['suspended', 'resumed'])
        self.assertFalse([c for c in self.live.calls if c[0] in ('type', 'label')])

    def test_already_asleep_pane_is_left_alone(self):
        self.live.data['terminals']['t12']['labels'] = {'sixfold.sleep': f'claude:{SID}'}
        got = self.run_cycle()
        self.assertEqual(got['t12']['action'], 'asleep')
        self.assertEqual(self.live.calls, [])


class CloseReportTests(unittest.TestCase):
    """Before it sleeps, the session reports itself (close-report); the observer only asks and checks."""
    state, run_cycle = SleepTests.state, SleepTests.run_cycle

    def setUp(self):
        SleepTests.setUp(self)
        self.config['close_report'] = {'timeout_seconds': 900, 'retry_seconds': 3600, 'settle_seconds': 120}

    def answer(self, state, minutes=3, turn_delta=1):
        """The session answered the request: one more turn, idle again since `minutes`."""
        t = self.live.data['terminals']['t12']
        t['turn'] += turn_delta
        t['status_ms'] = (NOW - minutes * 60) * 1000
        for r in sleep.cycle(self.live, self.config, state, NOW - minutes * 60 + 1, apply=False, paths=self.paths)['results']:
            if r['address'] == 't12' and r.get('fingerprint'):
                state['sessions']['t12'] = {'since': NOW - minutes * 60, 'fingerprint': r['fingerprint']}
        state['last_at'] = NOW - 60

    def test_first_cycle_asks_and_does_not_sleep(self):
        state = self.state()
        got = self.run_cycle(state)['t12']
        self.assertEqual(got['action'], 'report_requested')
        asks = [c for c in self.live.calls if c[0] == 'ask' and c[1] == 't12']
        self.assertEqual(len(asks), 1)
        self.assertTrue(asks[0][2].startswith(agent_sessions.REPORT_MARK))
        self.assertIn('close-report', asks[0][2])
        self.assertFalse([c for c in self.live.calls if c[0] in ('park', 'keys', 'label') and 't12' in c])
        self.assertEqual(state['reports']['t12']['session_id'], SID)

    def test_after_the_report_the_session_sleeps_without_another_twenty_minutes(self):
        state = self.state()
        self.run_cycle(state)
        self.live.calls.clear(); self.live.reported = True
        self.answer(state)
        got = self.run_cycle(state)['t12']
        self.assertEqual(got['action'], 'slept', got['reasons'])
        steps = [c[0] for c in self.live.calls if 't12' in c]
        self.assertEqual(steps[:3], ['status', 'park', 'keys'])
        self.assertNotIn('ask', steps)
        self.assertEqual(got['close_report'], 'REP1')
        self.assertNotIn('t12', state['reports'])

    def test_no_report_within_the_limit_keeps_the_session_and_does_not_ask_again_at_once(self):
        state = self.state()
        self.run_cycle(state)
        state['reports']['t12']['requested_at'] = NOW - 901
        self.answer(state)
        got = self.run_cycle(state)['t12']
        self.assertEqual(got['action'], 'keep')
        self.assertTrue(any('fail-closed' in r for r in got['reasons']), got['reasons'])
        self.assertFalse([c for c in self.live.calls if c[0] in ('park', 'keys', 'label') and 't12' in c])
        self.live.calls.clear()
        state['last_at'] = NOW - 60
        got = sleep.cycle(self.live, self.config, state, NOW + 60, apply=True, paths=self.paths)
        self.assertFalse([c for c in self.live.calls if c[0] == 'ask' and c[1] == 't12'])

    def test_waiting_within_the_limit_keeps_it(self):
        state = self.state()
        self.run_cycle(state)
        self.answer(state)
        got = self.run_cycle(state)['t12']
        self.assertEqual(got['action'], 'keep')
        self.assertIn('waiting for the session close report', got['reasons'])

    def test_work_after_the_request_needs_a_new_report(self):
        state = self.state()
        self.run_cycle(state)
        self.live.reported = True
        self.answer(state, turn_delta=3)   # the person kept working with it
        got = self.run_cycle(state)['t12']
        self.assertNotEqual(got['action'], 'slept')

    def test_typed_input_still_blocks_even_with_a_report(self):
        state = self.state()
        self.run_cycle(state)
        self.live.reported = True
        self.answer(state)
        self.live.text = EMPTY.replace('❯ ', '❯ 이어서')
        got = self.run_cycle(state)['t12']
        self.assertEqual(got['action'], 'keep')
        self.assertFalse([c for c in self.live.calls if c[0] in ('keys', 'label') and 't12' in c])

    def test_park_carries_the_report_task_and_masks(self):
        argv = []
        class R:
            returncode, stdout, stderr = 0, '{"id": "X"}', ''
        agent_sessions.harness_park({'harness': {'python': 'py', 'script': 'h.py'}},
                                    {'address': 't12', 'app': 'claude-code', 'session_id': SID, 'report_task_id': 'TASK1'},
                                    'suspended', runner=lambda a: argv.extend(a) or R())
        self.assertIn('--mask', argv)
        self.assertEqual(argv[argv.index('--task-id') + 1], 'TASK1')

    def test_close_status_parses_the_harness_answer(self):
        class R:
            returncode, stdout, stderr = 0, '{"ok": true, "report_id": "R", "task_id": "T"}', ''
        item = {'address': 't12', 'app': 'claude-code', 'session_id': SID}
        cfg = {'harness': {'python': 'py', 'script': 'h.py'}}
        self.assertEqual(agent_sessions.harness_close_status(cfg, item, 'S', runner=lambda a: R()),
                         (True, {'report_id': 'R', 'task_id': 'T'}))
        R.stdout = '{"ok": false}'
        self.assertEqual(agent_sessions.harness_close_status(cfg, item, 'S', runner=lambda a: R())[0], False)
        self.assertEqual(agent_sessions.harness_close_status({}, item, 'S')[0], False)


class EvidenceTests(unittest.TestCase):
    def rows(self, *extra):
        rows = {10: {'pid': 10, 'parent': 1, 'name': 'zsh', 'args': '-zsh'}, 11: {'pid': 11, 'parent': 10, 'name': 'codex', 'args': 'codex'}}
        for pid, parent, name, args in extra:
            rows[pid] = {'pid': pid, 'parent': parent, 'name': name, 'args': args}
        return rows

    def test_idle_codex_helpers_are_allowed(self):
        rows = self.rows((12, 11, 'node_repl', '/A/cua_node/bin/node_repl'), (13, 11, 'codex-code-mode-host', '/x/codex-code-mode-host'),
                         (14, 11, 'SkyComputerUseClient', '/x/SkyComputerUseClient computer-history mcp'),
                         (15, 11, 'node', '/A/cua_node/bin/node --import file:///x.mjs'))
        self.assertEqual(agent_sessions.process_evidence({'pid': 10, 'foreground': {'pid': 11}}, rows)[:2], (True, ''))

    def test_a_command_under_a_helper_is_still_work(self):
        rows = self.rows((13, 11, 'codex-code-mode-host', '/x/codex-code-mode-host'), (16, 13, 'zsh', '/bin/zsh -lc make test'))
        ok, why, _ = agent_sessions.process_evidence({'pid': 10, 'foreground': {'pid': 11}}, rows)
        self.assertFalse(ok)
        self.assertIn('zsh', why)

    def test_resume_keeps_flags_and_replaces_an_old_resume(self):
        self.assertEqual(agent_sessions.resume_argv('codex', ['codex', '--no-daemon', 'resume', 'old'], SID),
                         ['codex', '--no-daemon', 'resume', SID])
        self.assertEqual(agent_sessions.resume_argv('codex', ['/opt/homebrew/bin/codex', '--model', 'm', '--sandbox', 'x'], SID),
                         ['/opt/homebrew/bin/codex', '--model', 'm', '--sandbox', 'x', 'resume', SID])
        self.assertEqual(agent_sessions.resume_argv('claude-code', ['claude', '--resume', 'old', '--model', 'opus'], SID),
                         ['claude', '--model', 'opus', '--resume', SID])

    def test_pane_session_id_matches_the_harness_and_is_a_uuid(self):
        # the harness's runtime/lifecycle.pane_session_id('t38', 1, 2) gives the same value.
        self.assertEqual(agent_sessions.pane_session_id('t38', 1, 2), '901ebaf1-e70d-5c12-aff5-2ab7a207eba4')
        self.assertRegex(agent_sessions.pane_session_id('t1', 5, 6), agent_sessions.UUID)

    def test_cleanup_records_are_masked(self):
        self.assertIn('close-report --mask', agent_sessions.close_report_message({}))
        class R:
            returncode, stdout, stderr = 0, '{"ok": true, "archive": "A.json"}', ''
        seen = []
        ok, _ = agent_sessions.harness_archive({'harness': {'python': 'py', 'script': 'h.py'}}, {'workspace_id': 'm-sp'},
                                               runner=lambda a: seen.append(a) or R())
        self.assertTrue(ok)
        self.assertEqual(seen[0][-1], '--mask')
        self.assertEqual(agent_sessions.mask_text('Acme 정리 · ACME-2', ['acme']), '[가림] 정리 · [가림]-2')
        self.assertIn('새 세션', agent_sessions.summary({'session_id': SID, 'app': 'claude', 'address': 't1', 'no_resume': True})['remaining'])

    def test_summary_carries_no_paths(self):
        item = {'address': 't12', 'app': 'claude-code', 'session_id': SID, 'space_name': 'Project B',
                'title': 'edit /Users/someone/work/x.md', 'git': {'branch': 'main', 'head': 'abc', 'uncommitted': 0, 'worktrees': 1}}
        text = json.dumps(agent_sessions.summary(item), ensure_ascii=False)
        self.assertNotIn('/Users/', text)
        self.assertIn(f'claude --resume {SID}', text)

    def test_harness_failure_modes_are_not_ok(self):
        class R:
            def __init__(self, code, out='', err=''):
                self.returncode, self.stdout, self.stderr = code, out, err
        item = {'address': 't12', 'app': 'codex', 'session_id': SID, 'space_id': 'sp1'}
        cfg = {'harness': {'python': 'py', 'script': 'h.py'}}
        self.assertEqual(agent_sessions.harness_park({}, item, 'suspended')[0], False)
        self.assertEqual(agent_sessions.harness_park(cfg, item, 'suspended', runner=lambda a: R(2, err='invalid choice: park'))[0], False)
        self.assertEqual(agent_sessions.harness_park(cfg, item, 'suspended', runner=lambda a: R(0, 'not json'))[0], False)
        ok, rid = agent_sessions.harness_park(cfg, item, 'suspended', runner=lambda a: R(0, json.dumps({'id': 'REC'})))
        self.assertEqual((ok, rid), (True, 'REC'))
        seen = []
        agent_sessions.harness_park(cfg, item, 'suspended', runner=lambda a: seen.append(a) or R(0, '{"id":"x"}'))
        self.assertEqual(seen[0][2:4], ['park', 't12'])
        self.assertIn('--space-id', seen[0])


class StubTests(unittest.TestCase):
    def test_message_is_handed_over_as_the_first_prompt(self):
        ticket = {'argv': ['codex', '--no-daemon', 'resume', SID]}
        self.assertEqual(stub.command(ticket, ''), ['codex', '--no-daemon', 'resume', SID])
        self.assertEqual(stub.command(ticket, '<hc from="t3">이어서 해</hc>'), ['codex', '--no-daemon', 'resume', SID, '<hc from="t3">이어서 해</hc>'])

    def run_stub_in_pty(self, keys, icrnl=False):
        """The real stub in a real terminal whose CR→NL translation is off (as an exiting agent can
        leave it). The 'agent' it execs prints its argv and folder; `hc` is a fake on PATH."""
        import os, pty, select as sel, termios, time
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'bin').mkdir()
            fake_hc = root / 'bin/hc'
            fake_hc.write_text('#!/bin/sh\necho "$@" >> "' + str(root / 'hc.log') + '"\n'); fake_hc.chmod(0o755)
            agent = [sys.executable, '-c', 'import os,sys,json; print("AGENT", json.dumps([sys.argv[1:], os.getcwd()]))']
            ticket = root / 't13.json'
            ticket.write_text(json.dumps({'address': 't13', 'app': 'codex', 'session_id': SID, 'space_id': 'sp', 'cwd': str(root),
                                          'argv': agent + ['resume', SID], 'config': str(root / 'none.json'), 'title': 'x'}))
            pid, fd = pty.fork()
            if pid == 0:
                attrs = termios.tcgetattr(0)
                attrs[0] = attrs[0] | termios.ICRNL if icrnl else attrs[0] & ~termios.ICRNL
                termios.tcsetattr(0, termios.TCSANOW, attrs)
                os.environ['PATH'] = str(root / 'bin') + ':' + os.environ['PATH']
                os.execv(sys.executable, [sys.executable, str(Path(stub.__file__)), str(ticket)])
            out, end, sent = b'', time.time() + 15, False
            while time.time() < end:
                ready, _, _ = sel.select([fd], [], [], 0.1)
                if ready:
                    try:
                        chunk = os.read(fd, 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    out += chunk
                if not sent and b'ctrl+c' in out:
                    os.write(fd, keys); sent = True
                if b'AGENT' in out and out.rstrip().endswith(b']'):
                    break
            if not os.waitpid(pid, os.WNOHANG)[0]:
                os.kill(pid, 9); os.waitpid(pid, 0)   # a stub still waiting for Enter: the test fails, never hangs
            text = out.decode('utf-8', 'replace')
            self.assertNotIn('^M', text)
            line = text[text.index('AGENT ['):].splitlines()[0]
            labels = (root / 'hc.log').read_text() if (root / 'hc.log').exists() else ''
            args, cwd = json.loads(line[len('AGENT '):])
            return args, Path(cwd).resolve() == root.resolve(), labels

    def test_the_agent_starts_without_inherited_child_markers(self):
        env = {'CLAUDECODE': '1', 'CLAUDE_CODE_CHILD_SESSION': '1', 'HC_TERMINAL_ID': 't13', 'HERDR_PANE_ID': 'w1:p1', 'PATH': '/bin'}
        clean = stub.agent_env(env)
        self.assertEqual(clean, {'HC_TERMINAL_ID': 't13', 'PATH': '/bin'})

    def test_enter_as_a_bare_cr_resumes_in_the_original_folder_and_clears_labels(self):
        args, same_folder, labels = self.run_stub_in_pty(b'\r')
        self.assertEqual(args, ['resume', SID])
        self.assertTrue(same_folder)
        self.assertIn('label t13 sixfold.sleep= sixfold.title=', labels)

    def test_an_hc_send_message_is_handed_over_whole(self):
        # hc send: bracketed paste of the wrapped message, then Enter (a CR).
        msg = '<hc from="t3b">하네스 이어 열기 확인용입니다. 답만 하세요: OK</hc>'
        args, _, _ = self.run_stub_in_pty(('\x1b[200~' + msg + '\x1b[201~\r').encode())
        self.assertEqual(args, ['resume', SID, msg])
        long = '<hc from="t5">' + '가' * 1500 + '</hc>'    # longer than a macOS canonical line
        args, _, _ = self.run_stub_in_pty((long + '\r').encode(), icrnl=True)
        self.assertEqual(args, ['resume', SID, long])

    def test_message_text_is_cleaned_of_paste_markers_and_crs(self):
        self.assertEqual(stub.message_of(b'\x1b[200~a\r\nb\rc\x1b[201~\r'), 'a\nb\nc')
        self.assertEqual(stub.message_of(b'\r'), '')


class InstallTests(unittest.TestCase):
    def test_registers_its_own_label_in_dry_run_with_the_stub(self):
        import plistlib
        import install_session_sleep as installer
        with tempfile.TemporaryDirectory() as tmp:
            home, source = Path(tmp) / 'home', Path(tmp) / 'source'
            (source / 'scripts').mkdir(parents=True); (source / 'config').mkdir()
            for name in installer.SLEEP['files']:
                (source / 'scripts' / name).write_text(f'# {name}\n')
            (source / 'config/sleep-idle-sessions.example.json').write_text(json.dumps({'idle_seconds': 1200}))

            class Done:
                returncode = 0
            with patch.object(installer.common.subprocess, 'run', return_value=Done()):
                done = installer.install(home, source, execute=True)
            doc = plistlib.loads(Path(done['plist']).read_bytes())
            self.assertEqual(doc['Label'], 'local.herdr-sixfold.sleep-idle-sessions')
            self.assertIn('--dry-run', doc['ProgramArguments'])
            self.assertTrue((home / 'Library/Application Support/HerdrSixfold/session_sleep_stub.py').exists())
            self.assertEqual(installer.SLEEP['files'], sleep.OBSERVER_FILES)


if __name__ == '__main__':
    unittest.main()
