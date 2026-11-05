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
        self.close_stays = False

    def close_pane(self, pane_id):
        self.calls.append(('pane.close', pane_id))
        if self.close_stays:
            return
        for space in self.data['spaces']:
            for tab in space.get('tabs', []):
                gone = [t['terminal'] for t in tab['terminals'] if t.get('pane') == pane_id]
                tab['terminals'] = [t for t in tab['terminals'] if t.get('pane') != pane_id]
                for address in gone:
                    self.data['terminals'].pop(address, None)

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
            if r.get('fingerprint') and not [x for x in r['reasons'] if not x.startswith('unchanged') and x not in sleep.SLEEP_ONLY]:
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
        self.config['close_finished_panes'] = False   # the close path is in PaneCloseTests
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
            returncode, stdout, stderr = 0, '{"ok": true, "report_id": "R", "task_id": "T", "at": "2026-11-05T00:56:03Z"}', ''
        item = {'address': 't12', 'app': 'claude-code', 'session_id': SID}
        cfg = {'harness': {'python': 'py', 'script': 'h.py'}}
        self.assertEqual(agent_sessions.harness_close_status(cfg, item, 'S', runner=lambda a: R()),
                         (True, {'report_id': 'R', 'task_id': 'T', 'at': '2026-11-05T00:56:03Z'}))
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


class ReportGateTimingTests(unittest.TestCase):
    """Codex review 2026-11-05 P2: only a report written after the request, and within the limit, counts."""
    class Adapter:
        def __init__(self, report_at):
            self.report_at, self.asked = report_at, []

        def request_report(self, address, text):
            self.asked.append(address)

        def close_status(self, config, item, since):
            ok = agent_sessions.utc_iso(self.report_at) >= since   # what harness close-status compares
            return ((True, {'report_id': 'R', 'task_id': 'T', 'at': agent_sessions.utc_iso(self.report_at)}) if ok
                    else (False, 'no close report yet'))

    ITEM = {'address': 't12', 'session_id': SID, 'turn': 3}
    CONFIG = {'close_report': {'timeout_seconds': 900, 'retry_seconds': 3600}}

    def test_a_report_written_before_the_request_is_not_an_answer(self):
        now = 1_793_000_000.4
        adapter, entries = self.Adapter(report_at=now - 3), {}
        self.assertEqual(agent_sessions.report_gate(entries, dict(self.ITEM), adapter, self.CONFIG, now)[0], 'requested')
        self.assertEqual(agent_sessions.report_gate(entries, dict(self.ITEM), adapter, self.CONFIG, now + 60)[0], 'waiting')
        adapter.report_at = now + 30
        self.assertEqual(agent_sessions.report_gate(entries, dict(self.ITEM), adapter, self.CONFIG, now + 90)[0], 'ready')

    def test_a_report_after_the_limit_is_not_accepted(self):
        now = 1_793_000_000.0
        adapter, entries = self.Adapter(report_at=now + 901), {}
        agent_sessions.report_gate(entries, dict(self.ITEM), adapter, self.CONFIG, now)
        decision, detail = agent_sessions.report_gate(entries, dict(self.ITEM), adapter, self.CONFIG, now + 905)
        self.assertEqual(decision, 'failed')
        self.assertIn('fail-closed', detail)

    def test_a_report_written_in_time_counts_even_when_the_observer_looks_late(self):
        now = 1_793_000_000.0
        adapter, entries = self.Adapter(report_at=now + 50), {}
        agent_sessions.report_gate(entries, dict(self.ITEM), adapter, self.CONFIG, now)
        self.assertEqual(agent_sessions.report_gate(entries, dict(self.ITEM), adapter, self.CONFIG, now + 1200)[0], 'ready')

    def test_a_report_accepted_in_time_stays_ready_on_later_cycles(self):
        now = 1_793_000_000.0
        adapter, entries = self.Adapter(report_at=now + 30), {}
        agent_sessions.report_gate(entries, dict(self.ITEM), adapter, self.CONFIG, now)
        self.assertEqual(agent_sessions.report_gate(entries, dict(self.ITEM), adapter, self.CONFIG, now + 60)[0], 'ready')
        self.assertEqual(agent_sessions.report_gate(entries, dict(self.ITEM), adapter, self.CONFIG, now + 1000)[0], 'ready')


class AlreadyReportedTests(unittest.TestCase):
    """A session that already reported is not asked again, and its 'waiting in the
    memory window' answer is not a user decision."""
    Adapter = ReportGateTimingTests.Adapter
    CONFIG = ReportGateTimingTests.CONFIG

    def item(self, idle_since, turn=3):
        return {'address': 't38', 'session_id': SID, 'turn': turn, 'status_ms': int(idle_since * 1000)}

    def test_a_report_from_its_last_work_is_ready_without_asking(self):
        now = 1_793_000_000.0
        adapter = self.Adapter(report_at=now - 9 * 3600)            # reported at 09:56 for the other observer
        decision, detail = agent_sessions.report_gate({}, self.item(now - 9 * 3600 + 5), adapter, self.CONFIG, now)
        self.assertEqual((decision, adapter.asked), ('ready', []))

    def test_an_old_report_before_later_work_does_not_count(self):
        now = 1_793_000_000.0
        adapter = self.Adapter(report_at=now - 3 * 3600)
        decision, _ = agent_sessions.report_gate({}, self.item(now - 600), adapter, self.CONFIG, now)
        self.assertEqual((decision, adapter.asked), ('requested', ['t38']))

    def test_a_session_that_answered_an_earlier_request_points_to_its_older_report(self):
        now = 1_793_000_000.0
        adapter = self.Adapter(report_at=now - 3600)              # reported, then only answered requests
        item = {**self.item(now - 1800), 'answered_report': True}
        self.assertEqual((agent_sessions.report_gate({}, item, adapter, self.CONFIG, now)[0], adapter.asked), ('ready', []))

    def test_answering_a_pending_request_with_an_earlier_report_is_ready(self):
        # It answered with the id of the report it wrote an hour before this request.
        now = 1_793_000_000.0
        adapter, entries = self.Adapter(report_at=now - 3600), {}
        item = self.item(now - 60)
        entries['t38'] = {'session_id': SID, 'requested_at': now - 300, 'since': agent_sessions.utc_iso(now - 300), 'turn': 3}
        self.assertEqual(agent_sessions.report_gate(entries, item, adapter, self.CONFIG, now)[0], 'waiting')
        self.assertEqual(agent_sessions.report_gate(entries, {**item, 'answered_report': True}, adapter, self.CONFIG, now)[0], 'ready')

    def test_work_after_the_request_still_asks_again(self):
        now = 1_793_000_000.0
        adapter = self.Adapter(report_at=now + 10)
        entries = {}
        agent_sessions.report_gate(entries, self.item(now - 60), adapter, self.CONFIG, now)
        adapter.asked.clear()
        decision, _ = agent_sessions.report_gate(entries, self.item(now + 15, turn=6), adapter, self.CONFIG, now + 60)
        self.assertEqual((decision, adapter.asked), ('requested', ['t38']))

    SCREEN = ('❯ [세션 정리 보고 요청] 관찰기가 이 세션을 곧 정리(절전)합니다. 새 작업은 시작하지 말고 아래만 하세요.\n'
              '  다른 세션에 보고하지 말고, 보고 id만 한 줄로 답하고 끝내세요. 승인은 사람이 기억함에서 합니다.\n'
              '⏺ 01ARZ3NDEKTSV4RRFFQ69G5FAV (이미 제출함, 기억함에서 승인 대기 중)\n'
              '✻ Cogitated for 4s · done 오전 10:21\n────────\n❯ \n────────\n  ⏵⏵ auto mode on\n')

    def test_the_memory_window_answer_is_not_a_user_decision(self):
        self.assertFalse(sleep.spaces.decision_pending(self.SCREEN))
        self.assertTrue(sleep.spaces.decision_pending(self.SCREEN + '사용자 승인 대기: 배포 범위\n'))
        self.assertTrue(sleep.spaces.decision_pending('Do you want to proceed?\n❯ 1. Yes\n'))


class ProcessTableDecodeTests(unittest.TestCase):
    def test_ps_args_cut_mid_character_do_not_fail_the_observer(self):
        # ps truncates long args by bytes; a Korean prompt can end in half a character.
        cut = '세션 절전'.encode('utf-8')[:-1]
        outputs = {'pid=,ppid=,comm=': b'  10     1 /usr/local/bin/claude\n',
                   'pid=,args=': b'  10 claude ' + cut + b'\n'}

        class Done:
            def __init__(self, out):
                self.returncode, self.stderr = 0, ''
                self.stdout = out.decode('utf-8', 'replace')

        def fake_run(argv, **kwargs):
            self.assertEqual((kwargs.get('encoding'), kwargs.get('errors')), ('utf-8', 'replace'))
            return Done(outputs[argv[2]])

        with patch.object(agent_sessions.subprocess, 'run', fake_run):
            rows = agent_sessions.process_table()
        self.assertEqual(rows[10]['name'], 'claude')
        self.assertTrue(rows[10]['args'].startswith('claude 세션 절'))



class TicketArgvTests(unittest.TestCase):
    """Waking a pane must not send the original command-line prompts again (2026-11-05, ticket t11)."""
    OLD = ['claude', '<hc from="t3">11/4 요청 …', '<hc from="t3">번역 확인 …', '--resume', 'old-id']

    def test_claude_prompts_and_one_shot_flags_are_dropped(self):
        argv = ['/x/claude', '--dangerously-skip-permissions', '--model', 'opus', '--add-dir', '/a', '/b',
                '첫 지시 문장', '-p', '--output-format', 'json', '--continue', '--session-id', 'z']
        self.assertEqual(agent_sessions.resume_argv('claude-code', argv, SID),
                         ['/x/claude', '--dangerously-skip-permissions', '--model', 'opus', '--add-dir', '/a', '/b', '--resume', SID])
        self.assertEqual(agent_sessions.resume_argv('claude-code', self.OLD, SID), ['claude', '--resume', SID])

    def test_codex_prompt_dropped_flags_kept(self):
        self.assertEqual(agent_sessions.resume_argv('codex', ['codex', '--no-daemon', '-m', 'gpt-5', '고쳐 줘', 'resume', 'old'], SID),
                         ['codex', '--no-daemon', '-m', 'gpt-5', 'resume', SID])

    def test_ticket_written_by_observer_has_no_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            item = {'address': 't11', 'app': 'claude-code', 'session_id': SID, 'argv': self.OLD, 'space_id': 'sp', 'space_name': 'Project'}
            data = json.loads(sleep.ticket(item, tmp).read_text(encoding='utf-8'))
        self.assertEqual(data['argv'], ['claude', '--resume', SID])

    def test_old_ticket_is_cleaned_when_woken_and_screen_is_short(self):
        ticket = {'app': 'claude-code', 'session_id': SID, 'argv': self.OLD + [SID]}
        self.assertEqual(stub.command(ticket, None), ['claude', '--resume', SID])
        self.assertEqual(stub.command(ticket, '새 메시지'), ['claude', '--resume', SID, '새 메시지'])
        self.assertEqual(stub.shown(stub.launch(ticket)), f'claude --resume {SID}')
        self.assertLessEqual(len(stub.shown(['claude', *['--add-dir', '/very/long/path'] * 20])), 72)

    def test_new_session_ticket_left_as_written(self):
        self.assertEqual(stub.command({'app': 'claude-code', 'session_id': SID, 'argv': ['claude'], 'new_session': True}, None), ['claude'])


def add_pane(live, space, tab, address, pid, pane_id, shell=True):
    """Another finished Claude pane like t12, in live.data['spaces'][space]['tabs'][tab]."""
    live.data['spaces'][space]['tabs'][tab]['terminals'].append({'terminal': address, 'pane': pane_id, 'sub_agents': []})
    t = copy.deepcopy(live.data['terminals']['t12'])
    t.update(address=address, pid=pid, foreground={'pid': pid + 1, 'argv': ['claude'], 'name': 'claude'})
    if not shell:
        t['argv'] = ['claude', '--resume', SID]
    live.data['terminals'][address] = t
    live.data['processes'].update({pid: {'pid': pid, 'parent': 1, 'name': 'zsh' if shell else 'claude', 'args': 'x'},
                                   pid + 1: {'pid': pid + 1, 'parent': pid, 'name': 'claude', 'args': 'claude'}})


class PaneCloseTests(unittest.TestCase):
    """A session that finished through the harness (its final report found) closes its pane;
    every space keeps at least one pane (user rule, 2026-11-05)."""
    state, run_cycle = SleepTests.state, SleepTests.run_cycle

    def setUp(self):
        SleepTests.setUp(self)
        self.config['close_report'] = {'timeout_seconds': 900, 'retry_seconds': 3600, 'settle_seconds': 120}
        self.live.reported = True   # the harness finds its final report: 'ready'

    def steps(self, address):
        return [c for c in self.live.calls if address in c or (c[0] == 'pane.close')]

    def test_a_finished_session_in_a_space_with_another_pane_is_closed(self):
        got = self.run_cycle()['t12']
        self.assertEqual(got['action'], 'closed', got['reasons'])
        self.assertIn(('pane.close', 'p12'), self.live.calls)
        self.assertEqual([c[1] for c in self.live.calls if c[0] == 'park'], ['close_requested', 'closed'])
        order = [c[0] for c in self.live.calls if c[0] in ('park', 'pane.close')]
        self.assertEqual(order, ['park', 'pane.close', 'park'])
        self.assertFalse([c for c in self.live.calls if c[0] in ('keys', 'type', 'label')])
        self.assertNotIn('t12', pane_of_names(self.live))
        self.assertIn('t3', pane_of_names(self.live))
        self.assertTrue(Path(got['note']).exists())

    def test_the_last_pane_of_its_space_sleeps_instead(self):
        self.live.data['spaces'][1]['tabs'][0]['terminals'].pop()   # t3 gone: t12 is alone
        got = self.run_cycle()['t12']
        self.assertEqual(got['action'], 'slept', got['reasons'])
        self.assertFalse([c for c in self.live.calls if c[0] == 'pane.close'])
        self.assertIn('last pane in its space: slept instead of closed', got['reasons'])

    def test_two_finished_sessions_in_a_two_pane_space_keep_one_pane(self):
        self.config['exclude_addresses'] = []
        got = self.run_cycle()
        self.assertEqual((got['t12']['action'], got['t3']['action']), ('closed', 'slept'))
        self.assertEqual([c for c in self.live.calls if c[0] == 'pane.close'], [('pane.close', 'p12')])
        self.assertEqual(pane_of_names(self.live) & {'t12', 't3'}, {'t3'})

    def test_no_harness_record_no_close(self):
        self.live.park_ok = False
        got = self.run_cycle()['t12']
        self.assertEqual(got['action'], 'keep')
        self.assertTrue(any(r.startswith('harness record failed') for r in got['reasons']))
        self.assertFalse([c for c in self.live.calls if c[0] in ('pane.close', 'keys')])

    def test_a_pane_still_there_after_close_stops_everything(self):
        self.live.close_stays = True
        with self.assertRaisesRegex(RuntimeError, 'still present after pane.close'):
            self.run_cycle()
        # the open close_requested is settled, never left half closed (t1 decision 2026-11-05)
        self.assertEqual([c[1] for c in self.live.calls if c[0] == 'park'], ['close_requested', 'close_aborted'])

    def park_then(self, change, fail_closed=0):
        """Run `change` while the harness records close_requested; fail the next `closed` records."""
        real = self.live.park
        left = {'n': fail_closed}
        def park(config, item, event, reason=None):
            got = real(config, item, event, reason)
            if event == 'close_requested' and change:
                change()
            if event == 'closed' and left['n'] > 0:
                left['n'] -= 1
                return False, 'storage unavailable'
            return got
        self.live.park = park

    def test_work_input_or_focus_that_starts_while_parking_keeps_the_pane(self):
        # Codex review HOLD P1 (2026-11-05): the safety checks ran before the park, not before pane.close.
        changes = {
            'working': lambda: self.live.data['terminals']['t12']['status'].update(state='working'),
            'input': lambda: setattr(self.live, 'text', EMPTY.replace('❯ ', '❯ 이어서 할 일')),
            'focus': lambda: self.live.data['status'].update(focused_pane='p12'),
            'last pane': lambda: self.live.data['spaces'][1]['tabs'][0]['terminals'].pop(),
        }
        for name, change in changes.items():
            with self.subTest(name):
                self.setUp()
                self.park_then(change)
                got = self.run_cycle()['t12']
                self.assertFalse([c for c in self.live.calls if c[0] == 'pane.close'], got['reasons'])
                self.assertEqual(got['action'], 'keep')
                self.assertTrue(any(r.startswith('recheck before close') for r in got['reasons']), got['reasons'])
                self.assertEqual([c[1] for c in self.live.calls if c[0] == 'park'], ['close_requested', 'close_aborted'])
                self.assertIn('t12', pane_of_names(self.live))

    def test_a_failed_closed_record_is_not_reported_as_closed_and_is_retried(self):
        # Codex review HOLD P2: park closed failing was taken as success and nothing retried it.
        self.config['exclude_addresses'] = []
        self.live.data['spaces'][1]['tabs'][0]['terminals'].append({'terminal': 't7', 'pane': 'p7', 'sub_agents': []})
        self.live.data['terminals']['t7'] = copy.deepcopy(self.live.data['terminals']['t3'])
        self.live.data['terminals']['t7']['address'] = 't7'
        self.park_then(None, fail_closed=2)
        state = self.state()
        got = {r['address']: r for r in sleep.cycle(self.live, self.config, state, NOW, apply=True, paths=self.paths)['results']}
        self.assertEqual(got['t12']['action'], 'closed_unrecorded')
        self.assertNotIn('t12', pane_of_names(self.live))
        self.assertTrue(any('closed record failed' in r for r in got['t12']['reasons']))
        self.assertEqual([c for c in self.live.calls if c[0] == 'pane.close'], [('pane.close', 'p12')])  # nothing more
        self.assertEqual([e['address'] for e in state['unrecorded_closes']], ['t12'])
        # next cycle: the record is retried first; it lands and the list empties
        self.live.calls.clear()
        state['last_at'] = NOW - 300
        sleep.cycle(self.live, self.config, state, NOW, apply=True, paths=self.paths)
        self.assertEqual([c for c in self.live.calls if c[0] == 'park'][0], ('park', 'closed', 't12'))
        self.assertEqual(state['unrecorded_closes'], [])

    def test_while_a_closed_record_is_missing_nothing_else_acts(self):
        state = self.state()
        state['unrecorded_closes'] = [{'address': 't99', 'app': 'claude-code', 'session_id': SID, 'space_id': 'fixed'}]
        self.live.park_ok = False
        got = {r['address']: r for r in sleep.cycle(self.live, self.config, state, NOW, apply=True, paths=self.paths)['results']}
        self.assertFalse([c for c in self.live.calls if c[0] in ('pane.close', 'keys', 'ask')])
        self.assertTrue(any('without a harness record' in r for r in got['t12']['reasons']))
        self.assertEqual(len(state['unrecorded_closes']), 1)

    def test_an_unrecorded_close_survives_an_exception_later_in_the_cycle(self):
        # Codex re-review P2 (1): the retry list was put into the state only at the cycle's end.
        self.config['exclude_addresses'] = []
        self.park_then(None, fail_closed=2)
        real_focus = sleep.spaces.focus
        def focus(status):
            if ('pane.close', 'p12') in self.live.calls:
                raise RuntimeError('focus read failed')
            return real_focus(status)
        state = self.state()
        with patch.object(sleep.spaces, 'focus', focus):
            with self.assertRaisesRegex(RuntimeError, 'focus read failed'):
                sleep.cycle(self.live, self.config, state, NOW, apply=True, paths=self.paths)
        self.assertNotIn('t12', pane_of_names(self.live))
        self.assertEqual([(e['address'], e['pending']) for e in state['unrecorded_closes']], [('t12', 'unrecorded')])
        self.live.calls[:] = []
        state['last_at'] = NOW - 300
        sleep.cycle(self.live, self.config, state, NOW, apply=True, paths=self.paths)
        self.assertIn(('park', 'closed', 't12'), self.live.calls)
        self.assertEqual(state['unrecorded_closes'], [])

    def test_a_layout_unreadable_right_after_pane_close_is_not_recorded_as_aborted(self):
        # Codex re-review P2 (2): pane.close worked, only the snapshot failed -> it said close_aborted.
        real_close, real_snapshot = self.live.close_pane, self.live.snapshot
        broken = {'on': False}
        def close_pane(pane_id):
            real_close(pane_id)
            broken['on'] = True
        def snapshot():
            if broken['on']:
                raise RuntimeError('herdr-app status failed')
            return real_snapshot()
        self.live.close_pane, self.live.snapshot, self.live.wait = close_pane, snapshot, lambda s: None
        state = self.state()
        got = {r['address']: r for r in sleep.cycle(self.live, self.config, state, NOW, apply=True, paths=self.paths)['results']}
        self.assertEqual(got['t12']['action'], 'close_unconfirmed')
        self.assertEqual([c[1] for c in self.live.calls if c[0] == 'park'], ['close_requested'])   # no close_aborted
        self.assertEqual([(e['address'], e['pending']) for e in state['unrecorded_closes']], [('t12', 'unconfirmed')])
        # next cycle: the layout says it is gone -> closed
        broken['on'], self.live.calls[:] = False, []
        state['last_at'] = NOW - 300
        sleep.cycle(self.live, self.config, state, NOW, apply=True, paths=self.paths)
        self.assertEqual([c for c in self.live.calls if c[0] == 'park'][0], ('park', 'closed', 't12'))
        self.assertEqual(state['unrecorded_closes'], [])

    def test_an_unconfirmed_close_whose_pane_is_still_there_is_settled_as_aborted(self):
        state = self.state()
        state['unrecorded_closes'] = [{'address': 't12', 'app': 'claude-code', 'session_id': SID, 'space_id': 'fixed',
                                       '_pane_id': 'p12', 'pending': 'unconfirmed'}]
        sleep.cycle(self.live, self.config, state, NOW, apply=True, paths=self.paths)
        self.assertEqual([c for c in self.live.calls if c[0] == 'park'][0], ('park', 'close_aborted', 't12'))
        self.assertEqual(state['unrecorded_closes'], [])

    def test_an_unreadable_app_at_the_start_skips_the_cycle(self):
        def boom():
            raise TimeoutError("Command ['herdr-core', 'ls', '--all', '--json'] timed out after 12 seconds")
        state = self.state()
        self.live.snapshot = boom
        with self.assertRaises(sleep.agent_sessions.SkipCycle):
            sleep.cycle(self.live, self.config, state, NOW, apply=True, paths=self.paths)
        self.assertFalse([c for c in self.live.calls if c[0] in ('pane.close', 'keys', 'ask', 'park')])

    def test_one_pane_lookup_timing_out_keeps_only_that_pane(self):
        real = sleep.inspect
        def inspect(address, *a, **k):
            if address == 't3':
                raise TimeoutError("Command ['herdr-core', 'get', 't3', '--json'] timed out after 12 seconds")
            return real(address, *a, **k)
        state = self.state()
        with patch.object(sleep, 'inspect', inspect):
            got = {r['address']: r for r in sleep.cycle(self.live, self.config, state, NOW, apply=True, paths=self.paths)['results']}
        self.assertEqual(got['t3']['action'], 'keep')
        self.assertTrue(got['t3']['reasons'][0].startswith('lookup failed:'))
        self.assertEqual(got['t12']['action'], 'closed', got['t12']['reasons'])   # the others go on

    def test_a_recheck_lookup_failure_before_close_settles_and_keeps(self):
        self.park_then(lambda: setattr(self.live, 'snapshot', lambda: (_ for _ in ()).throw(TimeoutError('ls timed out'))))
        got = self.run_cycle()['t12']
        self.assertEqual(got['action'], 'keep')
        self.assertFalse([c for c in self.live.calls if c[0] == 'pane.close'])
        self.assertEqual([c[1] for c in self.live.calls if c[0] == 'park'], ['close_requested', 'close_aborted'])

    def test_main_skips_without_counting_an_error_and_errors_clear_after_healthy_cycles(self):
        import io, contextlib
        folder = Path(self.paths['notes']).parent
        config_path, state_path, log = folder / 'c.json', folder / 's.json', folder / 'l.jsonl'
        config_path.write_text(json.dumps({**self.config, 'idle_seconds': 1200}))
        state_path.write_text(json.dumps({'observer_sha256': sleep.observer_sha256(Path(sleep.__file__).parent),
                                          'trial': {'started_at': NOW, 'samples': 3, 'error_count': 1, 'healthy': 0}}))
        class Broken:
            def __init__(self, *a): pass
            def snapshot(self):
                raise TimeoutError('ls timed out')
        argv = ['sleep', '--config', str(config_path), '--state', str(state_path), '--log', str(log), '--data', str(folder), '--dry-run']
        with patch.object(sleep, 'Live', Broken), patch.object(sys, 'argv', argv), contextlib.redirect_stdout(io.StringIO()):
            sleep.main()
        self.assertEqual(json.loads(state_path.read_text())['trial']['error_count'], 1)   # skipped: not counted
        self.assertIn('skipped', json.loads(log.read_text().splitlines()[-1]))
        with patch.object(sleep, 'Live', lambda *a: self.live), patch.object(sys, 'argv', argv), contextlib.redirect_stdout(io.StringIO()):
            for _ in range(3):
                sleep.main()
        self.assertEqual(json.loads(state_path.read_text())['trial']['error_count'], 0)

    def test_a_long_gap_does_not_clear_an_earlier_error(self):
        # Re-review P2 (3), its fixture: error_count 1, then a 900 s gap (over max_sample_gap_seconds).
        state = self.state()
        state['trial'] = {'started_at': NOW - 3000, 'samples': 5, 'error_count': 1, 'healthy': 0}
        readiness = []
        for i in range(4):
            state['last_at'] = NOW - (900 if i == 0 else 300)
            self.live.calls.clear()
            out = sleep.cycle(self.live, self.config, state, NOW, apply=True, paths=self.paths)
            sleep.agent_sessions.settle_trial(state, self.config, ok=True)
            readiness.append(out['apply_ready'])
            if i < 3:
                self.assertFalse([c for c in self.live.calls if c[0] in ('pane.close', 'keys')], i)
        self.assertEqual(readiness, [False, False, False, True])   # only after three healthy cycles in a row
        self.assertEqual(state['trial']['error_count'], 0)

    def test_a_failing_pane_close_is_settled_with_close_aborted_and_stops(self):
        def boom(pane_id):
            self.live.calls.append(('pane.close', pane_id))
            raise RuntimeError('herdr-app do pane.close: exit 1')
        self.live.close_pane = boom
        with self.assertRaisesRegex(RuntimeError, 'still present after pane.close .herdr-app do pane.close: exit 1'):
            self.run_cycle()
        self.assertEqual([c[1] for c in self.live.calls if c[0] == 'park'], ['close_requested', 'close_aborted'])
        self.assertIn('t12', pane_of_names(self.live))

    def test_the_last_pane_of_a_hidden_tab_is_not_closed_even_if_the_space_keeps_others(self):
        # t1 decision 2026-11-05: a space keeps one pane and every tab keeps one (harness close gate).
        tabs = self.live.data['spaces'][1]['tabs']
        t3 = tabs[0]['terminals'].pop()
        tabs.append({'id': 'tab-other', 'terminals': [t3]})   # t12 and t3 alone in their own tabs
        got = self.run_cycle()['t12']
        self.assertFalse([c for c in self.live.calls if c[0] == 'pane.close'])
        self.assertEqual(got['action'], 'slept', got['reasons'])
        self.assertIn('last pane in its tab: slept instead of closed', got['reasons'])

    def test_switched_off_it_sleeps(self):
        self.config['close_finished_panes'] = False
        got = self.run_cycle()['t12']
        self.assertEqual(got['action'], 'slept')
        self.assertFalse([c for c in self.live.calls if c[0] == 'pane.close'])

    def test_close_reports_off_never_close(self):
        self.config['close_report'] = {'enabled': False}
        self.assertEqual(self.run_cycle()['t12']['action'], 'slept')
        self.assertFalse([c for c in self.live.calls if c[0] == 'pane.close'])

    def test_live_close_pane_closes_by_id_only(self):
        argv = []
        with patch.object(sleep.spaces, 'run', lambda a, timeout=12: argv.extend(a) or '{}'):
            sleep.Live('herdr-app', 'hc').close_pane('p12')
            with self.assertRaises(RuntimeError):
                sleep.Live('herdr-app', 'hc').close_pane(None)
        self.assertEqual(argv, ['herdr-app', 'do', 'pane.close', '{"pane": "p12"}'])

    def test_dry_run_types_nothing_and_says_what_it_would_do(self):
        got = self.run_cycle(apply=False)
        self.assertEqual(got['t12']['action'], 'would_sleep')   # finished not known without asking
        self.assertTrue(got['t12']['close_if_finished'])
        self.assertEqual(self.live.calls, [])
        state = self.state()
        state['reports'] = {'t12': {'session_id': SID, 'requested_at': NOW - 600, 'since': 'x', 'turn': 3,
                                    'report': {'report_id': 'REP1'}}}
        got = self.run_cycle(state, apply=False)
        self.assertEqual(got['t12']['action'], 'would_close')
        self.assertFalse([c for c in self.live.calls if c[0] in ('ask', 'keys', 'type', 'pane.close')])

    # E(1): closing does not need a shell under the agent
    def test_a_finished_agent_that_is_the_terminal_program_is_closed(self):
        self.live.data['terminals']['t12']['argv'] = ['claude', '--resume', SID]
        self.live.data['processes'][200]['name'] = 'claude'
        got = self.run_cycle()['t12']
        self.assertEqual(got['action'], 'closed', got['reasons'])
        self.assertFalse([c for c in self.live.calls if c[0] == 'keys'])

    def test_a_non_shell_last_pane_is_kept_after_its_report(self):
        self.live.data['spaces'][1]['tabs'][0]['terminals'].pop()
        self.live.data['terminals']['t12']['argv'] = ['claude', '--resume', SID]
        self.live.data['processes'][200]['name'] = 'claude'
        got = self.run_cycle()['t12']
        self.assertEqual(got['action'], 'reported', got['reasons'])
        self.assertFalse([c for c in self.live.calls if c[0] in ('keys', 'pane.close', 'label')])
        self.assertTrue(any('last pane in its space' in r for r in got['reasons']))

    # E(2): the shown tab does not block closing a finished session; the focused pane does
    def test_a_finished_session_in_the_shown_tab_is_closed_but_never_the_focused_pane(self):
        add_pane(self.live, 0, 0, 't5', 500, 'p5')    # Share, shown tab, beside the focused t1
        got = self.run_cycle()
        self.assertEqual(got['t5']['action'], 'closed', got['t5']['reasons'])
        self.assertIn(('pane.close', 'p5'), self.live.calls)
        self.assertIn('focused pane', got['t1']['reasons'])
        self.assertFalse([c for c in self.live.calls if c[1:2] == ('t1',) or 'p-focus' in c])

    def test_the_shown_tab_still_blocks_sleep_and_its_last_pane_is_not_closed(self):
        self.live.data['status']['focused_pane'] = 'p-float'   # focus elsewhere, t1 alone in the shown tab
        self.live.data['spaces'][0]['tabs'].append({'id': 'tab-2', 'terminals': []})
        add_pane(self.live, 0, 1, 't5', 500, 'p5')
        got = self.run_cycle()['t1']
        self.assertEqual(got['action'], 'reported', got['reasons'])
        self.assertTrue(any('last pane in its tab' in r for r in got['reasons']))
        self.assertFalse([c for c in self.live.calls if c in (('pane.close', 'p-focus'),) or c[:2] == ('keys', 't1')])

    def test_typed_input_or_a_float_blocks_closing_and_asking(self):
        add_pane(self.live, 0, 0, 't5', 500, 'p5')
        for name, change in {'input': lambda: setattr(self.live, 'text', EMPTY.replace('❯ ', '❯ 이어서')),
                             'float': lambda: self.live.data['status'].update(floats={'f': {'terminal': 't5'}})}.items():
            with self.subTest(name):
                self.live.calls.clear()
                self.live.text = EMPTY
                self.live.data['status'].pop('floats', None)
                state = self.state()
                change()
                got = self.run_cycle(state)['t5']
                self.assertEqual(got['action'], 'keep')
                self.assertFalse([c for c in self.live.calls if c[0] in ('ask', 'pane.close') and ('t5' in c or 'p5' in c)])

    # E(3): the report is collected even when the session will be kept, once per session and turn
    def test_a_kept_session_is_asked_once_for_its_report(self):
        self.live.reported = False
        self.live.data['spaces'][1]['tabs'][0]['terminals'].pop()          # last pane, not a shell: kept
        self.live.data['terminals']['t12']['argv'] = ['claude', '--resume', SID]
        self.live.data['processes'][200]['name'] = 'claude'
        state = self.state()
        got = self.run_cycle(state)['t12']
        self.assertEqual(got['action'], 'report_requested')
        self.assertEqual(len([c for c in self.live.calls if c[0] == 'ask']), 1)
        got = sleep.cycle(self.live, self.config, state, NOW + 60, apply=True, paths=self.paths)   # same turn
        self.assertEqual(len([c for c in self.live.calls if c[0] == 'ask']), 1)
        state['reports']['t12'].update(requested_at=NOW - 5000, failed_at=NOW - 4000)              # retry time passed
        state['last_at'] = NOW + 60
        sleep.cycle(self.live, self.config, state, NOW + 120, apply=True, paths=self.paths)
        self.assertEqual(len([c for c in self.live.calls if c[0] == 'ask']), 1)
        self.assertFalse([c for c in self.live.calls if c[0] in ('keys', 'pane.close')])

    def test_collect_after_seconds_asks_before_idle_seconds_without_closing(self):
        self.config['close_report']['collect_after_seconds'] = 300
        self.live.data['terminals']['t12']['status_ms'] = (NOW - 600) * 1000
        state = self.state(quiet=600)
        got = self.run_cycle(state)['t12']
        self.assertEqual(got['action'], 'reported', got['reasons'])    # report found, but only 10 of 20 minutes
        self.assertTrue(any('not idle long enough' in r for r in got['reasons']))
        self.assertFalse([c for c in self.live.calls if c[0] in ('pane.close', 'keys', 'park')])

    def test_dry_run_collect_types_nothing(self):
        self.live.data['spaces'][1]['tabs'][0]['terminals'].pop()
        self.live.data['terminals']['t12']['argv'] = ['claude', '--resume', SID]
        self.live.data['processes'][200]['name'] = 'claude'
        got = self.run_cycle(apply=False)['t12']
        self.assertEqual(got['action'], 'would_collect_report')
        self.assertFalse(got['close_if_finished'])
        self.assertEqual(self.live.calls, [])


def pane_of_names(live):
    return set(sleep.pane_of(live.data))


class SpareCloseTests(unittest.TestCase):
    """Empty agent panes (never received input) and finished asleep panes close while their space
    and tab keep another pane; no input ever reached an empty one, so it leaves no harness record."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.paths = {'notes': root / 'notes', 'tickets': root / 'tickets', 'stub': root / 'session_sleep_stub.py'}
        self.live = FakeLive()
        self.live.empty = lambda terminal, config: terminal.get('turn') == 0
        self.config = {'idle_seconds': 1200, 'exclude_addresses': ['t3'], 'user_approved_apply': True,
                       'reviewed_observer_sha256': 'code', 'close_report': {'enabled': True}}
        self.mapping = patch.object(agent_sessions, 'session_mapping', lambda t, c=None: ({'session_id': SID}, ''))
        self.mapping.start()
        self.addCleanup(self.mapping.stop)

    def seeded(self, quiet=1200):
        first = sleep.cycle(self.live, self.config, {'observer_sha256': 'code'}, NOW - quiet, apply=False, paths=self.paths)
        sessions = {r['address']: {'since': NOW - quiet, 'fingerprint': r['fingerprint']}
                    for r in first['results'] if r.get('fingerprint')}
        return {'observer_sha256': 'code', 'last_at': NOW - 300, 'trial': {'started_at': NOW - 600, 'samples': 1, 'error_count': 0},
                'sessions': sessions}

    def run_cycle(self, state, apply=True):
        result = sleep.cycle(self.live, self.config, state, NOW, apply=apply, paths=self.paths)
        return {r['address']: r for r in result['results']}

    def make_empty(self, address):
        self.live.data['terminals'][address]['turn'] = 0

    def make_asleep(self, address):
        self.live.data['terminals'][address].update(
            labels={sleep.SLEEP_LABEL: f'claude:{SID}', sleep.TITLE_LABEL: '절전 · PR 검토 마무리'},
            foreground={'pid': 999, 'argv': ['python3', '/fixture/session_sleep_stub.py', '/fixture/t12.json'], 'name': 'python3'})

    def test_an_empty_pane_closes_without_a_harness_record_when_its_space_keeps_another(self):
        self.make_empty('t12')
        state = self.seeded()
        got = self.run_cycle(state)
        self.assertEqual(got['t12']['action'], 'closed', got['t12'])
        self.assertIn(('pane.close', 'p12'), self.live.calls)
        self.assertFalse([c for c in self.live.calls if c[0] in ('park', 'ask', 'status')], self.live.calls)

    def test_an_empty_pane_is_never_asked_for_a_report_and_waits_the_idle_window(self):
        self.make_empty('t12')
        got = self.run_cycle(self.seeded(quiet=600))
        self.assertEqual(got['t12']['action'], 'keep')
        self.assertTrue(any('empty pane unchanged for 10 of 20 minutes' in r for r in got['t12']['reasons']), got['t12'])
        self.assertFalse([c for c in self.live.calls if c[0] in ('pane.close', 'park', 'ask')])

    def test_the_last_pane_of_a_space_stays_even_when_empty(self):
        self.make_empty('t12')
        self.live.data['spaces'][1]['tabs'][0]['terminals'] = [{'terminal': 't12', 'pane': 'p12', 'sub_agents': []}]
        got = self.run_cycle(self.seeded())
        self.assertEqual(got['t12']['action'], 'keep')
        self.assertIn('last pane in its space', got['t12']['reasons'])
        self.assertNotIn(('pane.close', 'p12'), self.live.calls)

    def test_an_empty_pane_with_typed_input_is_not_empty(self):
        self.make_empty('t12')
        self.live.text = EMPTY.replace('❯ \n', '❯ 지금 하는 일\n')
        got = self.run_cycle(self.seeded())
        self.assertNotIn(('pane.close', 'p12'), self.live.calls)
        self.assertNotEqual(got['t12'].get('action'), 'closed')

    def test_dry_run_says_would_close_empty(self):
        self.make_empty('t12')
        got = self.run_cycle(self.seeded(), apply=False)
        self.assertEqual(got['t12']['action'], 'would_close_empty')
        self.assertFalse([c for c in self.live.calls if c[0] == 'pane.close'])

    def test_a_finished_asleep_pane_closes_with_its_harness_records(self):
        self.make_asleep('t12')
        self.live.reported = True
        got = self.run_cycle(self.seeded())
        self.assertEqual(got['t12']['action'], 'closed', got['t12'])
        parks = [c[1] for c in self.live.calls if c[0] == 'park']
        self.assertEqual(parks, ['close_requested', 'closed'])
        self.assertIn(('pane.close', 'p12'), self.live.calls)
        self.assertEqual(got['t12']['close_report'], 'REP1')

    def test_an_asleep_pane_without_a_close_report_stays_asleep(self):
        self.make_asleep('t12')
        got = self.run_cycle(self.seeded())
        self.assertEqual(got['t12']['action'], 'asleep')
        self.assertTrue(any('without a close report' in r for r in got['t12']['reasons']), got['t12'])
        self.assertNotIn(('pane.close', 'p12'), self.live.calls)


class EmptyAgentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        (self.home / 'sessions').mkdir()
        (self.home / 'sessions' / '201.json').write_text(json.dumps({'pid': 201, 'sessionId': SID}))
        self.config = {'claude_home': str(self.home)}

    def terminal(self, turn=0, app='claude-code', argv=('claude', '--dangerously-skip-permissions')):
        return {'turn': turn, 'status': {'app': app, 'state': 'idle'}, 'foreground': {'pid': 201, 'argv': list(argv)}}

    def test_claude_turn_zero_without_transcript_is_empty(self):
        self.assertTrue(agent_sessions.empty_agent(self.terminal(), self.config))

    def test_a_transcript_or_a_turn_means_input_was_received(self):
        self.assertFalse(agent_sessions.empty_agent(self.terminal(turn=1), self.config))
        (self.home / 'projects' / 'p').mkdir(parents=True)
        (self.home / 'projects' / 'p' / f'{SID}.jsonl').write_text('{}\n')
        self.assertFalse(agent_sessions.empty_agent(self.terminal(), self.config))

    def test_unreadable_or_resumed_sessions_are_not_empty(self):
        self.assertFalse(agent_sessions.empty_agent(self.terminal(argv=('claude', '--resume', SID)), self.config))
        (self.home / 'sessions' / '201.json').unlink()
        self.assertFalse(agent_sessions.empty_agent(self.terminal(), self.config))
        self.assertFalse(agent_sessions.empty_agent({'turn': 0, 'status': {'app': 'claude-code'}}, self.config))

    def test_codex_without_a_rollout_is_empty_and_config_flags_are_not_resume(self):
        codex = self.terminal(app='codex', argv=('codex', '-c', 'model_reasoning_effort=high'))
        self.assertTrue(agent_sessions.empty_agent(codex, self.config, held=[]))
        self.assertFalse(agent_sessions.empty_agent(codex, self.config, held=['/x/rollout-1.jsonl']))
        self.assertFalse(agent_sessions.empty_agent(self.terminal(app='codex', argv=('codex', 'resume', SID)), self.config, held=[]))
