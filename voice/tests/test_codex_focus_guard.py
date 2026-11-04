import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import _isolate  # noqa: F401  (before any plugin module)
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import codex_focus as guard


class RoutingTests(unittest.TestCase):
    def route(self, voices, focused, owned=None, toggle_ok=True, identity='p:123'):
        owned = {} if owned is None else owned
        calls = []
        def toggle(pid, on):
            calls.append((pid, on))
            if toggle_ok:
                voices[pid] = (on, not on)
            return toggle_ok
        focus = focused if callable(focused) else lambda: focused
        guard.reconcile({p: {'pane_id': p} for p in voices}, focus, voices.__getitem__,
                        toggle, lambda _: identity, owned, lambda _: None)
        return calls, owned

    def test_other_microphone_is_muted_before_owned_focus_resumes(self):
        calls, owned = self.route({'a': (False, True), 'b': (True, False)}, 'a', {'a': 'p:123'})
        self.assertEqual(calls, [('b', False), ('a', True)])
        self.assertEqual(owned, {'b': 'p:123'})

    def test_initial_manual_mute_is_preserved(self):
        self.assertEqual(self.route({'a': (False, True)}, 'a')[0], [])

    def test_unknown_focus_mutes_every_live_microphone(self):
        calls, _ = self.route({'a': (True, False), 'b': (True, False)}, None)
        self.assertEqual(calls, [('a', False), ('b', False)])

    def test_failed_background_mute_prevents_unmute(self):
        calls, owned = self.route({'a': (False, True), 'b': (True, False)}, 'a',
                                 {'a': 'p:123'}, toggle_ok=False)
        self.assertEqual(calls, [('b', False)])
        self.assertNotIn('b', owned)

    def test_unknown_process_identity_can_mute_but_never_resume(self):
        calls, owned = self.route({'a': (True, False)}, None, identity='a:None')
        self.assertEqual(calls, [('a', False)])
        self.assertEqual(owned, {})
        calls, owned = self.route({'a': (False, True)}, 'a', {'a': 'a:None'}, identity='a:None')
        self.assertEqual((calls, owned), ([], {}))

    def test_new_process_never_inherits_unmute_permission(self):
        calls, owned = self.route({'a': (False, True)}, 'a', {'a': 'p:122'})
        self.assertEqual(calls, [])
        self.assertEqual(owned, {})

    def test_missing_connection_drops_resume_permission_without_keys(self):
        calls, owned = self.route({'a': (False, False)}, 'a', {'a': 'p:123'})
        self.assertEqual((calls, owned), ([], {}))

    def test_ambiguous_footer_blocks_unmute_and_receives_no_keys(self):
        calls, _ = self.route({'b': (True, True), 'a': (False, True)}, 'a', {'a': 'p:123'})
        self.assertEqual(calls, [])

    def test_focus_change_during_unmute_is_immediately_remuted(self):
        focus = iter(['a', 'a', 'a', 'b'])
        calls, owned = self.route({'a': (False, True)}, lambda: next(focus), {'a': 'p:123'})
        self.assertEqual(calls, [('a', True), ('a', False)])
        self.assertIn('a', owned)

    def test_focus_change_before_unmute_never_receives_key(self):
        focus = iter(['a', 'a', 'b'])
        self.assertEqual(self.route({'a': (False, True)}, lambda: next(focus), {'a': 'p:123'})[0], [])


class MappingTests(unittest.TestCase):
    def test_window_focus_is_mapped_to_source_pane_without_sidebar(self):
        from types import SimpleNamespace
        queue = SimpleNamespace(CORE='hc', app_backend=SimpleNamespace(APP='app'))
        def run(*args):
            return {'agent': 't4'} if args[0] == 'app' else {'labels': {'sixfold.source-pane': 'w8:p11'}}
        with patch.object(guard.subprocess, 'check_output', side_effect=['front', 'bundleid="dev.herdr.app"']), \
             patch.object(guard, 'run', side_effect=run):
            self.assertEqual(guard.selected(queue), 'w8:p11')

    def test_unknown_front_app_is_never_permission_to_listen(self):
        with patch.object(guard.subprocess, 'check_output', side_effect=['front', 'unknown']):
            self.assertIsNone(guard.selected(None))

    def test_iterm_front_does_not_identify_which_window_is_focused(self):
        with patch.object(guard.subprocess, 'check_output', side_effect=['front', 'bundleid="com.googlecode.iterm2"']):
            self.assertIsNone(guard.selected(None))

    def test_bridge_is_not_a_second_microphone(self):
        from types import SimpleNamespace
        queue = SimpleNamespace(CORE='hc')
        listed = {'terminals': [{'address': 't4', 'agent': 'codex'}, {'address': 't8', 'agent': 'codex'}]}
        with patch.object(guard, 'tui_panes', return_value={'p': {'agent': 'codex'}}), \
             patch.object(guard, 'run', side_effect=[listed, {'terminals': [{'address': 't4'}]}]):
            self.assertEqual(set(guard.targets(queue)), {'p', 'app:t8'})


class InstallerTests(unittest.TestCase):
    def test_installer_writes_only_its_agent_and_state_in_isolated_home(self):
        import tempfile, plistlib
        import install_codex_focus as installer
        with tempfile.TemporaryDirectory() as folder, patch.object(installer.subprocess, 'run') as run:
            home = Path(folder)
            path = installer.install(home, Path(guard.__file__).parent, Path(sys.executable), start=False)
            value = plistlib.loads(path.read_bytes())
            self.assertEqual(value['ProgramArguments'][-1], '--serve')
            self.assertEqual(value['Label'], installer.label(home))
            self.assertFalse((home / '.config').exists())
            self.assertFalse((home / '.codex').exists())
            run.assert_not_called()

if __name__ == '__main__':
    unittest.main()
